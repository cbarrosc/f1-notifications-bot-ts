export interface RuntimeConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  telegramToken: string;
  secretToken: string;
  openF1BaseUrl: string;
  disableWeeklyDigestWindow: boolean;
  disableSessionReminderWindow: boolean;
  disablePostRaceBriefingWindow: boolean;
  dispatcherV2DryRun: boolean;
  dispatcherV2BatchSize: number;
  dispatcherV2Allowlist: number[];
}

export function getRuntimeConfig(): RuntimeConfig {
  return {
    supabaseUrl: requireEnvWithFallback('APP_SUPABASE_URL', 'SUPABASE_URL'),
    supabaseServiceRoleKey: requireEnvWithFallback(
      'APP_SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
    ),
    telegramToken: requireEnv('TELEGRAM_TOKEN'),
    secretToken: requireEnv('SECRET_TOKEN'),
    openF1BaseUrl: Deno.env.get('OPENF1_BASE_URL') ?? 'https://api.openf1.org/v1',
    disableWeeklyDigestWindow: getBooleanEnv('DISABLE_WEEKLY_DIGEST_WINDOW', false),
    disableSessionReminderWindow: getBooleanEnv('DISABLE_SESSION_REMINDER_WINDOW', false),
    disablePostRaceBriefingWindow: getBooleanEnv('DISABLE_POST_RACE_BRIEFING_WINDOW', false),
    dispatcherV2DryRun: getBooleanEnv('DISPATCHER_V2_DRY_RUN', true),
    dispatcherV2BatchSize: getNumericEnv('DISPATCHER_V2_BATCH_SIZE', 25),
    dispatcherV2Allowlist: getIntegerListEnv('DISPATCHER_V2_ALLOWLIST'),
  };
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }

  return value;
}

function requireEnvWithFallback(primaryName: string, fallbackName: string): string {
  const primaryValue = Deno.env.get(primaryName);
  if (primaryValue) {
    return primaryValue;
  }

  const fallbackValue = Deno.env.get(fallbackName);
  if (fallbackValue) {
    return fallbackValue;
  }

  throw new Error(`Missing ${primaryName} or ${fallbackName}.`);
}

function getBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = Deno.env.get(name);
  if (!value) {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function getNumericEnv(name: string, defaultValue: number): number {
  const value = Deno.env.get(name);
  if (!value) {
    return defaultValue;
  }

  const parsedValue = Number.parseInt(value, 10);
  if (Number.isNaN(parsedValue) || parsedValue <= 0) {
    return defaultValue;
  }

  return parsedValue;
}

function getIntegerListEnv(name: string): number[] {
  const value = Deno.env.get(name);
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isFinite(entry));
}
