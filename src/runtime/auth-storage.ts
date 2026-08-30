import {
  getSecureValue,
  removeSecureValue,
  setSecureValue,
} from './secure-storage';

const SERVICE = 'onramp.account.session';

export function getAccountSession() {
  return getSecureValue(SERVICE);
}

export function saveAccountSession(token: string) {
  return setSecureValue(SERVICE, token, 'account');
}

export function removeAccountSession() {
  return removeSecureValue(SERVICE);
}

export const usesCookieSession = false;
