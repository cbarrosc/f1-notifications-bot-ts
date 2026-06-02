import type { BotSettings, PostRaceBriefing, Session, User, UserStatus } from './domain.ts';
import { DispatcherV2UseCase, PlannerV2UseCase } from './v2-application.ts';
import type { MessagingService, SettingsRepository, UserRepository } from './ports.ts';
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
import { buildSessionSourceKey, getSessionReminderSettingKeys } from './v2-domain.ts';
import type {
  DeliveryLogRepository,
  NotificationQueueRepository,
  PlannerSource,
  SessionCacheRepository,
} from './v2-ports.ts';

class InMemoryUserRepository implements UserRepository {
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

class InMemorySettingsRepository implements SettingsRepository {
  constructor(
    private readonly values: Record<string, string>,
    private readonly botSettings: BotSettings,
  ) {}

  getValue(key: string): Promise<string> {
    const value = this.values[key];
    if (value === undefined) {
      throw new Error(`Missing setting for key: ${key}`);
    }

    return Promise.resolve(value);
  }

  getBotSettings(): Promise<BotSettings> {
    return Promise.resolve(this.botSettings);
  }
}

class RecordingMessagingService implements MessagingService {
  readonly sentMessages: Array<{ chatId: number; text: string }> = [];
  readonly failedRecipients = new Set<number>();

  sendMessage(chatId: number, text: string): Promise<void> {
    if (this.failedRecipients.has(chatId)) {
      return Promise.reject(new Error('Simulated Telegram failure.'));
    }

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

Deno.test('session reminder template keys include sprint qualifying before fallbacks', () => {
  const keys = getSessionReminderSettingKeys('Sprint Qualifying');
  const expectedKeys = [
    'sprint_qualifying_reminder_msg',
    'qualifying_reminder_msg',
    'session_reminder_msg',
  ];

  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`Unexpected sprint qualifying template keys: ${JSON.stringify(keys)}`);
  }
});

class InMemorySessionCacheRepository implements SessionCacheRepository {
  readonly sessions = new Map<string, CachedSession>();
  nextId = 1;

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

class InMemoryNotificationQueueRepository implements NotificationQueueRepository {
  readonly items = new Map<string, QueueItem>();
  nextId = 1;

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

  private requireById(queueId: number): QueueItem {
    const item = [...this.items.values()].find((entry) => entry.id === queueId);
    if (!item) {
      throw new Error(`Missing queue item ${queueId}.`);
    }

    return item;
  }
}

class InMemoryDeliveryLogRepository implements DeliveryLogRepository {
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

class StubPlannerSource implements PlannerSource {
  constructor(
    private readonly weekend: RaceWeekend | null,
    private readonly briefing: PostRaceBriefing | null,
  ) {}

  getUpcomingRaceWeekend(_when: Date, _mode: PlannerMode): Promise<RaceWeekend | null> {
    return Promise.resolve(this.weekend);
  }

  getPostRaceBriefingForSession(_sessionKey: number): Promise<PostRaceBriefing | null> {
    return Promise.resolve(this.briefing);
  }
}

function buildRaceSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionName: 'Race',
    sessionType: 'Race',
    dateStart: new Date('2026-05-10T14:00:00Z'),
    dateEnd: new Date('2026-05-10T16:00:00Z'),
    sessionKey: 9001,
    meetingKey: 500,
    meetingName: 'Miami Grand Prix',
    location: 'Miami',
    ...overrides,
  };
}

function buildWeekend(): RaceWeekend {
  const race = buildRaceSession();
  const qualifying = buildRaceSession({
    sessionName: 'Qualifying',
    sessionType: 'Qualifying',
    sessionKey: 9000,
    dateStart: new Date('2026-05-09T18:00:00Z'),
    dateEnd: new Date('2026-05-09T19:00:00Z'),
  });

  return {
    race,
    sessions: [qualifying, race],
    sourceSyncedAt: new Date('2026-05-04T06:00:00Z'),
  };
}

function buildBriefing(): PostRaceBriefing {
  return {
    completedRace: buildRaceSession(),
    podium: [
      { position: 1, driverName: 'Driver One', teamName: 'Team One' },
      { position: 2, driverName: 'Driver Two', teamName: 'Team Two' },
      { position: 3, driverName: 'Driver Three', teamName: 'Team Three' },
    ],
    nextGrandPrix: 'Emilia Romagna Grand Prix',
    daysLeft: 7,
  };
}

function assertLocalTime(
  value: Date,
  timezone: string,
  expected: { weekday: string; hour: string; minute: string },
): void {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const actual = {
    weekday: byType.get('weekday'),
    hour: byType.get('hour'),
    minute: byType.get('minute'),
  };

  if (
    actual.weekday !== expected.weekday ||
    actual.hour !== expected.hour ||
    actual.minute !== expected.minute
  ) {
    throw new Error(
      `Expected ${value.toISOString()} to be ${JSON.stringify(expected)} in ${timezone}; got ${
        JSON.stringify(actual)
      }.`,
    );
  }
}

Deno.test('planner v2 caches sessions and queues all weekend notifications without duplicates', async () => {
  const weekend = buildWeekend();
  const settingsRepository = new InMemorySettingsRepository({}, {
    alertLeadTimeMinutes: 15,
    postRaceDeltaMinutes: 45,
    postRaceMaxWindowMinutes: null,
  });
  const sessionCacheRepository = new InMemorySessionCacheRepository();
  const queueRepository = new InMemoryNotificationQueueRepository();
  const useCase = new PlannerV2UseCase(
    new StubPlannerSource(weekend, null),
    settingsRepository,
    sessionCacheRepository,
    queueRepository,
  );

  const firstResult = await useCase.execute('weekly', new Date('2026-05-04T06:00:00Z'));
  const secondResult = await useCase.execute('rebuild', new Date('2026-05-04T06:05:00Z'));

  if (firstResult.cachedSessions !== 2 || firstResult.queuedCount !== 4) {
    throw new Error(`Unexpected planner result: ${JSON.stringify(firstResult)}`);
  }

  if (sessionCacheRepository.sessions.size !== 2) {
    throw new Error(
      `Expected 2 cached sessions, received ${sessionCacheRepository.sessions.size}.`,
    );
  }

  if (queueRepository.items.size !== 4) {
    throw new Error(`Expected 4 queued notifications, received ${queueRepository.items.size}.`);
  }

  if (secondResult.queuedCount !== 4) {
    throw new Error(
      `Expected rebuild to keep queue size stable, received ${secondResult.queuedCount}.`,
    );
  }
});

Deno.test('planner v2 queues weekly digest per active user timezone at local Monday noon', async () => {
  const weekend = buildWeekend();
  const settingsRepository = new InMemorySettingsRepository({}, {
    alertLeadTimeMinutes: 15,
    postRaceDeltaMinutes: 45,
    postRaceMaxWindowMinutes: null,
  });
  const sessionCacheRepository = new InMemorySessionCacheRepository();
  const queueRepository = new InMemoryNotificationQueueRepository();
  const raceSourceKey = buildSessionSourceKey(weekend.race);
  const useCase = new PlannerV2UseCase(
    new StubPlannerSource(weekend, null),
    settingsRepository,
    sessionCacheRepository,
    queueRepository,
    new InMemoryUserRepository([
      {
        userId: 1,
        firstName: 'Camilo',
        username: 'camilo',
        status: 'active',
        timezone: 'America/Santiago',
      },
      {
        userId: 2,
        firstName: 'Marta',
        username: 'marta',
        status: 'active',
        timezone: 'Europe/Madrid',
      },
      {
        userId: 3,
        firstName: 'Inactive',
        username: 'inactive',
        status: 'inactive',
        timezone: 'UTC',
      },
    ]),
  );

  const result = await useCase.execute('weekly', new Date('2026-05-04T06:00:00Z'));
  const weeklyItems = [...queueRepository.items.values()].filter((item) =>
    item.notificationType === 'weekly_digest'
  );

  if (result.queuedCount !== 5 || weeklyItems.length !== 2) {
    throw new Error(`Expected 2 timezone weekly digests: ${JSON.stringify(result)}`);
  }

  const santiagoItem = queueRepository.items.get(
    `weekly_digest:${raceSourceKey}:timezone:America/Santiago`,
  );
  const madridItem = queueRepository.items.get(
    `weekly_digest:${raceSourceKey}:timezone:Europe/Madrid`,
  );

  if (!santiagoItem || !madridItem) {
    throw new Error(
      `Missing timezone dedupe keys: ${JSON.stringify([...queueRepository.items.keys()])}`,
    );
  }

  if (
    santiagoItem.payload.notificationType !== 'weekly_digest' ||
    santiagoItem.payload.targetTimezone !== 'America/Santiago' ||
    madridItem.payload.notificationType !== 'weekly_digest' ||
    madridItem.payload.targetTimezone !== 'Europe/Madrid'
  ) {
    throw new Error('Weekly digest payloads should include their target timezones.');
  }

  assertLocalTime(santiagoItem.scheduledFor, 'America/Santiago', {
    weekday: 'Mon',
    hour: '12',
    minute: '00',
  });
  assertLocalTime(madridItem.scheduledFor, 'Europe/Madrid', {
    weekday: 'Mon',
    hour: '12',
    minute: '00',
  });
});

Deno.test('planner v2 does not queue weekly digest outside the 7-day window', async () => {
  const weekend = buildWeekend();
  const settingsRepository = new InMemorySettingsRepository({}, {
    alertLeadTimeMinutes: 15,
    postRaceDeltaMinutes: 45,
    postRaceMaxWindowMinutes: null,
  });
  const sessionCacheRepository = new InMemorySessionCacheRepository();
  const queueRepository = new InMemoryNotificationQueueRepository();
  const useCase = new PlannerV2UseCase(
    new StubPlannerSource(weekend, null),
    settingsRepository,
    sessionCacheRepository,
    queueRepository,
  );

  const result = await useCase.execute('weekly', new Date('2026-04-27T06:00:00Z'));
  const queuedTypes = [...queueRepository.items.values()].map((item) => item.notificationType);

  if (result.queuedCount !== 3) {
    throw new Error(`Expected 3 queued notifications, received ${result.queuedCount}.`);
  }

  if (queuedTypes.includes('weekly_digest')) {
    throw new Error('Weekly digest should not be queued more than 7 days before the race.');
  }
});

Deno.test('dispatcher v2 sends targeted weekly digest only to users in target timezone', async () => {
  const weekend = buildWeekend();
  const raceSourceKey = buildSessionSourceKey(weekend.race);
  const sessionCacheRepository = new InMemorySessionCacheRepository();
  await sessionCacheRepository.upsertSessions([
    {
      sourceKey: raceSourceKey,
      sessionKey: weekend.race.sessionKey,
      meetingKey: weekend.race.meetingKey,
      sessionName: weekend.race.sessionName,
      sessionType: weekend.race.sessionType,
      meetingName: weekend.race.meetingName,
      location: weekend.race.location,
      dateStart: weekend.race.dateStart,
      dateEnd: weekend.race.dateEnd,
      seasonYear: 2026,
      sourceSyncedAt: weekend.sourceSyncedAt,
    },
  ]);

  const queueRepository = new InMemoryNotificationQueueRepository();
  await queueRepository.upsertNotification({
    notificationType: 'weekly_digest',
    dedupeKey: `weekly_digest:${raceSourceKey}:timezone:America/Santiago`,
    payload: {
      notificationType: 'weekly_digest',
      sourceKey: raceSourceKey,
      templateKey: 'weekly_summary_msg',
      targetTimezone: 'America/Santiago',
    },
    scheduledFor: new Date('2026-05-04T16:00:00Z'),
  });

  const deliveryLogRepository = new InMemoryDeliveryLogRepository();
  const messagingService = new RecordingMessagingService();
  const dispatcherUseCase = new DispatcherV2UseCase(
    queueRepository,
    sessionCacheRepository,
    deliveryLogRepository,
    new InMemoryUserRepository([
      {
        userId: 1,
        firstName: 'Camilo',
        username: 'camilo',
        status: 'active',
        timezone: 'America/Santiago',
      },
      {
        userId: 2,
        firstName: 'Marta',
        username: 'marta',
        status: 'active',
        timezone: 'Europe/Madrid',
      },
    ]),
    new InMemorySettingsRepository({
      weekly_summary_msg: 'Hi {name} {tz}',
    }, {
      alertLeadTimeMinutes: 15,
      postRaceDeltaMinutes: 45,
      postRaceMaxWindowMinutes: null,
    }),
    messagingService,
    new StubPlannerSource(weekend, buildBriefing()),
    {
      dryRun: false,
      allowlistEnabled: false,
      allowlist: new Set<number>(),
      maxRetries: 3,
    },
  );

  const result = await dispatcherUseCase.execute(10);

  if (
    result.sentCount !== 1 ||
    messagingService.sentMessages.length !== 1 ||
    messagingService.sentMessages[0].chatId !== 1 ||
    deliveryLogRepository.entries.length !== 1
  ) {
    throw new Error(`Expected only Santiago user to receive digest: ${JSON.stringify(result)}`);
  }
});

Deno.test('dispatcher v2 keeps legacy weekly digest without target timezone global', async () => {
  const weekend = buildWeekend();
  const raceSourceKey = buildSessionSourceKey(weekend.race);
  const sessionCacheRepository = new InMemorySessionCacheRepository();
  await sessionCacheRepository.upsertSessions([
    {
      sourceKey: raceSourceKey,
      sessionKey: weekend.race.sessionKey,
      meetingKey: weekend.race.meetingKey,
      sessionName: weekend.race.sessionName,
      sessionType: weekend.race.sessionType,
      meetingName: weekend.race.meetingName,
      location: weekend.race.location,
      dateStart: weekend.race.dateStart,
      dateEnd: weekend.race.dateEnd,
      seasonYear: 2026,
      sourceSyncedAt: weekend.sourceSyncedAt,
    },
  ]);

  const queueRepository = new InMemoryNotificationQueueRepository();
  await queueRepository.upsertNotification({
    notificationType: 'weekly_digest',
    dedupeKey: `weekly_digest:${raceSourceKey}`,
    payload: {
      notificationType: 'weekly_digest',
      sourceKey: raceSourceKey,
      templateKey: 'weekly_summary_msg',
    },
    scheduledFor: new Date('2026-05-04T06:00:00Z'),
  });

  const messagingService = new RecordingMessagingService();
  const dispatcherUseCase = new DispatcherV2UseCase(
    queueRepository,
    sessionCacheRepository,
    new InMemoryDeliveryLogRepository(),
    new InMemoryUserRepository([
      {
        userId: 1,
        firstName: 'Camilo',
        username: 'camilo',
        status: 'active',
        timezone: 'America/Santiago',
      },
      {
        userId: 2,
        firstName: 'Marta',
        username: 'marta',
        status: 'active',
        timezone: 'Europe/Madrid',
      },
    ]),
    new InMemorySettingsRepository({
      weekly_summary_msg: 'Hi {name} {tz}',
    }, {
      alertLeadTimeMinutes: 15,
      postRaceDeltaMinutes: 45,
      postRaceMaxWindowMinutes: null,
    }),
    messagingService,
    new StubPlannerSource(weekend, buildBriefing()),
    {
      dryRun: false,
      allowlistEnabled: false,
      allowlist: new Set<number>(),
      maxRetries: 3,
    },
  );

  const result = await dispatcherUseCase.execute(10);

  if (result.sentCount !== 1 || messagingService.sentMessages.length !== 2) {
    throw new Error(`Expected legacy weekly digest to send globally: ${JSON.stringify(result)}`);
  }
});

Deno.test('dispatcher v2 dry-run marks queue items sent and writes delivery logs', async () => {
  const weekend = buildWeekend();
  const settingsRepository = new InMemorySettingsRepository({
    weekly_summary_msg: 'Hi {name} {flag} {tz} {time}',
    qualifying_reminder_msg: 'Reminder {name} {session_type} {local_time}',
    session_reminder_msg: 'Reminder {name} {session_type} {local_time}',
    post_race_briefing_msg: '{name} {P1_driver} {next_gp}',
  }, {
    alertLeadTimeMinutes: 15,
    postRaceDeltaMinutes: 45,
    postRaceMaxWindowMinutes: null,
  });
  const sessionCacheRepository = new InMemorySessionCacheRepository();
  await sessionCacheRepository.upsertSessions(
    weekend.sessions.map((session) => ({
      sourceKey: buildSessionSourceKey(session),
      sessionKey: session.sessionKey,
      meetingKey: session.meetingKey,
      sessionName: session.sessionName,
      sessionType: session.sessionType,
      meetingName: session.meetingName,
      location: session.location,
      dateStart: session.dateStart,
      dateEnd: session.dateEnd,
      seasonYear: 2026,
      sourceSyncedAt: weekend.sourceSyncedAt,
    })),
  );
  const queueRepository = new InMemoryNotificationQueueRepository();
  const plannerUseCase = new PlannerV2UseCase(
    new StubPlannerSource(weekend, buildBriefing()),
    settingsRepository,
    sessionCacheRepository,
    queueRepository,
  );
  await plannerUseCase.execute('weekly', new Date('2026-05-04T06:00:00Z'));

  const deliveryLogRepository = new InMemoryDeliveryLogRepository();
  const messagingService = new RecordingMessagingService();
  const dispatcherUseCase = new DispatcherV2UseCase(
    queueRepository,
    sessionCacheRepository,
    deliveryLogRepository,
    new InMemoryUserRepository([
      {
        userId: 1,
        firstName: 'John',
        username: 'john',
        status: 'active',
        timezone: 'America/Santiago',
      },
    ]),
    settingsRepository,
    messagingService,
    new StubPlannerSource(weekend, buildBriefing()),
    {
      dryRun: true,
      allowlistEnabled: false,
      allowlist: new Set<number>(),
      maxRetries: 3,
    },
  );

  const result = await dispatcherUseCase.execute(10, new Date('2026-05-11T17:00:00Z'));

  if (result.dryRunCount !== 4 || result.failedCount !== 0) {
    throw new Error(`Unexpected dispatcher result: ${JSON.stringify(result)}`);
  }

  if (deliveryLogRepository.entries.length !== 4) {
    throw new Error(`Expected 4 delivery logs, received ${deliveryLogRepository.entries.length}.`);
  }

  if (messagingService.sentMessages.length !== 0) {
    throw new Error('Dry-run should not send real messages.');
  }
});

Deno.test('dispatcher v2 ignores allowlist when feature flag is disabled', async () => {
  const weekend = buildWeekend();
  const sessionCacheRepository = new InMemorySessionCacheRepository();
  await sessionCacheRepository.upsertSessions([
    {
      sourceKey: buildSessionSourceKey(weekend.race),
      sessionKey: weekend.race.sessionKey,
      meetingKey: weekend.race.meetingKey,
      sessionName: weekend.race.sessionName,
      sessionType: weekend.race.sessionType,
      meetingName: weekend.race.meetingName,
      location: weekend.race.location,
      dateStart: weekend.race.dateStart,
      dateEnd: weekend.race.dateEnd,
      seasonYear: 2026,
      sourceSyncedAt: weekend.sourceSyncedAt,
    },
  ]);

  const queueRepository = new InMemoryNotificationQueueRepository();
  await queueRepository.upsertNotification({
    notificationType: 'weekly_digest',
    dedupeKey: `weekly:${buildSessionSourceKey(weekend.race)}`,
    payload: {
      notificationType: 'weekly_digest',
      sourceKey: buildSessionSourceKey(weekend.race),
      templateKey: 'weekly_summary_msg',
    },
    scheduledFor: new Date('2026-05-04T06:00:00Z'),
  });

  const messagingService = new RecordingMessagingService();
  const dispatcherUseCase = new DispatcherV2UseCase(
    queueRepository,
    sessionCacheRepository,
    new InMemoryDeliveryLogRepository(),
    new InMemoryUserRepository([
      { userId: 1, firstName: 'John', username: 'john', status: 'active', timezone: 'UTC' },
      { userId: 2, firstName: 'Jane', username: 'jane', status: 'active', timezone: 'UTC' },
    ]),
    new InMemorySettingsRepository({
      weekly_summary_msg: 'Hi {name} {time}',
    }, {
      alertLeadTimeMinutes: 15,
      postRaceDeltaMinutes: 45,
      postRaceMaxWindowMinutes: null,
    }),
    messagingService,
    new StubPlannerSource(weekend, buildBriefing()),
    {
      dryRun: false,
      allowlistEnabled: false,
      allowlist: new Set<number>([1]),
      maxRetries: 3,
    },
  );

  const result = await dispatcherUseCase.execute(10);
  if (result.sentCount !== 1 || messagingService.sentMessages.length !== 2) {
    throw new Error(
      `Expected both active users to receive the message: ${JSON.stringify(result)}`,
    );
  }
});

Deno.test('dispatcher v2 applies allowlist when feature flag is enabled', async () => {
  const weekend = buildWeekend();
  const sessionCacheRepository = new InMemorySessionCacheRepository();
  await sessionCacheRepository.upsertSessions([
    {
      sourceKey: buildSessionSourceKey(weekend.race),
      sessionKey: weekend.race.sessionKey,
      meetingKey: weekend.race.meetingKey,
      sessionName: weekend.race.sessionName,
      sessionType: weekend.race.sessionType,
      meetingName: weekend.race.meetingName,
      location: weekend.race.location,
      dateStart: weekend.race.dateStart,
      dateEnd: weekend.race.dateEnd,
      seasonYear: 2026,
      sourceSyncedAt: weekend.sourceSyncedAt,
    },
  ]);

  const queueRepository = new InMemoryNotificationQueueRepository();
  await queueRepository.upsertNotification({
    notificationType: 'weekly_digest',
    dedupeKey: `weekly:${buildSessionSourceKey(weekend.race)}`,
    payload: {
      notificationType: 'weekly_digest',
      sourceKey: buildSessionSourceKey(weekend.race),
      templateKey: 'weekly_summary_msg',
    },
    scheduledFor: new Date('2026-05-04T06:00:00Z'),
  });

  const deliveryLogRepository = new InMemoryDeliveryLogRepository();
  const messagingService = new RecordingMessagingService();
  const dispatcherUseCase = new DispatcherV2UseCase(
    queueRepository,
    sessionCacheRepository,
    deliveryLogRepository,
    new InMemoryUserRepository([
      { userId: 1, firstName: 'John', username: 'john', status: 'active', timezone: 'UTC' },
      { userId: 2, firstName: 'Jane', username: 'jane', status: 'active', timezone: 'UTC' },
    ]),
    new InMemorySettingsRepository({
      weekly_summary_msg: 'Hi {name} {time}',
    }, {
      alertLeadTimeMinutes: 15,
      postRaceDeltaMinutes: 45,
      postRaceMaxWindowMinutes: null,
    }),
    messagingService,
    new StubPlannerSource(weekend, buildBriefing()),
    {
      dryRun: false,
      allowlistEnabled: true,
      allowlist: new Set<number>([1]),
      maxRetries: 3,
    },
  );

  const result = await dispatcherUseCase.execute(10);
  const skippedLogs = deliveryLogRepository.entries.filter((entry) => entry.status === 'skipped');
  if (
    result.sentCount !== 1 || messagingService.sentMessages.length !== 1 ||
    skippedLogs.length !== 1
  ) {
    throw new Error(`Expected allowlist to send one and skip one: ${JSON.stringify(result)}`);
  }
});

Deno.test('dispatcher v2 retries failed recipients and preserves successful deliveries', async () => {
  const weekend = buildWeekend();
  const sessionCacheRepository = new InMemorySessionCacheRepository();
  await sessionCacheRepository.upsertSessions([
    {
      sourceKey: buildSessionSourceKey(weekend.race),
      sessionKey: weekend.race.sessionKey,
      meetingKey: weekend.race.meetingKey,
      sessionName: weekend.race.sessionName,
      sessionType: weekend.race.sessionType,
      meetingName: weekend.race.meetingName,
      location: weekend.race.location,
      dateStart: weekend.race.dateStart,
      dateEnd: weekend.race.dateEnd,
      seasonYear: 2026,
      sourceSyncedAt: weekend.sourceSyncedAt,
    },
  ]);

  const queueRepository = new InMemoryNotificationQueueRepository();
  await queueRepository.upsertNotification({
    notificationType: 'weekly_digest',
    dedupeKey: `weekly:${buildSessionSourceKey(weekend.race)}`,
    payload: {
      notificationType: 'weekly_digest',
      sourceKey: buildSessionSourceKey(weekend.race),
      templateKey: 'weekly_summary_msg',
    },
    scheduledFor: new Date('2026-05-04T06:00:00Z'),
  });

  const deliveryLogRepository = new InMemoryDeliveryLogRepository();
  const messagingService = new RecordingMessagingService();
  messagingService.failedRecipients.add(2);
  const settingsRepository = new InMemorySettingsRepository({
    weekly_summary_msg: 'Hi {name} {time}',
  }, {
    alertLeadTimeMinutes: 15,
    postRaceDeltaMinutes: 45,
    postRaceMaxWindowMinutes: null,
  });
  const dispatcherUseCase = new DispatcherV2UseCase(
    queueRepository,
    sessionCacheRepository,
    deliveryLogRepository,
    new InMemoryUserRepository([
      {
        userId: 1,
        firstName: 'John',
        username: 'john',
        status: 'active',
        timezone: 'UTC',
      },
      {
        userId: 2,
        firstName: 'Jane',
        username: 'jane',
        status: 'active',
        timezone: 'UTC',
      },
    ]),
    settingsRepository,
    messagingService,
    new StubPlannerSource(weekend, buildBriefing()),
    {
      dryRun: false,
      allowlistEnabled: false,
      allowlist: new Set<number>(),
      maxRetries: 3,
    },
  );

  const firstResult = await dispatcherUseCase.execute(10);
  if (firstResult.retryingCount !== 1) {
    throw new Error(`Expected retrying count to be 1, received ${firstResult.retryingCount}.`);
  }

  const queueItem = [...queueRepository.items.values()][0];
  if (queueItem.retryCount !== 1 || queueItem.status !== 'pending') {
    throw new Error(
      `Queue item should be pending with retry_count=1. Received ${JSON.stringify(queueItem)}.`,
    );
  }

  messagingService.failedRecipients.delete(2);
  const secondResult = await dispatcherUseCase.execute(10);
  if (secondResult.sentCount !== 1) {
    throw new Error(
      `Expected second pass to send queue item, received ${JSON.stringify(secondResult)}.`,
    );
  }

  if (messagingService.sentMessages.filter((message) => message.chatId === 1).length !== 1) {
    throw new Error('Recipient 1 should not receive duplicates across retries.');
  }
});

Deno.test('dispatcher v2 marks queue items failed after exceeding max retries', async () => {
  const race = buildRaceSession();
  const queueRepository = new InMemoryNotificationQueueRepository();
  await queueRepository.upsertNotification({
    notificationType: 'post_race_briefing',
    dedupeKey: `briefing:${buildSessionSourceKey(race)}`,
    payload: {
      notificationType: 'post_race_briefing',
      sourceKey: buildSessionSourceKey(race),
      templateKey: 'post_race_briefing_msg',
    },
    scheduledFor: new Date('2026-05-10T17:00:00Z'),
  });
  const sessionCacheRepository = new InMemorySessionCacheRepository();
  await sessionCacheRepository.upsertSessions([
    {
      sourceKey: buildSessionSourceKey(race),
      sessionKey: race.sessionKey,
      meetingKey: race.meetingKey,
      sessionName: race.sessionName,
      sessionType: race.sessionType,
      meetingName: race.meetingName,
      location: race.location,
      dateStart: race.dateStart,
      dateEnd: race.dateEnd,
      seasonYear: 2026,
      sourceSyncedAt: new Date(),
    },
  ]);

  const dispatcherUseCase = new DispatcherV2UseCase(
    queueRepository,
    sessionCacheRepository,
    new InMemoryDeliveryLogRepository(),
    new InMemoryUserRepository([
      {
        userId: 1,
        firstName: 'John',
        username: 'john',
        status: 'active',
        timezone: 'UTC',
      },
    ]),
    new InMemorySettingsRepository({
      post_race_briefing_msg: '{name}',
    }, {
      alertLeadTimeMinutes: 15,
      postRaceDeltaMinutes: 45,
      postRaceMaxWindowMinutes: null,
    }),
    new RecordingMessagingService(),
    new StubPlannerSource(buildWeekend(), null),
    {
      dryRun: false,
      allowlistEnabled: false,
      allowlist: new Set<number>(),
      maxRetries: 0,
    },
  );

  const result = await dispatcherUseCase.execute(10);
  if (result.failedCount !== 1) {
    throw new Error(`Expected failed count to be 1, received ${JSON.stringify(result)}.`);
  }

  const queueItem = [...queueRepository.items.values()][0];
  if (queueItem.status !== 'failed') {
    throw new Error(`Queue item should be failed, received ${queueItem.status}.`);
  }
});
