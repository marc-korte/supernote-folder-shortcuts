/**
 * Regression cover for who owns the link button across a delayed close.
 *
 * The button is held disabled from the moment a link starts until the picker
 * has finished closing, so a second press cannot put a second link on the same
 * strokes. That claim is handed back by whichever step finishes last, and the
 * close the user cancels is the one step that can go missing.
 */

import React from 'react';
import {DeviceEventEmitter, Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';

const mockClosePluginView = jest.fn();
const mockSetLassoStrokeLink = jest.fn();

jest.mock('sn-plugin-lib', () => ({
  FileUtils: {listFiles: jest.fn(async () => [])},
  PluginCommAPI: {
    getLassoRect: jest.fn(async () => ({result: {left: 1, top: 1, right: 9, bottom: 9}})),
    getCurrentPageNum: jest.fn(async () => ({result: 0})),
    getCurrentFilePath: jest.fn(async () => ({result: '/storage/emulated/0/Note/t.note'})),
    recycleElement: jest.fn(),
    clearElementCache: jest.fn(),
  },
  PluginManager: {
    closePluginView: (...a: any[]) => mockClosePluginView(...a),
    hasPermission: jest.fn(async () => 1),
    requestPermission: jest.fn(async () => 1),
  },
  PluginNoteAPI: {setLassoStrokeLink: (...a: any[]) => mockSetLassoStrokeLink(...a)},
  PluginFileAPI: {getElements: jest.fn(async () => ({result: []}))},
}));

import App from '../App';

/** The Pressable wrapping the given label, found the way a user finds it. */
const buttonFor = (tree: any, label: string) => {
  const text = tree.root
    .findAllByType(Text)
    .find((t: any) => typeof t.props.children === 'string' && t.props.children.includes(label));
  let node: any = text;
  while (node && !node.props?.onPress) {node = node.parent;}
  if (!node) {throw new Error(`no pressable for ${label}`);}
  return node;
};

const linkButton = (tree: any) => buttonFor(tree, 'Link lasso → this folder');
const closeButton = (tree: any) => buttonFor(tree, '✕');
const viewEvents = (emit: jest.SpyInstance) =>
  emit.mock.calls
    .map(call => call[0])
    .filter(name => name === 'folderLinkViewClosed' || name === 'folderLinkViewOpened');

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const press = async (node: any) => {
  await act(async () => {
    node.props.onPress();
  });
  await flush();
};

let tree: any;

beforeEach(async () => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockSetLassoStrokeLink.mockResolvedValue({success: true});
  mockClosePluginView.mockResolvedValue(undefined);
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await flush();
});

afterEach(() => {
  if (tree) {
    act(() => tree.unmount());
    tree = null;
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('a refused close hands the button back instead of stranding it', async () => {
  // The close the user cancels is the step that would have released the claim,
  // and a rejected closePluginView leaves the picker on screen — so nothing
  // else is coming. Before this was handled the button stayed disabled for the
  // life of the JS context.
  mockClosePluginView.mockRejectedValue(new Error('host refused'));
  const emit = jest.spyOn(DeviceEventEmitter, 'emit');

  await press(linkButton(tree));
  expect(mockSetLassoStrokeLink).toHaveBeenCalledTimes(1);
  expect(linkButton(tree).props.disabled).toBe(true);

  await press(closeButton(tree));

  expect(linkButton(tree).props.disabled).toBe(false);
  expect(viewEvents(emit).slice(-2)).toEqual([
    'folderLinkViewClosed',
    'folderLinkViewOpened',
  ]);
  await press(linkButton(tree));
  expect(mockSetLassoStrokeLink).toHaveBeenCalledTimes(2);
});

test('an automatic close refusal restores the visible picker state', async () => {
  mockClosePluginView.mockRejectedValue(new Error('host refused'));
  const emit = jest.spyOn(DeviceEventEmitter, 'emit');

  await press(linkButton(tree));
  expect(linkButton(tree).props.disabled).toBe(true);

  await act(async () => {
    jest.advanceTimersByTime(600);
    await Promise.resolve();
  });
  await flush();

  expect(mockClosePluginView).toHaveBeenCalledTimes(1);
  expect(linkButton(tree).props.disabled).toBe(false);
  expect(viewEvents(emit).slice(-2)).toEqual([
    'folderLinkViewClosed',
    'folderLinkViewOpened',
  ]);
});

test('closing mid-flight keeps the claim, so no second link joins the first', async () => {
  // Ownership is only handed to the closer once the native calls are done. A
  // press that lands while setLassoStrokeLink is still out must leave the claim
  // where it is, or the retry writes a second link onto the same strokes.
  let resolveLink: (v: any) => void = () => {};
  mockSetLassoStrokeLink.mockImplementation(
    () => new Promise(res => {resolveLink = res;}),
  );

  await press(linkButton(tree));
  expect(mockSetLassoStrokeLink).toHaveBeenCalledTimes(1);

  await press(closeButton(tree));
  expect(linkButton(tree).props.disabled).toBe(true);

  // The host announces the picker again after a successful close/reopen. That
  // visit boundary must not release a native link operation still in flight.
  act(() => DeviceEventEmitter.emit('folderLinkViewOpened'));
  expect(linkButton(tree).props.disabled).toBe(true);

  await press(linkButton(tree));
  expect(mockSetLassoStrokeLink).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveLink({success: true});
  });
  await flush();
});

test('unmount cancels a scheduled close instead of firing into a dead view', async () => {
  await press(linkButton(tree));
  expect(linkButton(tree).props.disabled).toBe(true);

  act(() => tree.unmount());
  tree = null;
  act(() => jest.advanceTimersByTime(600));
  await flush();

  expect(mockClosePluginView).not.toHaveBeenCalled();
});
