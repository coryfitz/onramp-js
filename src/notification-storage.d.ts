import type {SecureStorage} from './runtime/secure-storage';

export interface NotificationContact {
  email: string;
  token: string;
  /** Null means no scheduled expiry; finite dates are backend policy metadata. */
  expiresAt: string | null;
}

export interface NotificationContactStorage {
  /** Restores a well-formed record; the backend decides token validity. */
  getNotificationContact(apiBaseUrl: string): Promise<NotificationContact | null>;
  saveNotificationContact(apiBaseUrl: string, contact: NotificationContact): Promise<void>;
  clearNotificationContact(apiBaseUrl: string): Promise<void>;
  clearAllNotificationContacts(): Promise<void>;
}

export function createNotificationContactStorage(options: {
  storage: Pick<SecureStorage, 'getSecureValue' | 'setSecureValue' | 'removeSecureValue'>;
}): NotificationContactStorage;
