export function normalizeAccountEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeAccountCode(value: string): string {
  return value.replace(/\D/g, '').slice(0, 6);
}

export function accountUiErrorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'The request could not be completed.';
}
