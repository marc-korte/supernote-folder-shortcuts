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

const contextKey = (notePath: string, page: number) => `${notePath}#${page}`;

/** Native error 206: the element cache is full and getElements refuses to run. */
const ERR_TRAIL_CACHE_FULL = 206;

/**
 * Every getElements call caches that page's trail data natively, and the cache
 * is not self-limiting: left alone it fills, after which getElements fails with
 * error 206 and this plugin goes blind — no links found and every tap rejected.
 * Since links are re-read on a timer and on every tap, the elements have to be
 * handed back as soon as their fields have been copied out.
 */
const recycleElements = (elements: any[]): void => {
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
export const readFolderLinks = async (
  notePath: string,
  page: number,
): Promise<FolderLink[]> => {
  const elements = await getElements(notePath, page);

  const links: FolderLink[] = [];
  try {
    if (DEBUG_ELEMENTS) {
      for (const el of elements) {
        if (!el?.link) {continue;}
        console.log(`[folder-link] link el#${el.numInPage}: ${JSON.stringify(el.link)}`);
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

  cacheKey = contextKey(notePath, page);
  cached = merged;
  console.log(
    `[folder-link] page ${page} of ${notePath}: ${elements.length} elements, ${merged.length} folder links`,
  );
  return merged;
};

/** Last successfully read page, or null if it was a different page. */
export const cachedLinksFor = (notePath: string, page: number): FolderLink[] | null =>
  cacheKey === contextKey(notePath, page) ? cached : null;

export const invalidateCache = (): void => {
  cacheKey = '';
  cached = [];
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

