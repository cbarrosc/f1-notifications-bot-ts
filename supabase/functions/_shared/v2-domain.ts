import type { PostRaceBriefing, Session } from './domain.ts';

export type NotificationType = 'weekly_digest' | 'session_reminder' | 'post_race_briefing';
export type QueueStatus = 'pending' | 'processing' | 'sent' | 'failed';
export type DeliveryStatus = 'dry_run' | 'sent' | 'failed' | 'skipped';
export type PlannerMode = 'weekly' | 'rebuild';
export type QueueUpsertResult = 'scheduled' | 'already_sent';

export interface CachedSession {
  id: number;
  sourceKey: string;
  sessionKey: number | null;
  meetingKey: number | null;
  sessionName: string;
  sessionType: string | null;
  meetingName: string | null;
  location: string | null;
  dateStart: Date;
  dateEnd: Date | null;
  seasonYear: number;
  sourceSyncedAt: Date;
}

export interface CachedSessionInput {
  sourceKey: string;
  sessionKey: number | null;
  meetingKey: number | null;
  sessionName: string;
  sessionType: string | null;
  meetingName: string | null;
  location: string | null;
  dateStart: Date;
  dateEnd: Date | null;
  seasonYear: number;
  sourceSyncedAt: Date;
}

export interface RaceWeekend {
  race: Session;
  sessions: Session[];
  sourceSyncedAt: Date;
}

export interface WeeklyDigestPayload {
  notificationType: 'weekly_digest';
  sourceKey: string;
  templateKey: 'weekly_summary_msg';
}

export interface SessionReminderPayload {
  notificationType: 'session_reminder';
  sourceKey: string;
  templateKeys: string[];
}

export interface PostRaceBriefingPayload {
  notificationType: 'post_race_briefing';
  sourceKey: string;
  templateKey: 'post_race_briefing_msg';
}

export type QueuedNotificationPayload =
  | WeeklyDigestPayload
  | SessionReminderPayload
  | PostRaceBriefingPayload;

export interface QueueItem {
  id: number;
  notificationType: NotificationType;
  dedupeKey: string;
  payload: QueuedNotificationPayload;
  scheduledFor: Date;
  status: QueueStatus;
  retryCount: number;
  lastError: string | null;
  lockedAt: Date | null;
  sentAt: Date | null;
}

export interface PlannedNotification {
  notificationType: NotificationType;
  dedupeKey: string;
  payload: QueuedNotificationPayload;
  scheduledFor: Date;
}

export interface DeliveryLogEntry {
  queueId: number;
  userId: number;
  attempt: number;
  status: DeliveryStatus;
  provider: string;
  providerMessageId?: string | null;
  errorMessage?: string | null;
}

export interface DispatcherOptions {
  dryRun: boolean;
  allowlist: Set<number>;
  maxRetries: number;
}

export interface PlannerResult {
  status: 'ok';
  mode: PlannerMode;
  actionTaken: string;
  queuedCount: number;
  skippedSentCount: number;
  cachedSessions: number;
  meetingName: string | null;
  raceStartUtc: string | null;
}

export interface DispatcherResult {
  status: 'ok';
  actionTaken: string;
  claimedCount: number;
  sentCount: number;
  retryingCount: number;
  failedCount: number;
  dryRunCount: number;
  skippedCount: number;
}

export function buildSessionSourceKey(session: {
  sessionKey: number | null;
  meetingKey: number | null;
  sessionName: string;
  dateStart: Date;
}): string {
  if (session.sessionKey !== null) {
    return `session_key:${session.sessionKey}`;
  }

  return [
    session.dateStart.getUTCFullYear(),
    session.meetingKey ?? 'meeting_unknown',
    session.sessionName.toLowerCase().replace(/\s+/g, '_'),
    session.dateStart.toISOString(),
  ].join(':');
}

export function buildQueueDedupeKey(
  notificationType: NotificationType,
  sourceKey: string,
): string {
  return `${notificationType}:${sourceKey}`;
}

export function buildWeeklyDigestPayload(sourceKey: string): WeeklyDigestPayload {
  return {
    notificationType: 'weekly_digest',
    sourceKey,
    templateKey: 'weekly_summary_msg',
  };
}

export function buildSessionReminderPayload(
  sourceKey: string,
  sessionType: string | null,
): SessionReminderPayload {
  return {
    notificationType: 'session_reminder',
    sourceKey,
    templateKeys: getSessionReminderSettingKeys(sessionType ?? ''),
  };
}

export function buildPostRaceBriefingPayload(sourceKey: string): PostRaceBriefingPayload {
  return {
    notificationType: 'post_race_briefing',
    sourceKey,
    templateKey: 'post_race_briefing_msg',
  };
}

export function getSessionReminderSettingKeys(sessionLabel: string): string[] {
  if (sessionLabel === 'Practice 1') {
    return ['practice_1_reminder_msg', 'session_reminder_msg'];
  }

  if (sessionLabel === 'Practice 2') {
    return ['practice_2_reminder_msg', 'session_reminder_msg'];
  }

  if (sessionLabel === 'Practice 3') {
    return ['practice_3_reminder_msg', 'session_reminder_msg'];
  }

  if (sessionLabel === 'Qualifying') {
    return ['qualifying_reminder_msg', 'session_reminder_msg'];
  }

  if (sessionLabel === 'Sprint') {
    return ['sprint_reminder_msg', 'session_reminder_msg'];
  }

  if (sessionLabel === 'Race') {
    return ['race_reminder_msg', 'session_reminder_msg'];
  }

  return ['session_reminder_msg'];
}

export function isPostRaceBriefing(
  briefing: PostRaceBriefing | null,
): briefing is PostRaceBriefing {
  return briefing !== null;
}
