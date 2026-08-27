/**
 * @format
 */

import {AppRegistry, DeviceEventEmitter, Image, NativeModules} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

import {PluginManager, PluginCommAPI, PluginFileAPI, EventType} from 'sn-plugin-lib';
import {
  readFolderLinks,
  cachedLinksFor,
  invalidateCache,
  invalidatePageReads,
  recycleElements,
  resetElementCaches,
  linkAt,
} from './links';
import {
  createRefreshScheduler,
  contextPathKind,
  linkGeometryChanged,
  noteContextChanged,
  NOTE_HANDOFF_SETTLE_MS,
  motionListenerAction,
  normalizeMotionEvent,
  pluginLifecycleAction,
  rawFingerTapMotionPair,
  raceWithDeadline,
  readStableLinkSnapshot,
  shouldPublishLinkSnapshot,
  shouldReuseRetainedDocumentLinks,
  shouldRefreshAfterLinkedDrag,
  shouldRetryEmptyTransition,
  strokePointCountIsTap,
  tapAgeLimit,
  waitForStableNoteContext,
} from './runtime';

// Bumped by hand whenever a build is handed to a device. The plugin host can be
// running either an installed package or a hot-reloaded debug bundle, and the
// two are indistinguishable in the log without this — which has repeatedly made
// it unclear whether a fix was actually under test.
const BUILD_ID = '0.3.0';

AppRegistry.registerComponent(appName, () => App);

console.log(`[folder-link] build ${BUILD_ID} starting`);

PluginManager.init();

const Native = NativeModules.FolderLinkNative;
const CONTEXT_REQUEST_TIMEOUT_MS = 2000;
let fingerFallbackReady = false;
let fingerFallbackPromise = null;

const ensureFingerFallback = (force = false) => {
  if (!force && fingerFallbackReady) {return Promise.resolve(true);}
  if (fingerFallbackPromise) {return fingerFallbackPromise;}
  if (!Native || typeof Native.resetFingerMonitor !== 'function') {
    return Promise.resolve(false);
  }
  fingerFallbackPromise = Promise.resolve(Native.resetFingerMonitor())
    .then(ready => {
      fingerFallbackReady = Boolean(ready);
      return fingerFallbackReady;
    })
    .catch(error => {
      fingerFallbackReady = false;
      console.log(
        '[folder-link] finger fallback unavailable:',
        error?.message ?? String(error),
      );
      return false;
    })
    .finally(() => {
      fingerFallbackPromise = null;
    });
  return fingerFallbackPromise;
};

// The plugin view is paused during normal note-taking, so a JavaScript timer
// cannot enforce this deadline. FolderLinkNative.delay uses an Android Handler
// and continues to resolve while the view is paused, just like its heartbeat.
const withNativeTimeout = (operation, milliseconds, label) =>
  raceWithDeadline(
    operation,
    Native.delay(milliseconds),
    milliseconds,
    label,
  );

const iconUri = Image.resolveAssetSource(require('./assets/icon.png')).uri;

PluginManager.registerButton(1, ['NOTE', 'DOC'], {
  id: 100,
  name: 'Folder Shortcuts',
  icon: iconUri,
  enable: true,
  expandButton: 0,
});

PluginManager.registerButton(2, ['NOTE'], {
  id: 200,
  name: 'Link to folder',
  icon: iconUri,
  enable: true,
  editDataTypes: [0, 3],
});

// ----- Not navigating while the plugin's own UI is up ----------------------
//
// Opening the picker from the lasso toolbar is itself a touch on the screen, and
// the lasso menu appears right next to the word being lassoed — so the tap that
// opens the picker used to be hit-tested against the note and open the link
// underneath it. That threw the user into the file manager and destroyed the
// lasso, which is why the picker then answered the link button with error 904.
//
// An expiry rather than a flag: the host can take the view away without the
// picker ever running its own close path, and a flag left set that way would
// kill every link tap until the plugin restarted. Touches inside the picker push
// the deadline out, so browsing a deep folder tree cannot outlast it.
const SUPPRESS_MAX_MS = 120000;
let suppressUntil = 0;
// Whether the picker is believed to be on screen. The deadline alone cannot say:
// it lapses after a couple of idle minutes, and a touch arriving after that has
// to be able to revive it rather than fall through to the note underneath.
let pickerOpen = false;
const uiSuppressed = () => Date.now() < suppressUntil;

PluginManager.registerButtonListener({
  onButtonPress: (event) => {
    console.log(`[folder-link] plugin button press id=${event?.id}`);
    // Only this plugin's own buttons; every listener hears every button event.
    if (event?.id !== 100 && event?.id !== 200) {return;}
    pickerOpen = true;
    suppressUntil = Date.now() + SUPPRESS_MAX_MS;
    DeviceEventEmitter.emit('folderLinkViewOpened');
  },
});

// Only ever extends a window the picker is entitled to; a touch cannot arm
// suppression once the picker is gone.
DeviceEventEmitter.addListener('folderLinkViewTouched', () => {
  if (pickerOpen) {
    suppressUntil = Date.now() + SUPPRESS_MAX_MS;
  }
});

// A grace period rather than a clear: closing the picker is a press on its ✕,
// and that press arrives at the motion listener after this handler has run. Zero
// it here and the closing tap navigates into whatever link sits beneath the
// button.
const CLOSE_GRACE_MS = 1500;
DeviceEventEmitter.addListener('folderLinkViewClosed', () => {
  pickerOpen = false;
  suppressUntil = Math.min(suppressUntil, Date.now() + CLOSE_GRACE_MS);
  console.log(`[folder-link] picker closed; suppression grace until ${suppressUntil}`);
});

const unwrap = (res) => (res && typeof res === 'object' && 'result' in res ? res.result : res);

const currentContext = async () => {
  const [pageRes, pathRes] = await withNativeTimeout(
    Promise.all([
      PluginCommAPI.getCurrentPageNum(),
      PluginCommAPI.getCurrentFilePath(),
    ]),
    CONTEXT_REQUEST_TIMEOUT_MS,
    'current context',
  );
  const page = unwrap(pageRes);
  const notePath = unwrap(pathRes);
  if (typeof notePath !== 'string' || typeof page !== 'number') {return null;}
  return {notePath, page};
};

// ----- Where a tap is tested against the note ------------------------------
//
// Taps used to be caught by invisible SYSTEM_ALERT_WINDOW rectangles laid over
// each linked word. That is gone: the motion listener reports finger touches as
// well as stylus ones, so the windows were redundant, and they did real harm —
// a window swallows every finger event inside it, so a linked object could not
// be dragged, and its rectangle was positioned from the last refresh, leaving
// the tappable area behind whenever the object was moved or resized.
//
// Taps are now hit-tested against the note as it stands at that moment, so the
// clickable area is the link's own rectangle by definition, and it follows the
// object wherever it goes.

// Link rects are in page coords while touches arrive in screen pixels. On a
// Manta the two happen to match 1:1 — so this ratio has never had to be
// anything but 1 in testing — but other Supernote panels differ, so derive it
// from display metrics and the SDK's page size. Zoom is not handled yet.
const scaleProbe = async (notePath, page) => {
  try {
    const [metrics, pageSizeRes] = await Promise.all([
      Native.getDisplayMetrics(),
      PluginFileAPI.getPageSize(notePath, page),
    ]);
    const pageSize = unwrap(pageSizeRes);
    if (
      metrics &&
      typeof metrics.widthPixels === 'number' &&
      typeof metrics.heightPixels === 'number' &&
      pageSize &&
      typeof pageSize.width === 'number' &&
      typeof pageSize.height === 'number' &&
      pageSize.width > 0 &&
      pageSize.height > 0
    ) {
      return {
        x: metrics.widthPixels / pageSize.width,
        y: metrics.heightPixels / pageSize.height,
      };
    }
  } catch (e) {
    console.log('[folder-link] scaleProbe failed, assuming 1:1:', e?.message ?? String(e));
  }
  return {x: 1, y: 1};
};

// Reading page elements is not free, so links are re-read when the note or page
// changes and otherwise at this interval. This is also how quickly a link
// removed in the note app stops being tappable, since taps are hit-tested
// against the most recent read.
const LINK_RECHECK_MS = 30000;

// The page the cached scale and link list were measured for.
let measuredKey = '';
let measuredAt = 0;
let noContextSince = 0;
let documentExcursionPath = '';
let settlingKey = '';
let transitionRetriesRemaining = 0;
let handoffObservedAt = 0;
let handoffReadKey = '';
const NO_CONTEXT_DISARM_MS = 60000;
const EMPTY_TRANSITION_RETRIES = 1;

// Context observation and page scanning have deliberately separate lifetimes.
// getElements can take several seconds on a large note; putting the next
// context probe behind it made a PDF/note return look dead until that queue
// drained. Each heartbeat now probes immediately, while page work is
// single-flight and guarded by a generation before it can publish.
let observedContextIdentity = '';
let activeNoteContext = null;
let contextEpoch = 0;
let pageGeneration = 0;
let geometryDirtyKey = '';
let dragDirtyKey = '';
let dragMinimumLinkCount = 0;
let dragBaselineLinks = [];
const pageScans = new Map();
let followupScheduled = false;
let refreshScheduler = null;
let scheduleRefresh = () => Promise.resolve();

const EMPTY_TRANSITION_RETRY_MS = 500;

const scheduleFollowup = (delayMs = EMPTY_TRANSITION_RETRY_MS) => {
  if (followupScheduled || !Native || typeof Native.delay !== 'function') {return;}
  followupScheduled = true;
  Native.delay(delayMs)
    .then(() => {
      followupScheduled = false;
      if (running) {scheduleRefresh(true);}
    })
    .catch(() => {
      followupScheduled = false;
    });
};

const observeContext = ctx => {
  if (!ctx) {return;}
  const kind = contextPathKind(ctx.notePath);
  const identity =
    kind === 'note'
      ? `note:${ctx.notePath}#${ctx.page}`
      : `document:${ctx.notePath}`;
  if (identity !== observedContextIdentity) {
    observedContextIdentity = identity;
    contextEpoch++;
    pageGeneration++;
    const noteKey = kind === 'note' ? contextKey(ctx) : '';
    const preserveDirtyMove =
      kind === 'document' || (geometryDirtyKey && geometryDirtyKey === noteKey);
    if (!preserveDirtyMove) {
      geometryDirtyKey = '';
      dragDirtyKey = '';
      dragMinimumLinkCount = 0;
      dragBaselineLinks = [];
    }
    pageScans.clear();
    // Preserve the last good note links across a document excursion, but make
    // any native read from the previous context publication-ineligible.
    invalidatePageReads();
    penDown = null;
    if (kind === 'note') {
      handoffObservedAt = Date.now();
      handoffReadKey = contextKey(ctx);
    } else {
      handoffObservedAt = 0;
      handoffReadKey = '';
    }
  }
  activeNoteContext = kind === 'note' ? ctx : null;
};

const standDown = () => {
  measuredKey = '';
  measuredAt = 0;
  noContextSince = 0;
  documentExcursionPath = '';
  settlingKey = '';
  transitionRetriesRemaining = 0;
  handoffObservedAt = 0;
  handoffReadKey = '';
  pickerOpen = false;
  suppressUntil = 0;
  activeNoteContext = null;
  observedContextIdentity = '';
  contextEpoch++;
  pageGeneration++;
  geometryDirtyKey = '';
  dragDirtyKey = '';
  dragMinimumLinkCount = 0;
  dragBaselineLinks = [];
  pageScans.clear();
  invalidatePageReads();
  penDown = null;
  // Cancel context passes still in flight so they cannot restore state behind
  // an intentional stop.
  refreshScheduler?.cancel();
  ensureMotionListener(false);
};

const scanPage = (ctx, key, generation, cancelled) => {
  const scanKey = `${key}@${generation}`;
  const existing = pageScans.get(scanKey);
  if (existing) {return existing;}

  const startedAt = Date.now();
  const dragScan = dragDirtyKey === key && dragMinimumLinkCount > 0;
  let scan;
  scan = (async () => {
    try {
      // The SDK publishes the new note path before its native page has finished
      // loading. The first read for a handoff waits out that measured window
      // and then confirms the note/page is still current. This gate lives here,
      // not only in the heartbeat, because a tap on the speculative listener
      // can also be the first caller to request a scan.
      if (handoffReadKey === key) {
        const confirmed = await waitForStableNoteContext({
          wait: milliseconds => Native.delay(milliseconds),
          readContext: currentContext,
          expectedKey: key,
          keyOf: contextKey,
          observedAt: handoffObservedAt,
        });
        if (
          !confirmed ||
          cancelled() ||
          generation !== pageGeneration ||
          contextKey(activeNoteContext) !== key
        ) {
          throw new Error('page scan cancelled: note context did not settle');
        }
        handoffObservedAt = 0;
        handoffReadKey = '';
      }

      const read = minimumLinkCount => {
        if (
          cancelled() ||
          generation !== pageGeneration ||
          contextKey(activeNoteContext) !== key
        ) {
          throw new Error('page scan cancelled before read');
        }
        return readFolderLinks(ctx.notePath, ctx.page, minimumLinkCount);
      };
      const snapshot = dragScan
        ? await readStableLinkSnapshot({
          wait: () => Native.delay(DRAG_GEOMETRY_SETTLE_MS),
          read,
          minimumCount: dragMinimumLinkCount,
          maxAttempts: DRAG_SNAPSHOT_MAX_ATTEMPTS,
          accept: candidate => linkGeometryChanged(dragBaselineLinks, candidate),
        })
        : {links: await readFolderLinks(ctx.notePath, ctx.page), stable: true};
      const links = snapshot.links;
      if (
        cancelled() ||
        generation !== pageGeneration ||
        contextKey(activeNoteContext) !== key
      ) {return;}

      if (!shouldPublishLinkSnapshot({
        dragScan,
        snapshotStable: snapshot.stable,
      })) {
        // The selection transaction still reports the pre-drag rectangle. Keep
        // the page dirty until the note actually publishes a different
        // rectangle. A periodic scan can run while the object remains selected;
        // treating that unchanged snapshot as a completed move loses the link
        // at its new position when the user eventually deselects it.
        // Keep the dirty state, but do not hammer getElements on every 1.5 s
        // heartbeat while the user leaves the lasso selection open. A tap or
        // document return bypasses this timestamp and refreshes immediately;
        // otherwise the normal periodic recheck is sufficient.
        measuredAt = Date.now();
        ensureMotionListener(true);
        console.log(`[folder-link] drag geometry still pending ${key}`);
        return;
      }

      const scale = await scaleProbe(ctx.notePath, ctx.page);
      if (
        cancelled() ||
        generation !== pageGeneration ||
        contextKey(activeNoteContext) !== key
      ) {return;}

      currentScale = scale;

      if (
        shouldRetryEmptyTransition(
          settlingKey,
          key,
          links.length,
          transitionRetriesRemaining,
        )
      ) {
        transitionRetriesRemaining--;
        measuredAt = 0;
        ensureMotionListener(true);
        console.log(`[folder-link] context handoff: empty ${key}, retrying`);
        scheduleFollowup();
        return;
      }

      settlingKey = '';
      transitionRetriesRemaining = 0;
      measuredKey = key;
      measuredAt = Date.now();
      if (geometryDirtyKey === key) {geometryDirtyKey = '';}
      if (dragDirtyKey === key) {
        dragDirtyKey = '';
        dragMinimumLinkCount = 0;
        dragBaselineLinks = [];
      }
      ensureMotionListener(links.length > 0);
      console.log(
        `[folder-link] scan ${key} completed in ${Date.now() - startedAt}ms`,
      );
    } catch (e) {
      if (!cancelled() && generation === pageGeneration) {
        measuredAt = 0;
      }
      console.log('[folder-link] page scan error:', e?.message ?? String(e));
    }
  })().finally(() => {
    if (pageScans.get(scanKey) === scan) {pageScans.delete(scanKey);}
  });
  pageScans.set(scanKey, scan);
  return scan;
};

/**
 * Keeps two things current for the open page: the screen-to-page scale used to
 * place a tap, and whether the page has any folder link worth listening for.
 * Transient no-context reads are tolerated: the cached page and scale remain
 * usable while the note activity recovers, and the tap path still refuses to
 * navigate without a matching live context. Only sustained absence disarms the
 * listener, because an excursion to the file manager otherwise creates a
 * seconds-long blind window while the page is read again. The disarm threshold
 * is one minute of wall-clock absence, not a number of heartbeat passes.
 */
const runRefresh = async (ctx, {force, cancelled}) => {
  if (cancelled()) {return;}
  if (!ctx) {
    if (!noContextSince) {
      noContextSince = Date.now();
      console.log('[folder-link] refresh: no note context');
    }
    if (Date.now() - noContextSince > NO_CONTEXT_DISARM_MS) {
      ensureMotionListener(false);
      measuredKey = '';
    }
    return;
  }

  observeContext(ctx);
  if (cancelled()) {return;}

  try {
    // getCurrentFilePath also reports PDFs and EPUBs. They are a temporary
    // excursion from the note, not a page with zero links: reading one here
    // replaces the note cache with an empty document cache and switches the
    // only motion listener off. Keep the last note state intact so its link is
    // ready on the first tap after "Last Opened Note".
    if (contextPathKind(ctx.notePath) !== 'note') {
      noContextSince = 0;
      if (documentExcursionPath !== ctx.notePath) {
        documentExcursionPath = ctx.notePath;
        console.log(
          `[folder-link] document excursion: retaining note links for ${ctx.notePath}`,
        );
      }
      return;
    }
    const excursionPath = documentExcursionPath;
    const returningFromDocument = Boolean(excursionPath);
    if (returningFromDocument) {documentExcursionPath = '';}
    noContextSince = 0;
    const key = `${ctx.notePath}#${ctx.page}`;
    const retainedLinks = cachedLinksFor(ctx.notePath, ctx.page);

    // The JavaScript handle survives a NOTE/DOC client handoff, but its native
    // client binding does not. Refresh the same native listener ID: replacing
    // it makes Manta deliver an orphan first finger UP, while removing the last
    // handle first produces the same incomplete gesture boundary.
    // Claim the excursion before awaiting native renewal so overlapping
    // context heartbeats cannot do the same work. The firmware host's resume()
    // leaves its raw-finger monitor stale after Document was active, so renew
    // that monitor before refreshing the existing listener ID.
    if (returningFromDocument) {
      const reset = await ensureFingerFallback(true);
      if (
        cancelled() ||
        contextKey(activeNoteContext) !== key
      ) {return;}
      if (!reset || !ensureMotionListener(true, true)) {
        if (!documentExcursionPath) {documentExcursionPath = excursionPath;}
        console.log('[folder-link] document return: motion renewal pending');
        scheduleFollowup();
        return;
      }
    }

    if (geometryDirtyKey !== key && shouldReuseRetainedDocumentLinks(
      returningFromDocument,
      key,
      measuredKey,
      retainedLinks?.length ?? 0,
    )) {
      measuredAt = Date.now();
      console.log('[folder-link] retained document links ready immediately');
      return;
    }

    // getCurrentFilePath changes before getElements on some note-to-note
    // transitions. Prime the new context without trusting a page read made in
    // that window. A speculative listener makes the first real tap capable of
    // doing its own authoritative read while the next native heartbeat confirms
    // the page; a genuinely unlinked page removes it after the bounded retry.
    if (noteContextChanged(key, measuredKey)) {
      measuredKey = key;
      measuredAt = 0;
      // measuredKey now names this page, so drop the previous page's scale
      // rather than replacing it with a placeholder: scaleFor keys off
      // measuredKey and would take 1:1 for a real measurement of this page.
      currentScale = null;
      settlingKey = key;
      transitionRetriesRemaining = EMPTY_TRANSITION_RETRIES;
      resetElementCaches();
      // resetElementCaches invalidates the native read generation; mirror that
      // in the page coordinator so an older scan cannot update measuredAt or
      // listener ownership when it eventually returns.
      pageGeneration++;
      pageScans.clear();
      geometryDirtyKey = key;
      dragDirtyKey = '';
      dragMinimumLinkCount = 0;
      dragBaselineLinks = [];
      ensureMotionListener(true);
      console.log(`[folder-link] context handoff: primed ${key}`);
      scheduleFollowup(NOTE_HANDOFF_SETTLE_MS);
      return;
    }

    const stale = Date.now() - measuredAt > LINK_RECHECK_MS;
    if (!force && !returningFromDocument && key === measuredKey && !stale) {return;}

    return scanPage(ctx, key, pageGeneration, cancelled);
  } catch (e) {
    console.log('[folder-link] refresh error:', e?.message ?? String(e));
  }
};

refreshScheduler = createRefreshScheduler({
  readContext: currentContext,
  handleContext: runRefresh,
  onError: e => {
    console.log('[folder-link] context probe error:', e?.message ?? String(e));
  },
});
scheduleRefresh = (force = false) => refreshScheduler.schedule(force);

scheduleRefresh(true);

// Force a re-read after the plugin view saves a new link, even when the
// note+page context is unchanged.
DeviceEventEmitter.addListener('folderLinkChanged', () => {
  invalidateCache();
  pageGeneration++;
  pageScans.clear();
  geometryDirtyKey = contextKey(activeNoteContext);
  dragDirtyKey = '';
  dragMinimumLinkCount = 0;
  dragBaselineLinks = [];
  scheduleRefresh(true);
});

const openFolder = async (folderPath) => {
  if (Native && typeof Native.openFolder === 'function') {
    return Native.openFolder(folderPath);
  }
  throw new Error('FolderLinkNative.openFolder unavailable');
};

/**
 * Hit-tests the most recent page snapshot. Clean misses are final and never
 * start getElements: toolbar taps and handwriting miss link rectangles all day
 * long, and making each one an authoritative read was the request backlog
 * behind the intermittent delay.
 *
 * A possible linked-object drag is the one exception. It marks geometry dirty
 * and immediately starts one shared scan. A tap during that short window joins
 * the existing scan; no second native read is created, and neither the old nor
 * new rectangle is trusted until the replacement snapshot lands.
 */
const resolveLinkFast = async (ctx, x, y) => {
  const key = contextKey(ctx);
  let waitedForDirty = false;
  if (geometryDirtyKey === key) {
    waitedForDirty = true;
    const scanKey = `${key}@${pageGeneration}`;
    const scan =
      pageScans.get(scanKey) ??
      scanPage(ctx, key, pageGeneration, () => !running);
    await scan;
    if (geometryDirtyKey === key) {
      // An unchanged rectangle can also mean the lasso was cancelled. Keep the
      // dirty guard for a possibly still-selected move, but preserve the old
      // link at its old location in that no-op case.
      const baselineMatch = dragDirtyKey === key
        ? linkAt(dragBaselineLinks, x, y) ?? null
        : null;
      return {match: baselineMatch, waitedForDirty};
    }
  }
  const known = cachedLinksFor(ctx.notePath, ctx.page);
  return {match: known ? linkAt(known, x, y) ?? null : null, waitedForDirty};
};

// Assume running until the host says otherwise: the lifecycle callback may only
// arrive later, and taps should work from load.
let running = true;

// Pick up a change of note or page, and re-read the link list periodically so
// removals take effect. Skipped while the plugin is stopped, otherwise the next
// tick would undo what onStop just did.
//
// The heartbeat is emitted by the native module, not by setInterval here: React
// Native suspends JS timers while the host context is paused, which is its
// state whenever the plugin view is closed — so a JS interval fires only while
// the picker is open, and nothing would be maintained during normal
// note-taking. The setInterval is kept only as a fallback for a host that does
// keep timers running. Page work is single-flight, so a duplicate tick can
// probe context without duplicating getElements.
DeviceEventEmitter.addListener('folderLinkTick', () => {
  if (running) {scheduleRefresh();}
});

setInterval(() => {
  if (running) {scheduleRefresh();}
}, 1500);

// Stop listening for taps when the plugin is stopped.
try {
  PluginManager.registerPluginLifeListener({
    onMsg: (data) => {
      const state = typeof data === 'number' ? data : data?.state;
      const action = pluginLifecycleAction(state);
      if (action === 'start') {
        console.log('[folder-link] plugin life: start');
        running = true;
        invalidateCache();
        pageGeneration++;
        pageScans.clear();
        geometryDirtyKey = contextKey(activeNoteContext);
        dragDirtyKey = '';
        dragMinimumLinkCount = 0;
        dragBaselineLinks = [];
        scheduleRefresh(true);
      } else if (action === 'background') {
        // Closing the picker puts the plugin view in state 3, but the note is
        // precisely where its tap listener has to remain active. Bring the
        // newly written link into the cache before the JS context is paused.
        console.log('[folder-link] plugin life: background');
        running = true;
        scheduleRefresh(true);
      } else if (action === 'stop') {
        console.log('[folder-link] plugin life: stop');
        running = false;
        invalidateCache();
        standDown();
      }
    },
  });
} catch (e) {
  console.log('[folder-link] registerPluginLifeListener failed:', e?.message ?? String(e));
}

// ----- Pen-tap path: PEN_UP + delete ink + openFilePath --------------------

const extractTapPoint = (el) => {
  const r = el?.recognizeResult;
  if (!r) {return null;}
  if (typeof r.key_point_x === 'number' && typeof r.key_point_y === 'number') {
    return {x: r.key_point_x, y: r.key_point_y};
  }
  if (
    typeof r.up_left_point_x === 'number' &&
    typeof r.down_right_point_x === 'number' &&
    typeof r.up_left_point_y === 'number' &&
    typeof r.down_right_point_y === 'number'
  ) {
    return {
      x: (r.up_left_point_x + r.down_right_point_x) / 2,
      y: (r.up_left_point_y + r.down_right_point_y) / 2,
    };
  }
  return null;
};

// A pen tap is 1–5 sample points; a lasso or any drawn stroke has dozens.
// Using stroke.points.size() lets lassoes/writing fall through to the native
// 3-dots menu instead of being hijacked.
const TAP_MAX_POINTS = 10;

const isTapStroke = async (el) => {
  try {
    return await strokePointCountIsTap(el?.stroke?.points, TAP_MAX_POINTS);
  } catch {
    return false;
  }
};

// The SDK delivers each PEN_UP up to 4 times within ~10ms. Dedupe by uuid,
// synchronously, before any await, otherwise concurrent handlers race.
const handledUuids = new Set();
const rememberHandled = (uuid) => {
  if (!uuid) {return;}
  handledUuids.add(uuid);
  if (handledUuids.size > 200) {
    const tail = Array.from(handledUuids).slice(-100);
    handledUuids.clear();
    for (const u of tail) {handledUuids.add(u);}
  }
};

const DEBUG_PEN = false;
const penLog = (msg) => {
  if (DEBUG_PEN) {console.log(`[folder-link] pen: ${msg}`);}
};

// ----- Stylus path: motion events ------------------------------------------

// The note app hit-tests a pen tap against its own link rect and consumes it,
// so a stylus tap on linked ink never reaches PEN_UP — it just resolves the
// link internally, finds a directory where it expects a file, and does nothing.
// Motion events are delivered earlier in the chain and do arrive (tool=2), so
// the stylus is handled from here instead.
//
// Whichever path sees the tap first opens the folder and records the time; the
// other then skips opening so one tap cannot navigate twice. PEN_UP still
// erases the tap dot when it fires, because only it knows which element that
// dot is. Deliberately free of timers: JS timers can be suspended while the
// plugin view is closed, and a sleep here would hang the handler outright.
const ACTION_DOWN = 0;
const ACTION_UP = 1;
const ACTION_CANCEL = 3;
const TOOL_FINGER = 1;
const TOOL_STYLUS = 2;
const TAP_MAX_DURATION_MS = 300;
const TAP_MAX_MOVEMENT_PX = 25;

let motionSub = null;
let penDown = null;
let lastOpenAt = 0;
let tapClaimedAt = 0;
let inputSeq = 0;

// Motion coordinates are screen pixels; link rects are page coordinates. Null
// until a probe has actually measured the open page: a placeholder standing in
// for a measurement is indistinguishable from one, and taps would be hit-tested
// in the wrong space on any panel where the two do not already agree.
let currentScale = null;

const recentlyOpened = () => Date.now() - lastOpenAt < 1000;

/**
 * Brings the next read forward after a drag, because a drag may have moved a
 * linked object.
 *
 * Taps are hit-tested against the last read, so until the next one the plugin is
 * holding the rectangle the object used to occupy: tapping the object does
 * nothing and tapping where it was still opens the folder. Left to
 * LINK_RECHECK_MS can otherwise leave the link stale until the next background
 * pass plus the native read itself.
 *
 * Only a drag that starts inside a cached folder-link rectangle can move that
 * linked object. Ordinary handwriting and toolbar gestures therefore do not
 * dirty the page or start a scan.
 */
const DRAG_REREAD_MIN_INTERVAL_MS = 750;
const DRAG_GEOMETRY_SETTLE_MS = 500;
const DRAG_SNAPSHOT_MAX_ATTEMPTS = 3;
let lastDragRereadAt = 0;

const noteMayHaveMoved = down => {
  const ctx = activeNoteContext;
  const key = contextKey(ctx);
  if (!ctx || !key || !currentScale || measuredKey !== key) {return;}
  const known = cachedLinksFor(ctx.notePath, ctx.page);
  if (!known) {return;}
  if (!shouldRefreshAfterLinkedDrag(known, down.x, down.y, currentScale)) {return;}

  const now = Date.now();
  if (now - lastDragRereadAt < DRAG_REREAD_MIN_INTERVAL_MS) {return;}
  lastDragRereadAt = now;
  pageGeneration++;
  pageScans.clear();
  invalidatePageReads();
  geometryDirtyKey = key;
  dragDirtyKey = key;
  dragMinimumLinkCount = known.length;
  dragBaselineLinks = known.map(link => ({...link}));
  measuredAt = 0;
  console.log(`[folder-link] linked drag dirtied ${key}`);
  // Install the shared promise immediately so a tap joins this refresh, but
  // let the note app commit its selection transaction before getElements. A
  // snapshot taken synchronously on ACTION_UP temporarily omits the selection.
  scanPage(ctx, key, pageGeneration, () => !running);
};

/**
 * How long after a touch its result may still be acted on.
 *
 * A touch resolved seconds late can land on a screen the user has moved on
 * from: a tap on the sidebar was once resolved two seconds later, by which time
 * the note had reopened, and it opened the folder again — every time, forever.
 */
/**
 * Navigates and records the attempt so the other tap path stands down.
 *
 * The timestamp is rolled back if the launch fails, but only when no newer
 * attempt has taken the slot in the meantime — otherwise a failure here would
 * clear the record of someone else's successful open.
 */
const navigate = async (match, label) => {
  const stamp = Date.now();
  lastOpenAt = stamp;
  console.log(`[folder-link] ${label} openFolder("${match.folderPath}")`);
  try {
    await openFolder(match.folderPath);
  } catch (err) {
    if (lastOpenAt === stamp) {lastOpenAt = 0;}
    console.log('[folder-link] openFolder error:', err?.message ?? String(err));
  }
};

/**
 * One physical tap reaches both PEN_UP and the motion listener, so the two
 * paths agree on an owner: the first to claim within the window goes ahead and
 * the other stands down, which keeps them from duplicating the same reads.
 * Claiming is synchronous — with no await between the check and the assignment,
 * the single-threaded runtime cannot hand the tap to both.
 *
 * A claimant that gives up must release, or a tap the other path could have
 * handled is lost: the claim outlives the attempt and locks the other path out
 * for the rest of the window while nothing navigates.
 *
 * The claim is not what makes navigation exclusive — recentlyOpened() is, and
 * it is checked immediately before lastOpenAt is set with no await between, so
 * only one path can ever open a given tap even if both end up running.
 */
const TAP_CLAIM_MS = 1000;
const claimTap = () => {
  const now = Date.now();
  if (now - tapClaimedAt < TAP_CLAIM_MS) {return 0;}
  tapClaimedAt = now;
  return now;
};

/**
 * Releases only the claim the caller took.
 *
 * A handler slow enough to give up after its own window has expired would
 * otherwise clear a claim the other path has since taken, handing the same tap
 * to a third comer. Same rollback guard navigate() uses for lastOpenAt.
 */
const releaseTap = (stamp) => {
  if (stamp && tapClaimedAt === stamp) {tapClaimedAt = 0;}
};

const contextKey = (ctx) => (ctx ? `${ctx.notePath}#${ctx.page}` : '');

const preNavCheck = (expectedKey, expectedEpoch, expectedInput) => {
  if (
    !running ||
    contextKey(activeNoteContext) !== expectedKey ||
    contextEpoch !== expectedEpoch ||
    (typeof expectedInput === 'number' && inputSeq !== expectedInput)
  ) {return 'context';}
  if (uiSuppressed()) {return 'suppressed';}
  return null;
};

/**
 * The scale to convert this context's screen pixels into page coordinates.
 *
 * currentScale is only meaningful for the page the last refresh measured.
 * Measure the context at hand when the cached value does not belong to it,
 * including the handoff window where measuredKey names the new page but
 * nothing has measured it yet.
 */
const scaleFor = async (ctx) =>
  currentScale && contextKey(ctx) === measuredKey
    ? currentScale
    : scaleProbe(ctx.notePath, ctx.page);

const onMotion = async (e) => {
  // Only ever release a claim this handler took: the catch below must not clear
  // the other path's claim on the way out.
  let ownsTap = 0;
  try {
    const motion = normalizeMotionEvent(e);
    if (motion.toolType !== TOOL_STYLUS && motion.toolType !== TOOL_FINGER) {return;}
    if (motion.pointerCount !== 1) {
      penDown = null;
      return;
    }
    if (motion.action === ACTION_DOWN) {
      if (typeof motion.x !== 'number' || typeof motion.y !== 'number') {return;}
      const input = ++inputSeq;
      penDown = {
        x: motion.x,
        y: motion.y,
        t: motion.eventTime,
        tool: motion.toolType,
        contextEpoch,
        input,
      };
      return;
    }
    if (motion.action === ACTION_CANCEL) {
      // An aborted gesture has no up of its own. Left in place, its start point
      // waits to pair with the next orphan up and be measured as a tap.
      penDown = null;
      return;
    }
    if (motion.action !== ACTION_UP) {return;}
    if (typeof motion.x !== 'number' || typeof motion.y !== 'number') {
      penDown = null;
      return;
    }
    if (!penDown) {
      return penLog(`motion up at ${motion.x},${motion.y} with no matching down`);
    }
    const down = penDown;
    penDown = null;

    const tool = motion.toolType === TOOL_FINGER ? 'finger' : 'stylus';
    const tapAt = Date.now();
    const duration = motion.eventTime - down.t;
    const moved = Math.sqrt((motion.x - down.x) ** 2 + (motion.y - down.y) ** 2);
    penLog(
      `${tool} up at ${motion.x},${motion.y} after ${duration}ms, moved ${Math.round(moved)}px`,
    );
    if (duration > TAP_MAX_DURATION_MS || moved > TAP_MAX_MOVEMENT_PX) {
      // Distance, not duration: a long press that stayed put moved nothing.
      if (moved > TAP_MAX_MOVEMENT_PX) {noteMayHaveMoved(down);}
      return penLog('not a tap');
    }
    if (uiSuppressed()) {return penLog('plugin UI suppressed navigation');}
    if (!running) {return penLog('plugin stopped, ignoring tap');}
    if (recentlyOpened()) {return penLog('already opened for this tap');}
    ownsTap = claimTap();
    if (!ownsTap) {return penLog('PEN_UP owns this tap');}

    const ctx = await currentContext();
    if (!ctx) {
      releaseTap(ownsTap);
      return penLog('no note context');
    }
    if (contextPathKind(ctx.notePath) !== 'note') {
      releaseTap(ownsTap);
      return penLog('document context, preserving note links');
    }
    const key = contextKey(ctx);
    if (contextKey(activeNoteContext) !== key || down.contextEpoch !== contextEpoch) {
      releaseTap(ownsTap);
      scheduleRefresh(true);
      return penLog('context changed before tap resolution');
    }
    const scale = await scaleFor(ctx);
    const x = motion.x / (scale.x || 1);
    const y = motion.y / (scale.y || 1);
    const {match, waitedForDirty} = await resolveLinkFast(ctx, x, y);
    if (!match) {
      releaseTap(ownsTap);
      console.log(`[folder-link] ${tool} tap at ${x},${y} matched no link`);
      return;
    }

    const reason = preNavCheck(key, down.contextEpoch, down.input);
    if (reason === 'context') {
      releaseTap(ownsTap);
      return penLog('context moved on before opening');
    }
    if (reason === 'suppressed') {
      releaseTap(ownsTap);
      return penLog('plugin UI suppressed navigation');
    }

    // Everything from here to navigate() is synchronous, deliberately. The age
    // has to be measured after the last round trip or it does not account for
    // it, and recentlyOpened() only excludes the other path if nothing awaits
    // between the check and navigate() setting lastOpenAt.
    const age = Date.now() - tapAt;
    const maxAge = tapAgeLimit(waitedForDirty);
    if (age > maxAge) {
      releaseTap(ownsTap);
      return penLog(`tap resolved ${age}ms late, too stale to act on`);
    }
    if (recentlyOpened()) {
      releaseTap(ownsTap);
      return penLog('another path already opened this tap');
    }

    console.log(
      `[folder-link] ${tool} tap resolved in ${age}ms${
        waitedForDirty ? ' after geometry refresh' : ''
      }`,
    );
    await navigate(match, `${tool}-tap`);
  } catch (err) {
    // A claim held past a thrown handler locks the other path out for the rest
    // of the window while nothing navigates.
    if (ownsTap) {releaseTap(ownsTap);}
    console.log('[folder-link] motion handler error:', err?.message ?? String(err));
  }
};

// On affected Manta firmware the SDK monitor can lose every finger DOWN after
// a document handoff. The native fallback has already rejected movement and
// multi-touch; feed its complete tap through the same ownership, context,
// scale, and hit-testing path as an SDK gesture.
DeviceEventEmitter.addListener('folderLinkRawFingerTap', event => {
  const pair = rawFingerTapMotionPair(event);
  if (!pair) {return;}
  onMotion(pair[0]);
  onMotion(pair[1]);
});

/**
 * Motion events fire for every pen sample, so the listener is only registered
 * while the open page actually has a folder link to hit-test against — writing
 * on an ordinary page costs nothing.
 */
const ensureMotionListener = (wanted, renew = false) => {
  // Start before the document excursion so the fallback retains absolute axes
  // the touchscreen may suppress when the next value is unchanged.
  if (wanted) {ensureFingerFallback();}
  const action = motionListenerAction(wanted, Boolean(motionSub), renew);
  if (action === 'remove') {
    // A native subscription boundary cannot carry a coherent DOWN/UP pair.
    // Leaving the old DOWN alive pairs it with an orphan UP after a later
    // registration.
    penDown = null;
    if (motionSub) {
      try {
        motionSub.remove();
      } catch (e) {
        console.log('[folder-link] motion listener remove failed:', e?.message ?? String(e));
      }
      motionSub = null;
      console.log('[folder-link] motion listener off');
    }
    return true;
  }
  if (action === 'renew') {
    penDown = null;
    try {
      NativeModules.NativePluginAPI.registerEventListener(
        motionSub?.id ?? 0,
        EventType.MOTION_EVENT,
        0,
      );
      console.log('[folder-link] motion listener refreshed');
      return true;
    } catch (e) {
      console.log('[folder-link] refreshMotionListener failed:', e?.message ?? String(e));
      return false;
    }
  }
  if (action === 'register') {
    penDown = null;
    try {
      motionSub = PluginManager.registerMotionListener(0, {onMsg: onMotion});
      console.log('[folder-link] motion listener on');
      return true;
    } catch (e) {
      console.log('[folder-link] registerMotionListener failed:', e?.message ?? String(e));
      return false;
    }
  }
  return true;
};

PluginManager.registerEventListener(EventType.PEN_UP, 0, {
  onMsg: async (data) => {
    // The SDK runs transformElements over PEN_UP payloads exactly as it does
    // over getElements results, so these elements hold native cache entries
    // too and have to be handed back. Writing produces one of these per
    // stroke, so skipping them fills the very cache readFolderLinks is careful
    // to drain, and getElements starts failing with error 206.
    const list = Array.isArray(data) ? data : [];
    let ownsTap = 0;
    try {
      // Stamped before the first await: everything below it — the stroke size
      // probe, the context reads, erasing the dot — is a round trip, and their
      // total is what let a touch be acted on long after the user had moved on.
      const tapAt = Date.now();
      const tapEpoch = contextEpoch;
      const tapInput = inputSeq;
      penLog(
        `event with ${list.length} element(s): ${list
          .map((e) => `#${e?.numInPage}/type=${e?.type}/pt=${JSON.stringify(extractTapPoint(e))}`)
          .join(' ')}`,
      );
      const el = list.find((e) => e && extractTapPoint(e));
      if (!el) {return penLog('no element with a tap point, ignoring');}
      if (el.uuid && handledUuids.has(el.uuid)) {return penLog(`duplicate uuid ${el.uuid}`);}
      rememberHandled(el.uuid);

      if (!(await isTapStroke(el))) {return penLog('stroke too long to be a tap');}
      const tap = extractTapPoint(el);

      // Claimed only now: before isTapStroke this could still be handwriting,
      // and claiming every stroke would lock out real taps for a second.
      // Losing the claim does not end this handler — the tap dot is this path's
      // to erase whether or not it is the one that navigates, and the motion
      // path may yet give up without opening anything.
      ownsTap = claimTap();
      // Only ever release a claim this handler actually took.
      const giveUp = (msg) => {
        if (ownsTap) {releaseTap(ownsTap);}
        return penLog(msg);
      };

      // Suppression is deliberately not checked here, cheap though it is. The
      // window outlives the picker by a grace period, and a pen tap arriving
      // inside it landed on the note, not on plugin UI — bailing before the
      // erase below would leave its ink dot behind. The epoch check stops the
      // navigation instead, once the dot is gone.
      const ctx = await currentContext();
      if (!ctx) {return giveUp('no note context');}
      if (contextPathKind(ctx.notePath) !== 'note') {
        return giveUp('document context, preserving note links');
      }
      const key = contextKey(ctx);
      if (contextKey(activeNoteContext) !== key || contextEpoch !== tapEpoch) {
        scheduleRefresh(true);
        return giveUp('context changed before tap resolution');
      }

      // A clean cached miss never reads the page. Only a linked drag marks the
      // snapshot dirty, and that path joins its already-running shared scan.
      const known = cachedLinksFor(ctx.notePath, ctx.page);
      penLog(
        `tap at ${tap.x},${tap.y} on page ${ctx.page}; cached links: ${
          known ? JSON.stringify(known.map((l) => [l.left, l.top, l.right, l.bottom])) : 'none'
        }`,
      );
      const {match, waitedForDirty} = await resolveLinkFast(ctx, tap.x, tap.y);
      if (!match) {return giveUp('no link at tap');}

      // Erase the tap dot before navigating; once the file manager is in the
      // foreground the note app may not apply the edit. This happens even when
      // the motion path already opened the folder — the dot still needs to go.
      if (typeof el.numInPage === 'number') {
        try {
          await PluginFileAPI.deleteElements(ctx.notePath, ctx.page, [el.numInPage]);
        } catch (e) {
          console.log('[folder-link] deleteElements error:', e?.message ?? String(e));
        }
      }

      const reason = preNavCheck(key, tapEpoch, tapInput);
      if (reason === 'context') {
        return giveUp('context moved on before opening; dot erased only');
      }
      if (reason === 'suppressed') {
        return giveUp('plugin UI suppressed navigation; dot erased only');
      }

      // Synchronous from here to navigate(): recentlyOpened() only excludes the
      // other path while nothing awaits before lastOpenAt is set.
      //
      // Matching context is not enough on its own: leaving the note and coming
      // back lands on the same note and page, so a touch from before the
      // excursion would pass that check and navigate straight back out again.
      const age = Date.now() - tapAt;
      const maxAge = tapAgeLimit(waitedForDirty);
      if (age > maxAge) {
        return giveUp(`tap resolved ${age}ms late, too stale to act on; dot erased only`);
      }
      // Not owning the tap is not a reason to stop: the owner may have given up
      // on a context check without navigating, and this path has a real match in
      // hand. Only an open that actually happened rules this one out.
      if (recentlyOpened()) {return giveUp('another path already opened this tap; dot erased only');}

      console.log(
        `[folder-link] pen_up tap resolved in ${age}ms${
          waitedForDirty ? ' after geometry refresh' : ''
        }`,
      );
      await navigate(match, 'pen_up');
    } catch (e) {
      if (ownsTap) {releaseTap(ownsTap);}
      console.log('[folder-link] PEN_UP handler error:', e?.message ?? String(e));
    } finally {
      // Every field this handler needs is a plain value by now. Recycling last
      // covers the early returns too: each one leaves elements behind, and
      // they are the common case.
      recycleElements(list);
    }
  },
});
