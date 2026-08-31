import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockNavigate = jest.fn();
let mockCompactLayout = false;

jest.mock('../src/brand-image', () => ({
  brandLockup: 'brand-lockup.png',
  brandMark: 'brand-mark.png',
}));
jest.mock('../src/navigation/NavigationProvider', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));
jest.mock('../src/use-compact-layout', () => ({
  useCompactLayout: () => mockCompactLayout,
}));

import HomePage from '../app/index';
import ProfilePage from '../app/profile/[id]';

const nativeProblemPatterns = [
  /Text strings must be rendered within a <Text>/i,
  /unsupported style value/i,
  /Percentage values can only be used with.*boxSizing/i,
];

function messageFrom(args: unknown[]) {
  return args.map(value => String(value)).join(' ');
}

function render(element: React.ReactElement) {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(element);
  });
  if (!tree) {
    throw new Error('Native starter failed to render');
  }
  return tree;
}

function unmount(tree: TestRenderer.ReactTestRenderer) {
  act(() => {
    tree.unmount();
  });
}

function mergedStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(mergedStyle));
  }
  return style && typeof style === 'object'
    ? style as Record<string, unknown>
    : {};
}

function expectStarterScreenStyle(
  tree: TestRenderer.ReactTestRenderer,
  expectedPadding: number,
) {
  const renderedStyles = tree.root
    .findAll(instance => instance.props.style != null)
    .map(instance => mergedStyle(instance.props.style));

  expect(renderedStyles).toEqual(expect.arrayContaining([
    expect.objectContaining({
      backgroundColor: '#F4F7FC',
      padding: expectedPadding,
    }),
  ]));
}

describe.each([false, true])('starter native layout (compact=%s)', compact => {
  test('renders both starter routes without native text or style warnings', () => {
    mockCompactLayout = compact;
    const nativeProblems: string[] = [];
    const trees: TestRenderer.ReactTestRenderer[] = [];
    const recordProblem = (...args: unknown[]) => {
      const message = messageFrom(args);
      if (nativeProblemPatterns.some(pattern => pattern.test(message))) {
        nativeProblems.push(message);
      }
    };
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(recordProblem);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(recordProblem);

    try {
      const home = render(<HomePage />);
      trees.push(home);
      const profile = render(<ProfilePage id="ada" />);
      trees.push(profile);
      expectStarterScreenStyle(home, compact ? 16 : 20);
      expectStarterScreenStyle(profile, compact ? 16 : 20);
    } finally {
      trees.forEach(unmount);
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(nativeProblems).toEqual([]);
  });
});
