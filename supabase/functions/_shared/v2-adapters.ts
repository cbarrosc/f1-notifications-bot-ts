import type { SupabaseClient } from '@supabase/supabase-js';

import { buildSessionDisplayName, buildSupabaseClient } from './adapters.ts';
import type { MeetingDetails, PodiumFinisher, PostRaceBriefing, Session } from './domain.ts';
import type {
  CachedSession,
  CachedSessionInput,
  DeliveryLogEntry,
  PlannedNotification,
  PlannerMode,
  QueueItem,
  QueueStatus,
  QueueUpsertResult,
  RaceWeekend,
} from './v2-domain.ts';
import type {
  DeliveryLogRepository,
  NotificationQueueRepository,
  PlannerSource,
  SessionCacheRepository,
} from './v2-ports.ts';

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

type CachedSessionRow = {
  id?: unknown;
  source_key?: unknown;
  session_key?: unknown;
  meeting_key?: unknown;
  session_name?: unknown;
  session_type?: unknown;
  meeting_name?: unknown;
  location?: unknown;
  date_start?: unknown;
  date_end?: unknown;
  season_year?: unknown;
  source_synced_at?: unknown;
};

type QueueRow = {
  id?: unknown;
  notification_type?: unknown;
  dedupe_key?: unknown;
  payload?: unknown;
  scheduled_for?: unknown;
  status?: unknown;
  retry_count?: unknown;
  last_error?: unknown;
  locked_at?: unknown;
  sent_at?: unknown;
};

type DeliveryLogRow = {
  user_id?: unknown;
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

export function buildV2SupabaseClient(): SupabaseClient {
  return buildSupabaseClient();
}

export class SupabaseSessionCacheRepository implements SessionCacheRepository {
  constructor(private readonly client: SupabaseClient) {}

  async upsertSessions(sessions: CachedSessionInput[]): Promise<void> {
    if (sessions.length === 0) {
      return;
    }

    const rows = sessions.map((session) => ({
      source_key: session.sourceKey,
      session_key: session.sessionKey,
      meeting_key: session.meetingKey,
      session_name: session.sessionName,
      session_type: session.sessionType,
      meeting_name: session.meetingName,
      location: session.location,
      date_start: session.dateStart.toISOString(),
      date_end: session.dateEnd?.toISOString() ?? null,
      season_year: session.seasonYear,
      source_synced_at: session.sourceSyncedAt.toISOString(),
    }));

    const { error } = await this.client.from('f1_sessions_cache').upsert(rows, {
      onConflict: 'source_key',
    });

    if (error) {
      throw error;
    }
  }

  async getSessionBySourceKey(sourceKey: string): Promise<CachedSession | null> {
    const { data, error } = await this.client
      .from('f1_sessions_cache')
      .select(`
        id,
        source_key,
        session_key,
        meeting_key,
        session_name,
        session_type,
        meeting_name,
        location,
        date_start,
        date_end,
        season_year,
        source_synced_at
      `)
      .eq('source_key', sourceKey)
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return mapCachedSessionRow(data as CachedSessionRow | null | undefined);
  }
}

export class SupabaseNotificationQueueRepository implements NotificationQueueRepository {
  constructor(private readonly client: SupabaseClient) {}

  async upsertNotification(item: PlannedNotification): Promise<QueueUpsertResult> {
    const { data, error } = await this.client.rpc('upsert_notification_queue_item', {
      input_notification_type: item.notificationType,
      input_dedupe_key: item.dedupeKey,
      input_payload: item.payload,
      input_scheduled_for: item.scheduledFor.toISOString(),
    });

    if (error) {
      throw error;
    }

    const row = mapQueueRow(data as QueueRow | null | undefined);
    if (!row) {
      throw new Error('Invalid notification_queue row returned from upsert.');
    }

    return row.status === 'sent' ? 'already_sent' : 'scheduled';
  }

  async claimDueNotifications(batchSize: number): Promise<QueueItem[]> {
    const { data, error } = await this.client.rpc('claim_notification_queue_items', {
      batch_size: batchSize,
    });

    if (error) {
      throw error;
    }

    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .map((row) => mapQueueRow(row))
      .filter((row): row is QueueItem => row !== null);
  }

  async markAsSent(queueId: number): Promise<void> {
    const { error } = await this.client
      .from('notification_queue')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        locked_at: null,
        last_error: null,
      })
      .eq('id', queueId);

    if (error) {
      throw error;
    }
  }

  async markAsPending(
    queueId: number,
    retryCount: number,
    errorMessage: string,
    nextScheduledFor?: Date,
  ): Promise<void> {
    const updates: Record<string, unknown> = {
      status: 'pending',
      retry_count: retryCount,
      last_error: errorMessage,
      locked_at: null,
    };

    if (nextScheduledFor) {
      updates.scheduled_for = nextScheduledFor.toISOString();
    }

    const { error } = await this.client
      .from('notification_queue')
      .update(updates)
      .eq('id', queueId);

    if (error) {
      throw error;
    }
  }

  async markAsFailed(queueId: number, retryCount: number, errorMessage: string): Promise<void> {
    const { error } = await this.client
      .from('notification_queue')
      .update({
        status: 'failed',
        retry_count: retryCount,
        last_error: errorMessage,
        locked_at: null,
      })
      .eq('id', queueId);

    if (error) {
      throw error;
    }
  }
}

export class SupabaseDeliveryLogRepository implements DeliveryLogRepository {
  constructor(private readonly client: SupabaseClient) {}

  async listTerminalRecipientIds(queueId: number): Promise<Set<number>> {
    const { data, error } = await this.client
      .from('delivery_logs')
      .select('user_id')
      .eq('queue_id', queueId)
      .in('status', ['dry_run', 'sent', 'skipped']);

    if (error) {
      throw error;
    }

    if (!Array.isArray(data)) {
      return new Set<number>();
    }

    return new Set(
      data
        .map((row) => (typeof row.user_id === 'number' ? row.user_id : null))
        .filter((userId): userId is number => userId !== null),
    );
  }

  async recordAttempt(entry: DeliveryLogEntry): Promise<void> {
    const { error } = await this.client.from('delivery_logs').insert({
      queue_id: entry.queueId,
      user_id: entry.userId,
      attempt: entry.attempt,
      status: entry.status,
      provider: entry.provider,
      provider_message_id: entry.providerMessageId ?? null,
      error_message: entry.errorMessage ?? null,
    });

    if (error) {
      throw error;
    }
  }
}

export class OpenF1PlannerSource implements PlannerSource {
  private readonly meetingDetailsCache = new Map<string, MeetingDetails>();
  private readonly driversBySessionCache = new Map<
    number,
    Map<number, { name: string | null; team: string | null }>
  >();

  constructor(private readonly baseUrl: string) {}

  async getUpcomingRaceWeekend(when: Date, _mode: PlannerMode): Promise<RaceWeekend | null> {
    const year = when.getUTCFullYear();
    const sessions = await this.getSessionsForYear(year);
    const races = sessions
      .filter((session) => session.sessionType === 'Race' && session.dateStart > when)
      .sort((left, right) => left.dateStart.getTime() - right.dateStart.getTime());

    const nextRace = races[0];
    if (!nextRace) {
      return null;
    }

    const meetingSessions = sessions
      .filter((session) => session.meetingKey === nextRace.meetingKey)
      .sort((left, right) => left.dateStart.getTime() - right.dateStart.getTime());
    const weekendSessions = meetingSessions.length > 0 ? meetingSessions : [nextRace];
    const meetingDetails = await this.getMeetingDetails(year, nextRace.meetingKey);
    const enrichedSessions = weekendSessions.map((session) =>
      enrichSession(session, meetingDetails)
    );
    const race = enrichedSessions.find((session) => session.sessionType === 'Race') ??
      enrichedSessions[0];

    return {
      race,
      sessions: enrichedSessions,
      sourceSyncedAt: new Date(),
    };
  }

  async getPostRaceBriefingForSession(
    sessionKey: number,
    when: Date,
  ): Promise<PostRaceBriefing | null> {
    const year = when.getUTCFullYear();
    const sessions = await this.getSessionsForYear(year, 'Race');
    const race = sessions.find((session) => session.sessionKey === sessionKey);
    if (!race?.sessionKey) {
      return null;
    }

    const meetingDetails = await this.getMeetingDetails(year, race.meetingKey);
    const podium = await this.getSessionPodium(race.sessionKey);
    if (podium.length < 3) {
      return null;
    }

    const upcomingRaces = sessions
      .filter((session) => session.dateStart > race.dateStart)
      .sort((left, right) => left.dateStart.getTime() - right.dateStart.getTime());
    const nextRace = upcomingRaces[0] ?? null;
    const nextMeeting = nextRace
      ? await this.getMeetingDetails(nextRace.dateStart.getUTCFullYear(), nextRace.meetingKey)
      : { name: null, shortName: null, location: null };

    return {
      completedRace: enrichSession(race, meetingDetails),
      podium: [podium[0], podium[1], podium[2]],
      nextGrandPrix: nextMeeting.shortName ?? nextMeeting.name,
      daysLeft: nextRace ? diffInUtcDays(nextRace.dateStart, when) : null,
    };
  }

  private async getSessionsForYear(year: number, sessionName?: string): Promise<Session[]> {
    logger.info('Fetching OpenF1 sessions for planner source', {
      year,
      sessionName: sessionName ?? null,
    });
    const params = new URLSearchParams({ year: String(year) });
    if (sessionName) {
      params.set('session_name', sessionName);
    }

    const payload = await this.fetchJson(
      `${this.baseUrl.replace(/\/$/, '')}/sessions?${params.toString()}`,
      'Invalid OpenF1 sessions payload.',
    );

    if (!Array.isArray(payload)) {
      throw new Error('Invalid OpenF1 sessions payload.');
    }

    return payload
      .map((row) => mapOpenF1SessionRow(row))
      .filter((row): row is Session => row !== null);
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
      return cachedDetails;
    }

    const params = new URLSearchParams({
      year: String(year),
      meeting_key: String(meetingKey),
    });
    const payload = await this.fetchJson(
      `${this.baseUrl.replace(/\/$/, '')}/meetings?${params.toString()}`,
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

    const fallback = {
      name: null,
      shortName: null,
      location: null,
    };
    this.meetingDetailsCache.set(cacheKey, fallback);
    return fallback;
  }

  private async getSessionPodium(sessionKey: number): Promise<PodiumFinisher[]> {
    const params = new URLSearchParams({
      session_key: String(sessionKey),
      'position<': '3',
    });
    const payload = await this.fetchJson(
      `${this.baseUrl.replace(/\/$/, '')}/session_result?${params.toString()}`,
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
      return cachedDrivers;
    }

    const params = new URLSearchParams({
      session_key: String(sessionKey),
    });
    const payload = await this.fetchJson(
      `${this.baseUrl.replace(/\/$/, '')}/drivers?${params.toString()}`,
      'Invalid OpenF1 drivers payload.',
    );

    if (!Array.isArray(payload)) {
      throw new Error('Invalid OpenF1 drivers payload.');
    }

    const driversByNumber = new Map<number, { name: string | null; team: string | null }>();
    for (const row of payload) {
      if (!isRecord(row) || typeof row.driver_number !== 'number') {
        continue;
      }

      const driverRow = row as OpenF1DriverRow;
      driversByNumber.set(row.driver_number, {
        name: asNonEmptyString(driverRow.full_name),
        team: asNonEmptyString(driverRow.team_name),
      });
    }

    this.driversBySessionCache.set(sessionKey, driversByNumber);
    return driversByNumber;
  }

  private async fetchJson(url: string, defaultMessage: string): Promise<unknown> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      logger.info('Calling OpenF1 from planner source', { url, attempt });
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
        await delay(attempt * 300);
        continue;
      }

      throw new Error(`OpenF1 request failed with status ${response.status}.`);
    }

    throw new Error(defaultMessage);
  }
}

function mapCachedSessionRow(row: unknown): CachedSession | null {
  if (!isRecord(row) || typeof row.id !== 'number' || typeof row.source_key !== 'string') {
    return null;
  }

  const dateStart = parseOpenF1DatetimeLike(row.date_start);
  const dateEnd = row.date_end == null ? null : parseOpenF1DatetimeLike(row.date_end);
  const sourceSyncedAt = parseOpenF1DatetimeLike(row.source_synced_at);
  const seasonYear = typeof row.season_year === 'number' ? row.season_year : null;
  if (
    !dateStart || !sourceSyncedAt || seasonYear === null || typeof row.session_name !== 'string'
  ) {
    return null;
  }

  return {
    id: row.id,
    sourceKey: row.source_key,
    sessionKey: typeof row.session_key === 'number' ? row.session_key : null,
    meetingKey: typeof row.meeting_key === 'number' ? row.meeting_key : null,
    sessionName: row.session_name,
    sessionType: typeof row.session_type === 'string' ? row.session_type : null,
    meetingName: typeof row.meeting_name === 'string' ? row.meeting_name : null,
    location: typeof row.location === 'string' ? row.location : null,
    dateStart,
    dateEnd,
    seasonYear,
    sourceSyncedAt,
  };
}

function mapQueueRow(row: unknown): QueueItem | null {
  if (!isRecord(row) || typeof row.id !== 'number') {
    return null;
  }

  if (
    (row.notification_type !== 'weekly_digest' &&
      row.notification_type !== 'session_reminder' &&
      row.notification_type !== 'post_race_briefing') ||
    typeof row.dedupe_key !== 'string' ||
    !isRecord(row.payload) ||
    typeof row.scheduled_for !== 'string' ||
    (row.status !== 'pending' &&
      row.status !== 'processing' &&
      row.status !== 'sent' &&
      row.status !== 'failed') ||
    typeof row.retry_count !== 'number'
  ) {
    return null;
  }

  return {
    id: row.id,
    notificationType: row.notification_type,
    dedupeKey: row.dedupe_key,
    payload: row.payload as QueueItem['payload'],
    scheduledFor: new Date(row.scheduled_for),
    status: row.status as QueueStatus,
    retryCount: row.retry_count,
    lastError: typeof row.last_error === 'string' ? row.last_error : null,
    lockedAt: typeof row.locked_at === 'string' ? new Date(row.locked_at) : null,
    sentAt: typeof row.sent_at === 'string' ? new Date(row.sent_at) : null,
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
    sessionName: buildSessionDisplayName(session.sessionName, meetingDetails.name),
    meetingName: meetingDetails.shortName,
    location: meetingDetails.location,
    sessionType: session.sessionName,
  };
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

function parseOpenF1DatetimeLike(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }

  const parsedValue = new Date(value);
  return Number.isNaN(parsedValue.getTime()) ? null : parsedValue;
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
