import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useAccount, type AccountContextValue } from './AuthProvider';
import { useRuntimeConfig, type AppEnvironment } from './RuntimeConfig';
import {
  accountUiErrorText,
  normalizeAccountCode,
  normalizeAccountEmail,
} from './account-ui-state';

type AuthIntent = 'signup' | 'signin';
type Step = 'email' | 'code' | 'delete-confirm' | 'delete-code';

export interface AccountModalCopy {
  kicker: string;
  signedOutTitle: string;
  signedInTitle: string;
  closeAccessibilityLabel: string;
  signedOutBody: string;
  signedInBody: string;
  deleteTitle: string;
  deleteBody: string;
  deleteAction: string;
  cleanupFailure: string;
}

const defaultCopy: AccountModalCopy = {
  kicker: 'ACCOUNT',
  signedOutTitle: 'Sign in',
  signedInTitle: 'Your account',
  closeAccessibilityLabel: 'Close account',
  signedOutBody:
    'Create an email-only account or sign in without a password. We will send a six-digit verification code.',
  signedInBody:
    'This email has been verified. Your account can be used for features that this app explicitly connects to it.',
  deleteTitle: 'Delete this account?',
  deleteBody:
    'Your account, verified email, sessions, and notification contacts will be deleted. Anonymized operational records may remain without account or contact identifiers.',
  deleteAction: 'DELETE ACCOUNT',
  cleanupFailure:
    "Your account was deleted, but this device could not finish removing app data. Use the app's local-data controls to finish cleanup.",
};

export interface AccountDialogProps {
  visible: boolean;
  onClose(): void;
  accountState: AccountContextValue;
  appEnvironment: AppEnvironment;
  reasonMessage?: string;
  copy?: Partial<AccountModalCopy>;
  developmentCodeHint?: string | null;
  onAccountDeleted?(accountId: string): Promise<void> | void;
  audienceLabel?(audienceType: string): string;
}

export type AccountModalProps = Omit<
  AccountDialogProps,
  'accountState' | 'appEnvironment'
>;

/**
 * Opinionated passwordless account UI backed by AccountProvider and
 * RuntimeConfigProvider. Use AccountDialog when an app needs to inject those
 * values through a compatibility wrapper or test harness.
 */
export function AccountModal(props: AccountModalProps) {
  const accountState = useAccount();
  const { appEnvironment } = useRuntimeConfig();
  return (
    <AccountDialog
      {...props}
      accountState={accountState}
      appEnvironment={appEnvironment}
    />
  );
}

export function AccountDialog({
  visible,
  onClose,
  accountState,
  appEnvironment,
  reasonMessage,
  copy: copyOverrides,
  developmentCodeHint,
  onAccountDeleted,
  audienceLabel,
}: AccountDialogProps) {
  const {
    account,
    requestCode,
    verifyCode,
    signOut,
    requestDeletionCode,
    deleteAccount,
  } = accountState;
  const copy = useMemo(
    () => ({ ...defaultCopy, ...copyOverrides }),
    [copyOverrides],
  );
  const [intent, setIntent] = useState<AuthIntent>('signup');
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cleanupNotice, setCleanupNotice] = useState('');

  useEffect(() => {
    if (!visible) setCleanupNotice('');
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    setStep('email');
    setCode('');
    setError('');
    if (account) setEmail(account.email);
  }, [account, visible]);

  async function sendCode() {
    setBusy(true);
    setError('');
    try {
      const normalizedEmail = normalizeAccountEmail(email);
      await requestCode(normalizedEmail, intent);
      setEmail(normalizedEmail);
      setStep('code');
    } catch (nextError) {
      setError(accountUiErrorText(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function finishAuth() {
    setBusy(true);
    setError('');
    try {
      await verifyCode(email, code, intent);
      setCode('');
    } catch (nextError) {
      setError(accountUiErrorText(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function finishSignOut() {
    setBusy(true);
    setError('');
    try {
      await signOut();
      onClose();
    } catch (nextError) {
      setError(accountUiErrorText(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function startDeletion() {
    setBusy(true);
    setError('');
    try {
      await requestDeletionCode();
      setCode('');
      setStep('delete-code');
    } catch (nextError) {
      setError(accountUiErrorText(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function finishDeletion() {
    setBusy(true);
    setError('');
    try {
      const deletedAccountId = account?.id;
      await deleteAccount(code);
      if (deletedAccountId && onAccountDeleted) {
        try {
          await onAccountDeleted(deletedAccountId);
        } catch {
          setCleanupNotice(copy.cleanupFailure);
          return;
        }
      }
      onClose();
    } catch (nextError) {
      setError(accountUiErrorText(nextError));
    } finally {
      setBusy(false);
    }
  }

  const resolvedDevelopmentHint =
    developmentCodeHint === undefined
      ? appEnvironment === 'development'
        ? 'Development codes are written to .onramp/dev-mail-outbox.jsonl.'
        : ''
      : developmentCodeHint || '';
  const classification =
    account && account.audience_type !== 'regular'
      ? audienceLabel?.(account.audience_type) ||
        `${account.audience_type.toUpperCase()} ACCOUNT`
      : '';

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.root}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.kicker}>{copy.kicker}</Text>
            <Text style={styles.title}>
              {account ? copy.signedInTitle : copy.signedOutTitle}
            </Text>
          </View>
          <Pressable
            accessibilityLabel={copy.closeAccessibilityLabel}
            accessibilityRole="button"
            onPress={onClose}
            style={styles.closeButton}
          >
            <Text style={styles.closeText}>×</Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {cleanupNotice ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {cleanupNotice}
            </Text>
          ) : null}
          {account ? (
            <>
              <View style={styles.accountCard}>
                <Text style={styles.label}>VERIFIED EMAIL</Text>
                <Text style={styles.accountEmail}>{account.email}</Text>
                {classification ? (
                  <View style={styles.classificationBadge}>
                    <Text style={styles.classificationText}>
                      {classification}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.body}>{copy.signedInBody}</Text>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={finishSignOut}
                style={styles.secondaryButton}
              >
                {busy ? (
                  <ActivityIndicator color="#D7FF64" />
                ) : (
                  <Text style={styles.secondaryButtonText}>SIGN OUT</Text>
                )}
              </Pressable>
              {step === 'email' && error ? (
                <Text accessibilityRole="alert" style={styles.error}>
                  {error}
                </Text>
              ) : null}

              {step === 'delete-confirm' ? (
                <View style={styles.dangerPanel}>
                  <Text style={styles.dangerTitle}>{copy.deleteTitle}</Text>
                  <Text style={styles.dangerBody}>{copy.deleteBody}</Text>
                  {error ? (
                    <Text accessibilityRole="alert" style={styles.error}>
                      {error}
                    </Text>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={startDeletion}
                    style={styles.dangerButton}
                  >
                    {busy ? (
                      <ActivityIndicator color="#111611" />
                    ) : (
                      <Text style={styles.dangerButtonText}>
                        SEND DELETION CODE
                      </Text>
                    )}
                  </Pressable>
                  <Pressable
                    onPress={() => setStep('email')}
                    style={styles.linkButton}
                  >
                    <Text style={styles.linkText}>Cancel</Text>
                  </Pressable>
                </View>
              ) : step === 'delete-code' ? (
                <View style={styles.dangerPanel}>
                  <Text style={styles.dangerTitle}>
                    Confirm account deletion
                  </Text>
                  <Text style={styles.dangerBody}>
                    Enter the code sent to {account.email}.
                  </Text>
                  <CodeInput code={code} onChange={setCode} />
                  {resolvedDevelopmentHint ? (
                    <Text style={styles.hint}>{resolvedDevelopmentHint}</Text>
                  ) : null}
                  {error ? (
                    <Text accessibilityRole="alert" style={styles.error}>
                      {error}
                    </Text>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || code.length !== 6}
                    onPress={finishDeletion}
                    style={[
                      styles.dangerButton,
                      (busy || code.length !== 6) && styles.disabled,
                    ]}
                  >
                    {busy ? (
                      <ActivityIndicator color="#111611" />
                    ) : (
                      <Text style={styles.dangerButtonText}>
                        {copy.deleteAction}
                      </Text>
                    )}
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setStep('delete-confirm')}
                  style={styles.deleteLink}
                >
                  <Text style={styles.deleteLinkText}>Delete account</Text>
                </Pressable>
              )}
            </>
          ) : (
            <>
              <Text style={styles.body}>
                {reasonMessage || copy.signedOutBody}
              </Text>
              <View style={styles.segment}>
                {(['signup', 'signin'] as AuthIntent[]).map((value) => (
                  <Pressable
                    key={value}
                    onPress={() => {
                      setIntent(value);
                      setStep('email');
                      setError('');
                    }}
                    style={[
                      styles.segmentButton,
                      intent === value && styles.segmentActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.segmentText,
                        intent === value && styles.segmentTextActive,
                      ]}
                    >
                      {value === 'signup' ? 'CREATE ACCOUNT' : 'SIGN IN'}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {step === 'code' ? (
                <>
                  <Text style={styles.label}>VERIFICATION CODE</Text>
                  <Text style={styles.inputContext}>Sent to {email}</Text>
                  <CodeInput code={code} onChange={setCode} />
                  {resolvedDevelopmentHint ? (
                    <Text style={styles.hint}>{resolvedDevelopmentHint}</Text>
                  ) : null}
                  {error ? (
                    <Text accessibilityRole="alert" style={styles.error}>
                      {error}
                    </Text>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || code.length !== 6}
                    onPress={finishAuth}
                    style={[
                      styles.primaryButton,
                      (busy || code.length !== 6) && styles.disabled,
                    ]}
                  >
                    {busy ? (
                      <ActivityIndicator color="#111611" />
                    ) : (
                      <Text style={styles.primaryButtonText}>
                        {intent === 'signup' ? 'CREATE ACCOUNT' : 'SIGN IN'}
                      </Text>
                    )}
                  </Pressable>
                  <Pressable
                    onPress={() => setStep('email')}
                    style={styles.linkButton}
                  >
                    <Text style={styles.linkText}>Use a different email</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Text style={styles.label}>EMAIL ADDRESS</Text>
                  <TextInput
                    autoCapitalize="none"
                    autoComplete="email"
                    keyboardType="email-address"
                    onChangeText={setEmail}
                    placeholder="you@example.com"
                    placeholderTextColor="#687168"
                    style={styles.input}
                    value={email}
                  />
                  {error ? (
                    <Text accessibilityRole="alert" style={styles.error}>
                      {error}
                    </Text>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || !email.trim()}
                    onPress={sendCode}
                    style={[
                      styles.primaryButton,
                      (busy || !email.trim()) && styles.disabled,
                    ]}
                  >
                    {busy ? (
                      <ActivityIndicator color="#111611" />
                    ) : (
                      <Text style={styles.primaryButtonText}>
                        EMAIL ME A CODE
                      </Text>
                    )}
                  </Pressable>
                </>
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function CodeInput({
  code,
  onChange,
}: {
  code: string;
  onChange(value: string): void;
}) {
  return (
    <TextInput
      accessibilityLabel="Six-digit verification code"
      keyboardType="number-pad"
      maxLength={6}
      onChangeText={(value) => onChange(normalizeAccountCode(value))}
      placeholder="000000"
      placeholderTextColor="#687168"
      style={[styles.input, styles.codeInput]}
      value={code}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#111611' },
  header: {
    alignItems: 'center',
    borderBottomColor: '#293229',
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 18,
  },
  kicker: {
    color: '#8E998F',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  title: { color: '#F3F5EC', fontSize: 24, fontWeight: '800', marginTop: 4 },
  closeButton: {
    alignItems: 'center',
    backgroundColor: '#1D251D',
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  closeText: { color: '#DDE2D7', fontSize: 25, lineHeight: 27 },
  content: { padding: 20, paddingBottom: 54 },
  body: { color: '#9BA59B', fontSize: 13, lineHeight: 20, marginBottom: 22 },
  segment: {
    backgroundColor: '#192019',
    borderRadius: 13,
    flexDirection: 'row',
    marginBottom: 24,
    padding: 4,
  },
  segmentButton: {
    alignItems: 'center',
    borderRadius: 10,
    flex: 1,
    paddingVertical: 11,
  },
  segmentActive: { backgroundColor: '#D7FF64' },
  segmentText: {
    color: '#8E998F',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  segmentTextActive: { color: '#111611' },
  label: {
    color: '#8E998F',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.1,
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#192019',
    borderColor: '#303A30',
    borderRadius: 14,
    borderWidth: 1,
    color: '#F3F5EC',
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  codeInput: {
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: 7,
    textAlign: 'center',
  },
  inputContext: { color: '#B7BFB4', fontSize: 12, marginBottom: 12 },
  hint: { color: '#7F8980', fontSize: 10, lineHeight: 15, marginTop: 9 },
  error: { color: '#FF8C87', fontSize: 12, lineHeight: 17, marginTop: 10 },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#D7FF64',
    borderRadius: 14,
    justifyContent: 'center',
    marginTop: 16,
    minHeight: 48,
    paddingHorizontal: 16,
  },
  primaryButtonText: {
    color: '#111611',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  disabled: { opacity: 0.45 },
  linkButton: { alignItems: 'center', paddingVertical: 15 },
  linkText: { color: '#AAB4A8', fontSize: 12, fontWeight: '700' },
  accountCard: {
    backgroundColor: '#192019',
    borderColor: '#303A30',
    borderRadius: 18,
    borderWidth: 1,
    marginBottom: 18,
    padding: 18,
  },
  accountEmail: { color: '#F3F5EC', fontSize: 18, fontWeight: '700' },
  classificationBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#2A321C',
    borderRadius: 8,
    marginTop: 14,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  classificationText: {
    color: '#D7FF64',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  secondaryButton: {
    alignItems: 'center',
    borderColor: '#3A453A',
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 14,
  },
  secondaryButtonText: {
    color: '#E4E9DF',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  deleteLink: { alignItems: 'center', marginTop: 28, padding: 10 },
  deleteLinkText: { color: '#D77D79', fontSize: 12, fontWeight: '700' },
  dangerPanel: {
    backgroundColor: '#251919',
    borderColor: '#58302E',
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 24,
    padding: 16,
  },
  dangerTitle: { color: '#FF9A95', fontSize: 16, fontWeight: '800' },
  dangerBody: {
    color: '#C4A5A2',
    fontSize: 11,
    lineHeight: 17,
    marginBottom: 15,
    marginTop: 8,
  },
  dangerButton: {
    alignItems: 'center',
    backgroundColor: '#FF8C87',
    borderRadius: 12,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: 14,
  },
  dangerButtonText: {
    color: '#111611',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
});
