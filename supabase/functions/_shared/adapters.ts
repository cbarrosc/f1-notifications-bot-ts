import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@^2.50.0';

import type {
  BotSettings,
  MeetingDetails,
  PodiumFinisher,
  PostRaceBriefing,
  Session,
  User,
  UserStatus,
} from './domain.ts';
import type {
  CountryOption,
  MessagingService,
  NotificationLogRepository,
  SessionProvider,
  SettingsRepository,
  UserRepository,
} from './ports.ts';

const ALLOWED_SESSION_NAMES = new Set([
  'Practice 1',
  'Practice 2',
  'Practice 3',
  'Qualifying',
  'Race',
  'Sprint Qualifying',
  'Sprint',
]);
const logger = console;

type UserRow = {
  user_id?: unknown;
  first_name?: unknown;
  username?: unknown;
  status?: unknown;
  timezone?: unknown;
};

type SettingRow = {
  value?: unknown;
};

type PostgresError = Error & {
  code?: string;
};

type OpenF1SessionRow = {
  session_name?: unknown;
  date_start?: unknown;
  date_end?: unknown;
  session_key?: unknown;
  meeting_key?: unknown;
};

type OpenF1MeetingRow = {
  meeting_official_name?: unknown;
  meeting_name?: unknown;
  location?: unknown;
};

type OpenF1SessionResultRow = {
  position?: unknown;
  driver_number?: unknown;
};

type OpenF1DriverRow = {
  full_name?: unknown;
  team_name?: unknown;
};

export function buildSupabaseClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get('APP_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('APP_SUPABASE_SERVICE_ROLE_KEY') ??
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl) {
    throw new Error('Missing APP_SUPABASE_URL or SUPABASE_URL.');
  }

  if (!serviceRoleKey) {
    throw new Error('Missing APP_SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY.');
  }

  logger.info('Creating shared Supabase client');
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export class SupabaseUserRepository implements UserRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getUser(userId: number): Promise<User | null> {
    logger.info('Fetching user from Supabase', { userId });
    const { data, error } = await this.client
      .from('users')
      .select('user_id, first_name, username, status, timezone')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return mapUserRow(data as UserRow | null | undefined);
  }

  async saveUser(user: User): Promise<void> {
    const existingUser = await this.getUser(user.userId);
    // This preserves status and timezone when /start is called again for an existing user.
    const row = toUserRow({
      ...user,
      status: existingUser?.status ?? user.status,
      timezone: existingUser?.timezone ?? user.timezone,
    });

    logger.info('Upserting user in Supabase', { userId: user.userId });
    const { error } = await this.client.from('users').upsert(row, {
      onConflict: 'user_id',
    });

    if (error) {
      throw error;
    }
  }

  async updateUserStatus(userId: number, status: UserStatus): Promise<void> {
    logger.info('Updating user status in Supabase', { userId, status });
    const { error } = await this.client.from('users').update({ status }).eq('user_id', userId);
    if (error) {
      throw error;
    }
  }

  async updateUserTimezone(userId: number, timezone: string): Promise<void> {
    logger.info('Updating user timezone in Supabase', { userId, timezone });
    const { error } = await this.client.from('users').update({ timezone }).eq('user_id', userId);
    if (error) {
      throw error;
    }
  }

  async listActiveUsers(): Promise<User[]> {
    logger.info('Fetching active users from Supabase');
    const { data, error } = await this.client
      .from('users')
      .select('user_id, first_name, username, status, timezone')
      .eq('status', 'active');

    if (error) {
      throw error;
    }

    if (!Array.isArray(data)) {
      throw new Error('Invalid users response payload.');
    }

    return data
      .map((row) => mapUserRow(row))
      .filter((row): row is User => row !== null);
  }
}

export class SupabaseSettingsRepository implements SettingsRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getValue(key: string): Promise<string> {
    logger.info('Fetching bot setting from Supabase', { key });
    const { data, error } = await this.client
      .from('bot_settings')
      .select('value')
      .eq('key', key)
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    const row = data as SettingRow | null;
    if (!row) {
      throw new Error(`Missing bot setting: ${key}`);
    }

    const value = row.value;
    if (typeof value !== 'string') {
      throw new Error(`Invalid bot setting value for key: ${key}`);
    }

    return value;
  }

  async getBotSettings(): Promise<BotSettings> {
    const [alertLeadTime, postRaceDelta] = await Promise.all([
      this.getOptionalNumericValue('alert_lead_time'),
      this.getOptionalNumericValue('post_race_delta'),
    ]);

    return {
      alertLeadTimeMinutes: alertLeadTime,
      postRaceDeltaMinutes: postRaceDelta,
    };
  }

  private async getOptionalNumericValue(key: string): Promise<number | null> {
    const { data, error } = await this.client
      .from('bot_settings')
      .select('value')
      .eq('key', key)
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    const row = data as SettingRow | null;
    if (!row || row.value == null) {
      return null;
    }

    if (typeof row.value === 'number' && Number.isFinite(row.value)) {
      return row.value;
    }

    if (typeof row.value === 'string' && row.value.trim() !== '') {
      const numericValue = Number(row.value);
      return Number.isFinite(numericValue) ? numericValue : null;
    }

    return null;
  }
}

export class SupabaseNotificationLogRepository implements NotificationLogRepository {
  constructor(private readonly client: SupabaseClient) {}

  async markAsSent(userId: number, notificationKey: string): Promise<boolean> {
    logger.info('Recording notification delivery in Supabase', {
      userId,
      notificationKey,
    });
    const { error } = await this.client.from('notification_deliveries').insert({
      user_id: userId,
      notification_key: notificationKey,
      sent_at: new Date().toISOString(),
    });

    if (!error) {
      return true;
    }

    const postgresError = error as PostgresError;
    if (postgresError.code === '23505') {
      logger.info('Skipping duplicate notification delivery', {
        userId,
        notificationKey,
      });
      return false;
    }

    throw error;
  }

  async unmarkAsSent(userId: number, notificationKey: string): Promise<void> {
    logger.warn('Removing notification delivery mark after downstream failure', {
      userId,
      notificationKey,
    });
    const { error } = await this.client
      .from('notification_deliveries')
      .delete()
      .eq('user_id', userId)
      .eq('notification_key', notificationKey);

    if (error) {
      throw error;
    }
  }
}

export class TelegramMessagingService implements MessagingService {
  private readonly baseUrl: string;

  constructor(private readonly botToken: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.callTelegram('sendMessage', {
      chat_id: chatId,
      text,
    });
  }

  async sendCountryOptions(
    chatId: number,
    text: string,
    options: CountryOption[][],
  ): Promise<void> {
    await this.callTelegram('sendMessage', {
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: options.map((row) =>
          row.map((button) => ({
            text: button.text,
            callback_data: button.callbackData,
          }))
        ),
      },
    });
  }

  async sendSubscribePrompt(
    chatId: number,
    text: string,
    buttonText: string,
    callbackData: string,
  ): Promise<void> {
    await this.callTelegram('sendMessage', {
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [[{ text: buttonText, callback_data: callbackData }]],
      },
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
    await this.callTelegram('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
    await this.callTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
    });
  }

  private async callTelegram(method: string, body: Record<string, unknown>): Promise<void> {
    logger.info('Calling Telegram Bot API', { method });
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Telegram API request failed with status ${response.status}.`);
    }

    const payload = await response.json();
    if (!isTelegramOkResponse(payload)) {
      const description = getTelegramDescription(payload);
      throw new Error(description ?? `Telegram API returned an invalid response for ${method}.`);
    }
  }
}

export class OpenF1SessionProvider implements SessionProvider {
  private readonly meetingDetailsCache = new Map<string, MeetingDetails>();
  private readonly driversBySessionCache = new Map<
    number,
    Map<number, { name: string | null; team: string | null }>
  >();

  constructor(
    private readonly options: {
      baseUrl: string;
      enforcePostRaceBriefingWindow: boolean;
    },
  ) {}

  async getNextSessionAfter(when: Date): Promise<Session | null> {
    logger.info('Fetching next session from OpenF1', { when: when.toISOString() });
    const year = when.getUTCFullYear();
    const sessions = await this.getSessionsForYear(year);
    const upcomingSessions = sessions.filter((session) => session.dateStart > when);

    if (upcomingSessions.length === 0) {
      return null;
    }

    const nextSession = minByDateStart(upcomingSessions);
    const meetingDetails = await this.getMeetingDetails(year, nextSession.meetingKey);
    return enrichSession(nextSession, meetingDetails);
  }

  async getNextRaceAfter(when: Date): Promise<Session | null> {
    logger.info('Fetching next race from OpenF1', { when: when.toISOString() });
    const year = when.getUTCFullYear();
    const sessions = await this.getSessionsForYear(year, 'Race');
    const upcomingRaces = sessions.filter((session) => session.dateStart > when);

    if (upcomingRaces.length === 0) {
      return null;
    }

    const nextRace = minByDateStart(upcomingRaces);
    const meetingDetails = await this.getMeetingDetails(year, nextRace.meetingKey);
    return enrichSession(nextRace, meetingDetails);
  }

  async getPostRaceBriefing(when: Date): Promise<PostRaceBriefing | null> {
    logger.info('Building post-race briefing from OpenF1', { when: when.toISOString() });
    const year = when.getUTCFullYear();
    const sessions = await this.getSessionsForYear(year, 'Race');
    const previousRaces = sessions
      .filter((session) => {
        if (session.dateStart >= when) {
          return false;
        }

        if (!this.options.enforcePostRaceBriefingWindow) {
          return true;
        }

        return session.dateEnd !== null && session.dateEnd <= when;
      })
      .sort((left, right) => right.dateStart.getTime() - left.dateStart.getTime());

    const completedRace = previousRaces[0];
    if (!completedRace?.sessionKey) {
      return null;
    }

    const meetingDetails = await this.getMeetingDetails(year, completedRace.meetingKey);
    const podium = await this.getSessionPodium(completedRace.sessionKey);
    if (podium.length < 3) {
      return null;
    }

    const upcomingRaces = sessions.filter((session) => session.dateStart > when);
    const nextRace = upcomingRaces.length > 0 ? minByDateStart(upcomingRaces) : null;
    const nextMeeting = nextRace
      ? await this.getMeetingDetails(year, nextRace.meetingKey)
      : { name: null, shortName: null, location: null };

    return {
      completedRace: enrichSession(completedRace, meetingDetails),
      podium: [podium[0], podium[1], podium[2]],
      nextGrandPrix: nextMeeting.shortName ?? nextMeeting.name,
      daysLeft: nextRace ? diffInUtcDays(nextRace.dateStart, when) : null,
    };
  }

  getSourceName(): string {
    return 'OpenF1';
  }

  private async getSessionsForYear(year: number, sessionName?: string): Promise<Session[]> {
    logger.info('Fetching OpenF1 sessions', { year, sessionName: sessionName ?? null });
    const params = new URLSearchParams({ year: String(year) });
    if (sessionName) {
      params.set('session_name', sessionName);
    }

    const payload = await this.fetchJson(
      `${this.options.baseUrl.replace(/\/$/, '')}/sessions?${params.toString()}`,
      'Invalid OpenF1 response payload.',
    );

    if (!Array.isArray(payload)) {
      throw new Error('Invalid OpenF1 response payload.');
    }

    const sessions: Session[] = [];
    for (const row of payload) {
      const session = mapOpenF1SessionRow(row);
      if (session) {
        sessions.push(session);
      }
    }

    return sessions;
  }

  private async getMeetingDetails(
    year: number,
    meetingKey: number | null,
  ): Promise<MeetingDetails> {
    if (meetingKey === null) {
      return {
        name: null,
        shortName: null,
        location: null,
      };
    }

    const cacheKey = `${year}:${meetingKey}`;
    const cachedDetails = this.meetingDetailsCache.get(cacheKey);
    if (cachedDetails) {
      logger.info('Using cached OpenF1 meeting details', { year, meetingKey });
      return cachedDetails;
    }

    logger.info('Fetching OpenF1 meeting details', { year, meetingKey });
    const params = new URLSearchParams({
      year: String(year),
      meeting_key: String(meetingKey),
    });

    const payload = await this.fetchJson(
      `${this.options.baseUrl.replace(/\/$/, '')}/meetings?${params.toString()}`,
      'Invalid OpenF1 meetings payload.',
    );

    if (!Array.isArray(payload)) {
      throw new Error('Invalid OpenF1 meetings payload.');
    }

    for (const row of payload) {
      if (!isRecord(row)) {
        continue;
      }

      const meetingRow = row as OpenF1MeetingRow;
      const officialName = asNonEmptyString(meetingRow.meeting_official_name);
      const meetingName = asNonEmptyString(meetingRow.meeting_name);
      const location = asNonEmptyString(meetingRow.location);

      const details = {
        name: officialName ?? meetingName,
        shortName: meetingName,
        location,
      };
      this.meetingDetailsCache.set(cacheKey, details);
      return details;
    }

    const details = {
      name: null,
      shortName: null,
      location: null,
    };
    this.meetingDetailsCache.set(cacheKey, details);
    return details;
  }

  private async getSessionPodium(sessionKey: number): Promise<PodiumFinisher[]> {
    logger.info('Fetching OpenF1 session podium', { sessionKey });
    const params = new URLSearchParams({
      session_key: String(sessionKey),
      'position<': '3',
    });

    const payload = await this.fetchJson(
      `${this.options.baseUrl.replace(/\/$/, '')}/session_result?${params.toString()}`,
      'Invalid OpenF1 session results payload.',
    );

    if (!Array.isArray(payload)) {
      throw new Error('Invalid OpenF1 session results payload.');
    }

    const driversByNumber = await this.getDriversBySession(sessionKey);
    const podium: PodiumFinisher[] = [];
    for (const row of payload) {
      if (!isRecord(row)) {
        continue;
      }

      const resultRow = row as OpenF1SessionResultRow;
      if (typeof resultRow.position !== 'number' || typeof resultRow.driver_number !== 'number') {
        continue;
      }

      const driverDetails = driversByNumber.get(resultRow.driver_number) ?? {
        name: null,
        team: null,
      };
      podium.push({
        position: resultRow.position,
        driverName: driverDetails.name ?? String(resultRow.driver_number),
        teamName: driverDetails.team ?? 'TBC',
      });
    }

    podium.sort((left, right) => left.position - right.position);
    return podium;
  }

  private async getDriversBySession(
    sessionKey: number,
  ): Promise<Map<number, { name: string | null; team: string | null }>> {
    const cachedDrivers = this.driversBySessionCache.get(sessionKey);
    if (cachedDrivers) {
      logger.info('Using cached OpenF1 drivers for session', { sessionKey });
      return cachedDrivers;
    }

    logger.info('Fetching OpenF1 drivers for session', { sessionKey });
    const params = new URLSearchParams({
      session_key: String(sessionKey),
    });

    const payload = await this.fetchJson(
      `${this.options.baseUrl.replace(/\/$/, '')}/drivers?${params.toString()}`,
      'Invalid OpenF1 drivers payload.',
    );

    if (!Array.isArray(payload)) {
      throw new Error('Invalid OpenF1 drivers payload.');
    }

    const driversByNumber = new Map<number, { name: string | null; team: string | null }>();
    for (const row of payload) {
      if (!isRecord(row)) {
        continue;
      }

      const driverRow = row as OpenF1DriverRow;
      if (typeof row.driver_number !== 'number') {
        continue;
      }

      driversByNumber.set(row.driver_number, {
        name: asNonEmptyString(driverRow.full_name),
        team: asNonEmptyString(driverRow.team_name),
      });
    }

    this.driversBySessionCache.set(sessionKey, driversByNumber);
    return driversByNumber;
  }

  private async fetchJson(url: string, defaultMessage: string): Promise<unknown> {
    // OpenF1 can transiently return 429 under bursty access, so retry a couple of times.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      logger.info('Calling OpenF1 API', { url, attempt });
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
        },
      });

      if (response.ok) {
        try {
          return await response.json();
        } catch {
          throw new Error(defaultMessage);
        }
      }

      if (response.status === 429 && attempt < 3) {
        logger.warn('OpenF1 rate limit hit, retrying request', { url, attempt });
        await delay(attempt * 300);
        continue;
      }

      throw new Error(`OpenF1 request failed with status ${response.status}.`);
    }

    throw new Error(defaultMessage);
  }
}

function mapUserRow(row: unknown): User | null {
  if (!isRecord(row)) {
    return null;
  }

  const userId = row.user_id;
  const firstName = row.first_name;
  const username = row.username;
  const status = row.status;
  const timezone = row.timezone;

  if (typeof userId !== 'number' || typeof firstName !== 'string' || typeof status !== 'string') {
    return null;
  }

  if (username !== null && username !== undefined && typeof username !== 'string') {
    return null;
  }

  if (timezone !== null && timezone !== undefined && typeof timezone !== 'string') {
    return null;
  }

  if (status !== 'active' && status !== 'inactive') {
    return null;
  }

  return {
    userId,
    firstName,
    username: username ?? null,
    status,
    timezone: timezone ?? null,
  };
}

function toUserRow(user: User): Record<string, unknown> {
  return {
    user_id: user.userId,
    first_name: user.firstName,
    username: user.username,
    status: user.status,
    timezone: user.timezone,
  };
}

function mapOpenF1SessionRow(row: unknown): Session | null {
  if (!isRecord(row)) {
    return null;
  }

  const sessionRow = row as OpenF1SessionRow;
  const sessionName = asNonEmptyString(sessionRow.session_name);
  const rawDateStart = asNonEmptyString(sessionRow.date_start);

  if (!sessionName || !rawDateStart || !ALLOWED_SESSION_NAMES.has(sessionName)) {
    return null;
  }

  const dateStart = parseOpenF1Datetime(rawDateStart);
  const rawDateEnd = asNonEmptyString(sessionRow.date_end);

  return {
    sessionName,
    dateStart,
    dateEnd: rawDateEnd ? parseOpenF1Datetime(rawDateEnd) : null,
    sessionKey: typeof sessionRow.session_key === 'number' ? sessionRow.session_key : null,
    meetingKey: typeof sessionRow.meeting_key === 'number' ? sessionRow.meeting_key : null,
    meetingName: null,
    location: null,
    sessionType: sessionName,
  };
}

function enrichSession(session: Session, meetingDetails: MeetingDetails): Session {
  return {
    ...session,
    // The response model keeps both the display name and the original session type.
    sessionName: buildSessionDisplayName(session.sessionName, meetingDetails.name),
    meetingName: meetingDetails.shortName,
    location: meetingDetails.location,
    sessionType: session.sessionName,
  };
}

function minByDateStart(sessions: Session[]): Session {
  return sessions.reduce((best, current) =>
    current.dateStart.getTime() < best.dateStart.getTime() ? current : best
  );
}

function diffInUtcDays(futureDate: Date, baseDate: Date): number {
  const futureUtcMidnight = Date.UTC(
    futureDate.getUTCFullYear(),
    futureDate.getUTCMonth(),
    futureDate.getUTCDate(),
  );
  const baseUtcMidnight = Date.UTC(
    baseDate.getUTCFullYear(),
    baseDate.getUTCMonth(),
    baseDate.getUTCDate(),
  );

  return Math.round((futureUtcMidnight - baseUtcMidnight) / 86_400_000);
}

function parseOpenF1Datetime(value: string): Date {
  const normalizedValue = value.replace('Z', '+00:00');
  const parsedValue = new Date(normalizedValue);

  if (Number.isNaN(parsedValue.getTime())) {
    throw new Error(`Invalid OpenF1 datetime: ${value}`);
  }

  return parsedValue;
}

export function buildSessionDisplayName(sessionName: string, meetingName: string | null): string {
  if (!meetingName) {
    return sessionName;
  }

  return `${meetingName} - ${sessionName}`;
}

function isTelegramOkResponse(payload: unknown): payload is { ok: true } {
  return isRecord(payload) && payload.ok === true;
}

function getTelegramDescription(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  return typeof payload.description === 'string' ? payload.description : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
