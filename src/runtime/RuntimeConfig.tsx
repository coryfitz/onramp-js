import React, {createContext, useContext, useMemo} from 'react';
import {Platform} from 'react-native';

export type AppEnvironment = 'development' | 'staging' | 'production';

export interface RuntimeConfig {
  appEnvironment: AppEnvironment;
  apiBaseUrl: string;
}

interface RuntimeConfigInput {
  appEnvironment?: string;
  apiBaseUrl?: string | Partial<Record<'web' | 'ios' | 'android', string>>;
}

const RuntimeConfigContext = createContext<RuntimeConfig | null>(null);

function developmentApiBaseUrl() {
  return Platform.OS === 'android'
    ? 'http://10.0.2.2:8000'
    : 'http://127.0.0.1:8000';
}

export function resolveRuntimeConfig(input: RuntimeConfigInput = {}): RuntimeConfig {
  const normalized = input.appEnvironment?.trim().toLowerCase();
  const appEnvironment: AppEnvironment =
    normalized === 'staging' || normalized === 'production'
      ? normalized
      : 'development';
  const configuredApiBaseUrl = typeof input.apiBaseUrl === 'string'
    ? input.apiBaseUrl
    : input.apiBaseUrl?.[Platform.OS as 'web' | 'ios' | 'android'];
  const apiBaseUrl = (
    configuredApiBaseUrl ||
    (appEnvironment === 'development' ? developmentApiBaseUrl() : '')
  ).replace(/\/$/, '');
  return {appEnvironment, apiBaseUrl};
}

export function RuntimeConfigProvider({
  children,
  initialConfig,
}: {
  children: React.ReactNode;
  initialConfig?: RuntimeConfigInput;
}) {
  const value = useMemo(
    () => resolveRuntimeConfig(initialConfig),
    [initialConfig],
  );
  return (
    <RuntimeConfigContext.Provider value={value}>
      {children}
    </RuntimeConfigContext.Provider>
  );
}

export function useRuntimeConfig() {
  const value = useContext(RuntimeConfigContext);
  if (!value) {
    throw new Error('useRuntimeConfig must be used within RuntimeConfigProvider');
  }
  return value;
}
