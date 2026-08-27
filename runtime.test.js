import {
  createRefreshScheduler,
  contextPathKind,
  linkGeometryChanged,
  noteContextChanged,
  NOTE_HANDOFF_SETTLE_MS,
  motionListenerAction,
  normalizeMotionEvent,
  rawFingerTapMotionPair,
  pluginLifecycleAction,
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

describe('refresh scheduling', () => {
  test('probes context again while an earlier page handler is still busy', async () => {
    let releaseFirst;
    const firstHandler = new Promise(resolve => {
      releaseFirst = resolve;
    });
    const readContext = jest
      .fn()
      .mockResolvedValueOnce({notePath: 'one.note', page: 0})
      .mockResolvedValueOnce({notePath: 'two.note', page: 0});
    const handleContext = jest
      .fn()
      .mockReturnValueOnce(firstHandler)
      .mockResolvedValueOnce(undefined);
    const scheduler = createRefreshScheduler({readContext, handleContext});

    const first = scheduler.schedule(false);
    await Promise.resolve();
    const second = scheduler.schedule(false);
    await second;

    expect(readContext).toHaveBeenCalledTimes(2);
    expect(handleContext).toHaveBeenCalledTimes(2);
    releaseFirst();
    await first;
  });

  test('does not apply an older context result after a newer one', async () => {
    let releaseOld;
    const oldContext = new Promise(resolve => {
      releaseOld = resolve;
    });
    const readContext = jest
      .fn()
      .mockReturnValueOnce(oldContext)
      .mockResolvedValueOnce({notePath: 'new.note', page: 0});
    const handleContext = jest.fn().mockResolvedValue(undefined);
    const scheduler = createRefreshScheduler({readContext, handleContext});

    const oldPass = scheduler.schedule(false);
    await scheduler.schedule(false);
    releaseOld({notePath: 'old.note', page: 0});
    await oldPass;

    expect(handleContext).toHaveBeenCalledTimes(1);
    expect(handleContext.mock.calls[0][0]).toEqual({notePath: 'new.note', page: 0});
  });

  test('does not report an older probe failure after a newer probe succeeds', async () => {
    let rejectOld;
    const oldContext = new Promise((resolve, reject) => {
      rejectOld = reject;
    });
    const readContext = jest
      .fn()
      .mockReturnValueOnce(oldContext)
      .mockResolvedValueOnce({notePath: 'new.note', page: 0});
    const handleContext = jest.fn().mockResolvedValue(undefined);
    const onError = jest.fn();
    const scheduler = createRefreshScheduler({readContext, handleContext, onError});

    const oldPass = scheduler.schedule(false);
    await scheduler.schedule(false);
    rejectOld(new Error('old timeout'));
    await oldPass;

    expect(onError).not.toHaveBeenCalled();
  });

  test('bounds stranded context probes and coalesces excess ticks', async () => {
    let releaseFirst;
    let releaseSecond;
    const readContext = jest
      .fn()
      .mockReturnValueOnce(new Promise(resolve => {releaseFirst = resolve;}))
      .mockReturnValueOnce(new Promise(resolve => {releaseSecond = resolve;}))
      .mockResolvedValue({notePath: 'latest.note', page: 0});
    const handleContext = jest.fn().mockResolvedValue(undefined);
    const scheduler = createRefreshScheduler({readContext, handleContext});

    const passes = Array.from({length: 5}, () => scheduler.schedule(false));
    await Promise.resolve();
    expect(readContext).toHaveBeenCalledTimes(2);

    releaseFirst({notePath: 'old.note', page: 0});
    await Promise.resolve();
    await Promise.resolve();
    expect(readContext).toHaveBeenCalledTimes(3);

    releaseSecond({notePath: 'older.note', page: 0});
    await Promise.all(passes);
  });

  test('refreshes geometry only when a drag starts on a cached link', () => {
    const links = [{left: 100, top: 200, right: 300, bottom: 400}];

    expect(
      shouldRefreshAfterLinkedDrag(links, 400, 600, {x: 2, y: 2}),
    ).toBe(true);
    expect(
      shouldRefreshAfterLinkedDrag(links, 900, 600, {x: 2, y: 2}),
    ).toBe(false);
    expect(shouldRefreshAfterLinkedDrag(links, 400, 600, null)).toBe(false);
  });

  test('waits for a lasso move to settle and retries a short link snapshot', async () => {
    const wait = jest.fn().mockResolvedValue(true);
    const read = jest
      .fn()
      .mockResolvedValueOnce(['one', 'two', 'three'])
      .mockResolvedValueOnce(['one', 'two', 'three', 'four']);

    await expect(
      readStableLinkSnapshot({wait, read, minimumCount: 4, maxAttempts: 3}),
    ).resolves.toEqual({
      links: ['one', 'two', 'three', 'four'],
      stable: true,
    });

    expect(wait).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.map(call => call[0])).toEqual([4, 4]);
  });

  test('eventually accepts a real link removal instead of retrying forever', async () => {
    const wait = jest.fn().mockResolvedValue(true);
    const read = jest.fn().mockResolvedValue(['one', 'two', 'three']);

    await expect(
      readStableLinkSnapshot({wait, read, minimumCount: 4, maxAttempts: 3}),
    ).resolves.toEqual({links: ['one', 'two', 'three'], stable: true});

    expect(wait).toHaveBeenCalledTimes(3);
    // The last attempt relaxes the guard and publishes the authoritative lower
    // count, so a concurrent real unlink cannot leave the page dirty forever.
    expect(read.mock.calls.map(call => call[0])).toEqual([4, 4, 0]);
  });

  test('keeps a moved link dirty while the selected object still reports old geometry', async () => {
    const unchanged = [{folderPath: '/folder', left: 10, top: 20, right: 30, bottom: 40}];
    const wait = jest.fn().mockResolvedValue(true);
    const read = jest.fn().mockResolvedValue(unchanged);

    await expect(
      readStableLinkSnapshot({
        wait,
        read,
        minimumCount: 1,
        maxAttempts: 3,
        accept: links => linkGeometryChanged(unchanged, links),
      }),
    ).resolves.toEqual({links: unchanged, stable: false});

    expect(wait).toHaveBeenCalledTimes(3);
    expect(
      linkGeometryChanged(unchanged, [
        {...unchanged[0], top: 510, bottom: 530},
      ]),
    ).toBe(true);
    expect(linkGeometryChanged(unchanged, unchanged)).toBe(false);
  });

  test('does not publish unchanged drag geometry on a later background scan', () => {
    expect(shouldPublishLinkSnapshot({dragScan: true, snapshotStable: false})).toBe(false);
    expect(shouldPublishLinkSnapshot({dragScan: true, snapshotStable: false})).toBe(false);
    expect(shouldPublishLinkSnapshot({dragScan: true, snapshotStable: true})).toBe(true);
    expect(shouldPublishLinkSnapshot({dragScan: false, snapshotStable: false})).toBe(true);
  });
});

describe('paused-runtime request deadline', () => {
  test('rejects a stranded host request when the native deadline fires', async () => {
    const stranded = new Promise(() => {});

    await expect(
      raceWithDeadline(stranded, Promise.resolve(true), 2000, 'current context'),
    ).rejects.toThrow('current context timed out after 2000ms');
  });

  test('returns an SDK result that beats the deadline', async () => {
    const never = new Promise(() => {});

    await expect(
      raceWithDeadline(Promise.resolve('note'), never, 2000, 'current context'),
    ).resolves.toBe('note');
  });
});

describe('note handoff readiness', () => {
  test('waits out the measured native load window before confirming context', async () => {
    const order = [];
    const wait = jest.fn(async milliseconds => {
      order.push(`wait:${milliseconds}`);
    });
    const readContext = jest.fn(async () => {
      order.push('context');
      return {notePath: 'linked.note', page: 2};
    });

    await expect(
      waitForStableNoteContext({
        wait,
        readContext,
        expectedKey: 'linked.note#2',
        keyOf: ctx => ctx ? `${ctx.notePath}#${ctx.page}` : '',
        observedAt: 1000,
        now: () => 1000,
      }),
    ).resolves.toEqual({notePath: 'linked.note', page: 2});

    expect(NOTE_HANDOFF_SETTLE_MS).toBe(2000);
    expect(wait).toHaveBeenCalledWith(2000);
    expect(order).toEqual(['wait:2000', 'context']);
  });

  test('rejects a handoff when the confirmed note changed during the wait', async () => {
    const wait = jest.fn().mockResolvedValue(undefined);
    const readContext = jest.fn().mockResolvedValue({notePath: 'other.note', page: 0});

    await expect(
      waitForStableNoteContext({
        wait,
        readContext,
        expectedKey: 'linked.note#2',
        keyOf: ctx => ctx ? `${ctx.notePath}#${ctx.page}` : '',
        observedAt: 1000,
        now: () => 2500,
      }),
    ).resolves.toBeNull();

    expect(wait).toHaveBeenCalledWith(500);
  });
});

describe('tap freshness', () => {
  test('turns a native raw-finger tap into one coherent SDK-shaped gesture', () => {
    expect(rawFingerTapMotionPair({x: 1100, y: 1040}, 5000)).toEqual([
      {
        action: 0,
        eventTime: 4999,
        pointerCount: 1,
        toolType: 1,
        x: 1100,
        y: 1040,
      },
      {
        action: 1,
        eventTime: 5000,
        pointerCount: 1,
        toolType: 1,
        x: 1100,
        y: 1040,
      },
    ]);
    expect(rawFingerTapMotionPair({x: 1100}, 5000)).toBeNull();
    expect(
      rawFingerTapMotionPair({x: 1100, y: 1040, durationMs: 450}, 5000),
    ).toEqual([
      expect.objectContaining({action: 0, eventTime: 4550}),
      expect.objectContaining({action: 1, eventTime: 5000}),
    ]);
  });

  test('accepts a cached hit delayed behind one device page read', () => {
    // Measured on the Manta: a valid hit queued behind getElements resolved in
    // 957ms and the old 800ms cutoff discarded it.
    expect(tapAgeLimit(false)).toBeGreaterThanOrEqual(957);
    expect(tapAgeLimit(false)).toBeLessThan(2500);
  });

  test('allows the longer shared refresh only for known dirty geometry', () => {
    expect(tapAgeLimit(true)).toBeGreaterThan(tapAgeLimit(false));
  });
});

describe('sn-plugin-lib 0.1.65 compatibility', () => {
  test('normalizes pointer-only motion payloads', () => {
    expect(
      normalizeMotionEvent({
        action: 1,
        actionIndex: 0,
        eventTime: 120,
        pointers: [{x: 348, y: 2335, toolType: 1}],
      }),
    ).toMatchObject({
      action: 1,
      eventTime: 120,
      pointerCount: 1,
      toolType: 1,
      x: 348,
      y: 2335,
    });
  });

  test('maps the current SDK lifecycle state numbers', () => {
    expect(pluginLifecycleAction(1)).toBeNull();
    expect(pluginLifecycleAction(2)).toBe('start');
    expect(pluginLifecycleAction(3)).toBe('background');
    expect(pluginLifecycleAction(4)).toBe('stop');
    expect(pluginLifecycleAction(5)).toBe('stop');
  });

  test('accepts only tap-sized raw PEN_UP point counts', async () => {
    await expect(strokePointCountIsTap(4, 10)).resolves.toBe(true);
    await expect(strokePointCountIsTap(40, 10)).resolves.toBe(false);
  });

  test('retains support for transformed point accessors', async () => {
    await expect(
      strokePointCountIsTap({size: async () => 5}, 10),
    ).resolves.toBe(true);
    await expect(
      strokePointCountIsTap({size: async () => 50}, 10),
    ).resolves.toBe(false);
  });

  test('rejects missing and unmaterialized point counts', async () => {
    await expect(strokePointCountIsTap(undefined, 10)).resolves.toBe(false);
    await expect(strokePointCountIsTap(-1, 10)).resolves.toBe(false);
  });

  test('distinguishes note contexts from document excursions', () => {
    expect(contextPathKind('/storage/emulated/0/Note/test.note')).toBe('note');
    expect(contextPathKind('/storage/emulated/0/Document/book.epub')).toBe(
      'document',
    );
    expect(contextPathKind('/storage/emulated/0/Document/manual.PDF')).toBe(
      'document',
    );
    expect(contextPathKind(undefined)).toBe('missing');
  });

  test('renews a stale native motion listener after a document excursion', () => {
    expect(motionListenerAction(true, true, true)).toBe('renew');
    expect(motionListenerAction(true, true, false)).toBe('keep');
    expect(motionListenerAction(true, false, false)).toBe('register');
    expect(motionListenerAction(false, true, false)).toBe('remove');
  });

  test('reuses retained links immediately on a same-note document return', () => {
    const key = '/storage/emulated/0/Note/test.note#0';

    expect(shouldReuseRetainedDocumentLinks(true, key, key, 4)).toBe(true);
    expect(shouldReuseRetainedDocumentLinks(false, key, key, 4)).toBe(false);
    expect(shouldReuseRetainedDocumentLinks(true, key, key, 0)).toBe(false);
  });

  test('recognizes a note or page handoff before trusting its elements', () => {
    expect(noteContextChanged('new.note#0', 'old.note#0')).toBe(true);
    expect(noteContextChanged('same.note#0', 'same.note#0')).toBe(false);
  });

  test('retries a provisional empty transition but eventually accepts no links', () => {
    const key = '/storage/emulated/0/Note/unlinked.note#0';

    expect(shouldRetryEmptyTransition(key, key, 0, 1)).toBe(true);
    expect(shouldRetryEmptyTransition(key, key, 0, 0)).toBe(false);
    expect(shouldRetryEmptyTransition(key, key, 2, 1)).toBe(false);
    expect(shouldRetryEmptyTransition('other.note#0', key, 0, 1)).toBe(false);
  });
});
