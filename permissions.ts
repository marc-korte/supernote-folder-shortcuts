import {PluginManager} from 'sn-plugin-lib';

export const FILE_READ_PERMISSION = 'plugin.permission.FILE:READ';
export const FILE_WRITE_PERMISSION = 'plugin.permission.FILE:WRITE';

type PermissionSpec = {
  name: string;
  description: string;
};

export type FilePermissionResult =
  | {granted: true; legacyHost?: boolean}
  | {granted: false; permission: string; message: string};

const REQUIRED_FILE_PERMISSIONS: PermissionSpec[] = [
  {
    name: FILE_READ_PERMISSION,
    description:
      'Folder Shortcuts needs read access to browse folders and find folder links in your notes.',
  },
  {
    name: FILE_WRITE_PERMISSION,
    description:
      'Folder Shortcuts needs write access to add a folder link to the lassoed note content.',
  },
];

/** Status 0 is denied; 1 is session access; 2 is persistent access. */
export const permissionGranted = (status: number): boolean =>
  status === 1 || status === 2;

/**
 * SDK 0.1.65 exposes the permission methods in JavaScript, but firmware older
 * than Chauvet 3.29.43 has no matching native methods. Those releases did not
 * enforce plugin file permissions, so an absent native API means "legacy host"
 * rather than "permission denied".
 */
const permissionApiUnavailable = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /hasPermission|requestPermission/i.test(message) &&
    /not a function|undefined|not implemented|unavailable|unknown method/i.test(message);
};

let requestInFlight: Promise<FilePermissionResult> | null = null;

/** Check read access without showing a permission dialog. */
export const hasFileReadPermission = async (): Promise<boolean> => {
  try {
    return permissionGranted(
      await PluginManager.hasPermission(FILE_READ_PERMISSION),
    );
  } catch (error) {
    if (permissionApiUnavailable(error)) {return true;}
    throw error;
  }
};

/**
 * Check and, if necessary, request every permission the picker needs.
 *
 * The single-flight guard matters on first open: the React view can mount at
 * the same time as the host delivers its button-open event. Without it, both
 * paths can ask the host to present the same permission dialog.
 */
export const ensureFilePermissions = (): Promise<FilePermissionResult> => {
  if (requestInFlight) {return requestInFlight;}

  const flow = (async (): Promise<FilePermissionResult> => {
    for (const permission of REQUIRED_FILE_PERMISSIONS) {
      let status: number;
      try {
        status = await PluginManager.hasPermission(permission.name);
      } catch (error) {
        if (permissionApiUnavailable(error)) {
          return {granted: true, legacyHost: true};
        }
        return {
          granted: false,
          permission: permission.name,
          message: error instanceof Error ? error.message : String(error),
        };
      }

      if (permissionGranted(status)) {continue;}

      try {
        status = await PluginManager.requestPermission(
          permission.name,
          permission.description,
        );
      } catch (error) {
        if (permissionApiUnavailable(error)) {
          return {granted: true, legacyHost: true};
        }
        return {
          granted: false,
          permission: permission.name,
          message: error instanceof Error ? error.message : String(error),
        };
      }

      if (!permissionGranted(status)) {
        return {
          granted: false,
          permission: permission.name,
          message: 'Permission was not granted.',
        };
      }
    }

    return {granted: true};
  })();
  const settled = flow.finally(() => {
    requestInFlight = null;
  });
  requestInFlight = settled;
  return settled;
};
