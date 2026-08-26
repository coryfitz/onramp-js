import { useWindowDimensions } from 'react-native';

export function useCompactLayout(breakpoint = 760) {
  return useWindowDimensions().width < breakpoint;
}
