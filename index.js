/**
 * @format
 */

import {AppRegistry, Image} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

import {PluginManager, PluginCommAPI, PluginFileAPI, FileUtils, EventType} from 'sn-plugin-lib';
import {loadShortcuts, findShortcut} from './shortcuts';

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

loadShortcuts();

const unwrap = (res) => (res && typeof res === 'object' && 'result' in res ? res.result : res);

// Only activate the shortcut for small (tap-like) strokes. A lasso gesture is
// a large loop — letting it trigger the open would prevent the user from
// lassoing a linked word to edit/remove the link via the native 3-dots menu.
const TAP_MAX_EXTENT = 60;

const extractTapPoint = (el) => {
  const r = el?.recognizeResult;
  if (!r) return null;
  const hasBox =
    typeof r.up_left_point_x === 'number' &&
    typeof r.down_right_point_x === 'number' &&
    typeof r.up_left_point_y === 'number' &&
    typeof r.down_right_point_y === 'number';
  if (hasBox) {
    const w = r.down_right_point_x - r.up_left_point_x;
    const h = r.down_right_point_y - r.up_left_point_y;
    if (w > TAP_MAX_EXTENT || h > TAP_MAX_EXTENT) return null;
  }
  if (typeof r.key_point_x === 'number' && typeof r.key_point_y === 'number') {
    return {x: r.key_point_x, y: r.key_point_y};
  }
  if (hasBox) {
    return {
      x: (r.up_left_point_x + r.down_right_point_x) / 2,
      y: (r.up_left_point_y + r.down_right_point_y) / 2,
    };
  }
  return null;
};

// The SDK delivers each PEN_UP multiple times. Dedupe by uuid so we only
// delete the stroke + open the folder once per physical tap.
const handledUuids = new Set();

PluginManager.registerEventListener(EventType.PEN_UP, 0, {
  onMsg: async (data) => {
    try {
      const elements = Array.isArray(data) ? data : [];
      const el = elements.find((e) => e && extractTapPoint(e));
      if (!el) return;
      if (el.uuid && handledUuids.has(el.uuid)) return;

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

      if (el.uuid) {
        handledUuids.add(el.uuid);
        if (handledUuids.size > 200) {
          const arr = Array.from(handledUuids);
          handledUuids.clear();
          for (const u of arr.slice(-100)) handledUuids.add(u);
        }
      }

      console.log(
        `[folder-link] match! tap=(${tap.x},${tap.y}) numInPage=${el.numInPage} → ${match.folderPath}`,
      );

      if (typeof el.numInPage === 'number') {
        try {
          const delRes = await PluginFileAPI.deleteElements(notePath, page, [el.numInPage]);
          console.log(`[folder-link] deleteElements result ${JSON.stringify(delRes)}`);
        } catch (e) {
          console.log('[folder-link] deleteElements error:', e?.message ?? String(e));
        }
      }

      const ok = await FileUtils.openFilePath(match.folderPath);
      console.log(`[folder-link] openFilePath resolved=${ok}`);
    } catch (e) {
      console.log('[folder-link] PEN_UP handler error:', e?.message ?? String(e));
    }
  },
});
