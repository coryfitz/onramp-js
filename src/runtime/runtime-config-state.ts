export interface RuntimeConfigInput {
  appEnvironment?: string;
  apiBaseUrl?: string | Partial<Record<'web' | 'ios' | 'android', string>>;
}

let registeredRuntimeConfig: RuntimeConfigInput = {};

export function registerRuntimeConfig(input: RuntimeConfigInput = {}) {
  registeredRuntimeConfig = {...input};
}

export function effectiveRuntimeConfig(
  input: RuntimeConfigInput = {},
): RuntimeConfigInput {
  if (input.appEnvironment !== undefined || input.apiBaseUrl !== undefined) {
    return input;
  }
  return registeredRuntimeConfig;
}
