/** Compatibility helpers for the plugin runtime. */

/**
 * Runs lightweight context probes independently of expensive page handlers.
 *
 * The old scheduler chained whole refresh passes. Since a pass includes
 * getElements, a three-second page read also postponed learning that the user
 * had opened a PDF or returned to another note. Here each tick probes context
 * immediately. A newer completed probe supersedes an older result, while page
 * work already started is allowed to finish and uses its own context/generation
 * guards before publishing.
 */
export const createRefreshScheduler = ({
  readContext,
  handleContext,
  onError,
  maxConcurrentProbes = 2,
}) => {
  let requestSeq = 0;
  let latestApplied = 0;
  let cancelGeneration = 0;
  let activeProbes = 0;
  let queued = null;

  const report = (task, relevant = () => true) =>
    task.catch(error => {
      if (!relevant()) {return undefined;}
      if (typeof onError === 'function') {return onError(error);}
      throw error;
    });

  const drain = () => {
    if (!queued || activeProbes >= maxConcurrentProbes) {return;}
    const pending = queued;
    queued = null;
    const task = start(pending.force);
    task.then(
      value => pending.waiters.forEach(({resolve}) => resolve(value)),
      error => pending.waiters.forEach(({reject}) => reject(error)),
    );
  };

  const start = force => {
    const request = ++requestSeq;
    const generation = cancelGeneration;
    activeProbes++;
    return report((async () => {
      let context;
      try {
        context = await readContext();
      } finally {
        // Page handling is intentionally outside the probe slot: a slow scan
        // must not keep a later context request from starting.
        activeProbes--;
        drain();
      }
      if (generation !== cancelGeneration || request < latestApplied) {return;}
      latestApplied = request;
      return handleContext(context, {
        force: Boolean(force),
        request,
        cancelled: () => generation !== cancelGeneration,
      });
    })(), () => generation === cancelGeneration && request >= latestApplied);
  };

  const schedule = force => {
    if (activeProbes < maxConcurrentProbes) {return start(force);}
    return new Promise((resolve, reject) => {
      if (!queued) {queued = {force: Boolean(force), waiters: []};}
      queued.force = queued.force || Boolean(force);
      queued.waiters.push({resolve, reject});
    });
  };

  const cancel = () => {
    cancelGeneration++;
    latestApplied = ++requestSeq;
    if (queued) {
      queued.waiters.forEach(({resolve}) => resolve(undefined));
      queued = null;
    }
  };

  return {schedule, cancel};
};

/**
 * Whether a completed drag could have moved a cached linked object.
 *
 * Motion coordinates are screen pixels while link rectangles are page
 * coordinates. Restricting refreshes to gestures that begin on a link avoids
 * treating every handwritten stroke on a linked page as a geometry change.
 */
export const shouldRefreshAfterLinkedDrag = (
  links,
  screenX,
  screenY,
  scale,
  pad = 20,
) => {
  if (
    !Array.isArray(links) ||
    !scale ||
    !Number.isFinite(scale.x) ||
    !Number.isFinite(scale.y) ||
    scale.x <= 0 ||
    scale.y <= 0
  ) {return false;}
  const x = screenX / scale.x;
  const y = screenY / scale.y;
  return links.some(
    link =>
      x >= link.left - pad &&
      x <= link.right + pad &&
      y >= link.top - pad &&
      y <= link.bottom + pad,
  );
};

/** Whether a page snapshot changed any link rectangle or destination. */
export const linkGeometryChanged = (before, after) => {
  if (!Array.isArray(before) || !Array.isArray(after)) {return true;}
  if (before.length !== after.length) {return true;}
  const signature = link => [
    link?.folderPath ?? '',
    link?.left,
    link?.top,
    link?.right,
    link?.bottom,
  ].join('|');
  const oldSignatures = before.map(signature).sort();
  const newSignatures = after.map(signature).sort();
  return oldSignatures.some((value, index) => value !== newSignatures[index]);
};

// A drag snapshot is publication-safe only after its link rectangles have
// actually changed. Background scans may observe the same pre-move rectangle
// repeatedly for as long as the lasso selection remains active.
export const shouldPublishLinkSnapshot = ({dragScan, snapshotStable}) =>
  !dragScan || snapshotStable;

/**
 * Reads link geometry only after the note app has had time to commit a lasso
 * move, retrying snapshots that temporarily omit a previously known link.
 *
 * The final attempt deliberately relaxes the minimum. That bounds the dirty
 * state when a real unlink happens concurrently, instead of retrying forever.
 * `read` receives the minimum it must preserve while publishing its result.
 */
export const readStableLinkSnapshot = async ({
  wait,
  read,
  minimumCount,
  maxAttempts,
  accept = () => true,
}) => {
  const attempts = Math.max(1, Math.floor(maxAttempts));
  let links = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    await wait();
    const required = attempt === attempts - 1 ? 0 : minimumCount;
    links = await read(required);
    const stable = accept(links);
    if (links.length >= minimumCount && stable) {return {links, stable: true};}
    if (required === 0) {
      // A lower final count is an authoritative concurrent unlink. An equal
      // count with unchanged rectangles is the still-selected drag case.
      return {links, stable: stable || links.length < minimumCount};
    }
  }
  return {links, stable: false};
};

/**
 * Native note loading trails the SDK's current-file update. Hardware traces on
 * a Manta showed provisional 0-element pages at 531ms and 1026ms after a note
 * handoff, with the note load finishing at 1525ms. Calling getElements in that
 * window can do worse than return a provisional page: one linked test note
 * aborts the native note process with std::out_of_range. Keep a measured safety
 * margin and confirm that the same note/page is still current before reading.
 */
export const NOTE_HANDOFF_SETTLE_MS = 2000;

export const waitForStableNoteContext = async ({
  wait,
  readContext,
  expectedKey,
  keyOf,
  observedAt,
  now = Date.now,
}) => {
  const elapsed = Math.max(0, now() - observedAt);
  const remaining = Math.max(0, NOTE_HANDOFF_SETTLE_MS - elapsed);
  if (remaining > 0) {await wait(remaining);}
  const confirmed = await readContext();
  return keyOf(confirmed) === expectedKey ? confirmed : null;
};

/**
 * Maximum end-to-end age for a tap before navigation is abandoned.
 *
 * A clean cached hit can still queue behind one native getElements request;
 * 957ms was measured on a 125-element Manta page. Two seconds admits that one
 * device round trip while still rejecting the older multi-second replays that
 * originally motivated the guard. A tap known to overlap a page scan keeps the
 * same two-second margin beyond that page's observed scan time; context and
 * input-epoch checks still reject a tap if the user moves on while it waits.
 */
export const tapAgeLimit = (waitedForPageScan, observedScanMs = 0) => {
  if (!waitedForPageScan) {return 2000;}
  const scanMs = Number.isFinite(observedScanMs) && observedScanMs > 0
    ? Math.ceil(observedScanMs)
    : 0;
  return Math.max(4000, scanMs + 2000);
};

/**
 * Races an SDK request against a deadline supplied by the native module.
 *
 * The deadline is passed in rather than created here so this remains a pure,
 * testable helper and the caller can use an Android Handler while React Native
 * has paused its JavaScript timers.
 */
export const raceWithDeadline = (operation, deadline, milliseconds, label) =>
  Promise.race([
    operation,
    deadline.then(() => {
      throw new Error(`${label} timed out after ${milliseconds}ms`);
    }),
  ]);

/**
 * The SDK exposes one current-file API for notes, PDFs, and EPUBs. Folder links
 * belong only to native `.note` files, so a document path is an excursion from
 * the last note rather than an empty replacement note.
 */
export const contextPathKind = path => {
  if (typeof path !== 'string' || !path) {return 'missing';}
  return /\.note$/i.test(path) ? 'note' : 'document';
};

/**
 * SDK 0.1.65 supplies the active pointer in `pointers`; older payloads placed
 * the same values at the top level. Accept both so a firmware-side rollout
 * cannot silently disable finger and stylus taps.
 */
export const normalizeMotionEvent = event => {
  const pointers = Array.isArray(event?.pointers) ? event.pointers : [];
  const pointer = pointers[event?.actionIndex ?? 0] ?? pointers[0] ?? null;
  return {
    action:
      // Android action values may include the pointer index in the high bits.
      // eslint-disable-next-line no-bitwise
      typeof event?.action === 'number' ? event.action & 0xff : undefined,
    eventTime:
      typeof event?.eventTime === 'number' ? event.eventTime : Date.now(),
    pointerCount:
      typeof event?.pointerCount === 'number'
        ? event.pointerCount
        : pointers.length,
    toolType:
      typeof event?.toolType === 'number'
        ? event.toolType
        : pointer?.toolType,
    x: typeof event?.x === 'number' ? event.x : pointer?.x,
    y: typeof event?.y === 'number' ? event.y : pointer?.y,
  };
};

/**
 * Adapts the native raw-touch fallback into the same complete gesture shape as
 * the SDK motion listener. The fallback has already rejected drags and
 * multi-touch, so its one tap needs only a coherent DOWN/UP boundary.
 */
export const rawFingerTapMotionPair = (event, eventTime = Date.now()) => {
  if (typeof event?.x !== 'number' || typeof event?.y !== 'number') {return null;}
  const durationMs = Number.isFinite(event?.durationMs) && event.durationMs >= 0
    ? Math.min(event.durationMs, 60_000)
    : 1;
  const common = {
    pointerCount: 1,
    toolType: 1,
    x: event.x,
    y: event.y,
  };
  return [
    {action: 0, eventTime: eventTime - durationMs, ...common},
    {action: 1, eventTime, ...common},
  ];
};

/**
 * SDK 0.1.65 lifecycle states. `stop` means the plugin view went into the
 * background; that is the normal state while the user is tapping a note, so it
 * must not tear down note listeners. Only unmount/destroy end the runtime.
 */
export const pluginLifecycleAction = state => {
  if (state === 2) {return 'start';}
  if (state === 3) {return 'background';}
  if (state === 4 || state === 5) {return 'stop';}
  return null;
};

/**
 * Chooses how the SDK motion subscription should change for the current page.
 *
 * The JavaScript subscription survives NOTE/DOC client handoffs, but the
 * native registration behind it belongs to the old client. Refresh that same
 * listener ID after a document return: replacing the ID makes Manta deliver an
 * orphan first finger UP, while crossing a zero-listener boundary can leave the
 * replacement receiving UP without DOWN as well.
 */
export const motionListenerAction = (wanted, registered, renew = false) => {
  if (!wanted) {return registered ? 'remove' : 'keep';}
  if (!registered) {return 'register';}
  if (renew) {return 'renew';}
  return 'keep';
};

/**
 * A PDF/EPUB return can happen before the regular page cache is stale. In that
 * case the cached links and the retained motion subscription are both still
 * authoritative, so no element read is needed.
 */
export const shouldReuseRetainedDocumentLinks = (
  returningFromDocument,
  currentKey,
  measuredKey,
  retainedLinkCount,
) =>
  Boolean(
    returningFromDocument &&
      currentKey &&
      currentKey === measuredKey &&
      retainedLinkCount > 0,
  );

/** The SDK can publish a new note path before getElements changes pages. */
export const noteContextChanged = (currentKey, measuredKey) =>
  Boolean(currentKey && currentKey !== measuredKey);

/**
 * One empty result immediately after a note handoff is provisional. A second
 * empty read is accepted so a genuinely unlinked note still sheds the
 * speculative listener instead of polling and listening forever.
 */
export const shouldRetryEmptyTransition = (
  settlingKey,
  currentKey,
  linkCount,
  retriesRemaining,
) =>
  settlingKey === currentKey && linkCount === 0 && retriesRemaining > 0;

/**
 * PEN_UP elements can contain a raw numeric count, while elements returned by
 * PluginFileAPI expose an async accessor. Unknown counts are not taps: treating
 * them as taps lets a lasso or handwritten stroke open a folder.
 */
export const strokePointCountIsTap = async (points, maxPoints) => {
  let count;
  if (typeof points === 'number') {
    count = points;
  } else if (points && typeof points.size === 'function') {
    count = await points.size();
  } else {
    return false;
  }
  return typeof count === 'number' && count > 0 && count <= maxPoints;
};
