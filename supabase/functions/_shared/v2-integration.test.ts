import type { BotSettings, PostRaceBriefing, Session, User, UserStatus } from './domain.ts';
import type { MessagingService, SettingsRepository, UserRepository } from './ports.ts';
import { DispatcherV2UseCase, PlannerV2UseCase } from './v2-application.ts';
import {
  buildSessionSourceKey,
  type CachedSession,
  type CachedSessionInput,
  type DeliveryLogEntry,
  type PlannedNotification,
  type PlannerMode,
  type QueueItem,
  type QueueStatus,
  type QueueUpsertResult,
  type RaceWeekend,
} from './v2-domain.ts';
import type {
  DeliveryLogRepository,
  NotificationQueueRepository,
  PlannerSource,
  SessionCacheRepository,
} from './v2-ports.ts';

class IntegrationUserRepository implements UserRepository {
  constructor(private readonly users: User[]) {}

  getUser(userId: number): Promise<User | null> {
    return Promise.resolve(this.users.find((user) => user.userId === userId) ?? null);
  }

  saveUser(_user: User): Promise<void> {
    return Promise.resolve();
  }

  updateUserStatus(_userId: number, _status: UserStatus): Promise<void> {
    return Promise.resolve();
  }

  updateUserTimezone(_userId: number, _timezone: string): Promise<void> {
    return Promise.resolve();
  }

  listActiveUsers(): Promise<User[]> {
    return Promise.resolve(this.users.filter((user) => user.status === 'active'));
  }
}

class IntegrationSettingsRepository implements SettingsRepository {
  constructor(
    private readonly values: Record<string, string>,
    private readonly botSettings: BotSettings,
  ) {}

  getValue(key: string): Promise<string> {
    const value = this.values[key];
    if (value === undefined) {
      return Promise.reject(new Error(`Missing setting for key: ${key}`));
    }

    return Promise.resolve(value);
  }

  getBotSettings(): Promise<BotSettings> {
    return Promise.resolve(this.botSettings);
  }
}

class RecordingMessagingService implements MessagingService {
  readonly sentMessages: Array<{ chatId: number; text: string }> = [];

  sendMessage(chatId: number, text: string): Promise<void> {
    this.sentMessages.push({ chatId, text });
    return Promise.resolve();
  }

  sendCountryOptions(): Promise<void> {
    return Promise.resolve();
  }

  sendSubscribePrompt(): Promise<void> {
    return Promise.resolve();
  }

  answerCallbackQuery(): Promise<void> {
    return Promise.resolve();
  }

  editMessage(): Promise<void> {
    return Promise.resolve();
  }
}

class IntegrationSessionCacheRepository implements SessionCacheRepository {
  readonly sessions = new Map<string, CachedSession>();
  private nextId = 1;

  upsertSessions(sessions: CachedSessionInput[]): Promise<void> {
    for (const session of sessions) {
      const current = this.sessions.get(session.sourceKey);
      this.sessions.set(session.sourceKey, {
        id: current?.id ?? this.nextId++,
        ...session,
      });
    }

    return Promise.resolve();
  }

  getSessionBySourceKey(sourceKey: string): Promise<CachedSession | null> {
    return Promise.resolve(this.sessions.get(sourceKey) ?? null);
  }
}

class IntegrationNotificationQueueRepository implements NotificationQueueRepository {
  readonly items = new Map<string, QueueItem>();
  private nextId = 1;

  upsertNotification(item: PlannedNotification): Promise<QueueUpsertResult> {
    const existingItem = this.items.get(item.dedupeKey);
    if (existingItem?.status === 'sent') {
      return Promise.resolve('already_sent');
    }

    this.items.set(item.dedupeKey, {
      id: existingItem?.id ?? this.nextId++,
      notificationType: item.notificationType,
      dedupeKey: item.dedupeKey,
      payload: item.payload,
      scheduledFor: item.scheduledFor,
      status: existingItem?.status === 'failed' ? 'pending' : (existingItem?.status ?? 'pending'),
      retryCount: 0,
      lastError: null,
      lockedAt: null,
      sentAt: existingItem?.sentAt ?? null,
    });

    return Promise.resolve('scheduled');
  }

  claimDueNotifications(batchSize: number): Promise<QueueItem[]> {
    const claimedItems = [...this.items.values()]
      .filter((item) => item.status === 'pending')
      .sort((left, right) => left.scheduledFor.getTime() - right.scheduledFor.getTime())
      .slice(0, batchSize)
      .map((item) => {
        const claimedItem = {
          ...item,
          status: 'processing' as QueueStatus,
          lockedAt: new Date(),
        };
        this.items.set(item.dedupeKey, claimedItem);
        return claimedItem;
      });

    return Promise.resolve(claimedItems);
  }

  markAsSent(queueId: number): Promise<void> {
    const item = this.requireById(queueId);
    this.items.set(item.dedupeKey, {
      ...item,
      status: 'sent',
      sentAt: new Date(),
      lockedAt: null,
      lastError: null,
    });

    return Promise.resolve();
  }

  markAsPending(queueId: number, retryCount: number, errorMessage: string): Promise<void> {
    const item = this.requireById(queueId);
    this.items.set(item.dedupeKey, {
      ...item,
      status: 'pending',
      retryCount,
      lastError: errorMessage,
      lockedAt: null,
    });

    return Promise.resolve();
  }

  markAsFailed(queueId: number, retryCount: number, errorMessage: string): Promise<void> {
    const item = this.requireById(queueId);
    this.items.set(item.dedupeKey, {
      ...item,
      status: 'failed',
      retryCount,
      lastError: errorMessage,
      lockedAt: null,
    });

    return Promise.resolve();
  }

  keepOnlyPending(dedupeKey: string): void {
    for (const [key, item] of this.items.entries()) {
      this.items.set(key, {
        ...item,
        status: key === dedupeKey ? 'pending' : 'sent',
      });
    }
  }

  private requireById(queueId: number): QueueItem {
    const item = [...this.items.values()].find((entry) => entry.id === queueId);
    if (!item) {
      throw new Error(`Missing queue item ${queueId}.`);
    }

    return item;
  }
}

class IntegrationDeliveryLogRepository implements DeliveryLogRepository {
  readonly entries: DeliveryLogEntry[] = [];

  listTerminalRecipientIds(queueId: number): Promise<Set<number>> {
    return Promise.resolve(
      new Set(
        this.entries
          .filter((entry) =>
            entry.queueId === queueId &&
            (entry.status === 'dry_run' || entry.status === 'sent' || entry.status === 'skipped')
          )
          .map((entry) => entry.userId),
      ),
    );
  }

  recordAttempt(entry: DeliveryLogEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

class FixturePlannerSource implements PlannerSource {
  constructor(
    private readonly weekend: RaceWeekend,
    private readonly briefing: PostRaceBriefing = buildBriefing(),
  ) {}

  getUpcomingRaceWeekend(_when: Date, _mode: PlannerMode): Promise<RaceWeekend | null> {
    return Promise.resolve(this.weekend);
  }

  getPostRaceBriefingForSession(
    _sessionKey: number,
    _when: Date,
  ): Promise<PostRaceBriefing | null> {
    return Promise.resolve(this.briefing);
  }
}

Deno.test('integration v2 plans sprint qualifying with a dedicated template chain', async () => {
  const weekend = buildSprintWeekend();
  const queueRepository = new IntegrationNotificationQueueRepository();
  const planner = new PlannerV2UseCase(
    new FixturePlannerSource(weekend),
    buildSettingsRepository(defaultTemplates()),
    new IntegrationSessionCacheRepository(),
    queueRepository,
  );

  const result = await planner.execute('weekly', new Date('2026-05-18T06:00:00Z'));
  const sprintQualifyingItem = queueRepository.items.get(
    `session_reminder:${buildSessionSourceKey(findSession(weekend, 'Sprint Qualifying'))}`,
  );

  if (result.queuedCount !== 7 || !sprintQualifyingItem) {
    throw new Error(`Sprint weekend was not fully planned: ${JSON.stringify(result)}`);
  }

  if (sprintQualifyingItem.payload.notificationType !== 'session_reminder') {
    throw new Error('Sprint Qualifying queue item should be a session reminder.');
  }

  assertEquals(sprintQualifyingItem.payload.templateKeys, [
    'sprint_qualifying_reminder_msg',
    'qualifying_reminder_msg',
    'session_reminder_msg',
  ]);
});

Deno.test('integration v2 dispatches sprint qualifying with the dedicated template', async () => {
  const harness = await buildPlannedSprintHarness(defaultTemplates());
  const sprintQualifying = findSession(harness.weekend, 'Sprint Qualifying');
  harness.queueRepository.keepOnlyPending(
    `session_reminder:${buildSessionSourceKey(sprintQualifying)}`,
  );

  const result = await harness.dispatcher.execute(10, new Date('2026-05-23T19:45:00Z'));

  if (result.sentCount !== 1 || harness.messagingService.sentMessages.length !== 2) {
    throw new Error(`Unexpected dispatcher result: ${JSON.stringify(result)}`);
  }

  for (const message of harness.messagingService.sentMessages) {
    if (!message.text.startsWith('SPRINT_QUALY|')) {
      throw new Error(`Expected dedicated sprint qualifying template, received: ${message.text}`);
    }
  }
});

Deno.test('integration v2 falls back from sprint qualifying to qualifying before legacy', async () => {
  const templates = defaultTemplates();
  delete templates.sprint_qualifying_reminder_msg;
  const harness = await buildPlannedSprintHarness(templates);
  const sprintQualifying = findSession(harness.weekend, 'Sprint Qualifying');
  harness.queueRepository.keepOnlyPending(
    `session_reminder:${buildSessionSourceKey(sprintQualifying)}`,
  );

  await harness.dispatcher.execute(10, new Date('2026-05-23T19:45:00Z'));

  const texts = harness.messagingService.sentMessages.map((message) => message.text);
  if (!texts.every((text) => text.startsWith('QUALY|'))) {
    throw new Error(`Expected qualifying fallback, received: ${JSON.stringify(texts)}`);
  }
  if (texts.some((text) => text.startsWith('LEGACY|'))) {
    throw new Error(`Sprint qualifying should not fall back to legacy: ${JSON.stringify(texts)}`);
  }
});

Deno.test('integration v2 allowlist flag controls active recipient filtering', async () => {
  const withoutAllowlist = await buildPlannedSprintHarness(defaultTemplates(), {
    allowlistEnabled: false,
    allowlist: new Set<number>([101]),
  });
  const sprint = findSession(withoutAllowlist.weekend, 'Sprint');
  withoutAllowlist.queueRepository.keepOnlyPending(
    `session_reminder:${buildSessionSourceKey(sprint)}`,
  );

  await withoutAllowlist.dispatcher.execute(10, new Date('2026-05-23T15:45:00Z'));

  if (withoutAllowlist.messagingService.sentMessages.length !== 2) {
    throw new Error('Disabled allowlist should send to every active user.');
  }

  const withAllowlist = await buildPlannedSprintHarness(defaultTemplates(), {
    allowlistEnabled: true,
    allowlist: new Set<number>([101]),
  });
  withAllowlist.queueRepository.keepOnlyPending(
    `session_reminder:${buildSessionSourceKey(sprint)}`,
  );

  await withAllowlist.dispatcher.execute(10, new Date('2026-05-23T15:45:00Z'));

  const skippedLogs = withAllowlist.deliveryLogRepository.entries.filter((entry) =>
    entry.status === 'skipped'
  );
  if (withAllowlist.messagingService.sentMessages.length !== 1 || skippedLogs.length !== 1) {
    throw new Error('Enabled allowlist should send to one user and skip one user.');
  }
});

Deno.test('integration v2 deactivates user when messaging service throws blocked error', async () => {
  const templates = defaultTemplates();
  const harness = await buildPlannedSprintHarness(templates);
  const sprint = findSession(harness.weekend, 'Sprint');
  harness.queueRepository.keepOnlyPending(
    `session_reminder:${buildSessionSourceKey(sprint)}`,
  );

  const originalSendMessage = harness.messagingService.sendMessage;
  harness.messagingService.sendMessage = (chatId: number, text: string) => {
    if (chatId === 101) {
      return Promise.reject(new Error('Forbidden: bot was blocked by the user'));
    }
    return originalSendMessage.call(harness.messagingService, chatId, text);
  };

  let updatedUserId: number | null = null;
  let updatedStatus: UserStatus | null = null;
  harness.dispatcher['userRepository'].updateUserStatus = (userId: number, status: UserStatus) => {
    updatedUserId = userId;
    updatedStatus = status;
    return Promise.resolve();
  };

  await harness.dispatcher.execute(10, new Date('2026-05-23T15:45:00Z'));

  assertEquals(updatedUserId, 101);
  assertEquals(updatedStatus, 'inactive');
});

function buildSettingsRepository(templates: Record<string, string>): IntegrationSettingsRepository {
  return new IntegrationSettingsRepository(templates, {
    alertLeadTimeMinutes: 15,
    postRaceDeltaMinutes: 45,
    postRaceMaxWindowMinutes: null,
  });
}

async function buildPlannedSprintHarness(
  templates: Record<string, string>,
  options: { allowlistEnabled: boolean; allowlist: Set<number> } = {
    allowlistEnabled: false,
    allowlist: new Set<number>(),
  },
) {
  const weekend = buildSprintWeekend();
  const plannerSource = new FixturePlannerSource(weekend);
  const settingsRepository = buildSettingsRepository(templates);
  const sessionCacheRepository = new IntegrationSessionCacheRepository();
  const queueRepository = new IntegrationNotificationQueueRepository();
  const deliveryLogRepository = new IntegrationDeliveryLogRepository();
  const messagingService = new RecordingMessagingService();

  const planner = new PlannerV2UseCase(
    plannerSource,
    settingsRepository,
    sessionCacheRepository,
    queueRepository,
  );
  await planner.execute('weekly', new Date('2026-05-18T06:00:00Z'));

  return {
    weekend,
    queueRepository,
    deliveryLogRepository,
    messagingService,
    dispatcher: new DispatcherV2UseCase(
      queueRepository,
      sessionCacheRepository,
      deliveryLogRepository,
      new IntegrationUserRepository([
        {
          userId: 101,
          firstName: 'Camilo',
          username: 'camilo',
          status: 'active',
          timezone: 'America/Santiago',
        },
        {
          userId: 202,
          firstName: 'NaranDja',
          username: 'naran',
          status: 'active',
          timezone: 'America/Argentina/Buenos_Aires',
        },
        {
          userId: 303,
          firstName: 'Inactive',
          username: 'inactive',
          status: 'inactive',
          timezone: 'UTC',
        },
      ]),
      settingsRepository,
      messagingService,
      plannerSource,
      {
        dryRun: false,
        allowlistEnabled: options.allowlistEnabled,
        allowlist: options.allowlist,
        maxRetries: 3,
      },
    ),
  };
}

function defaultTemplates(): Record<string, string> {
  return {
    weekly_summary_msg: 'WEEKLY|{name}|{session_name}|{time}',
    practice_1_reminder_msg: 'P1|{name}|{session_type}|{local_time}',
    sprint_qualifying_reminder_msg: 'SPRINT_QUALY|{name}|{session_type}|{local_time}',
    sprint_reminder_msg: 'SPRINT|{name}|{session_type}|{local_time}',
    qualifying_reminder_msg: 'QUALY|{name}|{session_type}|{local_time}',
    race_reminder_msg: 'RACE|{name}|{session_type}|{local_time}',
    session_reminder_msg: 'LEGACY|{name}|{session_type}|{local_time}|/set_country',
    post_race_briefing_msg: 'BRIEFING|{name}|{winner}',
  };
}

function buildSprintWeekend(): RaceWeekend {
  const sourceSyncedAt = new Date('2026-05-18T06:00:00Z');
  const meeting = {
    meetingKey: 700,
    meetingName: 'Monaco Grand Prix',
    location: 'Monaco',
  };
  const sessions: Session[] = [
    buildSession({
      sessionName: 'Practice 1',
      sessionType: 'Practice 1',
      sessionKey: 12001,
      dateStart: '2026-05-22T12:30:00Z',
      dateEnd: '2026-05-22T13:30:00Z',
      ...meeting,
    }),
    buildSession({
      sessionName: 'Sprint Qualifying',
      sessionType: 'Sprint Qualifying',
      sessionKey: 12002,
      dateStart: '2026-05-22T20:00:00Z',
      dateEnd: '2026-05-22T21:00:00Z',
      ...meeting,
    }),
    buildSession({
      sessionName: 'Sprint',
      sessionType: 'Sprint',
      sessionKey: 12003,
      dateStart: '2026-05-23T16:00:00Z',
      dateEnd: '2026-05-23T17:00:00Z',
      ...meeting,
    }),
    buildSession({
      sessionName: 'Qualifying',
      sessionType: 'Qualifying',
      sessionKey: 12004,
      dateStart: '2026-05-23T20:00:00Z',
      dateEnd: '2026-05-23T21:00:00Z',
      ...meeting,
    }),
    buildSession({
      sessionName: 'Race',
      sessionType: 'Race',
      sessionKey: 12005,
      dateStart: '2026-05-24T20:00:00Z',
      dateEnd: '2026-05-24T22:00:00Z',
      ...meeting,
    }),
  ];

  return {
    race: findSession({ sessions }, 'Race'),
    sessions,
    sourceSyncedAt,
  };
}

function buildSession(input: {
  sessionName: string;
  sessionType: string;
  sessionKey: number;
  meetingKey: number;
  meetingName: string;
  location: string;
  dateStart: string;
  dateEnd: string;
}): Session {
  return {
    sessionName: input.sessionName,
    sessionType: input.sessionType,
    sessionKey: input.sessionKey,
    meetingKey: input.meetingKey,
    meetingName: input.meetingName,
    location: input.location,
    dateStart: new Date(input.dateStart),
    dateEnd: new Date(input.dateEnd),
  };
}

function buildBriefing(): PostRaceBriefing {
  const race = findSession(buildSprintWeekend(), 'Race');
  return {
    completedRace: race,
    podium: [
      { position: 1, driverName: 'Winner', teamName: 'Team One' },
      { position: 2, driverName: 'Second', teamName: 'Team Two' },
      { position: 3, driverName: 'Third', teamName: 'Team Three' },
    ],
    nextGrandPrix: 'Spanish Grand Prix',
    daysLeft: 7,
  };
}

function findSession(weekend: Pick<RaceWeekend, 'sessions'>, sessionName: string): Session {
  const session = weekend.sessions.find((entry) => entry.sessionName === sessionName);
  if (!session) {
    throw new Error(`Missing fixture session: ${sessionName}`);
  }

  return session;
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}
