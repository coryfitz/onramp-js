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

interface ApiContext {
  apiBaseUrl: string;
  sessionToken?: string | null;
  cookieSession?: boolean;
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
): Promise<T> {
  const headers: Record<string, string> = {Accept: 'application/json'};
  if (body) headers['Content-Type'] = 'application/json';
  if (context.sessionToken) {
    headers.Authorization = `Bearer ${context.sessionToken}`;
  }
  const response = await fetch(endpoint(context, path), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: context.cookieSession ? 'include' : 'same-origin',
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
  return request<{
    subscription_id: string;
    status: 'verified' | 'unverified';
    verification_required: boolean;
    demand_eligible: boolean;
  }>(context, '/api/notifications/subscriptions', 'POST', {
    resource_type: input.resourceType,
    resource_id: input.resourceId,
    resource_title: input.resourceTitle,
    source: input.source || 'app',
    metadata: input.metadata || {},
    email: input.email,
    app_version: input.appVersion,
  });
}

export function verifyNotificationSubscription(
  context: ApiContext,
  subscriptionId: string,
  email: string,
  code: string,
) {
  return request<{
    subscription_id: string;
    status: 'verified';
    verified: true;
    demand_eligible: boolean;
  }>(
    context,
    '/api/notifications/subscriptions/verify',
    'POST',
    {subscription_id: subscriptionId, email, code},
  );
}
