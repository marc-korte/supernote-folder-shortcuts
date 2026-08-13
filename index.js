/**
 * @format
 */

import {AppRegistry, DeviceEventEmitter, Image, NativeModules} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

import {PluginManager, PluginCommAPI, PluginFileAPI, EventType} from 'sn-plugin-lib';
import {readFolderLinks, cachedLinksFor, invalidateCache, linkAt} from './links';

// Bumped by hand whenever a build is handed to a device. The plugin host can be
// running either an installed package or a hot-reloaded debug bundle, and the
// two are indistinguishable in the log without this — which has repeatedly made
// it unclear whether a fix was actually under test.
const BUILD_ID = '0.2.0';

AppRegistry.registerComponent(appName, () => App);

console.log(`[folder-link] build ${BUILD_ID} starting`);

PluginManager.init();

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

const unwrap = (res) => (res && typeof res === 'object' && 'result' in res ? res.result : res);

const currentContext = async () => {
  const [pageRes, pathRes] = await Promise.all([
    PluginCommAPI.getCurrentPageNum(),
    PluginCommAPI.getCurrentFilePath(),
  ]);
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

const Native = NativeModules.FolderLinkNative;

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
const LINK_RECHECK_MS = 6000;

// The page the cached scale and link list were measured for.
let measuredKey = '';
let measuredAt = 0;
let loggedNoContext = false;

// A refresh spans several bridge round-trips, and it is kicked off from the
// heartbeat, the plugin view, the lifecycle callbacks and tap handling. Passes
// are chained so two of them cannot interleave, and a pass that is still
// queued when a newer one arrives collapses into it (refreshSeq). Cancelling a
// pass mid-flight is a separate, rarer thing (cancelSeq): ticks arrive every
// 1.5s while a busy page can take longer than that to read, so cancelling on
// every schedule would drop every pass before its results landed and the
// motion listener would never arm. Only standDown cancels — a pass that
// outlives a stop must not re-arm the listener behind it.
let refreshSeq = 0;
let cancelSeq = 0;
let refreshChain = Promise.resolve();

const standDown = () => {
  measuredKey = '';
  measuredAt = 0;
  // Cancel any refresh still in flight so it cannot re-arm behind us.
  cancelSeq++;
  refreshSeq++;
  ensureMotionListener(false);
};

/**
 * Keeps two things current for the open page: the screen-to-page scale used to
 * place a tap, and whether the page has any folder link worth listening for.
 * Nothing is installed on screen, so a refresh that arrives late is only ever
 * out of date, never wrong — the tap itself is checked against a fresh read.
 */
const runRefresh = async (force, cancel) => {
  try {
    const ctx = await currentContext();
    if (cancel !== cancelSeq) {return;}
    if (!ctx) {
      // Logged once per run of no-context passes: silence here is
      // indistinguishable from the refresh never being driven at all, which has
      // already sent one diagnosis down the wrong path.
      if (!loggedNoContext) {
        loggedNoContext = true;
        console.log('[folder-link] refresh: no note context');
      }
      ensureMotionListener(false);
      measuredKey = '';
      return;
    }
    loggedNoContext = false;
    const key = `${ctx.notePath}#${ctx.page}`;
    const stale = Date.now() - measuredAt > LINK_RECHECK_MS;
    if (!force && key === measuredKey && !stale) {return;}

    const links = await readFolderLinks(ctx.notePath, ctx.page);
    if (cancel !== cancelSeq) {return;}
    const scale = await scaleProbe(ctx.notePath, ctx.page);
    if (cancel !== cancelSeq) {return;}

    measuredKey = key;
    measuredAt = Date.now();
    currentScale = scale;
    ensureMotionListener(links.length > 0);
  } catch (e) {
    measuredKey = '';
    console.log('[folder-link] refresh error:', e?.message ?? String(e));
  }
};

const scheduleRefresh = (force = false) => {
  const gen = ++refreshSeq;
  const cancel = cancelSeq;
  // A pass that was still queued when a newer one arrived has nothing to add —
  // but once a pass has started, only a cancel stops its results landing.
  const run = () => (gen === refreshSeq ? runRefresh(force, cancel) : undefined);
  refreshChain = refreshChain.then(run, run);
  return refreshChain;
};

scheduleRefresh(true);

// Force a re-read after the plugin view saves a new link, even when the
// note+page context is unchanged.
DeviceEventEmitter.addListener('folderLinkChanged', () => {
  invalidateCache();
  scheduleRefresh(true);
});

const openFolder = async (folderPath) => {
  if (Native && typeof Native.openFolder === 'function') {
    return Native.openFolder(folderPath);
  }
  throw new Error('FolderLinkNative.openFolder unavailable');
};

/**
 * Reads the page and hit-tests the point against the links actually on it.
 * Authoritative but slow; see resolveLinkFast for why that matters.
 */
const resolveLinkAt = async (ctx, x, y) => {
  let links;
  try {
    links = await readFolderLinks(ctx.notePath, ctx.page);
  } catch (e) {
    console.log('[folder-link] link re-read failed:', e?.message ?? String(e));
    return null;
  }
  return linkAt(links, x, y) ?? null;
};

/**
 * Hit-tests against the links the heartbeat last read, falling back to a read
 * only for a page never read before.
 *
 * Reading a page costs a second or more on a busy one, and that latency is not
 * merely slow — it is a correctness problem. A touch resolved seconds after the
 * fact can be applied to a screen the user has since navigated away from and
 * back to, which is precisely how a tap meant for the sidebar ended up opening
 * a folder over and over. The cached list is at most LINK_RECHECK_MS old, and a
 * tap is checked for staleness before it is allowed to navigate.
 */
const resolveLinkFast = async (ctx, x, y) => {
  const known = cachedLinksFor(ctx.notePath, ctx.page);
  if (known) {return linkAt(known, x, y) ?? null;}
  return resolveLinkAt(ctx, x, y);
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
// keep timers running; duplicate passes are harmless because refreshes are
// serialised and superseded ones drop their results.
DeviceEventEmitter.addListener('folderLinkTick', () => {
  if (running) {scheduleRefresh();}
});

setInterval(() => {
  if (running) {scheduleRefresh();}
}, 1500);

// Stop listening for taps when the plugin is stopped.
try {
  PluginManager.addPluginLifeListener({
    onStart: () => {
      console.log('[folder-link] plugin life: start');
      running = true;
      invalidateCache();
      scheduleRefresh(true);
    },
    onStop: () => {
      console.log('[folder-link] plugin life: stop');
      running = false;
      invalidateCache();
      standDown();
    },
  });
} catch (e) {
  console.log('[folder-link] addPluginLifeListener failed:', e?.message ?? String(e));
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
    const accessor = el?.stroke?.points;
    if (!accessor || typeof accessor.size !== 'function') {return true;}
    const n = await accessor.size();
    return typeof n !== 'number' || n <= TAP_MAX_POINTS;
  } catch {
    return true;
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
const TOOL_FINGER = 1;
const TOOL_STYLUS = 2;
const TAP_MAX_DURATION_MS = 300;
const TAP_MAX_MOVEMENT_PX = 25;

let motionSub = null;
let penDown = null;
let lastOpenAt = 0;
let tapClaimedAt = 0;

// Motion coordinates are screen pixels; link rects are page coordinates.
let currentScale = {x: 1, y: 1};

const recentlyOpened = () => Date.now() - lastOpenAt < 1000;

/**
 * How long after a touch its result may still be acted on.
 *
 * A touch resolved seconds late can land on a screen the user has moved on
 * from: a tap on the sidebar was once resolved two seconds later, by which time
 * the note had reopened, and it opened the folder again — every time, forever.
 */
const TAP_MAX_AGE_MS = 800;

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
  if (now - tapClaimedAt < TAP_CLAIM_MS) {return false;}
  tapClaimedAt = now;
  return true;
};

const releaseTap = () => {
  tapClaimedAt = 0;
};

const contextKey = (ctx) => (ctx ? `${ctx.notePath}#${ctx.page}` : '');

/**
 * The scale to convert this context's screen pixels into page coordinates.
 *
 * currentScale is only meaningful for the page the last refresh measured, and
 * measuredKey is cleared whenever a refresh errors or is superseded — so
 * requiring a match here would drop perfectly good taps, which is exactly what
 * it did. Measure the context at hand instead when the cached value does not
 * belong to it.
 */
const scaleFor = async (ctx) =>
  contextKey(ctx) === measuredKey ? currentScale : scaleProbe(ctx.notePath, ctx.page);

const onMotion = async (e) => {
  try {
    if (e?.toolType !== TOOL_STYLUS && e?.toolType !== TOOL_FINGER) {return;}
    if (e.action === ACTION_DOWN) {
      penDown = {x: e.x, y: e.y, t: e.eventTime ?? Date.now(), tool: e.toolType};
      return;
    }
    if (e.action !== ACTION_UP) {return;}
    if (!penDown) {return penLog(`motion up at ${e.x},${e.y} with no matching down`);}
    const down = penDown;
    penDown = null;

    const tool = e.toolType === TOOL_FINGER ? 'finger' : 'stylus';
    const tapAt = Date.now();
    const duration = (e.eventTime ?? Date.now()) - down.t;
    const moved = Math.sqrt((e.x - down.x) ** 2 + (e.y - down.y) ** 2);
    penLog(`${tool} up at ${e.x},${e.y} after ${duration}ms, moved ${Math.round(moved)}px`);
    if (duration > TAP_MAX_DURATION_MS || moved > TAP_MAX_MOVEMENT_PX) {
      return penLog('not a tap');
    }
    if (!running) {return penLog('plugin stopped, ignoring tap');}
    if (recentlyOpened()) {return penLog('already opened for this tap');}
    if (!claimTap()) {return penLog('PEN_UP owns this tap');}

    const ctx = await currentContext();
    if (!ctx) {
      releaseTap();
      return penLog('no note context');
    }
    const key = contextKey(ctx);
    const scale = await scaleFor(ctx);
    const x = e.x / (scale.x || 1);
    const y = e.y / (scale.y || 1);
    const match = await resolveLinkFast(ctx, x, y);
    if (!match) {
      releaseTap();
      console.log(`[folder-link] ${tool} tap at ${x},${y} matched no link`);
      return;
    }

    // Re-check rather than trust the reads above: the page can turn, or the
    // plugin stop, while they are in flight. Compared against the page this tap
    // was resolved on, not against whatever the last refresh measured.
    const stillHere = await currentContext();
    if (!running || contextKey(stillHere) !== key) {
      releaseTap();
      return penLog('context moved on before opening');
    }

    const age = Date.now() - tapAt;
    if (age > TAP_MAX_AGE_MS) {
      releaseTap();
      return penLog(`tap resolved ${age}ms late, too stale to act on`);
    }

    if (recentlyOpened()) {return penLog('another path already opened this tap');}
    await navigate(match, `${tool}-tap`);
  } catch (err) {
    console.log('[folder-link] motion handler error:', err?.message ?? String(err));
  }
};

/**
 * Motion events fire for every pen sample, so the listener is only registered
 * while the open page actually has a folder link to hit-test against — writing
 * on an ordinary page costs nothing.
 */
const ensureMotionListener = (wanted) => {
  if (wanted && !motionSub) {
    try {
      motionSub = PluginManager.registerMotionListener(0, {onMsg: onMotion});
      console.log('[folder-link] motion listener on');
    } catch (e) {
      console.log('[folder-link] registerMotionListener failed:', e?.message ?? String(e));
    }
  } else if (!wanted && motionSub) {
    try {
      motionSub.remove();
    } catch (e) {
      console.log('[folder-link] motion listener remove failed:', e?.message ?? String(e));
    }
    motionSub = null;
    console.log('[folder-link] motion listener off');
  }
};

PluginManager.registerEventListener(EventType.PEN_UP, 0, {
  onMsg: async (data) => {
    try {
      // Stamped before the first await: everything below it — the stroke size
      // probe, the context reads, erasing the dot — is a round trip, and their
      // total is what let a touch be acted on long after the user had moved on.
      const tapAt = Date.now();
      const list = Array.isArray(data) ? data : [];
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
      const ownsTap = claimTap();
      // Only ever release a claim this handler actually took.
      const giveUp = (msg) => {
        if (ownsTap) {releaseTap();}
        return penLog(msg);
      };

      const ctx = await currentContext();
      if (!ctx) {return giveUp('no note context');}

      // Cheap reject before the authoritative re-read: if the last read of this
      // page had no link near the tap, there is nothing to open.
      const known = cachedLinksFor(ctx.notePath, ctx.page);
      penLog(
        `tap at ${tap.x},${tap.y} on page ${ctx.page}; cached links: ${
          known ? JSON.stringify(known.map((l) => [l.left, l.top, l.right, l.bottom])) : 'none'
        }`,
      );
      if (known && !linkAt(known, tap.x, tap.y)) {return giveUp('tap outside every cached link');}

      // Cache-first, as the motion path is: a full re-read here costs seconds,
      // which would put every genuine pen tap past the staleness limit below.
      const match = await resolveLinkFast(ctx, tap.x, tap.y);
      if (!match) {return giveUp('no link at tap after re-read');}

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

      // Erasing the dot above is another await, and the reads before it were
      // more, so confirm the page is still the one this tap was resolved on
      // before navigating — the user may have turned the page or left the note.
      const stillHere = await currentContext();
      if (!running || contextKey(stillHere) !== contextKey(ctx)) {
        return giveUp('context moved on before opening; dot erased only');
      }

      // Matching context is not enough on its own: leaving the note and coming
      // back lands on the same note and page, so a touch from before the
      // excursion would pass that check and navigate straight back out again.
      const age = Date.now() - tapAt;
      if (age > TAP_MAX_AGE_MS) {
        return giveUp(`tap resolved ${age}ms late, too stale to act on; dot erased only`);
      }

      // Not owning the tap is not a reason to stop: the owner may have given up
      // on a context check without navigating, and this path has a real match in
      // hand. Only an open that actually happened rules this one out.
      if (recentlyOpened()) {return penLog('another path already opened this tap; dot erased only');}
      await navigate(match, 'pen_up');
    } catch (e) {
      console.log('[folder-link] PEN_UP handler error:', e?.message ?? String(e));
    }
  },
});
