import {Platform} from 'react-native';

export type RuntimePlatform = 'web' | 'ios' | 'android';

export const runtimePlatform = Platform.OS as RuntimePlatform;
