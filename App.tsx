/**
 * Folder Shortcuts — lasso-toolbar plugin
 *
 * Flow:
 *   user lassos a word in a note → taps 3-dots → picks Folder Shortcuts
 *   → this view opens → user navigates to target folder → taps
 *   "Link lasso → this folder" → we save a sidecar entry
 *   (notePath, page, lassoRect, folderPath) and call setLassoStrokeLink
 *   so the word gets the native underline. Tapping the underlined word
 *   fires PEN_UP, which our listener in index.js catches and turns into
 *   FileUtils.openFilePath(folderPath).
 */

import React, {useEffect, useMemo, useState} from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {FileUtils, PluginCommAPI, PluginManager, PluginNoteAPI} from 'sn-plugin-lib';
import {addShortcut} from './shortcuts';

const NOTE_ROOT = '/storage/emulated/0/Note';

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
  const [cwd, setCwd] = useState<string>(NOTE_ROOT);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('Navigate to a folder, then tap the button.');

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
    if (cwd === NOTE_ROOT) return 'Note/';
    const rel = cwd.startsWith(NOTE_ROOT + '/') ? cwd.slice(NOTE_ROOT.length + 1) : cwd;
    return 'Note/' + rel;
  }, [cwd]);

  const goUp = () => {
    if (cwd === NOTE_ROOT) return;
    const parent = cwd.replace(/\/+$/, '').replace(/\/[^/]+$/, '');
    setCwd(parent || NOTE_ROOT);
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

      console.log('[folder-link] link-press context', {rect, page, notePath, cwd});

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
      console.log('[folder-link] setLassoStrokeLink result', linkResult);
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

      setStatus(`OK — linked to ${cwd}. Closing…`);
      setTimeout(() => PluginManager.closePluginView(), 600);
    } catch (e: any) {
      console.log('[folder-link] link-press error', e);
      setStatus(`THREW: ${e?.message ?? String(e)}`);
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
          style={[styles.upBtn, cwd === NOTE_ROOT && styles.upBtnDisabled]}
          onPress={goUp}
          disabled={cwd === NOTE_ROOT}>
          <Text style={styles.upBtnText}>↑ up</Text>
        </Pressable>
        <Text style={styles.breadcrumb} numberOfLines={1}>
          {breadcrumb}
        </Text>
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
          data={entries}
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
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  closeText: {
    fontSize: 32,
    fontWeight: '600',
    color: '#000000',
  },
  title: {
    fontSize: 32,
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
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 6,
    marginRight: 12,
  },
  upBtnDisabled: {
    borderColor: '#cccccc',
  },
  upBtnText: {
    fontSize: 20,
    color: '#000000',
  },
  breadcrumb: {
    fontSize: 20,
    color: '#333333',
    flex: 1,
    fontFamily: 'monospace',
  },
  linkBtn: {
    backgroundColor: '#000000',
    borderRadius: 8,
    paddingVertical: 18,
    paddingHorizontal: 18,
    marginBottom: 12,
  },
  linkBtnText: {
    color: '#ffffff',
    fontSize: 22,
    fontWeight: '600',
  },
  linkBtnPath: {
    color: '#cccccc',
    fontSize: 16,
    fontFamily: 'monospace',
    marginTop: 4,
  },
  status: {
    fontSize: 18,
    color: '#000000',
    backgroundColor: '#f0f0f0',
    padding: 14,
    borderRadius: 6,
    marginBottom: 12,
  },
  error: {
    fontSize: 18,
    color: '#aa0000',
    padding: 12,
  },
  row: {
    paddingVertical: 18,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  rowFile: {
    opacity: 0.5,
  },
  rowText: {
    fontSize: 24,
    color: '#000000',
  },
  empty: {
    fontSize: 20,
    color: '#777777',
    padding: 14,
  },
});

export default App;
