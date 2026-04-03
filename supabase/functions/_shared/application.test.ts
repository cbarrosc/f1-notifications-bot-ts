import { COUNTRY_OPTIONS, TelegramBotUseCase, WakeUpUseCase } from './application.ts';
import type {
  MessagingService,
  NotificationLogRepository,
  SessionProvider,
  SettingsRepository,
  UserRepository,
} from './ports.ts';
import type { PostRaceBriefing, Session, User, UserStatus } from './domain.ts';

class InMemoryUserRepository implements UserRepository {
  private readonly users = new Map<number, User>();

  constructor(initialUsers: User[] = []) {
    for (const user of initialUsers) {
      this.users.set(user.userId, structuredClone(user));
    }
  }

  getUser(userId: number): Promise<User | null> {
    return Promise.resolve(this.users.get(userId) ?? null);
  }

  saveUser(user: User): Promise<void> {
    this.users.set(user.userId, structuredClone(user));
    return Promise.resolve();
  }

  updateUserStatus(userId: number, status: UserStatus): Promise<void> {
    const user = this.users.get(userId);
    if (!user) {
      return Promise.resolve();
    }

    this.users.set(userId, { ...user, status });
    return Promise.resolve();
  }

  updateUserTimezone(userId: number, timezone: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) {
      return Promise.resolve();
    }

    this.users.set(userId, { ...user, timezone });
    return Promise.resolve();
  }

  listActiveUsers(): Promise<User[]> {
    return Promise.resolve(
      [...this.users.values()].filter((user) => user.status === 'active'),
    );
  }
}

class InMemorySettingsRepository implements SettingsRepository {
  constructor(private readonly values: Record<string, string>) {}

  getValue(key: string): Promise<string> {
    const value = this.values[key];
    if (value === undefined) {
      throw new Error(`Missing setting for key: ${key}`);
    }

    return Promise.resolve(value);
  }

  getBotSettings() {
    return Promise.resolve({
      alertLeadTimeMinutes: Number(this.values.alert_lead_time ?? 0),
      postRaceDeltaMinutes: Number(this.values.post_race_delta ?? 0),
    });
  }
}

class RecordingMessagingService implements MessagingService {
  readonly sentMessages: Array<{ chatId: number; text: string }> = [];
  readonly countryOptions: Array<{ chatId: number; text: string }> = [];

  sendMessage(chatId: number, text: string): Promise<void> {
    this.sentMessages.push({ chatId, text });
    return Promise.resolve();
  }

  sendCountryOptions(
    chatId: number,
    text: string,
    _options: typeof COUNTRY_OPTIONS,
  ): Promise<void> {
    this.countryOptions.push({ chatId, text });
    return Promise.resolve();
  }

  sendSubscribePrompt(
    chatId: number,
    text: string,
    _buttonText: string,
    _callbackData: string,
  ): Promise<void> {
    this.sentMessages.push({ chatId, text });
    return Promise.resolve();
  }

  answerCallbackQuery(_callbackQueryId: string, _text: string): Promise<void> {
    return Promise.resolve();
  }

  editMessage(_chatId: number, _messageId: number, _text: string): Promise<void> {
    return Promise.resolve();
  }
}

class InMemoryNotificationLogRepository implements NotificationLogRepository {
  private readonly sent = new Set<string>();

  markAsSent(userId: number, notificationKey: string): Promise<boolean> {
    const compositeKey = `${userId}:${notificationKey}`;
    if (this.sent.has(compositeKey)) {
      return Promise.resolve(false);
    }

    this.sent.add(compositeKey);
    return Promise.resolve(true);
  }

  unmarkAsSent(userId: number, notificationKey: string): Promise<void> {
    this.sent.delete(`${userId}:${notificationKey}`);
    return Promise.resolve();
  }
}

class StubSessionProvider implements SessionProvider {
  constructor(
    private readonly sourceName: string,
    private readonly nextSession: Session | null,
    private readonly nextRace: Session | null,
    private readonly postRaceBriefing: PostRaceBriefing | null,
  ) {}

  getNextSessionAfter(_when: Date): Promise<Session | null> {
    return Promise.resolve(this.nextSession);
  }

  getNextRaceAfter(_when: Date): Promise<Session | null> {
    return Promise.resolve(this.nextRace);
  }

  getPostRaceBriefing(_when: Date): Promise<PostRaceBriefing | null> {
    return Promise.resolve(this.postRaceBriefing);
  }

  getSourceName(): string {
    return this.sourceName;
  }
}

function buildSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionName: 'Race',
    dateStart: new Date('2026-04-12T15:00:00Z'),
    dateEnd: new Date('2026-04-12T17:00:00Z'),
    sessionKey: 11261,
    meetingKey: 1283,
    meetingName: 'Bahrain Grand Prix',
    location: 'Sakhir',
    sessionType: 'Race',
    ...overrides,
  };
}

const SUPPORTED_TIMEZONE_CASES = [
  {
    userId: 11,
    firstName: 'Chile',
    timezone: 'America/Santiago',
    flag: '🇨🇱',
    weeklyDigestTime: '11:00',
    sessionReminderTime: '07:30',
  },
  {
    userId: 12,
    firstName: 'Argentina',
    timezone: 'America/Argentina/Buenos_Aires',
    flag: '🇦🇷',
    weeklyDigestTime: '12:00',
    sessionReminderTime: '08:30',
  },
  {
    userId: 13,
    firstName: 'Colombia',
    timezone: 'America/Bogota',
    flag: '🇨🇴',
    weeklyDigestTime: '10:00',
    sessionReminderTime: '06:30',
  },
  {
    userId: 14,
    firstName: 'Spain',
    timezone: 'Europe/Madrid',
    flag: '🇪🇸',
    weeklyDigestTime: '17:00',
    sessionReminderTime: '13:30',
  },
  {
    userId: 15,
    firstName: 'Uruguay',
    timezone: 'America/Montevideo',
    flag: '🇺🇾',
    weeklyDigestTime: '12:00',
    sessionReminderTime: '08:30',
  },
] as const;

Deno.test('/subscribe returns already_registered_msg for an active user', async () => {
  const userRepository = new InMemoryUserRepository([
    {
      userId: 1,
      firstName: 'John',
      username: 'john_doe',
      status: 'active',
      timezone: 'America/Santiago',
    },
  ]);
  const settingsRepository = new InMemorySettingsRepository({
    already_registered_msg: 'Hi {name} {flag} ({tz}), you are already registered.',
  });
  const messagingService = new RecordingMessagingService();
  const useCase = new TelegramBotUseCase(
    userRepository,
    settingsRepository,
    messagingService,
  );

  await useCase.executeCommand({
    command: '/subscribe',
    userId: 1,
    firstName: 'John',
    username: 'john_doe',
  });

  if (messagingService.sentMessages.length !== 1) {
    throw new Error('Expected exactly one outbound message.');
  }

  const [message] = messagingService.sentMessages;
  if (message.text !== 'Hi John 🇨🇱 (America/Santiago), you are already registered.') {
    throw new Error(`Unexpected message text: ${message.text}`);
  }
});

Deno.test('weekly_digest skips sending when the next race is outside the 7-day window', async () => {
  const userRepository = new InMemoryUserRepository([
    {
      userId: 1,
      firstName: 'John',
      username: 'john_doe',
      status: 'active',
      timezone: 'UTC',
    },
  ]);
  const settingsRepository = new InMemorySettingsRepository({
    weekly_summary_msg: 'Unused in this test',
    alert_lead_time: '15',
    post_race_delta: '45',
  });
  const messagingService = new RecordingMessagingService();
  const notificationLogRepository = new InMemoryNotificationLogRepository();
  const sessionProvider = new StubSessionProvider(
    'OpenF1',
    null,
    buildSession({ dateStart: new Date('2026-04-20T15:00:00Z') }),
    null,
  );
  const useCase = new WakeUpUseCase(
    sessionProvider,
    settingsRepository,
    userRepository,
    messagingService,
    notificationLogRepository,
    {
      enforceWeeklyDigestWindow: true,
      enforceSessionReminderWindow: true,
    },
  );

  const result = await useCase.execute('weekly_digest', new Date('2026-04-02T15:00:00Z'));

  if (result.action_taken !== 'outside_weekly_digest_window') {
    throw new Error(`Unexpected action: ${result.action_taken}`);
  }

  if (result.messages_sent !== 0) {
    throw new Error(`Expected zero messages, received ${result.messages_sent}`);
  }
});

Deno.test('session_reminder skips sending when the next session is outside the alert window', async () => {
  const userRepository = new InMemoryUserRepository([
    {
      userId: 1,
      firstName: 'John',
      username: 'john_doe',
      status: 'active',
      timezone: 'UTC',
    },
  ]);
  const settingsRepository = new InMemorySettingsRepository({
    session_reminder_msg: 'Unused in this test',
    alert_lead_time: '15',
    post_race_delta: '45',
  });
  const messagingService = new RecordingMessagingService();
  const notificationLogRepository = new InMemoryNotificationLogRepository();
  const sessionProvider = new StubSessionProvider(
    'OpenF1',
    buildSession({
      sessionName: 'Practice 1',
      sessionType: 'Practice 1',
      dateStart: new Date('2026-04-10T11:30:00Z'),
    }),
    null,
    null,
  );
  const useCase = new WakeUpUseCase(
    sessionProvider,
    settingsRepository,
    userRepository,
    messagingService,
    notificationLogRepository,
    {
      enforceWeeklyDigestWindow: true,
      enforceSessionReminderWindow: true,
    },
  );

  const result = await useCase.execute('session_reminder', new Date('2026-04-02T20:00:00Z'));

  if (result.action_taken !== 'outside_alert_window') {
    throw new Error(`Unexpected action: ${result.action_taken}`);
  }

  if (result.messages_sent !== 0) {
    throw new Error(`Expected zero messages, received ${result.messages_sent}`);
  }
});

Deno.test('weekly_digest renders the correct local time for every supported timezone', async () => {
  const userRepository = new InMemoryUserRepository(
    SUPPORTED_TIMEZONE_CASES.map((testCase) => ({
      userId: testCase.userId,
      firstName: testCase.firstName,
      username: testCase.firstName.toLowerCase(),
      status: 'active',
      timezone: testCase.timezone,
    })),
  );
  const settingsRepository = new InMemorySettingsRepository({
    weekly_summary_msg: '{name}|{flag}|{tz}|{time}',
    alert_lead_time: '15',
    post_race_delta: '45',
  });
  const messagingService = new RecordingMessagingService();
  const notificationLogRepository = new InMemoryNotificationLogRepository();
  const sessionProvider = new StubSessionProvider(
    'OpenF1',
    null,
    buildSession({ dateStart: new Date('2026-04-12T15:00:00Z') }),
    null,
  );
  const useCase = new WakeUpUseCase(
    sessionProvider,
    settingsRepository,
    userRepository,
    messagingService,
    notificationLogRepository,
    {
      enforceWeeklyDigestWindow: true,
      enforceSessionReminderWindow: true,
    },
  );

  const result = await useCase.execute('weekly_digest', new Date('2026-04-10T15:00:00Z'));

  if (result.action_taken !== 'weekly_digest_sent') {
    throw new Error(`Unexpected action: ${result.action_taken}`);
  }

  if (result.messages_sent !== SUPPORTED_TIMEZONE_CASES.length) {
    throw new Error(
      `Expected ${SUPPORTED_TIMEZONE_CASES.length} messages, received ${result.messages_sent}`,
    );
  }

  const messagesByUserId = new Map(
    messagingService.sentMessages.map((message) => [message.chatId, message.text]),
  );

  for (const testCase of SUPPORTED_TIMEZONE_CASES) {
    const expected =
      `${testCase.firstName}|${testCase.flag}|${testCase.timezone}|${testCase.weeklyDigestTime}`;
    const actual = messagesByUserId.get(testCase.userId);

    if (actual !== expected) {
      throw new Error(`Unexpected weekly digest for ${testCase.timezone}: ${actual}`);
    }
  }
});

Deno.test('session_reminder renders the correct local time for every supported timezone', async () => {
  const userRepository = new InMemoryUserRepository(
    SUPPORTED_TIMEZONE_CASES.map((testCase) => ({
      userId: testCase.userId,
      firstName: testCase.firstName,
      username: testCase.firstName.toLowerCase(),
      status: 'active',
      timezone: testCase.timezone,
    })),
  );
  const settingsRepository = new InMemorySettingsRepository({
    session_reminder_msg: '{name}|{flag}|{tz}|{local_time}|{session_type}',
    alert_lead_time: '15',
    post_race_delta: '45',
  });
  const messagingService = new RecordingMessagingService();
  const notificationLogRepository = new InMemoryNotificationLogRepository();
  const sessionProvider = new StubSessionProvider(
    'OpenF1',
    buildSession({
      sessionName: 'Practice 1',
      sessionType: 'Practice 1',
      dateStart: new Date('2026-04-10T11:30:00Z'),
    }),
    null,
    null,
  );
  const useCase = new WakeUpUseCase(
    sessionProvider,
    settingsRepository,
    userRepository,
    messagingService,
    notificationLogRepository,
    {
      enforceWeeklyDigestWindow: true,
      enforceSessionReminderWindow: true,
    },
  );

  const result = await useCase.execute('session_reminder', new Date('2026-04-10T11:20:00Z'));

  if (result.action_taken !== 'session_reminder_sent') {
    throw new Error(`Unexpected action: ${result.action_taken}`);
  }

  if (result.messages_sent !== SUPPORTED_TIMEZONE_CASES.length) {
    throw new Error(
      `Expected ${SUPPORTED_TIMEZONE_CASES.length} messages, received ${result.messages_sent}`,
    );
  }

  const messagesByUserId = new Map(
    messagingService.sentMessages.map((message) => [message.chatId, message.text]),
  );

  for (const testCase of SUPPORTED_TIMEZONE_CASES) {
    const expected =
      `${testCase.firstName}|${testCase.flag}|${testCase.timezone}|${testCase.sessionReminderTime}|Practice 1`;
    const actual = messagesByUserId.get(testCase.userId);

    if (actual !== expected) {
      throw new Error(`Unexpected session reminder for ${testCase.timezone}: ${actual}`);
    }
  }
});
