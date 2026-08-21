export interface KeychainAdapter {
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: unknown };
  SECURITY_LEVEL: { SECURE_SOFTWARE: unknown };
  setGenericPassword(
    account: string,
    value: string,
    options: Record<string, unknown>,
  ): Promise<false | unknown>;
  getGenericPassword(
    options: Record<string, unknown>,
  ): Promise<false | { password: string }>;
  resetGenericPassword(options: Record<string, unknown>): Promise<boolean>;
}

export interface SecureStorage {
  setSecureValue(service: string, value: string, account?: string): Promise<void>;
  getSecureValue(service: string): Promise<string | null>;
  removeSecureValue(service: string): Promise<boolean>;
  setSecureJson(service: string, value: unknown, account?: string): Promise<void>;
  getSecureJson<T = unknown>(service: string): Promise<T | null>;
}

export function createSecureStorage(options: {
  keychain: KeychainAdapter;
  platform: 'ios' | 'android' | (() => string);
}): SecureStorage;

export const setSecureValue: SecureStorage['setSecureValue'];
export const getSecureValue: SecureStorage['getSecureValue'];
export const removeSecureValue: SecureStorage['removeSecureValue'];
export const setSecureJson: SecureStorage['setSecureJson'];
export const getSecureJson: SecureStorage['getSecureJson'];
