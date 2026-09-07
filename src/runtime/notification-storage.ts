import {createNotificationContactStorage} from '../notification-storage';
import {getSecureValue, removeSecureValue, setSecureValue} from './secure-storage';

export type {NotificationContact} from '../notification-storage';

export const {
  getNotificationContact,
  saveNotificationContact,
  clearNotificationContact,
  clearAllNotificationContacts,
} = createNotificationContactStorage({
  storage: {getSecureValue, removeSecureValue, setSecureValue},
});
