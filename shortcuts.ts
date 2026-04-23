import {FileUtils, PluginManager} from 'sn-plugin-lib';

export type Shortcut = {
  notePath: string;
  page: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  folderPath: string;
};

type RawListItem = {type?: number; path?: string} | string | null | undefined;

let cache: Shortcut[] = [];
let shortcutsDirPromise: Promise<string> | null = null;

const hex = (s: string): string =>
  Array.from(s, c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
const unhex = (h: string): string => {
  let s = '';
  for (let i = 0; i < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
  return s;
};

const encodeName = (sc: Shortcut): string =>
  [
    'v1',
    hex(sc.notePath),
    String(sc.page),
    String(sc.left),
    String(sc.top),
    String(sc.right),
    String(sc.bottom),
    hex(sc.folderPath),
  ].join('_');

const decodeName = (name: string): Shortcut | null => {
  const parts = name.split('_');
  if (parts.length !== 8 || parts[0] !== 'v1') return null;
  try {
    return {
      notePath: unhex(parts[1]),
      page: parseInt(parts[2], 10),
      left: parseFloat(parts[3]),
      top: parseFloat(parts[4]),
      right: parseFloat(parts[5]),
      bottom: parseFloat(parts[6]),
      folderPath: unhex(parts[7]),
    };
  } catch {
    return null;
  }
};

const basename = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
};

const shortcutsDir = async (): Promise<string> => {
  if (!shortcutsDirPromise) {
    shortcutsDirPromise = (async () => {
      const dir = await PluginManager.getPluginDirPath();
      if (typeof dir !== 'string' || !dir) {
        throw new Error(`getPluginDirPath returned ${String(dir)}`);
      }
      const path = `${dir.replace(/\/+$/, '')}/shortcuts`;
      try {
        const ex = await FileUtils.exists(path);
        if (!ex) await FileUtils.makeDir(path);
      } catch (e: any) {
        console.log('[folder-link] makeDir warn:', e?.message ?? String(e));
      }
      return path;
    })();
  }
  return shortcutsDirPromise;
};

export const loadShortcuts = async (): Promise<Shortcut[]> => {
  try {
    const dir = await shortcutsDir();
    const entries = (await FileUtils.listFiles(dir)) as unknown as RawListItem[] | null | undefined;
    const names: string[] = [];
    if (Array.isArray(entries)) {
      for (const e of entries) {
        if (typeof e === 'string') names.push(basename(e));
        else if (e && typeof e === 'object' && typeof e.path === 'string')
          names.push(basename(e.path));
      }
    }
    cache = names.map(decodeName).filter((s): s is Shortcut => s !== null);
    console.log(`[folder-link] loaded ${cache.length} shortcuts from ${dir}`);
    return cache;
  } catch (e: any) {
    console.log('[folder-link] loadShortcuts failed:', e?.message ?? String(e));
    cache = [];
    return cache;
  }
};

export const addShortcut = async (entry: Shortcut): Promise<void> => {
  const dir = await shortcutsDir();
  for (const old of cache) {
    if (
      old.notePath === entry.notePath &&
      old.page === entry.page &&
      Math.abs(old.left - entry.left) < 2 &&
      Math.abs(old.top - entry.top) < 2
    ) {
      try {
        await FileUtils.deleteDir(`${dir}/${encodeName(old)}`);
      } catch (e: any) {
        console.log('[folder-link] replace-old deleteDir warn:', e?.message ?? String(e));
      }
    }
  }
  cache = cache.filter(
    s =>
      !(
        s.notePath === entry.notePath &&
        s.page === entry.page &&
        Math.abs(s.left - entry.left) < 2 &&
        Math.abs(s.top - entry.top) < 2
      ),
  );
  cache.push(entry);
  const path = `${dir}/${encodeName(entry)}`;
  await FileUtils.makeDir(path);
  console.log(`[folder-link] saved shortcut (${cache.length} total) → ${entry.folderPath}`);
};

export const findShortcut = (
  notePath: string,
  page: number,
  x: number,
  y: number,
  pad = 20,
): Shortcut | undefined =>
  cache.find(
    s =>
      s.notePath === notePath &&
      s.page === page &&
      x >= s.left - pad &&
      x <= s.right + pad &&
      y >= s.top - pad &&
      y <= s.bottom + pad,
  );

export const shortcutsForPage = (notePath: string, page: number): Shortcut[] =>
  cache.filter(s => s.notePath === notePath && s.page === page);

export const shortcutId = (s: Shortcut): string =>
  `${s.notePath}#${s.page}#${s.left},${s.top},${s.right},${s.bottom}`;

export const findById = (id: string): Shortcut | undefined =>
  cache.find(s => shortcutId(s) === id);
