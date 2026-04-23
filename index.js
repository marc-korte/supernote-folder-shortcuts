/**
 * @format
 */

import {AppRegistry, DeviceEventEmitter, Image, NativeModules} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

import {PluginManager, PluginCommAPI, PluginFileAPI, EventType} from 'sn-plugin-lib';
import {loadShortcuts, findShortcut, shortcutsForPage, shortcutId, findById} from './shortcuts';

AppRegistry.registerComponent(appName, () => App);

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

// ----- Finger-tap path: transparent SYSTEM_ALERT_WINDOW overlays -----------

const Overlay = NativeModules.FolderLinkOverlay;
let lastContextKey = '';

// Lasso rects come back in page coords. On a Manta/Nomad those happen to match
// screen pixels 1:1, but on other Supernote panels the ratio differs. Compute
// the ratio from display metrics and the SDK's page size so overlay rectangles
// land on the right spot regardless of device. Zoom is not handled yet.
const scaleProbe = async (notePath, page) => {
  try {
    const [metrics, pageSizeRes] = await Promise.all([
      Overlay.getDisplayMetrics(),
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

const refreshOverlays = async () => {
  if (!Overlay || typeof Overlay.setOverlays !== 'function') return;
  try {
    const [pageRes, pathRes] = await Promise.all([
      PluginCommAPI.getCurrentPageNum(),
      PluginCommAPI.getCurrentFilePath(),
    ]);
    const page = unwrap(pageRes);
    const notePath = unwrap(pathRes);
    const key = `${notePath}#${page}`;
    if (key === lastContextKey) return;
    lastContextKey = key;

    if (typeof notePath !== 'string' || typeof page !== 'number') {
      await Overlay.setOverlays([]);
      return;
    }
    const scale = await scaleProbe(notePath, page);
    const overlays = shortcutsForPage(notePath, page).map((s) => ({
      id: shortcutId(s),
      x: Math.round(s.left * scale.x),
      y: Math.round(s.top * scale.y),
      width: Math.round((s.right - s.left) * scale.x),
      height: Math.round((s.bottom - s.top) * scale.y),
    }));
    await Overlay.setOverlays(overlays);
  } catch (e) {
    console.log('[folder-link] refreshOverlays error:', e?.message ?? String(e));
  }
};

loadShortcuts()
  .then(() => refreshOverlays())
  .catch((e) => {
    console.log('[folder-link] loadShortcuts error:', e?.message ?? String(e));
    refreshOverlays();
  });

// Force a re-install after the plugin view saves a new shortcut, even when
// the note+page context is unchanged.
DeviceEventEmitter.addListener('folderLinkShortcutsChanged', () => {
  lastContextKey = '';
  refreshOverlays();
});

// Finger tap on a shortcut overlay → open the matching folder.
const openFolder = async (folderPath) => {
  if (Overlay && typeof Overlay.openFolder === 'function') {
    return Overlay.openFolder(folderPath);
  }
  throw new Error('FolderLinkOverlay.openFolder unavailable');
};

DeviceEventEmitter.addListener('folderLinkOverlayTap', async (e) => {
  const match = e?.id ? findById(e.id) : undefined;
  if (!match) return;
  try {
    console.log(`[folder-link] overlay-tap openFolder("${match.folderPath}")`);
    await openFolder(match.folderPath);
  } catch (err) {
    console.log('[folder-link] openFolder error:', err?.message ?? String(err));
  }
});

// Re-install overlays when the user navigates to a different note or page.
// No-op when context is unchanged.
setInterval(refreshOverlays, 1500);

// ----- Pen-tap path: PEN_UP + delete ink + openFilePath --------------------

const extractTapPoint = (el) => {
  const r = el?.recognizeResult;
  if (!r) return null;
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
    if (!accessor || typeof accessor.size !== 'function') return true;
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
  if (!uuid) return;
  handledUuids.add(uuid);
  if (handledUuids.size > 200) {
    const tail = Array.from(handledUuids).slice(-100);
    handledUuids.clear();
    for (const u of tail) handledUuids.add(u);
  }
};

PluginManager.registerEventListener(EventType.PEN_UP, 0, {
  onMsg: async (data) => {
    try {
      const el = (Array.isArray(data) ? data : []).find((e) => e && extractTapPoint(e));
      if (!el) return;
      if (el.uuid && handledUuids.has(el.uuid)) return;
      rememberHandled(el.uuid);

      if (!(await isTapStroke(el))) return;
      const tap = extractTapPoint(el);

      const [pageRes, pathRes] = await Promise.all([
        PluginCommAPI.getCurrentPageNum(),
        PluginCommAPI.getCurrentFilePath(),
      ]);
      const page = unwrap(pageRes);
      const notePath = unwrap(pathRes);
      if (typeof notePath !== 'string' || typeof page !== 'number') return;

      const match = findShortcut(notePath, page, tap.x, tap.y);
      if (!match) return;

      if (typeof el.numInPage === 'number') {
        try {
          await PluginFileAPI.deleteElements(notePath, page, [el.numInPage]);
        } catch (e) {
          console.log('[folder-link] deleteElements error:', e?.message ?? String(e));
        }
      }

      console.log(`[folder-link] pen_up openFolder("${match.folderPath}")`);
      try {
        await openFolder(match.folderPath);
      } catch (err) {
        console.log('[folder-link] openFolder error:', err?.message ?? String(err));
      }
    } catch (e) {
      console.log('[folder-link] PEN_UP handler error:', e?.message ?? String(e));
    }
  },
});
