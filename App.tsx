/**
 * Folder Shortcuts plugin view.
 *
 * Opened from the lasso toolbar (type=2) after the user has lassoed a
 * word. Lets the user navigate to a target folder and tap
 * "Link lasso → this folder", which:
 *   1. calls setLassoStrokeLink(linkType=2), which both draws the native
 *      underline and stores the link in the note — the note is the only
 *      record we keep, so removing the link in the note removes the shortcut,
 *   2. signals index.js to refresh the on-canvas overlay for the new link so
 *      finger tap works immediately.
 */

import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  DeviceEventEmitter,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {FileUtils, PluginCommAPI, PluginManager, PluginNoteAPI} from 'sn-plugin-lib';
import {addPendingLink, usableLassoRect} from './links';

const SUPERNOTE_ROOT = '/storage/emulated/0';
const NOTE_DIR = SUPERNOTE_ROOT + '/Note';

type Entry = {name: string; path: string; isFolder: boolean};

type RawListItem = {type?: number; path?: string} | string | null | undefined;

const IDLE_STATUS = 'Navigate to a folder, then tap the button.';
const LASSO_LOST_STATUS = 'Lasso selection was lost. Close this picker, lasso the word again, then retry.';

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
    if (a.isFolder !== b.isFolder) {return a.isFolder ? -1 : 1;}
    return a.name.localeCompare(b.name);
  });
  return out;
}

function unwrap<T>(res: any): T | null {
  if (res && typeof res === 'object' && 'result' in res) {return (res.result ?? null) as T | null;}
  return (res ?? null) as T | null;
}

function App(): React.JSX.Element {
  const [cwd, setCwd] = useState<string>(NOTE_DIR);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>(IDLE_STATUS);
  const [showHidden, setShowHidden] = useState<boolean>(false);
  // On e-ink the screen lags the tap, so the button is often pressed again
  // before the first linkLassoToCwd has finished — which wrote a second link
  // onto the same strokes. One flight at a time; keep it set until the host has
  // finished closing because closePluginView does not unmount the React tree.
  const [linking, setLinking] = useState<boolean>(false);
  // The guard has to hold across the same tick, and state does not: two presses
  // flushed in one batch both read the pre-update value and both link. The
  // state is kept alongside for the button's disabled/busy rendering.
  const linkingRef = useRef<number | null>(null);
  const linkingTokenRef = useRef<number>(0);
  const [refreshCounter, setRefreshCounter] = useState<number>(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Which linking run scheduled the pending close, so whoever cancels that
  // close knows whose ownership is left stranded. Only ever set once a run has
  // finished its native calls: while one is still in flight, ownership has to
  // stay held or a second press could overlap its setLassoStrokeLink.
  const closeOwnerRef = useRef<number | null>(null);
  const lastTouchAt = useRef<number>(0);
  // Bumped every time the picker is shown or closed, so work started in one
  // visit cannot apply its result during the next one.
  const sessionRef = useRef<number>(0);
  // Native work may resolve after React has torn the picker down. Refs still
  // need releasing in that case, but no state update may target the dead tree.
  const mountedRef = useRef<boolean>(true);

  useEffect(() => {
    mountedRef.current = true;
    const subscription = DeviceEventEmitter.addListener('folderLinkViewOpened', () => {
      sessionRef.current += 1;
      if (closeTimer.current !== null) {
        clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
      // An owner recorded here has completed every native link call and was
      // only holding the button for a now-cancelled close. An owner without a
      // closeOwner is still inside setLassoStrokeLink and must remain claimed.
      const strandedOwner = closeOwnerRef.current;
      closeOwnerRef.current = null;
      if (strandedOwner !== null) {stopLinking(strandedOwner);}
      if (linkingRef.current === null) {setStatus(IDLE_STATUS);}
      setRefreshCounter(value => value + 1);
    });
    return () => {
      mountedRef.current = false;
      sessionRef.current += 1;
      if (closeTimer.current !== null) {
        clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
      closeOwnerRef.current = null;
      linkingRef.current = null;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setListError(null);
      try {
        const files = (await FileUtils.listFiles(cwd)) as unknown as RawListItem[] | null | undefined;
        if (cancelled) {return;}
        if (!files) {
          setEntries([]);
          setListError(`listFiles returned ${files === null ? 'null' : 'undefined'}`);
          return;
        }
        setEntries(normalizeEntries(files));
      } catch (e: any) {
        if (!cancelled) {setListError(`listFiles threw: ${e?.message ?? String(e)}`);}
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, refreshCounter]);

  const breadcrumb = useMemo(() => {
    if (cwd === SUPERNOTE_ROOT) {return 'Supernote/';}
    const rel = cwd.startsWith(SUPERNOTE_ROOT + '/') ? cwd.slice(SUPERNOTE_ROOT.length + 1) : cwd;
    return 'Supernote/' + rel;
  }, [cwd]);

  const visibleEntries = useMemo(
    () => (showHidden ? entries : entries.filter(e => !e.name.startsWith('.'))),
    [entries, showHidden],
  );

  const stopLinking = (owner?: number) => {
    if (owner !== undefined && linkingRef.current !== owner) {return;}
    linkingRef.current = null;
    if (mountedRef.current) {setLinking(false);}
  };

  const goUp = () => {
    if (cwd === SUPERNOTE_ROOT) {return;}
    const parent = cwd.replace(/\/+$/, '').replace(/\/[^/]+$/, '');
    setCwd(parent || SUPERNOTE_ROOT);
  };

  const linkLassoToCwd = async () => {
    if (linkingRef.current !== null) {
      return;
    }
    const owner = ++linkingTokenRef.current;
    linkingRef.current = owner;
    const stopThisLinking = () => stopLinking(owner);
    // Every await below can outlive the visit that started it — the user can
    // close the picker mid-flight, and the host suspends this context while it
    // is away. Anything this run does afterwards belongs to a visit that is
    // over, so it must not touch the picker the user has since reopened.
    const session = sessionRef.current;
    const current = () => sessionRef.current === session;
    setLinking(true);
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

      if (!current()) {
        stopThisLinking();
        return;
      }

      if (!usableLassoRect(rect)) {
        console.log('[folder-link] getLassoRect returned no usable rect:', JSON.stringify(rect));
        setStatus(LASSO_LOST_STATUS);
        stopThisLinking();
        return;
      }
      if (typeof notePath !== 'string' || typeof page !== 'number') {
        setStatus(`Bad context: notePath=${notePath} page=${page}`);
        stopThisLinking();
        return;
      }

      const linkResult: any = await PluginNoteAPI.setLassoStrokeLink({
        destPath: cwd,
        destPage: 0,
        style: 0,
        linkType: 2,
      });
      if (linkResult && linkResult.success === false) {
        if (!current()) {
          stopThisLinking();
          return;
        }
        setStatus(
          `Link FAIL code=${linkResult?.error?.code} msg=${linkResult?.error?.message}`,
        );
        stopThisLinking();
        return;
      }

      // The link now lives in the note itself. Hold it in memory as well so the
      // word is tappable before the note is next written to disk; the pending
      // copy is dropped as soon as a read of the page reports the real link.
      addPendingLink({
        notePath,
        page,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        folderPath: cwd,
      });

      // The link is in the note whether or not this visit is still the current
      // one, so it is recorded and announced either way.
      DeviceEventEmitter.emit('folderLinkChanged');

      // Closing, though, is this visit's business. If the user already dismissed
      // the picker, there is nothing of ours left to close.
      if (!current()) {
        stopThisLinking();
        return;
      }

      setStatus(`OK: linked to ${cwd}. Closing…`);
      // Every native call this run makes is done, so the claim it still holds
      // is only guarding the close. Record it: if the close is cancelled, the
      // canceller inherits the job of handing it back.
      closeOwnerRef.current = owner;
      closeTimer.current = setTimeout(async () => {
        closeTimer.current = null;
        // Host timers are suspended while the view is closed, so this can only
        // run once the picker is showing again — and that picker may belong to a
        // later visit, which this one must not close or reset.
        if (!current()) {
          if (closeOwnerRef.current === owner) {closeOwnerRef.current = null;}
          stopThisLinking();
          return;
        }
        DeviceEventEmitter.emit('folderLinkViewClosed');
        try {
          await PluginManager.closePluginView();
        } catch (e: any) {
          // Nothing here can retry a close the host refused, but the rejection
          // has to be caught: this runs from a timer, so it would otherwise
          // surface as an unhandled rejection with no context attached.
          console.log('[folder-link] closePluginView failed:', e?.message ?? String(e));
          // The canvas suppresses link taps while the picker is visible. We
          // announced a close before asking the host so its closing tap could
          // not leak through; restore the visible state when the host refuses.
          if (current() && mountedRef.current) {
            DeviceEventEmitter.emit('folderLinkViewOpened');
          }
        } finally {
          if (closeOwnerRef.current === owner) {closeOwnerRef.current = null;}
          if (current()) {
            stopThisLinking();
            setStatus(IDLE_STATUS);
          }
        }
      }, 600);
    } catch (e: any) {
      if (!current()) {
        stopThisLinking();
        return;
      }
      setStatus(`Error: ${e?.message ?? String(e)}`);
      stopThisLinking();
    }
  };

  const closePicker = () => {
    sessionRef.current += 1;
    // Cancelling a scheduled close destroys the only thing that would have
    // released that run's claim. Null unless a run had got as far as scheduling
    // one, so a press landing mid-flight leaves its claim alone.
    const strandedOwner = closeOwnerRef.current;
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    DeviceEventEmitter.emit('folderLinkViewClosed');
    PluginManager.closePluginView()
      .then(() => {
        // By token, not unconditionally: a visit boundary can begin while the
        // close promise is pending, and releasing its newer claim would let a
        // second setLassoStrokeLink overlap it.
        if (closeOwnerRef.current === strandedOwner) {
          closeOwnerRef.current = null;
        }
        if (strandedOwner !== null) {stopLinking(strandedOwner);}
      })
      .catch((e: any) => {
        console.log('[folder-link] closePluginView failed:', e?.message ?? String(e));
        if (mountedRef.current) {
          DeviceEventEmitter.emit('folderLinkViewOpened');
        }
      });
  };

  const onStartShouldSetResponderCapture = () => {
    const now = Date.now();
    if (now - lastTouchAt.current >= 1000) {
      lastTouchAt.current = now;
      DeviceEventEmitter.emit('folderLinkViewTouched');
    }
    return false;
  };

  return (
    <View
      style={styles.container}
      onStartShouldSetResponderCapture={onStartShouldSetResponderCapture}>
      <Pressable style={styles.closeButton} onPress={closePicker}>
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

      <Pressable
        style={[styles.linkBtn, linking && styles.linkBtnBusy]}
        onPress={linkLassoToCwd}
        disabled={linking}>
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
  linkBtnBusy: {
    opacity: 0.5,
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
