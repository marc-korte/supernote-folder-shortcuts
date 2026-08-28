const mockHasPermission = jest.fn();
const mockRequestPermission = jest.fn();

jest.mock('sn-plugin-lib', () => ({
  PluginManager: {
    hasPermission: (...args: any[]) => mockHasPermission(...args),
    requestPermission: (...args: any[]) => mockRequestPermission(...args),
  },
}));

import {
  ensureFilePermissions,
  FILE_READ_PERMISSION,
  FILE_WRITE_PERMISSION,
  hasFileReadPermission,
  permissionGranted,
} from '../permissions';

beforeEach(() => {
  jest.clearAllMocks();
});

test('recognizes check and request success values', () => {
  expect(permissionGranted(0)).toBe(false);
  expect(permissionGranted(-1)).toBe(false);
  expect(permissionGranted(1)).toBe(true);
  expect(permissionGranted(2)).toBe(true);
});

test('uses already-granted read and write permissions without prompting', async () => {
  mockHasPermission.mockResolvedValue(1);

  await expect(ensureFilePermissions()).resolves.toEqual({granted: true});

  expect(mockHasPermission.mock.calls.map(call => call[0])).toEqual([
    FILE_READ_PERMISSION,
    FILE_WRITE_PERMISSION,
  ]);
  expect(mockRequestPermission).not.toHaveBeenCalled();
});

test('requests each missing permission in order', async () => {
  mockHasPermission.mockResolvedValue(0);
  mockRequestPermission
    .mockResolvedValueOnce(1)
    .mockResolvedValueOnce(2);

  await expect(ensureFilePermissions()).resolves.toEqual({granted: true});

  expect(mockRequestPermission.mock.calls.map(call => call[0])).toEqual([
    FILE_READ_PERMISSION,
    FILE_WRITE_PERMISSION,
  ]);
});

test('stops when the user denies read access', async () => {
  mockHasPermission.mockResolvedValue(0);
  mockRequestPermission.mockResolvedValue(0);

  await expect(ensureFilePermissions()).resolves.toMatchObject({
    granted: false,
    permission: FILE_READ_PERMISSION,
  });

  expect(mockRequestPermission).toHaveBeenCalledTimes(1);
});

test('shares one permission flow across simultaneous picker-open signals', async () => {
  let finishCheck: (status: number) => void = () => undefined;
  mockHasPermission
    .mockReturnValueOnce(new Promise(resolve => {finishCheck = resolve;}))
    .mockResolvedValueOnce(1);

  const first = ensureFilePermissions();
  const second = ensureFilePermissions();
  expect(first).toBe(second);

  finishCheck(1);
  await expect(Promise.all([first, second])).resolves.toEqual([
    {granted: true},
    {granted: true},
  ]);
  expect(mockHasPermission).toHaveBeenCalledTimes(2);
});

test('treats an absent permission API as a pre-.43 host', async () => {
  mockHasPermission.mockRejectedValue(
    new Error('NativePluginManager.hasPermission is not a function (it is undefined)'),
  );

  await expect(hasFileReadPermission()).resolves.toBe(true);
  await expect(ensureFilePermissions()).resolves.toEqual({
    granted: true,
    legacyHost: true,
  });
});
