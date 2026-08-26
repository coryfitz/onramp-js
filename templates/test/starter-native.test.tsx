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
  act(() => {
    tree?.unmount();
  });
}

describe.each([false, true])('starter native layout (compact=%s)', compact => {
  test('renders both starter routes without native text or style warnings', () => {
    mockCompactLayout = compact;
    const nativeProblems: string[] = [];
    const recordProblem = (...args: unknown[]) => {
      const message = messageFrom(args);
      if (nativeProblemPatterns.some(pattern => pattern.test(message))) {
        nativeProblems.push(message);
      }
    };
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(recordProblem);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(recordProblem);

    try {
      render(<HomePage />);
      render(<ProfilePage id="ada" />);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(nativeProblems).toEqual([]);
  });
});
