export interface RuntimeConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  telegramToken: string;
  secretToken: string;
  openF1BaseUrl: string;
  disableWeeklyDigestWindow: boolean;
  disableSessionReminderWindow: boolean;
  disablePostRaceBriefingWindow: boolean;
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
