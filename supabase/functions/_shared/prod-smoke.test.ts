const REQUIRED_TEMPLATE_KEYS = [
  'welcome_msg',
  'subscribe_ok',
  'unsubscribe_ok',
  'set_country_msg',
  'timezone_confirmation_text',
  'weekly_summary_msg',
  'session_reminder_msg',
  'post_race_briefing_msg',
  'alert_lead_time',
  'post_race_delta',
];

const REQUIRED_TEMPLATE_ALTERNATIVES = [
  ['already_registered', 'already_registered_msg'],
];

const OPTIONAL_CRITICAL_TEMPLATE_KEYS = [
  'practice_1_reminder_msg',
  'practice_2_reminder_msg',
  'practice_3_reminder_msg',
  'qualifying_reminder_msg',
  'sprint_qualifying_reminder_msg',
  'sprint_reminder_msg',
  'race_reminder_msg',
];

const HEALTH_FUNCTIONS = [
  'telegram-webhook',
  'wake-up',
  'fn-planner-v2',
  'fn-dispatcher-v2',
];

type BotSettingRow = {
  key?: unknown;
  value?: unknown;
};

type UserRow = {
  user_id?: unknown;
  status?: unknown;
};

type DeliveryLogRow = {
  status?: unknown;
  error_message?: unknown;
  created_at?: unknown;
};

Deno.test('prod smoke health endpoints respond without mutation', async () => {
  const config = getProdSmokeConfig();

  for (const functionName of HEALTH_FUNCTIONS) {
    const response = await fetch(`${config.supabaseUrl}/functions/v1/${functionName}`);
    if (!response.ok) {
      throw new Error(
        `${functionName} health check failed with ${response.status}: ${await response.text()}`,
      );
    }
  }
});

Deno.test('prod smoke required bot settings exist and do not use obsolete commands', async () => {
  const config = getProdSmokeConfig();
  const keys = [
    ...REQUIRED_TEMPLATE_KEYS,
    ...REQUIRED_TEMPLATE_ALTERNATIVES.flat(),
    ...OPTIONAL_CRITICAL_TEMPLATE_KEYS,
  ];
  const settings = await restGet<BotSettingRow[]>(
    config,
    '/rest/v1/bot_settings',
    {
      select: 'key,value',
      key: `in.(${keys.join(',')})`,
    },
  );
  const settingByKey = new Map(
    settings.map((setting) => [String(setting.key), setting.value]),
  );
  const missingRequiredKeys = REQUIRED_TEMPLATE_KEYS.filter((key) => !settingByKey.has(key));
  const missingAlternativeGroups = REQUIRED_TEMPLATE_ALTERNATIVES.filter((group) =>
    !group.some((key) => settingByKey.has(key))
  );
  const missingCriticalKeys = OPTIONAL_CRITICAL_TEMPLATE_KEYS.filter((key) =>
    !settingByKey.has(key)
  );

  if (
    missingRequiredKeys.length > 0 || missingAlternativeGroups.length > 0 ||
    missingCriticalKeys.length > 0
  ) {
    throw new Error(
      `Missing bot settings. Required: ${missingRequiredKeys.join(', ') || 'none'}. ` +
        `Alternatives: ${
          missingAlternativeGroups.map((group) => group.join(' or ')).join(', ') || 'none'
        }. Critical: ${missingCriticalKeys.join(', ') || 'none'}.`,
    );
  }

  const obsoleteCommands = [...settingByKey.entries()]
    .filter(([, value]) => typeof value === 'string' && value.includes('/set_timezone'))
    .map(([key]) => key);
  if (obsoleteCommands.length > 0) {
    throw new Error(`Bot settings contain obsolete /set_timezone command: ${obsoleteCommands}`);
  }
});

Deno.test('prod smoke has active users available for notifications', async () => {
  const config = getProdSmokeConfig();
  const activeUsers = await restGet<UserRow[]>(config, '/rest/v1/users', {
    select: 'user_id,status',
    status: 'eq.active',
    limit: '1',
  });

  if (activeUsers.length === 0) {
    throw new Error('Expected at least one active user in production users table.');
  }
});

Deno.test('prod smoke recent delivery logs are not dominated by allowlist skips when disabled', async () => {
  const config = getProdSmokeConfig();
  if (config.allowlistEnabled) {
    return;
  }

  const since = new Date(
    Date.now() - config.deliveryLogLookbackHours * 60 * 60 * 1000,
  ).toISOString();
  const deliveryLogs = await restGet<DeliveryLogRow[]>(config, '/rest/v1/delivery_logs', {
    select: 'status,error_message,created_at',
    created_at: `gte.${since}`,
    order: 'created_at.desc',
    limit: '50',
  });
  if (deliveryLogs.length === 0) {
    return;
  }

  const allowlistSkips = deliveryLogs.filter((entry) =>
    entry.status === 'skipped' &&
    typeof entry.error_message === 'string' &&
    entry.error_message.includes('outside dispatcher allowlist')
  );

  if (allowlistSkips.length > deliveryLogs.length / 2) {
    throw new Error(
      `Recent delivery logs are dominated by allowlist skips: ${allowlistSkips.length}/${deliveryLogs.length}`,
    );
  }
});

function getProdSmokeConfig(): {
  supabaseUrl: string;
  serviceRoleKey: string;
  allowlistEnabled: boolean;
  deliveryLogLookbackHours: number;
} {
  const supabaseUrl = readEnvWithFallback('APP_SUPABASE_URL', 'SUPABASE_URL');
  const serviceRoleKey = readEnvWithFallback(
    'APP_SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  );

  return {
    supabaseUrl: supabaseUrl.replace(/\/$/, ''),
    serviceRoleKey,
    allowlistEnabled: parseBooleanEnv('DISPATCHER_V2_ALLOWLIST_ENABLED', false),
    deliveryLogLookbackHours: parseNumericEnv('PROD_SMOKE_DELIVERY_LOG_LOOKBACK_HOURS', 2),
  };
}

async function restGet<T>(
  config: { supabaseUrl: string; serviceRoleKey: string },
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(`${config.supabaseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
    },
  });
  if (!response.ok) {
    throw new Error(
      `REST read failed for ${path} with ${response.status}: ${await response.text()}`,
    );
  }

  return await response.json() as T;
}

function readEnvWithFallback(primaryName: string, fallbackName: string): string {
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

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = Deno.env.get(name);
  if (!value) {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseNumericEnv(name: string, defaultValue: number): number {
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
