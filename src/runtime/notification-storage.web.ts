import {createNotificationContactStorage} from '../notification-storage';

export type {NotificationContact} from '../notification-storage';

// Notification capabilities never enter browser persistence. A page reload
// requires fresh proof; the native adapter alone remembers across launches.
let collection: string | null = null;

export const {
  getNotificationContact,
  saveNotificationContact,
  clearNotificationContact,
  clearAllNotificationContacts,
} = createNotificationContactStorage({
  storage: {
    async getSecureValue() {
      return collection;
    },
    async setSecureValue(_service: string, value: string) {
      collection = value;
    },
    async removeSecureValue() {
      collection = null;
      return true;
    },
  },
});
