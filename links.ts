/**
 * Folder links are read back from the note itself.
 *
 * v0.1.1 kept a sidecar directory of shortcut records under the plugin dir and
 * treated it as the source of truth. Nothing ever deleted those records, so a
 * link removed in the note (or the ink erased) still fired, and a record from
 * one note could stay live while another note was open (issue #2). The note
 * already stores everything we need: `setLassoStrokeLink` writes a real link
 * element with a rect and a destination path, and the note app deletes that
 * element when the user removes the link. So the note is the source of truth
 * and there is no separate state to go stale.
 */

import {FileUtils, PluginCommAPI, PluginFileAPI} from 'sn-plugin-lib';

export type FolderLink = {
  notePath: string;
  page: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  folderPath: string;
};

/** Link type 2 = "document". We reuse it for folders; see isFolder(). */
const LINK_TYPE_DOCUMENT = 2;

/** Logs each link element found on a page. Noisy; on only while debugging. */
const DEBUG_ELEMENTS = false;

const unwrap = (res: any): any =>
  res && typeof res === 'object' && 'result' in res ? res.result : res;

/**
 * Whether getLassoRect returned a rectangle worth acting on.
 *
 * The bounds have to be finite and enclose something. An empty rect passes a
 * bare type check but describes the top-left corner of the page, and an
 * infinite one describes half of it; a pending link built from either answers
 * to taps nowhere near the word — while never matching the real link, so it
 * lingers for its full TTL.
 */
export const usableLassoRect = (value: any): boolean =>
  Boolean(
    value &&
    typeof value === 'object' &&
    Number.isFinite(value.left) &&
    Number.isFinite(value.top) &&
    Number.isFinite(value.right) &&
    Number.isFinite(value.bottom) &&
    value.right > value.left &&
    value.bottom > value.top,
  );

// ----- folder-vs-file classification ---------------------------------------

// The note app's own "link to document" also uses link type 2, so type alone
// does not identify our links. A folder is a path listFiles() can enumerate;
// a PDF is not. Results are cached because this runs per link per page turn,
// but only for a while: a cached answer held forever outlives the filesystem
// it describes — a folder created after a failed probe stayed "not a folder"
// (its link dead) until the plugin restarted, and a deleted one stayed live.
const DIR_CACHE_TTL_MS = 60000;

const dirCache = new Map<string, {isDir: boolean; expiresAt: number}>();

const isFolder = async (path: string): Promise<boolean> => {
  const hit = dirCache.get(path);
  if (hit !== undefined && hit.expiresAt > Date.now()) {return hit.isDir;}
  let result = false;
  try {
    const entries = await FileUtils.listFiles(path);
    result = Array.isArray(entries);
  } catch {
    result = false;
  }
  dirCache.set(path, {isDir: result, expiresAt: Date.now() + DIR_CACHE_TTL_MS});
  return result;
};

// ----- pending links -------------------------------------------------------

// A link created from the plugin view is not necessarily flushed to the note
// file yet, so getElements may not see it until the note is saved. Hold onto
// it until a read of that page confirms it, so a freshly linked word is
// tappable straight away.
//
// Confirmation is not guaranteed: the write can fail, or the user can undo the
// link before the note is ever saved. An entry that no read has confirmed by
// its deadline is dropped, so an unconfirmed link cannot become a permanent
// phantom that keeps opening a folder — the exact failure the sidecar caused.
const PENDING_TTL_MS = 120000;

type PendingLink = FolderLink & {expiresAt: number};

let pending: PendingLink[] = [];

export const addPendingLink = (link: FolderLink): void => {
  pending = pending.filter(p => !sameSpot(p, link));
  pending.push({...link, expiresAt: Date.now() + PENDING_TTL_MS});
};

const sameSpot = (a: FolderLink, b: FolderLink): boolean =>
  a.notePath === b.notePath &&
  a.page === b.page &&
  Math.abs(a.left - b.left) < 4 &&
  Math.abs(a.top - b.top) < 4;

// ----- reading links off the page ------------------------------------------

let cacheKey = '';
let cached: FolderLink[] = [];

// Invalidating the cache starts a new publication generation. Native page
// reads cannot be cancelled, so a read from the previous note may still finish
// after a handoff; the generation prevents that late result from becoming the
// current tap map. Reads for the same page and generation share one promise so
// heartbeat, drag and lifecycle refreshes cannot build a native request queue.
let cacheGeneration = 0;
type InflightRead = {
  generation: number;
  minimumLinkCount: number;
  promise: Promise<FolderLink[]>;
};
const inflightReads = new Map<string, InflightRead>();

const contextKey = (notePath: string, page: number) => `${notePath}#${page}`;

/** Native error 206: the element cache is full and getElements refuses to run. */
const ERR_TRAIL_CACHE_FULL = 206;

/**
 * Every getElements call caches that page's trail data natively, and the cache
 * is not self-limiting: left alone it fills, after which getElements fails with
 * error 206 and this plugin goes blind — no links found and every tap rejected.
 * Since links are re-read on a timer and after linked-object moves, the
 * elements have to be handed back as soon as their fields have been copied out.
 */
export const recycleElements = (elements: any[]): void => {
  for (const el of elements) {
    if (typeof el?.uuid !== 'string' || !el.uuid) {continue;}
    try {
      PluginCommAPI.recycleElement(el.uuid);
    } catch (e: any) {
      console.log('[folder-link] recycleElement warn:', e?.message ?? String(e));
    }
  }
};

const getElements = async (notePath: string, page: number): Promise<any[]> => {
  let res: any = await PluginFileAPI.getElements(page, notePath);
  if (res && res.success === false && res?.error?.code === ERR_TRAIL_CACHE_FULL) {
    // Recovery for a cache already full when this build starts up, or filled by
    // something else: drop the cache wholesale and take one more run at it.
    console.log('[folder-link] element cache full, clearing and retrying');
    try {
      PluginCommAPI.clearElementCache();
    } catch (e: any) {
      console.log('[folder-link] clearElementCache warn:', e?.message ?? String(e));
    }
    res = await PluginFileAPI.getElements(page, notePath);
  }
  if (res && res.success === false) {
    throw new Error(`getElements failed code=${res?.error?.code} msg=${res?.error?.message}`);
  }
  const raw = unwrap(res);
  return Array.isArray(raw) ? raw : [];
};

/**
 * Reads every folder link on the given page. Throws if the elements cannot be
 * read, so callers can leave the previous link list alone rather than acting on
 * an empty page.
 */
const readFolderLinksOnce = async (
  notePath: string,
  page: number,
  generation: number,
  minimumLinkCount: () => number,
): Promise<FolderLink[]> => {
  const elements = await getElements(notePath, page);

  const links: FolderLink[] = [];
  try {
    if (DEBUG_ELEMENTS) {
      for (const el of elements) {
        if (el?.link) {
          console.log(`[folder-link] link el#${el.numInPage}: ${JSON.stringify(el.link)}`);
        }
      }
    }

    for (const el of elements) {
      const link = el?.link;
      if (!link || link.linkType !== LINK_TYPE_DOCUMENT) {continue;}
      if (typeof link.destPath !== 'string' || !link.destPath) {continue;}
      if (typeof link.X !== 'number' || typeof link.Y !== 'number') {continue;}
      if (!(await isFolder(link.destPath))) {continue;}
      links.push({
        notePath,
        page,
        left: link.X,
        top: link.Y,
        right: link.X + (link.width ?? 0),
        bottom: link.Y + (link.height ?? 0),
        folderPath: link.destPath,
      });
    }
  } finally {
    // Everything needed has been copied into plain values by now, and this must
    // happen even if the loop above throws — a skipped recycle is what fills
    // the cache and takes getElements down.
    recycleElements(elements);
  }

  // A read invalidated during getElements still returns its copied plain values
  // to its original caller, but it must not mutate pending links or publish a
  // cache entry for a context that has since moved on.
  if (generation !== cacheGeneration) {
    console.log(
      `[folder-link] stale page read ignored for ${notePath}#${page} generation ${generation}`,
    );
    return links;
  }

  // A pending link that the page now reports has been persisted, so it can be
  // dropped; one this read still cannot see stays pending and is merged in so
  // it keeps working until the note is saved, but only until its deadline.
  const now = Date.now();
  pending = pending.filter(p => {
    if (p.notePath !== notePath || p.page !== page) {return true;}
    if (links.some(l => sameSpot(l, p))) {return false;}
    if (p.expiresAt <= now) {
      console.log(`[folder-link] pending link never persisted, dropping → ${p.folderPath}`);
      return false;
    }
    return true;
  });
  // expiresAt is bookkeeping internal to this module; callers get plain links.
  const merged = links.concat(
    pending
      .filter(p => p.notePath === notePath && p.page === page)
      .map(({expiresAt: _expiresAt, ...link}) => link),
  );

  // While the note app commits a lasso move, getElements briefly excludes the
  // selected object. Publishing that partial result drops its link from the
  // tap map until the next periodic read. A drag caller supplies the number of
  // links known before the move; return the copied snapshot for retry logic,
  // but retain the last complete cache until that invariant holds again.
  const minimum = minimumLinkCount();
  if (merged.length < minimum) {
    console.log(
      `[folder-link] provisional page ${page} of ${notePath}: ${elements.length} elements, ` +
        `${merged.length}/${minimum} folder links; retaining prior cache`,
    );
    return merged;
  }

  cacheKey = contextKey(notePath, page);
  cached = merged;
  console.log(
    `[folder-link] page ${page} of ${notePath}: ${elements.length} elements, ${merged.length} folder links`,
  );
  return merged;
};

/**
 * Reads every folder link on the page, sharing native work between callers.
 *
 * The SDK's getElements queue is the expensive resource here. A heartbeat that
 * arrives while a drag refresh is reading the same page should observe the
 * same result, not enqueue a duplicate read behind it.
 */
export const readFolderLinks = (
  notePath: string,
  page: number,
  minimumLinkCount = 0,
): Promise<FolderLink[]> => {
  const key = contextKey(notePath, page);
  const generation = cacheGeneration;
  const existing = inflightReads.get(key);
  if (existing?.generation === generation) {
    // A drag guard arriving behind an ordinary caller strengthens the shared
    // read before it reaches the publication point, without duplicating the
    // expensive native getElements request.
    existing.minimumLinkCount = Math.max(
      existing.minimumLinkCount,
      minimumLinkCount,
    );
    return existing.promise;
  }

  const inflight: InflightRead = {
    generation,
    minimumLinkCount,
    promise: Promise.resolve([]),
  };
  let promise: Promise<FolderLink[]>;
  promise = readFolderLinksOnce(
    notePath,
    page,
    generation,
    () => inflight.minimumLinkCount,
  ).finally(() => {
    // A reset may have installed a newer promise under the same page key. The
    // older completion owns only its own entry and must not delete the newer
    // generation's single-flight guard.
    if (inflightReads.get(key)?.promise === promise) {
      inflightReads.delete(key);
    }
  });
  inflight.promise = promise;
  inflightReads.set(key, inflight);
  return promise;
};

/** Last successfully read page, or null if it was a different page. */
export const cachedLinksFor = (notePath: string, page: number): FolderLink[] | null =>
  cacheKey === contextKey(notePath, page) ? cached : null;

/** Invalidates native work already in flight while retaining last good links. */
export const invalidatePageReads = (): void => {
  cacheGeneration++;
  // Existing promises remain alive so their elements are recycled, but new
  // callers must not join work from the invalidated generation.
  inflightReads.clear();
};

export const invalidateCache = (): void => {
  invalidatePageReads();
  cacheKey = '';
  cached = [];
};

/**
 * Drops both layers that can carry the previous note into a new note context.
 * The SDK sometimes updates getCurrentFilePath before its native element cache
 * changes pages; clearing only our JavaScript cache then lets getElements hand
 * the old note's elements back under the new note's path.
 */
export const resetElementCaches = (): void => {
  invalidateCache();
  try {
    PluginCommAPI.clearElementCache();
  } catch (e: any) {
    console.log('[folder-link] clearElementCache warn:', e?.message ?? String(e));
  }
};

export const linkAt = (
  links: FolderLink[],
  x: number,
  y: number,
  pad = 20,
): FolderLink | undefined =>
  links.find(
    s => x >= s.left - pad && x <= s.right + pad && y >= s.top - pad && y <= s.bottom + pad,
  );

/**
 * Uses only the cheap cached hit. An ordinary miss is not permission to scan
 * the whole page: motion events also cover toolbar taps and handwriting, and
 * each miss used to enqueue a multi-second getElements request. A lasso move
 * marks the page dirty and schedules one shared background refresh separately.
 */
export const linkAtCachedOrFresh = async (
  cachedLinks: FolderLink[],
  x: number,
  y: number,
  _readFresh: () => Promise<FolderLink[]>,
): Promise<FolderLink | undefined> => {
  // Keep the callback in the signature for compatibility with older callers;
  // deliberately do not invoke it on a miss.
  return linkAt(cachedLinks, x, y);
};
