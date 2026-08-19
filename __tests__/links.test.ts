/**
 * Regression cover for reading folder links off a note page.
 *
 * Each case here corresponds to a fault that reached a device and broke the
 * plugin in a way that was not obvious from the code — see the comments on the
 * individual tests for what actually went wrong.
 */

const mockGetElements = jest.fn();
const mockRecycleElement = jest.fn();
const mockClearElementCache = jest.fn();
const mockListFiles = jest.fn();

jest.mock('sn-plugin-lib', () => ({
  PluginFileAPI: {
    getElements: (...args: any[]) => mockGetElements(...args),
  },
  PluginCommAPI: {
    recycleElement: (...args: any[]) => mockRecycleElement(...args),
    clearElementCache: (...args: any[]) => mockClearElementCache(...args),
  },
  FileUtils: {
    listFiles: (...args: any[]) => mockListFiles(...args),
  },
}));

const NOTE = '/storage/emulated/0/Note/test.note';
const FOLDER = '/storage/emulated/0/Note/Dungeon Maps';

/** A stroke link element as the SDK reports it. */
const linkElement = (overrides: any = {}) => ({
  uuid: 'uuid-link',
  numInPage: 65,
  type: 600,
  link: {
    category: 1,
    linkType: 2,
    destPath: FOLDER,
    destPage: 0,
    X: 886,
    Y: 1190,
    width: 237,
    height: 179,
    ...overrides,
  },
});

const strokeElement = (uuid: string) => ({uuid, numInPage: 1, type: 0, link: null});

const ok = (result: any) => ({success: true, result});

let links: typeof import('../links');

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  // Anything asked about is a directory unless a test says otherwise.
  mockListFiles.mockResolvedValue([]);
  links = require('../links');
});

describe('readFolderLinks', () => {
  it('returns the folder link with a rect derived from the link element', async () => {
    mockGetElements.mockResolvedValue(ok([strokeElement('a'), linkElement()]));

    const found = await links.readFolderLinks(NOTE, 0);

    expect(found).toEqual([
      {
        notePath: NOTE,
        page: 0,
        left: 886,
        top: 1190,
        right: 1123,
        bottom: 1369,
        folderPath: FOLDER,
      },
    ]);
  });

  // Every getElements call caches that page's trail data natively and the cache
  // does not drain by itself. Skipping the handback filled it, after which
  // getElements failed with error 206 and the plugin went blind: no links, no
  // overlays, and every tap rejected. Nothing in the plugin's own behaviour
  // hinted at the cause, so this is pinned down here.
  it('hands every element back to the native cache', async () => {
    mockGetElements.mockResolvedValue(
      ok([strokeElement('a'), strokeElement('b'), linkElement()]),
    );

    await links.readFolderLinks(NOTE, 0);

    expect(mockRecycleElement.mock.calls.map(c => c[0]).sort()).toEqual([
      'a',
      'b',
      'uuid-link',
    ]);
  });

  it('still recycles when reading a page yields no links at all', async () => {
    mockGetElements.mockResolvedValue(ok([strokeElement('a')]));

    await links.readFolderLinks(NOTE, 0);

    expect(mockRecycleElement).toHaveBeenCalledWith('a');
  });

  // Recovery for a cache that is already full when the plugin starts, or that
  // something else filled.
  it('clears the cache and retries once on error 206', async () => {
    mockGetElements
      .mockResolvedValueOnce({
        success: false,
        error: {code: 206, message: 'Trail cache data is too large.'},
      })
      .mockResolvedValueOnce(ok([linkElement()]));

    const found = await links.readFolderLinks(NOTE, 0);

    expect(mockClearElementCache).toHaveBeenCalledTimes(1);
    expect(mockGetElements).toHaveBeenCalledTimes(2);
    expect(found).toHaveLength(1);
  });

  it('throws rather than reporting an empty page when the read fails', async () => {
    mockGetElements.mockResolvedValue({
      success: false,
      error: {code: 500, message: 'nope'},
    });

    // Callers rely on this to leave the previous overlays alone: treating a
    // failed read as "no links here" would tear down working tap targets.
    await expect(links.readFolderLinks(NOTE, 0)).rejects.toThrow(/code=500/);
  });

  // The note app's own "link to document" also uses link type 2, so the type
  // alone does not identify a folder link.
  it('ignores a type 2 link whose target is not a directory', async () => {
    mockListFiles.mockRejectedValue(new Error('not a directory'));
    mockGetElements.mockResolvedValue(
      ok([linkElement({destPath: '/storage/emulated/0/Document/manual.pdf'})]),
    );

    expect(await links.readFolderLinks(NOTE, 0)).toEqual([]);
  });

  it('ignores link types other than document', async () => {
    mockGetElements.mockResolvedValue(ok([linkElement({linkType: 0})]));

    expect(await links.readFolderLinks(NOTE, 0)).toEqual([]);
  });

  // The folder-vs-file answer is cached, but a cached answer held forever
  // outlives the filesystem: a folder created after a failed probe left its
  // link permanently dead until the plugin restarted.
  it('re-probes a destination after the directory cache expires', async () => {
    mockGetElements.mockResolvedValue(ok([linkElement()]));
    mockListFiles.mockRejectedValue(new Error('no such directory'));

    expect(await links.readFolderLinks(NOTE, 0)).toEqual([]);

    // The folder now exists; within the TTL the stale "not a folder" holds…
    mockListFiles.mockResolvedValue([]);
    expect(await links.readFolderLinks(NOTE, 0)).toEqual([]);

    // …and after it, the link comes back.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 2 * 60 * 1000;
      expect(await links.readFolderLinks(NOTE, 0)).toHaveLength(1);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('usableLassoRect', () => {
  it('requires all four numeric bounds', () => {
    expect(links.usableLassoRect({left: 1, top: 2, right: 3, bottom: 4})).toBe(true);
    expect(links.usableLassoRect({left: 1, top: 2, right: 3})).toBe(false);
  });

  it('rejects a rect that encloses nothing', () => {
    expect(links.usableLassoRect({left: 0, top: 0, right: 0, bottom: 0})).toBe(false);
    expect(links.usableLassoRect({left: 9, top: 2, right: 3, bottom: 4})).toBe(false);
  });

  it('rejects bounds that are not finite', () => {
    expect(links.usableLassoRect({left: NaN, top: 2, right: 3, bottom: 4})).toBe(false);
    expect(links.usableLassoRect({left: -Infinity, top: 2, right: 3, bottom: 4})).toBe(false);
    expect(links.usableLassoRect({left: 1, top: 2, right: Infinity, bottom: 4})).toBe(false);
  });

  it('rejects an error response', () => {
    expect(links.usableLassoRect(null)).toBe(false);
    expect(links.usableLassoRect({error: {code: 904}, success: false})).toBe(false);
  });
});

describe('pending links', () => {
  const pending = {
    notePath: NOTE,
    page: 0,
    left: 886,
    top: 1190,
    right: 1123,
    bottom: 1369,
    folderPath: FOLDER,
  };

  it('serves a link that the note has not written to disk yet', async () => {
    mockGetElements.mockResolvedValue(ok([]));
    links.addPendingLink(pending);

    expect(await links.readFolderLinks(NOTE, 0)).toEqual([pending]);
  });

  it('drops the pending copy once the page reports the real link', async () => {
    mockGetElements.mockResolvedValue(ok([linkElement()]));
    links.addPendingLink(pending);

    expect(await links.readFolderLinks(NOTE, 0)).toHaveLength(1);
  });

  it('does not serve a pending link for a different page', async () => {
    mockGetElements.mockResolvedValue(ok([]));
    links.addPendingLink(pending);

    expect(await links.readFolderLinks(NOTE, 1)).toEqual([]);
  });

  // Left unbounded, a link that never persisted would keep opening a folder
  // forever — the ghost-tap failure the sidecar used to cause.
  it('expires a pending link that is never confirmed', async () => {
    mockGetElements.mockResolvedValue(ok([]));
    const realNow = Date.now;
    try {
      links.addPendingLink(pending);
      Date.now = () => realNow() + 10 * 60 * 1000;
      expect(await links.readFolderLinks(NOTE, 0)).toEqual([]);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('linkAt', () => {
  const link = {
    notePath: NOTE,
    page: 0,
    left: 100,
    top: 100,
    right: 200,
    bottom: 150,
    folderPath: FOLDER,
  };

  it('matches inside the rect', () => {
    expect(links.linkAt([link], 150, 120)).toBe(link);
  });

  it('matches just outside, within the touch padding', () => {
    expect(links.linkAt([link], 210, 120)).toBe(link);
  });

  it('does not match well outside the rect', () => {
    expect(links.linkAt([link], 400, 120)).toBeUndefined();
  });
});
