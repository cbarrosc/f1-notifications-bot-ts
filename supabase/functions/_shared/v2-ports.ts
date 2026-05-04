import type { MessagingService, SettingsRepository, UserRepository } from './ports.ts';
import type { PostRaceBriefing } from './domain.ts';
import type {
  CachedSession,
  CachedSessionInput,
  DeliveryLogEntry,
  PlannedNotification,
  PlannerMode,
  QueueItem,
  QueueUpsertResult,
  RaceWeekend,
} from './v2-domain.ts';

export type { MessagingService, SettingsRepository, UserRepository };

export interface SessionCacheRepository {
  upsertSessions(sessions: CachedSessionInput[]): Promise<void>;
  getSessionBySourceKey(sourceKey: string): Promise<CachedSession | null>;
}

export interface NotificationQueueRepository {
  upsertNotification(item: PlannedNotification): Promise<QueueUpsertResult>;
  claimDueNotifications(batchSize: number): Promise<QueueItem[]>;
  markAsSent(queueId: number): Promise<void>;
  markAsPending(queueId: number, retryCount: number, errorMessage: string): Promise<void>;
  markAsFailed(queueId: number, retryCount: number, errorMessage: string): Promise<void>;
}

export interface DeliveryLogRepository {
  listTerminalRecipientIds(queueId: number): Promise<Set<number>>;
  recordAttempt(entry: DeliveryLogEntry): Promise<void>;
}

export interface PlannerSource {
  getUpcomingRaceWeekend(when: Date, mode: PlannerMode): Promise<RaceWeekend | null>;
  getPostRaceBriefingForSession(sessionKey: number, when: Date): Promise<PostRaceBriefing | null>;
}
