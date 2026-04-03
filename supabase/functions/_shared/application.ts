import { buildNewUser } from './domain.ts';
import type {
  CountryOption,
  MessagingService,
  NotificationLogRepository,
  SessionProvider,
  SettingsRepository,
  UserRepository,
} from './ports.ts';
import { SUBSCRIBE_BUTTON_TEXT, SUBSCRIBE_CALLBACK_DATA } from './telegram.ts';

const CHILE_TIME_ZONE = 'America/Santiago';
const logger = console;

export const COUNTRY_OPTIONS: CountryOption[][] = [
  [
    { text: '🇨🇱 Chile', callbackData: 'tz_cl' },
    { text: '🇦🇷 Argentina', callbackData: 'tz_ar' },
  ],
  [
    { text: '🇨🇴 Colombia', callbackData: 'tz_co' },
    { text: '🇪🇸 España', callbackData: 'tz_es' },
  ],
  [
    { text: '🇺🇾 Uruguay', callbackData: 'tz_uy' },
  ],
];

const TIMEZONE_BY_CALLBACK: Record<string, string> = {
  tz_cl: 'America/Santiago',
  tz_ar: 'America/Argentina/Buenos_Aires',
  tz_co: 'America/Bogota',
  tz_es: 'Europe/Madrid',
  tz_uy: 'America/Montevideo',
};

const TIMEZONE_FLAG_BY_NAME: Record<string, string> = {
  'America/Santiago': '🇨🇱',
  'America/Argentina/Buenos_Aires': '🇦🇷',
  'America/Bogota': '🇨🇴',
  'Europe/Madrid': '🇪🇸',
  'America/Montevideo': '🇺🇾',
  UTC: '🌐',
};

export class TelegramBotUseCase {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly settingsRepository: SettingsRepository,
    private readonly messagingService: MessagingService,
  ) {}

  async executeCommand(input: {
    command: string;
    userId: number;
    firstName: string;
    username?: string | null;
  }): Promise<void> {
    if (input.command === '/start') {
      logger.info('Processing Telegram command', {
        command: input.command,
        userId: input.userId,
      });
      const existingUser = await this.userRepository.getUser(input.userId);
      if (existingUser) {
        const text = await this.buildAlreadyRegisteredText(input.firstName, existingUser, [
          'already_registered',
          'already_registered_msg',
        ]);
        await this.messagingService.sendMessage(input.userId, text);
        logger.info('Completed Telegram command for existing user', {
          command: input.command,
          userId: input.userId,
        });
        return;
      }

      const user = buildNewUser(input);
      await this.userRepository.saveUser(user);
      const template = await this.settingsRepository.getValue('welcome_msg');
      const text = template.replace('{name}', input.firstName);
      await this.messagingService.sendSubscribePrompt(
        input.userId,
        text,
        SUBSCRIBE_BUTTON_TEXT,
        SUBSCRIBE_CALLBACK_DATA,
      );
      logger.info('Completed Telegram command for new user', {
        command: input.command,
        userId: input.userId,
      });
      return;
    }

    if (input.command === '/subscribe') {
      logger.info('Processing Telegram command', {
        command: input.command,
        userId: input.userId,
      });
      const existingUser = await this.ensureUserExists({
        userId: input.userId,
        firstName: input.firstName,
        username: input.username ?? null,
      });
      if (existingUser?.status === 'active') {
        const text = await this.buildAlreadyRegisteredText(input.firstName, existingUser, [
          'already_registered_msg',
          'already_registered',
        ]);
        await this.messagingService.sendMessage(input.userId, text);
        logger.info('Skipped subscribe because user is already active', {
          userId: input.userId,
        });
        return;
      }

      const text = await this.activateUserAndBuildSubscribeText(input.userId, input.firstName);
      await this.messagingService.sendMessage(input.userId, text);
      return;
    }

    if (input.command === '/unsubscribe') {
      logger.info('Processing Telegram command', {
        command: input.command,
        userId: input.userId,
      });
      await this.ensureUserExists({
        userId: input.userId,
        firstName: input.firstName,
        username: input.username ?? null,
      });
      await this.userRepository.updateUserStatus(input.userId, 'inactive');
      const text = await this.settingsRepository.getValue('unsubscribe_ok');
      await this.messagingService.sendMessage(input.userId, text);
      logger.info('Updated user subscription status', {
        userId: input.userId,
        status: 'inactive',
      });
      return;
    }

    if (input.command === '/set_country') {
      logger.info('Processing Telegram command', {
        command: input.command,
        userId: input.userId,
      });
      await this.ensureUserExists({
        userId: input.userId,
        firstName: input.firstName,
        username: input.username ?? null,
      });
      await this.messagingService.sendCountryOptions(
        input.userId,
        await this.settingsRepository.getValue('set_country_msg'),
        COUNTRY_OPTIONS,
      );
      logger.info('Sent country selector', {
        userId: input.userId,
      });
      return;
    }

    logger.warn('Ignoring unsupported Telegram command', {
      command: input.command,
      userId: input.userId,
    });
  }

  async handleCountryCallback(input: {
    callbackQueryId: string;
    callbackData: string;
    userId: number;
    firstName: string;
    username?: string | null;
    chatId: number;
    messageId: number;
  }): Promise<void> {
    const timezone = TIMEZONE_BY_CALLBACK[input.callbackData];
    if (!timezone) {
      logger.warn('Ignoring unsupported country callback', {
        callbackData: input.callbackData,
        userId: input.userId,
      });
      await this.messagingService.answerCallbackQuery(
        input.callbackQueryId,
        'Opcion no soportada.',
      );
      return;
    }

    logger.info('Updating user timezone from callback', {
      callbackData: input.callbackData,
      timezone,
      userId: input.userId,
    });
    await this.ensureUserExists({
      userId: input.userId,
      firstName: input.firstName,
      username: input.username ?? null,
    });
    await this.userRepository.updateUserTimezone(input.userId, timezone);
    await this.messagingService.answerCallbackQuery(input.callbackQueryId, '');

    const template = await this.settingsRepository.getValue('timezone_confirmation_text');
    const text = template.replace('{name}', input.firstName);

    try {
      await this.messagingService.editMessage(input.chatId, input.messageId, text);
    } catch {
      logger.warn('Falling back to sendMessage after editMessage failure', {
        userId: input.userId,
        messageId: input.messageId,
      });
      await this.messagingService.sendMessage(input.userId, text);
    }
  }

  async handleSubscribeCallback(input: {
    callbackQueryId: string;
    userId: number;
    firstName: string;
    username?: string | null;
    chatId: number;
    messageId: number;
  }): Promise<void> {
    logger.info('Processing subscribe callback', {
      userId: input.userId,
    });
    const existingUser = await this.ensureUserExists({
      userId: input.userId,
      firstName: input.firstName,
      username: input.username ?? null,
    });
    await this.messagingService.answerCallbackQuery(input.callbackQueryId, '');
    const text = existingUser.status === 'active'
      ? await this.buildAlreadyRegisteredText(input.firstName, existingUser, [
        'already_registered_msg',
        'already_registered',
      ])
      : await this.activateUserAndBuildSubscribeText(input.userId, input.firstName);

    try {
      await this.messagingService.editMessage(input.chatId, input.messageId, text);
    } catch {
      logger.warn('Falling back to sendMessage after subscribe edit failure', {
        userId: input.userId,
        messageId: input.messageId,
      });
      await this.messagingService.sendMessage(input.userId, text);
    }
  }

  private async ensureUserExists(input: {
    userId: number;
    firstName: string;
    username?: string | null;
  }) {
    const existingUser = await this.userRepository.getUser(input.userId);
    if (existingUser) {
      return existingUser;
    }

    const user = buildNewUser(input);
    await this.userRepository.saveUser(user);
    logger.info('Created missing user before follow-up action', {
      userId: input.userId,
    });
    return user;
  }

  private async activateUserAndBuildSubscribeText(
    userId: number,
    firstName: string,
  ): Promise<string> {
    await this.userRepository.updateUserStatus(userId, 'active');
    logger.info('Updated user subscription status', {
      userId,
      status: 'active',
    });
    return (await this.settingsRepository.getValue('subscribe_ok')).replace('{name}', firstName);
  }

  private async buildAlreadyRegisteredText(
    firstName: string,
    user: { timezone: string | null },
    preferredKeys: string[],
  ): Promise<string> {
    let template: string | null = null;
    let lastError: Error | null = null;

    for (const key of preferredKeys) {
      try {
        template = await this.settingsRepository.getValue(key);
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown bot setting error.');
      }
    }

    if (template === null) {
      throw lastError ?? new Error('Missing already-registered message template.');
    }

    const timezone = user.timezone ?? 'UTC';
    return template
      .replace('{name}', firstName)
      .replace('{tz}', timezone)
      .replace('{flag}', formatTimezoneFlag(timezone));
  }
}

export class WakeUpUseCase {
  constructor(
    private readonly sessionProvider: SessionProvider,
    private readonly settingsRepository: SettingsRepository,
    private readonly userRepository: UserRepository,
    private readonly messagingService: MessagingService,
    private readonly notificationLogRepository: NotificationLogRepository,
    private readonly options: {
      enforceWeeklyDigestWindow: boolean;
      enforceSessionReminderWindow: boolean;
    },
  ) {}

  async execute(triggerType: string, now = new Date()): Promise<Record<string, unknown>> {
    logger.info('Processing wake-up trigger', {
      triggerType,
      now: now.toISOString(),
    });
    if (triggerType === 'weekly_digest') {
      return await this.sendWeeklyDigest(now);
    }

    if (triggerType === 'session_reminder') {
      return await this.sendSessionReminder(now);
    }

    if (triggerType === 'post_race_briefing') {
      return await this.sendPostRaceBriefing(now);
    }

    throw new Error(`Unsupported trigger_type: ${triggerType}`);
  }

  private async sendWeeklyDigest(now: Date): Promise<Record<string, unknown>> {
    const nextSession = await this.sessionProvider.getNextRaceAfter(now);
    // The endpoint response mirrors the Python service to make the migration easier to validate.
    const response: Record<string, unknown> = {
      status: 'awake',
      source: this.sessionProvider.getSourceName(),
      trigger_type: 'weekly_digest',
      next_session: buildSessionPayload(nextSession, now),
    };

    if (nextSession === null) {
      logger.info('Weekly digest skipped because no next race was found');
      response.action_taken = 'no_session_found';
      response.messages_sent = 0;
      return response;
    }

    const weeklyDigestWindowMs = 7 * 24 * 60 * 60 * 1000;
    if (
      this.options.enforceWeeklyDigestWindow &&
      nextSession.dateStart.getTime() - now.getTime() > weeklyDigestWindowMs
    ) {
      logger.info('Weekly digest skipped because the next race is outside the 7-day window');
      response.action_taken = 'outside_weekly_digest_window';
      response.messages_sent = 0;
      return response;
    }

    const activeUsers = await this.userRepository.listActiveUsers();
    if (activeUsers.length === 0) {
      logger.info('Weekly digest skipped because there are no active users');
      response.action_taken = 'no_active_users';
      response.messages_sent = 0;
      return response;
    }

    const template = await this.settingsRepository.getValue('weekly_summary_msg');
    const notificationKey = buildWeeklyDigestNotificationKey(nextSession);
    let messagesSent = 0;
    for (const user of activeUsers) {
      const shouldSend = await this.notificationLogRepository.markAsSent(
        user.userId,
        notificationKey,
      );
      if (!shouldSend) {
        continue;
      }

      const timezone = user.timezone ?? 'UTC';
      const message = renderWeeklySummaryMessage(template, nextSession, user.firstName, timezone);
      try {
        await this.messagingService.sendMessage(user.userId, message);
      } catch (error) {
        await this.notificationLogRepository.unmarkAsSent(user.userId, notificationKey);
        throw error;
      }
      messagesSent += 1;
    }

    logger.info('Completed weekly digest dispatch', {
      messagesSent,
    });
    response.action_taken = messagesSent > 0 ? 'weekly_digest_sent' : 'already_sent';
    response.messages_sent = messagesSent;
    return response;
  }

  private async sendSessionReminder(now: Date): Promise<Record<string, unknown>> {
    const nextSession = await this.sessionProvider.getNextSessionAfter(now);
    const response: Record<string, unknown> = {
      status: 'awake',
      source: this.sessionProvider.getSourceName(),
      trigger_type: 'session_reminder',
      next_session: buildSessionPayload(nextSession, now),
    };

    if (nextSession === null) {
      logger.info('Session reminder skipped because no next session was found');
      response.action_taken = 'no_session_found';
      response.messages_sent = 0;
      return response;
    }

    const alertLeadTime = await this.getAlertLeadTime();
    response.alert_lead_time_minutes = alertLeadTime;
    if (
      this.options.enforceSessionReminderWindow &&
      nextSession.dateStart.getTime() - now.getTime() > alertLeadTime * 60_000
    ) {
      logger.info('Session reminder skipped because the session is outside the alert window', {
        alertLeadTime,
      });
      response.action_taken = 'outside_alert_window';
      response.messages_sent = 0;
      return response;
    }

    if (nextSession.dateStart.getTime() <= now.getTime()) {
      logger.info('Session reminder skipped because the session has already started');
      response.action_taken = 'session_already_started';
      response.messages_sent = 0;
      return response;
    }

    const activeUsers = await this.userRepository.listActiveUsers();
    if (activeUsers.length === 0) {
      logger.info('Session reminder skipped because there are no active users');
      response.action_taken = 'no_active_users';
      response.messages_sent = 0;
      return response;
    }

    const template = await this.settingsRepository.getValue('session_reminder_msg');
    const notificationKey = buildSessionReminderNotificationKey(nextSession);
    let messagesSent = 0;
    for (const user of activeUsers) {
      const shouldSend = await this.notificationLogRepository.markAsSent(
        user.userId,
        notificationKey,
      );
      if (!shouldSend) {
        continue;
      }

      const timezone = user.timezone ?? 'UTC';
      const message = renderSessionReminderMessage(template, nextSession, user.firstName, timezone);
      try {
        await this.messagingService.sendMessage(user.userId, message);
      } catch (error) {
        await this.notificationLogRepository.unmarkAsSent(user.userId, notificationKey);
        throw error;
      }
      messagesSent += 1;
    }

    logger.info('Completed session reminder dispatch', {
      messagesSent,
      alertLeadTime,
    });
    response.action_taken = messagesSent > 0 ? 'session_reminder_sent' : 'already_sent';
    response.messages_sent = messagesSent;
    return response;
  }

  private async sendPostRaceBriefing(now: Date): Promise<Record<string, unknown>> {
    const briefing = await this.sessionProvider.getPostRaceBriefing(now);
    const response: Record<string, unknown> = {
      status: 'awake',
      source: this.sessionProvider.getSourceName(),
      trigger_type: 'post_race_briefing',
    };

    if (briefing === null) {
      logger.info('Post-race briefing skipped because no completed race was found');
      response.action_taken = 'no_completed_race_found';
      response.messages_sent = 0;
      return response;
    }

    response.completed_race = buildSessionPayload(briefing.completedRace, now);
    response.next_gp = briefing.nextGrandPrix;
    response.days_left = briefing.daysLeft;

    const postRaceDelta = await this.getPostRaceDelta();
    const postRaceMaxWindow = await this.getOptionalPostRaceMaxWindow();
    response.post_race_delta_minutes = postRaceDelta;
    response.post_race_max_window_minutes = postRaceMaxWindow;
    const elapsedSinceRaceEndMs = briefing.completedRace.dateEnd === null
      ? null
      : now.getTime() - briefing.completedRace.dateEnd.getTime();

    if (
      briefing.completedRace.dateEnd === null ||
      elapsedSinceRaceEndMs === null ||
      elapsedSinceRaceEndMs < postRaceDelta * 60_000 ||
      (
        postRaceMaxWindow !== null &&
        elapsedSinceRaceEndMs > postRaceMaxWindow * 60_000
      )
    ) {
      logger.info('Post-race briefing skipped because it is outside the configured time window', {
        postRaceDelta,
        postRaceMaxWindow,
      });
      response.action_taken = 'outside_post_race_window';
      response.messages_sent = 0;
      return response;
    }

    const activeUsers = await this.userRepository.listActiveUsers();
    if (activeUsers.length === 0) {
      logger.info('Post-race briefing skipped because there are no active users');
      response.action_taken = 'no_active_users';
      response.messages_sent = 0;
      return response;
    }

    const template = await this.settingsRepository.getValue('post_race_briefing_msg');
    const notificationKey = buildPostRaceBriefingNotificationKey(briefing.completedRace);
    let messagesSent = 0;
    for (const user of activeUsers) {
      const shouldSend = await this.notificationLogRepository.markAsSent(
        user.userId,
        notificationKey,
      );
      if (!shouldSend) {
        continue;
      }

      const message = renderPostRaceBriefingMessage(template, briefing, user.firstName);
      try {
        await this.messagingService.sendMessage(user.userId, message);
      } catch (error) {
        await this.notificationLogRepository.unmarkAsSent(user.userId, notificationKey);
        throw error;
      }
      messagesSent += 1;
    }

    logger.info('Completed post-race briefing dispatch', {
      messagesSent,
      postRaceDelta,
    });
    response.action_taken = messagesSent > 0 ? 'post_race_briefing_sent' : 'already_sent';
    response.messages_sent = messagesSent;
    return response;
  }

  private async getAlertLeadTime(): Promise<number> {
    const rawValue = await this.settingsRepository.getValue('alert_lead_time');
    const leadTime = Number.parseInt(rawValue, 10);
    if (Number.isNaN(leadTime)) {
      throw new Error('Invalid bot setting value for key: alert_lead_time');
    }

    if (leadTime < 0) {
      throw new Error('alert_lead_time must be zero or greater');
    }

    return leadTime;
  }

  private async getPostRaceDelta(): Promise<number> {
    const rawValue = await this.settingsRepository.getValue('post_race_delta');
    const delta = Number.parseInt(rawValue, 10);
    if (Number.isNaN(delta)) {
      throw new Error('Invalid bot setting value for key: post_race_delta');
    }

    if (delta < 0) {
      throw new Error('post_race_delta must be zero or greater');
    }

    return delta;
  }

  private async getOptionalPostRaceMaxWindow(): Promise<number | null> {
    const rawValue = await this.settingsRepository.getBotSettings();
    const maxWindow = rawValue.postRaceMaxWindowMinutes;

    if (maxWindow === null) {
      return null;
    }

    if (Number.isNaN(maxWindow)) {
      throw new Error('Invalid bot setting value for key: post_race_max_window');
    }

    if (maxWindow < 0) {
      throw new Error('post_race_max_window must be zero or greater');
    }

    return maxWindow;
  }
}

function buildSessionPayload(
  session: {
    sessionName: string;
    location: string | null;
    dateStart: Date;
  } | null,
  now: Date,
): Record<string, unknown> | null {
  if (session === null) {
    return null;
  }

  return {
    name: session.sessionName,
    location: session.location,
    utc_start: formatUtcDatetime(session.dateStart),
    chile_start: formatChileDatetime(session.dateStart),
    minutes_to_start: Math.floor((session.dateStart.getTime() - now.getTime()) / 60_000),
  };
}

function renderWeeklySummaryMessage(
  template: string,
  session: { location: string | null; dateStart: Date; sessionName: string },
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
  briefing: {
    completedRace: { location: string | null };
    podium: [
      { driverName: string; teamName: string },
      { driverName: string; teamName: string },
      { driverName: string; teamName: string },
    ];
    nextGrandPrix: string | null;
    daysLeft: number | null;
  },
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

function formatUtcDatetime(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function formatChileDatetime(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: CHILE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).formatToParts(value);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute} ${values.timeZoneName}`;
}

function formatUserDatetime(value: Date, timezone: string): string {
  // Invalid user timezones fall back to UTC to preserve the Python behavior.
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

function buildWeeklyDigestNotificationKey(session: {
  sessionKey: number | null;
  dateStart: Date;
}): string {
  return `weekly_digest:${session.sessionKey ?? session.dateStart.toISOString()}`;
}

function buildSessionReminderNotificationKey(session: {
  sessionKey: number | null;
  dateStart: Date;
}): string {
  return `session_reminder:${session.sessionKey ?? session.dateStart.toISOString()}`;
}

function buildPostRaceBriefingNotificationKey(session: {
  sessionKey: number | null;
  dateStart: Date;
}): string {
  return `post_race_briefing:${session.sessionKey ?? session.dateStart.toISOString()}`;
}

function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
