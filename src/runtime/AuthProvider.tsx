import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  deleteAccount as deleteRemoteAccount,
  loadAccount,
  logoutAccount,
  OnRampApiError,
  requestAccountCode as requestRemoteAccountCode,
  requestAccountDeletion,
  verifyAccountCode as verifyRemoteAccountCode,
  type AuthIntent,
  type OnRampAccount,
} from './auth-client';
import {
  getAccountSession,
  removeAccountSession,
  saveAccountSession,
  usesCookieSession,
} from './auth-storage';
import {useRuntimeConfig} from './RuntimeConfig';

interface AccountContextValue {
  account: OnRampAccount | null;
  sessionToken: string | null;
  loading: boolean;
  requestCode(email: string, intent: AuthIntent): Promise<void>;
  verifyCode(email: string, code: string, intent: AuthIntent): Promise<void>;
  signOut(): Promise<void>;
  requestDeletionCode(): Promise<void>;
  deleteAccount(code: string): Promise<number>;
}

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({children}: {children: React.ReactNode}) {
  const {apiBaseUrl} = useRuntimeConfig();
  const [account, setAccount] = useState<OnRampAccount | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const context = useMemo(
    () => ({apiBaseUrl, sessionToken, cookieSession: usesCookieSession}),
    [apiBaseUrl, sessionToken],
  );

  useEffect(() => {
    let active = true;
    async function restore() {
      try {
        const token = await getAccountSession();
        if (!apiBaseUrl) return;
        if (!token && !usesCookieSession) return;
        const response = await loadAccount({
          apiBaseUrl,
          sessionToken: token,
          cookieSession: usesCookieSession,
        });
        if (!active) return;
        setSessionToken(token);
        setAccount(response.account);
      } catch (error) {
        if (error instanceof OnRampApiError && error.status === 401) {
          await removeAccountSession();
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void restore();
    return () => {
      active = false;
    };
  }, [apiBaseUrl]);

  const requestCode = useCallback(
    async (email: string, intent: AuthIntent) => {
      await requestRemoteAccountCode(context, email, intent);
    },
    [context],
  );

  const verifyCode = useCallback(
    async (email: string, code: string, intent: AuthIntent) => {
      const response = await verifyRemoteAccountCode(context, email, code, intent);
      if (response.session_token) {
        await saveAccountSession(response.session_token);
        setSessionToken(response.session_token);
      }
      setAccount(response.account);
    },
    [context],
  );

  const signOut = useCallback(async () => {
    setAccount(null);
    setSessionToken(null);
    await removeAccountSession();
    try {
      await logoutAccount(context);
    } catch {
      // A local sign-out must still work while the backend is unavailable.
    }
  }, [context]);

  const requestDeletionCode = useCallback(async () => {
    await requestAccountDeletion(context);
  }, [context]);

  const deleteAccount = useCallback(async (code: string) => {
    const response = await deleteRemoteAccount(context, code);
    setAccount(null);
    setSessionToken(null);
    await removeAccountSession();
    return response.anonymized_subscriptions;
  }, [context]);

  const value = useMemo<AccountContextValue>(() => ({
    account,
    sessionToken,
    loading,
    requestCode,
    verifyCode,
    signOut,
    requestDeletionCode,
    deleteAccount,
  }), [
    account,
    sessionToken,
    loading,
    requestCode,
    verifyCode,
    signOut,
    requestDeletionCode,
    deleteAccount,
  ]);

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount() {
  const value = useContext(AccountContext);
  if (!value) throw new Error('useAccount must be used within AccountProvider');
  return value;
}

export * from './auth-client';
