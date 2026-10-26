/** Exercise the installed runtime through the same callbacks the host invokes. */
let harness;

const NOTE_ACTIVITY = 'com.ratta.supernote.note/com.ratta.supernote.note.view.NoteInsidePagesActivity';
const FILE_MANAGER = 'com.ratta.supernote.filemanager/.MainActivity';
const NOTE_PATH = '/storage/emulated/0/Note/Index.note';
const FOLDER_PATH = '/storage/emulated/0/Note/Projects';

const flush = async () => {
  // Native promises settle through several independent SDK and scheduler hops.
  for (let turn = 0; turn < 30; turn++) {await Promise.resolve();}
};

const deferred = () => {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise, resolve};
};

const loadRuntime = async () => {
  const listeners = new Map();
  const state = {
    foreground: NOTE_ACTIVITY,
    blocked: false,
    revision: 0,
    uiRevision: 0,
    writable: true,
    path: NOTE_PATH,
    page: 0,
  };
  const link = {
    notePath: NOTE_PATH, page: 0,
    left: 100, top: 100, right: 200, bottom: 200,
    folderPath: FOLDER_PATH,
  };
  let cached = [];
  let motion;
  let penUp;
  const motionSubscription = {id: 7, remove: jest.fn()};
  const emitter = {
    addListener: jest.fn((name, callback) => {
      const subscribers = listeners.get(name) ?? [];
      subscribers.push(callback);
      listeners.set(name, subscribers);
      return {remove: jest.fn()};
    }),
    emit: (name, event) => {
      for (const callback of listeners.get(name) ?? []) {callback(event);}
    },
  };
  const native = {
    delay: jest.fn(ms => new Promise(resolve => setTimeout(resolve, ms))),
    resetFingerMonitor: jest.fn().mockResolvedValue(true),
    getForegroundActivity: jest.fn(async () => state.foreground),
    getInteractionState: jest.fn(async () => ({blocked: state.blocked, revision: state.revision, uiRevision: state.uiRevision})),
    validateFingerContact: jest.fn().mockResolvedValue(true),
    getDisplayMetrics: jest.fn().mockResolvedValue({widthPixels: 1920, heightPixels: 2560}),
    openFolder: jest.fn().mockResolvedValue(undefined),
  };
  const comm = {
    getCurrentPageNum: jest.fn(async () => ({result: state.page})),
    getCurrentFilePath: jest.fn(async () => ({result: state.path})),
    canHandwrite: jest.fn(async () => ({result: state.writable})),
  };
  const file = {
    getPageSize: jest.fn().mockResolvedValue({result: {width: 1920, height: 2560}}),
    deleteElements: jest.fn().mockResolvedValue(undefined),
  };
  const links = {
    readFolderLinks: jest.fn(async () => {cached = [{...link, notePath: state.path}]; return cached;}),
    cachedLinksFor: jest.fn(() => cached),
    invalidateCache: jest.fn(() => {cached = [];}),
    invalidatePageReads: jest.fn(),
    resetElementCaches: jest.fn(() => {cached = [];}),
    recycleElements: jest.fn(),
    // Test the runtime's decisions while retaining production hit-testing.
    linkAt: (...args) => jest.requireActual('../links').linkAt(...args),
  };
  const nativeAPI = {registerEventListener: jest.fn()};
  const manager = {
    init: jest.fn(),
    registerButton: jest.fn(),
    registerButtonListener: jest.fn(),
    registerPluginLifeListener: jest.fn(),
    registerMotionListener: jest.fn((_page, handler) => {
      motion = handler.onMsg;
      return motionSubscription;
    }),
    registerEventListener: jest.fn((_event, _page, handler) => {penUp = handler.onMsg;}),
  };
  jest.doMock('react-native', () => ({
    AppRegistry: {registerComponent: jest.fn()},
    Image: {resolveAssetSource: () => ({uri: 'fixture-icon'})},
    DeviceEventEmitter: emitter,
    NativeModules: {FolderLinkNative: native, NativePluginAPI: nativeAPI},
  }));
  jest.doMock('sn-plugin-lib', () => ({
    PluginManager: manager, PluginCommAPI: comm, PluginFileAPI: file,
    EventType: {PEN_UP: 1, MOTION_EVENT: 2},
  }));
  jest.doMock('../permissions', () => ({hasFileReadPermission: jest.fn().mockResolvedValue(true)}));
  jest.doMock('../links', () => links);
  jest.doMock('../App', () => () => null);
  require('../index');
  await flush();
  await jest.advanceTimersByTimeAsync(2500);
  await flush();
  expect(links.readFolderLinks).toHaveBeenCalled();
  expect(motion).toEqual(expect.any(Function));
  return {state, native, nativeAPI, comm, file, links, emitter, motionSubscription,
    motion: event => motion(event), penUp: elements => penUp(elements)};
};

beforeEach(async () => {
  jest.resetModules();
  jest.useFakeTimers({now: new Date('2026-10-26T12:00:00Z')});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  harness = await loadRuntime();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const motionEvent = (action, overrides = {}) => ({
  action, eventTime: Date.now() + (action === 1 ? 50 : 0),
  pointerCount: 1, toolType: 1, x: 150, y: 150, ...overrides,
});

const tap = async (overrides = {}) => {
  await harness.motion(motionEvent(0, overrides));
  await harness.motion(motionEvent(1, overrides));
  await flush();
};

const rawTap = (overrides = {}) => {
  harness.emitter.emit('folderLinkRawFingerTap', {
    x: 150, y: 150, durationMs: 50, eventTime: Date.now(),
    noteInFrontAtDown: true,
    uiBlockedAtDown: false,
    uiRevisionAtDown: harness.state.uiRevision,
    ...overrides,
  });
};

const penElement = () => ({
  uuid: 'tap-stroke', numInPage: 3, type: 0,
  recognizeResult: {key_point_x: 150, key_point_y: 150},
  stroke: {points: 1},
});

const tick = async () => {
  harness.emitter.emit('folderLinkTick');
  await flush();
};

test('a normal SDK finger tap on a visible note opens its folder once', async () => {
  await tap({touchMajor: 120});
  expect(harness.native.openFolder).toHaveBeenCalledTimes(1);
  expect(harness.native.openFolder).toHaveBeenCalledWith(FOLDER_PATH);
});

test('a normal PEN_UP tap on a visible note removes its dot and opens its folder', async () => {
  const element = penElement();
  await harness.penUp([element]);
  expect(harness.file.deleteElements).toHaveBeenCalledWith(NOTE_PATH, 0, [3]);
  expect(harness.native.openFolder).toHaveBeenCalledWith(FOLDER_PATH);
  expect(harness.links.recycleElements).toHaveBeenCalledWith([element]);
});

test.each(['sdk', 'raw', 'pen'])('#11 a %s tap in the file manager cannot use the host\'s stale note path', async source => {
  harness.state.foreground = FILE_MANAGER;
  if (source === 'sdk') {await tap();}
  if (source === 'raw') {
    rawTap();
    await flush();
  }
  if (source === 'pen') {await harness.penUp([penElement()]);}
  expect(harness.native.openFolder).not.toHaveBeenCalled();
});

test('#11 a file-manager tap that brings the note forward before UP cannot replay against it', async () => {
  harness.state.foreground = FILE_MANAGER;
  await harness.motion(motionEvent(0));
  harness.state.foreground = NOTE_ACTIVITY;
  await harness.motion(motionEvent(1));
  expect(harness.native.openFolder).not.toHaveBeenCalled();
});

test('#11 native heartbeats pause page reads while the file manager reports the last note path', async () => {
  const reads = harness.links.readFolderLinks.mock.calls.length;
  harness.state.foreground = FILE_MANAGER;
  for (let index = 0; index < 80; index++) {
    await tick();
    await jest.advanceTimersByTimeAsync(500);
  }
  expect(harness.links.readFolderLinks).toHaveBeenCalledTimes(reads);
});

test('#11 error 118 disarms closed-note links and does not retry the same closed note every heartbeat', async () => {
  harness.links.readFolderLinks.mockRejectedValueOnce(Object.assign(new Error('The handwriting app is not open'), {code: 118}));
  harness.emitter.emit('folderLinkChanged');
  await flush();
  const reads = harness.links.readFolderLinks.mock.calls.length;
  expect(harness.motionSubscription.remove).toHaveBeenCalled();
  for (let index = 0; index < 10; index++) {await tick(); await jest.advanceTimersByTimeAsync(500);}
  expect(harness.links.readFolderLinks).toHaveBeenCalledTimes(reads);
  rawTap();
  await flush();
  expect(harness.links.readFolderLinks).toHaveBeenCalledTimes(reads);
  expect(harness.native.openFolder).not.toHaveBeenCalled();
});

test('#14 the raw duplicate cannot invalidate an SDK tap waiting for its context reply', async () => {
  const contextReply = deferred();
  await harness.motion(motionEvent(0, {eventTime: Date.now() - 50}));
  harness.comm.getCurrentPageNum.mockReturnValueOnce(contextReply.promise);
  const sdkTap = harness.motion(motionEvent(1, {eventTime: Date.now()}));
  await flush();
  rawTap();
  await flush();
  contextReply.resolve({result: 0});
  await sdkTap;
  await flush();
  expect(harness.native.openFolder).toHaveBeenCalledTimes(1);
});

test('#14 a delayed SDK duplicate cannot invalidate a raw fallback waiting for its context reply', async () => {
  const contextReply = deferred();
  harness.comm.getCurrentPageNum.mockReturnValueOnce(contextReply.promise);
  rawTap();
  await flush();
  await harness.motion(motionEvent(0, {eventTime: Date.now() - 50}));
  await harness.motion(motionEvent(1, {eventTime: Date.now()}));
  contextReply.resolve({result: 0});
  await flush();
  expect(harness.native.openFolder).toHaveBeenCalledTimes(1);
});

test('#16 an SDK palm-sized contact cannot open a link', async () => {
  await tap({touchMajor: 447});
  expect(harness.native.openFolder).not.toHaveBeenCalled();
});

test('#16 palm size seen only during MOVE permanently rejects that contact', async () => {
  await harness.motion(motionEvent(0, {touchMajor: 120}));
  await harness.motion(motionEvent(2, {touchMajor: 447}));
  await harness.motion(motionEvent(1, {touchMajor: 120}));
  expect(harness.native.openFolder).not.toHaveBeenCalled();
});

test('#16 native raw contact validation rejects palms omitted from SDK size fields', async () => {
  harness.native.validateFingerContact.mockResolvedValue(false);
  await tap();
  expect(harness.native.validateFingerContact).toHaveBeenCalled();
  expect(harness.native.openFolder).not.toHaveBeenCalled();
});

test.each(['blocked', 'writable'])('#13 %s menu state suppresses both SDK motion and PEN_UP navigation', async stateKey => {
  harness.state[stateKey] = stateKey === 'blocked';
  await tap({toolType: 2});
  await harness.penUp([penElement()]);
  expect(harness.native.openFolder).not.toHaveBeenCalled();
});

test('#13 the tap dismissing an overlay stays suppressed after the overlay closes', async () => {
  harness.state.blocked = true;
  await harness.motion(motionEvent(0, {toolType: 2}));
  harness.state.blocked = false;
  harness.state.revision++;
  await harness.motion(motionEvent(1, {toolType: 2}));
  expect(harness.native.openFolder).not.toHaveBeenCalled();
});

test('#13 an overlay shown and dismissed between DOWN and UP invalidates the gesture', async () => {
  await harness.motion(motionEvent(0, {toolType: 2}));
  harness.state.revision += 2;
  await harness.motion(motionEvent(1, {toolType: 2}));
  expect(harness.native.openFolder).not.toHaveBeenCalled();
});

test('#13 a menu transition while PEN_UP awaits note context prevents navigation', async () => {
  const contextReply = deferred();
  harness.comm.getCurrentPageNum.mockReturnValueOnce(contextReply.promise);
  const element = penElement();
  const penTap = harness.penUp([element]);
  await flush();
  harness.state.revision += 2;
  contextReply.resolve({result: 0});
  await penTap;
  expect(harness.native.openFolder).not.toHaveBeenCalled();
  expect(harness.links.recycleElements).toHaveBeenCalledWith([element]);
});


test.each(['file-manager', 'pdf', 'epub'])('#11/#15 return from %s renews the same SDK listener even when raw fallback is unsupported', async destination => {
  const reads = harness.links.readFolderLinks.mock.calls.length;
  harness.native.resetFingerMonitor.mockClear().mockResolvedValue(false);
  harness.state.foreground = destination === 'file-manager'
    ? FILE_MANAGER : 'com.ratta.supernote.document/.DocumentActivity';
  if (destination !== 'file-manager') {
    harness.state.path = `/storage/emulated/0/Document/Book.${destination}`;
  }
  await tick();
  harness.state.foreground = NOTE_ACTIVITY;
  harness.state.path = NOTE_PATH;
  await tick();
  expect(harness.native.resetFingerMonitor).toHaveBeenCalled();
  expect(harness.nativeAPI.registerEventListener).toHaveBeenCalledWith(7, 2, 0);
  expect(harness.motionSubscription.remove).not.toHaveBeenCalled();
  expect(harness.links.readFolderLinks).toHaveBeenCalledTimes(reads);
  await tap({touchMajor: 120});
  expect(harness.native.openFolder).toHaveBeenCalledTimes(1);
});


test.each([
  ['file-manager DOWN', {noteInFrontAtDown: false}],
  ['overlay DOWN', {uiBlockedAtDown: true}],
  ['missing foreground snapshot', {noteInFrontAtDown: undefined}],
  ['missing menu snapshot', {uiBlockedAtDown: undefined}],
  ['missing UI revision snapshot', {uiRevisionAtDown: undefined}],
])('#11/#13 raw %s cannot navigate after the physical tap has returned to an unobstructed note', async (_description, overrides) => {
  rawTap(overrides);
  await flush();
  expect(harness.native.openFolder).not.toHaveBeenCalled();
});

test('#13 a raw tap retains its physical DOWN menu revision even if the synthetic DOWN arrives after dismissal', async () => {
  harness.state.uiRevision = 2;
  rawTap({uiRevisionAtDown: 0});
  await flush();
  expect(harness.native.openFolder).not.toHaveBeenCalled();
});

test('#14 a raw miss cannot suppress the next distinct SDK hit within 90ms', async () => {
  const time = Date.now();
  rawTap({x: 79, durationMs: 20, eventTime: time});
  await flush();
  expect(harness.native.openFolder).not.toHaveBeenCalled();
  // Close enough in space/time to look like a duplicate, but its physical DOWN
  // begins after the earlier raw contact ended.
  await harness.motion(motionEvent(0, {x: 100, eventTime: time + 20}));
  await harness.motion(motionEvent(1, {x: 100, eventTime: time + 70}));
  await flush();
  expect(harness.native.openFolder).toHaveBeenCalledTimes(1);
});

test('#13 an in-note menu appearing and disappearing between SDK DOWN and UP changes its UI revision', async () => {
  await harness.motion(motionEvent(0, {toolType: 2}));
  harness.state.uiRevision += 2;
  await harness.motion(motionEvent(1, {toolType: 2}));
  expect(harness.native.openFolder).not.toHaveBeenCalled();
});


test.each(['sdk', 'raw', 'pen'])('#13 %s hit-testing asks native UI state at the actual screen point', async source => {
  harness.native.getInteractionState.mockImplementation(async (x, y) => ({
    blocked: x === 150 && y === 150,
    revision: 0, uiRevision: 0,
  }));
  if (source === 'sdk') {await tap({toolType: 2});}
  if (source === 'raw') {rawTap(); await flush();}
  if (source === 'pen') {await harness.penUp([penElement()]);}
  expect(harness.native.getInteractionState).toHaveBeenCalledWith(150, 150);
  expect(harness.native.openFolder).not.toHaveBeenCalled();
});
