/**
 * Folder Shortcuts plugin view.
 *
 * Opened from the lasso toolbar (type=2) after the user has lassoed a
 * word. Lets the user navigate to a target folder and tap
 * "Link lasso → this folder", which:
 *   1. calls setLassoStrokeLink(linkType=2) for the native underline,
 *   2. saves a sidecar entry (notePath, page, rect, folderPath),
 *   3. signals index.js to refresh the on-canvas overlay for the new
 *      shortcut so finger tap works immediately.
 */

import React, {useEffect, useMemo, useState} from 'react';
import {
  DeviceEventEmitter,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {FileUtils, PluginCommAPI, PluginManager, PluginNoteAPI} from 'sn-plugin-lib';
import {addShortcut} from './shortcuts';

const SUPERNOTE_ROOT = '/storage/emulated/0';
const NOTE_DIR = SUPERNOTE_ROOT + '/Note';

type Entry = {name: string; path: string; isFolder: boolean};

type RawListItem = {type?: number; path?: string} | string | null | undefined;

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function normalizeEntries(raw: RawListItem[]): Entry[] {
  const out: Entry[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item) {
      out.push({name: basename(item), path: item, isFolder: false});
    } else if (item && typeof item === 'object' && typeof item.path === 'string') {
      out.push({
        name: basename(item.path),
        path: item.path,
        isFolder: item.type === 0,
      });
    }
  }
  out.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

function unwrap<T>(res: any): T | null {
  if (res && typeof res === 'object' && 'result' in res) return (res.result ?? null) as T | null;
  return (res ?? null) as T | null;
}

function App(): React.JSX.Element {
  const [cwd, setCwd] = useState<string>(NOTE_DIR);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('Navigate to a folder, then tap the button.');
  const [showHidden, setShowHidden] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setListError(null);
      try {
        const files = (await FileUtils.listFiles(cwd)) as unknown as RawListItem[] | null | undefined;
        if (cancelled) return;
        if (!files) {
          setEntries([]);
          setListError(`listFiles returned ${files === null ? 'null' : 'undefined'}`);
          return;
        }
        setEntries(normalizeEntries(files));
      } catch (e: any) {
        if (!cancelled) setListError(`listFiles threw: ${e?.message ?? String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const breadcrumb = useMemo(() => {
    if (cwd === SUPERNOTE_ROOT) return 'Supernote/';
    const rel = cwd.startsWith(SUPERNOTE_ROOT + '/') ? cwd.slice(SUPERNOTE_ROOT.length + 1) : cwd;
    return 'Supernote/' + rel;
  }, [cwd]);

  const visibleEntries = useMemo(
    () => (showHidden ? entries : entries.filter(e => !e.name.startsWith('.'))),
    [entries, showHidden],
  );

  const goUp = () => {
    if (cwd === SUPERNOTE_ROOT) return;
    const parent = cwd.replace(/\/+$/, '').replace(/\/[^/]+$/, '');
    setCwd(parent || SUPERNOTE_ROOT);
  };

  const linkLassoToCwd = async () => {
    setStatus('Reading lasso context…');
    try {
      const [rectRes, pageRes, pathRes] = await Promise.all([
        PluginCommAPI.getLassoRect(),
        PluginCommAPI.getCurrentPageNum(),
        PluginCommAPI.getCurrentFilePath(),
      ]);
      const rect = unwrap<any>(rectRes);
      const page = unwrap<number>(pageRes);
      const notePath = unwrap<string>(pathRes);

      if (
        !rect ||
        typeof rect.left !== 'number' ||
        typeof rect.right !== 'number' ||
        typeof rect.top !== 'number' ||
        typeof rect.bottom !== 'number'
      ) {
        setStatus(`No lasso rect: ${JSON.stringify(rect)}`);
        return;
      }
      if (typeof notePath !== 'string' || typeof page !== 'number') {
        setStatus(`Bad context: notePath=${notePath} page=${page}`);
        return;
      }

      const linkResult: any = await PluginNoteAPI.setLassoStrokeLink({
        destPath: cwd,
        destPage: 0,
        style: 0,
        linkType: 2,
      });
      if (linkResult && linkResult.success === false) {
        setStatus(
          `Link FAIL code=${linkResult?.error?.code} msg=${linkResult?.error?.message}`,
        );
        return;
      }

      await addShortcut({
        notePath,
        page,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        folderPath: cwd,
      });

      DeviceEventEmitter.emit('folderLinkShortcutsChanged');

      setStatus(`OK: linked to ${cwd}. Closing…`);
      setTimeout(() => PluginManager.closePluginView(), 600);
    } catch (e: any) {
      setStatus(`Error: ${e?.message ?? String(e)}`);
    }
  };

  return (
    <View style={styles.container}>
      <Pressable style={styles.closeButton} onPress={() => PluginManager.closePluginView()}>
        <Text style={styles.closeText}>✕</Text>
      </Pressable>

      <Text style={styles.title}>Link lasso → folder</Text>

      <View style={styles.pathBar}>
        <Pressable
          style={[styles.upBtn, cwd === SUPERNOTE_ROOT && styles.upBtnDisabled]}
          onPress={goUp}
          disabled={cwd === SUPERNOTE_ROOT}>
          <Text style={styles.upBtnText}>↑ up</Text>
        </Pressable>
        <Text style={styles.breadcrumb} numberOfLines={1}>
          {breadcrumb}
        </Text>
        <Pressable
          style={styles.hiddenToggle}
          onPress={() => setShowHidden(v => !v)}>
          <Text style={styles.hiddenToggleText}>
            {showHidden ? '[✓]' : '[ ]'} Hidden
          </Text>
        </Pressable>
      </View>

      <Pressable style={styles.linkBtn} onPress={linkLassoToCwd}>
        <Text style={styles.linkBtnText}>Link lasso → this folder</Text>
        <Text style={styles.linkBtnPath} numberOfLines={1}>
          {cwd}
        </Text>
      </Pressable>

      <Text style={styles.status}>{status}</Text>

      {listError ? (
        <Text style={styles.error}>{listError}</Text>
      ) : (
        <FlatList
          data={visibleEntries}
          keyExtractor={item => item.path}
          ListEmptyComponent={<Text style={styles.empty}>Empty folder.</Text>}
          renderItem={({item}) => (
            <Pressable
              style={[styles.row, !item.isFolder && styles.rowFile]}
              onPress={() => item.isFolder && setCwd(item.path)}
              disabled={!item.isFolder}>
              <Text style={styles.rowText}>
                {item.isFolder ? '📁 ' : '📄 '}
                {item.name}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
    paddingTop: 48,
    paddingHorizontal: 16,
  },
  closeButton: {
    position: 'absolute',
    top: 12,
    right: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  closeText: {
    fontSize: 44,
    fontWeight: '600',
    color: '#000000',
  },
  title: {
    fontSize: 40,
    fontWeight: '700',
    color: '#000000',
    marginBottom: 14,
  },
  pathBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  upBtn: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 6,
    marginRight: 12,
  },
  upBtnDisabled: {
    borderColor: '#cccccc',
  },
  upBtnText: {
    fontSize: 26,
    color: '#000000',
  },
  hiddenToggle: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 6,
    marginLeft: 12,
  },
  hiddenToggleText: {
    fontSize: 22,
    color: '#000000',
    fontFamily: 'monospace',
  },
  breadcrumb: {
    fontSize: 28,
    color: '#000000',
    fontWeight: '500',
    flex: 1,
    fontFamily: 'monospace',
  },
  linkBtn: {
    backgroundColor: '#000000',
    borderRadius: 8,
    paddingVertical: 24,
    paddingHorizontal: 18,
    marginBottom: 12,
  },
  linkBtnText: {
    color: '#ffffff',
    fontSize: 30,
    fontWeight: '600',
  },
  linkBtnPath: {
    color: '#cccccc',
    fontSize: 20,
    fontFamily: 'monospace',
    marginTop: 4,
  },
  status: {
    fontSize: 24,
    color: '#000000',
    backgroundColor: '#f0f0f0',
    padding: 18,
    borderRadius: 6,
    marginBottom: 12,
  },
  error: {
    fontSize: 24,
    color: '#aa0000',
    padding: 12,
  },
  row: {
    paddingVertical: 28,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#b0b0b0',
  },
  rowFile: {
    opacity: 0.4,
  },
  rowText: {
    fontSize: 40,
    fontWeight: '600',
    color: '#000000',
  },
  empty: {
    fontSize: 30,
    color: '#555555',
    fontWeight: '500',
    padding: 14,
  },
});

export default App;
