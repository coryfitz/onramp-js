export interface RuntimeConfigInput {
  appEnvironment?: string;
  apiBaseUrl?: string | Partial<Record<'web' | 'ios' | 'android', string>>;
}

let registeredRuntimeConfig: RuntimeConfigInput | undefined;

export function registerRuntimeConfig(input: RuntimeConfigInput = {}) {
  registeredRuntimeConfig = {...input};
}

export function effectiveRuntimeConfig(
  input: RuntimeConfigInput = {},
): RuntimeConfigInput {
  if (!registeredRuntimeConfig) return input;

  const inputEnvironment = input.appEnvironment?.trim().toLowerCase();
  const registeredEnvironment = registeredRuntimeConfig.appEnvironment
    ?.trim()
    .toLowerCase();
  if (
    inputEnvironment
    && registeredEnvironment
    && inputEnvironment !== registeredEnvironment
  ) {
    // A native build's identity is authoritative across environments. This
    // prevents a stale generated development file from redirecting a release
    // build, while same-environment registration can still carry a newly
    // selected local backend port into a reused development binary.
    return input;
  }

  // The entrypoint registers the latest generated configuration, including a
  // backend port selected after the native app was compiled. Treat it as the
  // authority so stale iOS initialProperties or Android launch options cannot
  // route a reused development build to an old backend process.
  return registeredRuntimeConfig;
}
