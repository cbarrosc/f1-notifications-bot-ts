import type { PostRaceBriefing, Session, User } from './domain.ts';
import type { MessagingService, SettingsRepository, UserRepository } from './ports.ts';
import type {
  CachedSession,
  DispatcherOptions,
  DispatcherResult,
  PlannedNotification,
  PlannerMode,
  PlannerResult,
  QueueItem,
  RaceWeekend,
} from './v2-domain.ts';
import {
  buildPostRaceBriefingPayload,
  buildQueueDedupeKey,
  buildSessionReminderPayload,
  buildSessionSourceKey,
  buildWeeklyDigestPayload,
} from './v2-domain.ts';
import type {
  DeliveryLogRepository,
  NotificationQueueRepository,
  PlannerSource,
  SessionCacheRepository,
} from './v2-ports.ts';

const TIMEZONE_FLAG_BY_NAME: Record<string, string> = {
  'America/Santiago': '🇨🇱',
  'America/Argentina/Buenos_Aires': '🇦🇷',
  'America/Bogota': '🇨🇴',
  'Europe/Madrid': '🇪🇸',
  'America/Montevideo': '🇺🇾',
  UTC: '🌐',
};
const logger = console;

export class PlannerV2UseCase {
  constructor(
    private readonly plannerSource: PlannerSource,
    private readonly settingsRepository: SettingsRepository,
    private readonly sessionCacheRepository: SessionCacheRepository,
    private readonly queueRepository: NotificationQueueRepository,
  ) {}

  async execute(mode: PlannerMode, now = new Date()): Promise<PlannerResult> {
    const weekend = await this.plannerSource.getUpcomingRaceWeekend(now, mode);
    if (!weekend) {
      return {
        status: 'ok',
        mode,
        actionTaken: 'no_weekend_found',
        queuedCount: 0,
        skippedSentCount: 0,
        cachedSessions: 0,
        meetingName: null,
        raceStartUtc: null,
      };
    }

    await this.sessionCacheRepository.upsertSessions(
      weekend.sessions.map((session) => toCachedSessionInput(session, weekend.sourceSyncedAt)),
    );

    const settings = await this.settingsRepository.getBotSettings();
    const plannedNotifications = buildPlannedNotifications(weekend, now, {
      alertLeadTimeMinutes: settings.alertLeadTimeMinutes ?? 15,
      postRaceDeltaMinutes: settings.postRaceDeltaMinutes ?? 45,
    });

    let queuedCount = 0;
    let skippedSentCount = 0;
    for (const plannedNotification of plannedNotifications) {
      const result = await this.queueRepository.upsertNotification(plannedNotification);
      if (result === 'already_sent') {
        skippedSentCount += 1;
      } else {
        queuedCount += 1;
      }
    }

    return {
      status: 'ok',
      mode,
      actionTaken: 'weekend_planned',
      queuedCount,
      skippedSentCount,
      cachedSessions: weekend.sessions.length,
      meetingName: weekend.race.meetingName,
      raceStartUtc: weekend.race.dateStart.toISOString(),
    };
  }
}

export class DispatcherV2UseCase {
  constructor(
    private readonly queueRepository: NotificationQueueRepository,
    private readonly sessionCacheRepository: SessionCacheRepository,
    private readonly deliveryLogRepository: DeliveryLogRepository,
    private readonly userRepository: UserRepository,
    private readonly settingsRepository: SettingsRepository,
    private readonly messagingService: MessagingService,
    private readonly plannerSource: PlannerSource,
    private readonly options: DispatcherOptions,
  ) {}

  async execute(batchSize: number, now = new Date()): Promise<DispatcherResult> {
    const claimedItems = await this.queueRepository.claimDueNotifications(batchSize);
    if (claimedItems.length === 0) {
      return {
        status: 'ok',
        actionTaken: 'no_due_notifications',
        claimedCount: 0,
        sentCount: 0,
        retryingCount: 0,
        failedCount: 0,
        dryRunCount: 0,
        skippedCount: 0,
      };
    }

    let sentCount = 0;
    let retryingCount = 0;
    let failedCount = 0;
    let dryRunCount = 0;
    let skippedCount = 0;

    for (const item of claimedItems) {
      const outcome = await this.processQueueItem(item, now);
      if (outcome === 'sent') {
        sentCount += 1;
      } else if (outcome === 'retrying') {
        retryingCount += 1;
      } else if (outcome === 'failed') {
        failedCount += 1;
      } else if (outcome === 'dry_run') {
        dryRunCount += 1;
      } else if (outcome === 'skipped') {
        skippedCount += 1;
      }
    }

    return {
      status: 'ok',
      actionTaken: 'notifications_processed',
      claimedCount: claimedItems.length,
      sentCount,
      retryingCount,
      failedCount,
      dryRunCount,
      skippedCount,
    };
  }

  private async processQueueItem(
    item: QueueItem,
    now: Date,
  ): Promise<'sent' | 'retrying' | 'failed' | 'dry_run' | 'skipped'> {
    try {
      const deliveredRecipients = await this.deliveryLogRepository.listTerminalRecipientIds(
        item.id,
      );
      const activeUsers = (await this.userRepository.listActiveUsers()).filter((user) =>
        !deliveredRecipients.has(user.userId)
      );

      if (activeUsers.length === 0) {
        await this.queueRepository.markAsSent(item.id);
        return 'skipped';
      }

      if (item.payload.notificationType === 'post_race_briefing') {
        return await this.processPostRaceBriefing(item, activeUsers, now);
      }

      const cachedSession = await this.sessionCacheRepository.getSessionBySourceKey(
        item.payload.sourceKey,
      );
      if (!cachedSession) {
        throw new Error(`Missing cached session for ${item.payload.sourceKey}.`);
      }

      if (item.payload.notificationType === 'weekly_digest') {
        return await this.processSessionBasedQueueItem(
          item,
          activeUsers,
          cachedSession,
          (user) =>
            this.renderWeeklyDigest(
              user,
              cachedSession,
              getWeeklyDigestPayload(item.payload).templateKey,
            ),
        );
      }

      return await this.processSessionBasedQueueItem(
        item,
        activeUsers,
        cachedSession,
        (user) =>
          this.renderSessionReminder(
            user,
            cachedSession,
            getSessionReminderPayload(item.payload).templateKeys,
          ),
      );
    } catch (error) {
      return await this.transitionAfterFailure(
        item,
        error instanceof Error ? error.message : 'Unknown dispatcher error.',
      );
    }
  }

  private async processSessionBasedQueueItem(
    item: QueueItem,
    recipients: User[],
    _cachedSession: CachedSession,
    renderMessage: (user: User) => Promise<string>,
  ): Promise<'sent' | 'retrying' | 'failed' | 'dry_run'> {
    const outcome = await this.deliverToRecipients(
      item,
      recipients,
      async (user) => await renderMessage(user),
    );

    if (outcome.status === 'success') {
      await this.queueRepository.markAsSent(item.id);
      return this.options.dryRun ? 'dry_run' : 'sent';
    }

    return await this.transitionAfterFailure(item, outcome.errorMessage);
  }

  private async processPostRaceBriefing(
    item: QueueItem,
    recipients: User[],
    now: Date,
  ): Promise<'sent' | 'retrying' | 'failed' | 'dry_run'> {
    const cachedSession = await this.sessionCacheRepository.getSessionBySourceKey(
      item.payload.sourceKey,
    );
    if (!cachedSession?.sessionKey) {
      throw new Error(`Missing cached race session for ${item.payload.sourceKey}.`);
    }

    const briefing = await this.plannerSource.getPostRaceBriefingForSession(
      cachedSession.sessionKey,
      now,
    );
    if (!briefing) {
      throw new Error(
        `Unable to build post-race briefing for session ${cachedSession.sessionKey}.`,
      );
    }

    const template = await this.settingsRepository.getValue(
      getPostRaceBriefingPayload(item.payload).templateKey,
    );
    const outcome = await this.deliverToRecipients(
      item,
      recipients,
      async (user) =>
        await Promise.resolve(
          renderPostRaceBriefingMessage(template, briefing, user.firstName),
        ),
    );

    if (outcome.status === 'success') {
      await this.queueRepository.markAsSent(item.id);
      return this.options.dryRun ? 'dry_run' : 'sent';
    }

    return await this.transitionAfterFailure(item, outcome.errorMessage);
  }

  private async deliverToRecipients(
    item: QueueItem,
    recipients: User[],
    renderMessage: (user: User) => Promise<string>,
  ): Promise<{ status: 'success' } | { status: 'failure'; errorMessage: string }> {
    const errors: string[] = [];
    const attempt = item.retryCount + 1;

    for (const user of recipients) {
      if (
        !this.options.dryRun && this.options.allowlistEnabled &&
        this.options.allowlist.size > 0 &&
        !this.options.allowlist.has(user.userId)
      ) {
        await this.deliveryLogRepository.recordAttempt({
          queueId: item.id,
          userId: user.userId,
          attempt,
          status: 'skipped',
          provider: 'telegram',
          errorMessage: 'Skipped because user is outside dispatcher allowlist.',
        });
        continue;
      }

      const text = await renderMessage(user);
      if (this.options.dryRun) {
        await this.deliveryLogRepository.recordAttempt({
          queueId: item.id,
          userId: user.userId,
          attempt,
          status: 'dry_run',
          provider: 'telegram',
        });
        continue;
      }

      try {
        await this.messagingService.sendMessage(user.userId, text);
        await this.deliveryLogRepository.recordAttempt({
          queueId: item.id,
          userId: user.userId,
          attempt,
          status: 'sent',
          provider: 'telegram',
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown messaging error.';
        errors.push(`user ${user.userId}: ${errorMessage}`);
        await this.deliveryLogRepository.recordAttempt({
          queueId: item.id,
          userId: user.userId,
          attempt,
          status: 'failed',
          provider: 'telegram',
          errorMessage,
        });
      }
    }

    if (errors.length > 0) {
      return {
        status: 'failure',
        errorMessage: errors.join(' | '),
      };
    }

    return { status: 'success' };
  }

  private async renderWeeklyDigest(
    user: User,
    session: CachedSession,
    templateKey: string,
  ): Promise<string> {
    const template = await this.settingsRepository.getValue(templateKey);
    return renderWeeklySummaryMessage(template, session, user.firstName, user.timezone ?? 'UTC');
  }

  private async renderSessionReminder(
    user: User,
    session: CachedSession,
    templateKeys: string[],
  ): Promise<string> {
    const template = await this.resolveTemplate(templateKeys);
    return renderSessionReminderMessage(template, session, user.firstName, user.timezone ?? 'UTC');
  }

  private async resolveTemplate(templateKeys: string[]): Promise<string> {
    let lastError: Error | null = null;
    for (const templateKey of templateKeys) {
      try {
        return await this.settingsRepository.getValue(templateKey);
      } catch (error) {
        lastError = error instanceof Error
          ? error
          : new Error('Unknown template resolution error.');
      }
    }

    throw lastError ?? new Error('Unable to resolve message template.');
  }

  private async transitionAfterFailure(
    item: QueueItem,
    errorMessage: string,
  ): Promise<'retrying' | 'failed'> {
    const nextRetryCount = item.retryCount + 1;
    logger.warn('Dispatcher V2 will transition queue item after failure', {
      queueId: item.id,
      nextRetryCount,
      errorMessage,
    });

    if (nextRetryCount > this.options.maxRetries) {
      await this.queueRepository.markAsFailed(item.id, nextRetryCount, errorMessage);
      return 'failed';
    }

    await this.queueRepository.markAsPending(item.id, nextRetryCount, errorMessage);
    return 'retrying';
  }
}

function toCachedSessionInput(
  session: Session,
  sourceSyncedAt: Date,
) {
  return {
    sourceKey: buildSessionSourceKey(session),
    sessionKey: session.sessionKey,
    meetingKey: session.meetingKey,
    sessionName: session.sessionName,
    sessionType: session.sessionType,
    meetingName: session.meetingName,
    location: session.location,
    dateStart: session.dateStart,
    dateEnd: session.dateEnd,
    seasonYear: session.dateStart.getUTCFullYear(),
    sourceSyncedAt,
  };
}

function buildPlannedNotifications(
  weekend: RaceWeekend,
  now: Date,
  settings: {
    alertLeadTimeMinutes: number;
    postRaceDeltaMinutes: number;
  },
): PlannedNotification[] {
  const plannedNotifications: PlannedNotification[] = [];
  const raceSourceKey = buildSessionSourceKey(weekend.race);

  plannedNotifications.push({
    notificationType: 'weekly_digest',
    dedupeKey: buildQueueDedupeKey('weekly_digest', raceSourceKey),
    payload: buildWeeklyDigestPayload(raceSourceKey),
    scheduledFor: new Date(now),
  });

  for (const session of weekend.sessions) {
    const sourceKey = buildSessionSourceKey(session);
    plannedNotifications.push({
      notificationType: 'session_reminder',
      dedupeKey: buildQueueDedupeKey('session_reminder', sourceKey),
      payload: buildSessionReminderPayload(sourceKey, session.sessionType),
      scheduledFor: new Date(
        session.dateStart.getTime() - settings.alertLeadTimeMinutes * 60_000,
      ),
    });
  }

  if (weekend.race.dateEnd) {
    plannedNotifications.push({
      notificationType: 'post_race_briefing',
      dedupeKey: buildQueueDedupeKey('post_race_briefing', raceSourceKey),
      payload: buildPostRaceBriefingPayload(raceSourceKey),
      scheduledFor: new Date(
        weekend.race.dateEnd.getTime() + settings.postRaceDeltaMinutes * 60_000,
      ),
    });
  }

  return plannedNotifications;
}

function renderWeeklySummaryMessage(
  template: string,
  session: {
    location: string | null;
    dateStart: Date;
    sessionName: string;
  },
  firstName: string,
  timezone: string,
): string {
  return template
    .replace('{name}', firstName)
    .replace('{location}', session.location ?? 'TBC')
    .replace('{time}', formatUserDatetime(session.dateStart, timezone))
    .replace('{flag}', formatTimezoneFlag(timezone))
    .replace('{tz}', timezone)
    .replace('{session_name}', session.sessionName);
}

function renderSessionReminderMessage(
  template: string,
  session: {
    location: string | null;
    dateStart: Date;
    sessionType: string | null;
    sessionName: string;
  },
  firstName: string,
  timezone: string,
): string {
  const sessionType = session.sessionType ?? session.sessionName;
  return template
    .replace('{name}', firstName)
    .replace('{circuit}', session.location ?? 'TBC')
    .replace('{local_time}', formatUserDatetime(session.dateStart, timezone))
    .replace('{flag}', formatTimezoneFlag(timezone))
    .replace('{session_type}', sessionType)
    .replace('{tz}', timezone);
}

function renderPostRaceBriefingMessage(
  template: string,
  briefing: PostRaceBriefing,
  firstName: string,
): string {
  const [firstPlace, secondPlace, thirdPlace] = briefing.podium;
  return template
    .replace('{name}', firstName)
    .replace('{circuit}', briefing.completedRace.location ?? 'TBC')
    .replace('{P1_driver}', firstPlace.driverName)
    .replace('{P1_team}', firstPlace.teamName)
    .replace('{P2_driver}', secondPlace.driverName)
    .replace('{P2_team}', secondPlace.teamName)
    .replace('{P3_driver}', thirdPlace.driverName)
    .replace('{P3_team}', thirdPlace.teamName)
    .replace('{next_gp}', briefing.nextGrandPrix ?? 'TBC')
    .replace('{days_left}', briefing.daysLeft !== null ? String(briefing.daysLeft) : 'TBC');
}

function formatUserDatetime(value: Date, timezone: string): string {
  const safeTimeZone = isValidTimeZone(timezone) ? timezone : 'UTC';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: safeTimeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

function formatTimezoneFlag(timezone: string): string {
  return TIMEZONE_FLAG_BY_NAME[timezone] ?? '🌐';
}

function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function getWeeklyDigestPayload(payload: QueueItem['payload']) {
  if (payload.notificationType !== 'weekly_digest') {
    throw new Error('Queue item payload is not a weekly digest payload.');
  }

  return payload;
}

function getSessionReminderPayload(payload: QueueItem['payload']) {
  if (payload.notificationType !== 'session_reminder') {
    throw new Error('Queue item payload is not a session reminder payload.');
  }

  return payload;
}

function getPostRaceBriefingPayload(payload: QueueItem['payload']) {
  if (payload.notificationType !== 'post_race_briefing') {
    throw new Error('Queue item payload is not a post-race briefing payload.');
  }

  return payload;
}
