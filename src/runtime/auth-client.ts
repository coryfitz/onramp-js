export interface OnRampAccount {
  id: string;
  email: string;
  verified: true;
  audience_type: 'regular' | 'internal' | 'tester';
  roles: string[];
  created_at: string;
}

export type AuthIntent = 'signup' | 'signin';

export class OnRampApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code = 'request_failed') {
    super(message);
    this.name = 'OnRampApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiContext {
  apiBaseUrl: string;
  sessionToken?: string | null;
  cookieSession?: boolean;
  /** Verified-email capability used only for notification intake and revocation. */
  notificationToken?: string | null;
  /** Opt in to receiving a reusable notification capability after email proof. */
  rememberEmail?: boolean;
  /** Client deadline; defaults above OnRamp's 15-second email-provider limit. */
  requestTimeoutMs?: number;
}

export interface NotificationSubscriptionResponse {
  subscription_id: string;
  status: 'verified' | 'unverified';
  verification_required: boolean;
  demand_eligible: boolean;
  suppressed?: boolean;
  /** Proof-gated URL for reviewing or cancelling this one notification. */
  unsubscribe_url?: string;
  unsubscribe_path?: string;
}

export interface VerifiedNotificationSubscriptionResponse {
  subscription_id: string;
  status: 'verified';
  verified: true;
  demand_eligible: boolean;
  /** URL for reviewing or cancelling this one notification. */
  unsubscribe_url: string;
  unsubscribe_path: string;
  /** Present only when remembered-email reuse was requested and granted. */
  notification_token?: string;
  /** Explicit null means no scheduled expiry; absence means no remembered proof. */
  notification_token_expires_at?: string | null;
}

function endpoint(context: ApiContext, path: string) {
  if (!context.apiBaseUrl) {
    throw new Error('This app environment does not have a backend URL configured.');
  }
  return `${context.apiBaseUrl.replace(/\/$/, '')}${path}`;
}

async function request<T>(
  context: ApiContext,
  path: string,
  method = 'GET',
  body?: Record<string, unknown>,
  notificationCapability = false,
): Promise<T> {
  const headers: Record<string, string> = {Accept: 'application/json'};
  if (body) headers['Content-Type'] = 'application/json';
  if (context.sessionToken) {
    headers.Authorization = `Bearer ${context.sessionToken}`;
  }
  if (notificationCapability && context.notificationToken) {
    headers['X-OnRamp-Notification-Token'] = context.notificationToken;
  }
  const controller = new AbortController();
  const timeoutMs = context.requestTimeoutMs ?? 25_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint(context, path), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      credentials: context.cookieSession ? 'include' : 'same-origin',
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new OnRampApiError(
        payload.error || `Request failed (${response.status})`,
        response.status,
        payload.code,
      );
    }
    return payload as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new OnRampApiError(
        'The request timed out. Check your connection and try again.',
        408,
        'request_timeout',
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function requestAccountCode(
  context: ApiContext,
  email: string,
  intent: AuthIntent,
) {
  return request<{email: string; code_sent: true; expires_in_seconds: number}>(
    context,
    '/api/auth/request',
    'POST',
    {email, intent},
  );
}

export function verifyAccountCode(
  context: ApiContext,
  email: string,
  code: string,
  intent: AuthIntent,
) {
  return request<{
    account: OnRampAccount;
    session_token?: string;
    expires_at: string;
  }>(context, '/api/auth/verify', 'POST', {
    email,
    code,
    intent,
    session_mode: context.cookieSession ? 'cookie' : 'bearer',
  });
}

export function loadAccount(context: ApiContext) {
  return request<{account: OnRampAccount}>(context, '/api/account');
}

export function logoutAccount(context: ApiContext) {
  return request<{signed_out: true}>(context, '/api/auth/logout', 'POST');
}

export function requestAccountDeletion(context: ApiContext) {
  return request<{code_sent: true; expires_in_seconds: number}>(
    context,
    '/api/account/delete/request',
    'POST',
  );
}

export function deleteAccount(context: ApiContext, code: string) {
  return request<{deleted: true; anonymized_subscriptions: number}>(
    context,
    '/api/account',
    'DELETE',
    {code},
  );
}

export function requestNotificationSubscription(
  context: ApiContext,
  input: {
    resourceType: string;
    resourceId: string;
    resourceTitle: string;
    source?: string;
    metadata?: Record<string, unknown>;
    email?: string;
    appVersion?: string;
  },
) {
  return request<NotificationSubscriptionResponse>(
    context,
    '/api/notifications/subscriptions',
    'POST',
    {
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      resource_title: input.resourceTitle,
      source: input.source || 'app',
      metadata: input.metadata || {},
      email: input.email,
      app_version: input.appVersion,
    },
    true,
  );
}

export function verifyNotificationSubscription(
  context: ApiContext,
  subscriptionId: string,
  email: string,
  code: string,
) {
  return request<VerifiedNotificationSubscriptionResponse>(
    context,
    '/api/notifications/subscriptions/verify',
    'POST',
    {
      subscription_id: subscriptionId,
      email,
      code,
      ...(context.rememberEmail === true ? {remember_email: true} : {}),
    },
  );
}

/** Revoke this remembered-email capability; existing subscriptions remain. */
export function revokeNotificationContact(context: ApiContext) {
  return request<{revoked: true}>(
    context,
    '/api/notifications/contact/revoke',
    'POST',
    undefined,
    true,
  );
}
