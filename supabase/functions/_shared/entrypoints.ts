import {
  buildSupabaseClient,
  OpenF1SessionProvider,
  SupabaseNotificationLogRepository,
  SupabaseSettingsRepository,
  SupabaseUserRepository,
  TelegramMessagingService,
} from './adapters.ts';
import { TelegramBotUseCase, WakeUpUseCase } from './application.ts';
import { getRuntimeConfig } from './env.ts';
import { errorResponse, jsonResponse } from './responses.ts';
import { extractCommand, RecentUpdateRegistry, SUBSCRIBE_CALLBACK_DATA } from './telegram.ts';

const SUPPORTED_COMMANDS = new Set(['/start', '/subscribe', '/unsubscribe', '/set_country']);
const recentUpdates = new RecentUpdateRegistry();
const logger = console;

function createRuntimeDependencies() {
  const config = getRuntimeConfig();
  const supabaseClient = buildSupabaseClient();
  const userRepository = new SupabaseUserRepository(supabaseClient);
  const settingsRepository = new SupabaseSettingsRepository(supabaseClient);
  const notificationLogRepository = new SupabaseNotificationLogRepository(supabaseClient);
  const messagingService = new TelegramMessagingService(config.telegramToken);
  const sessionProvider = new OpenF1SessionProvider({
    baseUrl: config.openF1BaseUrl,
    enforcePostRaceBriefingWindow: !config.disablePostRaceBriefingWindow,
  });

  return {
    config,
    userRepository,
    settingsRepository,
    notificationLogRepository,
    messagingService,
    sessionProvider,
  };
}

export async function handleTelegramWebhook(request: Request): Promise<Response> {
  const startedAt = Date.now();
  try {
    if (request.method !== 'POST') {
      logger.info('Serving Telegram webhook health check');
      return jsonResponse({ status: 'online', architecture: 'hexagonal' });
    }

    logger.info('Received Telegram webhook request');
    const payload = await request.json();
    const { userRepository, settingsRepository, messagingService } = createRuntimeDependencies();
    const useCase = new TelegramBotUseCase(userRepository, settingsRepository, messagingService);

    if (!isRecord(payload)) {
      throw new Error('Invalid Telegram payload.');
    }

    const rawUpdateId = payload.update_id;
    if (typeof rawUpdateId === 'number' && !recentUpdates.markSeen(rawUpdateId)) {
      logger.info('Ignoring duplicate Telegram update', { updateId: rawUpdateId });
      return jsonResponse({ status: 'ok' });
    }

    const message = getRecord(payload.message);
    const command = extractCommand(typeof message?.text === 'string' ? message.text : null);
    if (message && command && SUPPORTED_COMMANDS.has(command)) {
      const user = getRecord(message.from);
      if (!user || typeof user.id !== 'number' || typeof user.first_name !== 'string') {
        throw new Error('Update missing effective user.');
      }

      logger.info('Dispatching Telegram command', {
        command,
        userId: user.id,
      });
      await useCase.executeCommand({
        command,
        userId: user.id,
        firstName: user.first_name,
        username: typeof user.username === 'string' ? user.username : null,
      });
      logger.info('Completed Telegram command request', {
        command,
        userId: user.id,
        durationMs: Date.now() - startedAt,
      });
      return jsonResponse({ status: 'ok' });
    }

    const callbackQuery = getRecord(payload.callback_query);
    const callbackData = typeof callbackQuery?.data === 'string' ? callbackQuery.data : null;
    if (callbackQuery && callbackData) {
      const user = getRecord(callbackQuery.from);
      const callbackMessage = getRecord(callbackQuery.message);
      if (
        !user ||
        typeof user.id !== 'number' ||
        typeof user.first_name !== 'string' ||
        !callbackMessage ||
        typeof callbackMessage.message_id !== 'number'
      ) {
        throw new Error('Invalid Telegram callback payload.');
      }

      const chat = getRecord(callbackMessage.chat);
      if (!chat || typeof chat.id !== 'number' || typeof callbackQuery.id !== 'string') {
        throw new Error('Invalid Telegram callback payload.');
      }

      if (callbackData === SUBSCRIBE_CALLBACK_DATA) {
        logger.info('Dispatching subscribe callback', {
          userId: user.id,
        });
        await useCase.handleSubscribeCallback({
          callbackQueryId: callbackQuery.id,
          userId: user.id,
          firstName: user.first_name,
          username: typeof user.username === 'string' ? user.username : null,
          chatId: chat.id,
          messageId: callbackMessage.message_id,
        });
        logger.info('Completed Telegram subscribe callback', {
          userId: user.id,
          durationMs: Date.now() - startedAt,
        });
      } else if (callbackData.startsWith('tz_')) {
        logger.info('Dispatching timezone callback', {
          callbackData,
          userId: user.id,
        });
        await useCase.handleCountryCallback({
          callbackQueryId: callbackQuery.id,
          callbackData,
          userId: user.id,
          firstName: user.first_name,
          username: typeof user.username === 'string' ? user.username : null,
          chatId: chat.id,
          messageId: callbackMessage.message_id,
        });
        logger.info('Completed Telegram timezone callback', {
          callbackData,
          userId: user.id,
          durationMs: Date.now() - startedAt,
        });
      } else {
        logger.info('Ignoring unsupported callback data', { callbackData });
      }

      return jsonResponse({ status: 'ok' });
    }

    logger.info('Ignoring unsupported or empty Telegram update');
    return jsonResponse({ status: 'ok' });
  } catch (error) {
    logger.error('Telegram webhook error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return jsonResponse({
      status: 'error',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export async function handleWakeUp(request: Request): Promise<Response> {
  const startedAt = Date.now();
  try {
    if (request.method === 'GET') {
      logger.info('Serving wake-up health check');
      return jsonResponse({ status: 'online', architecture: 'hexagonal' });
    }

    const {
      config,
      sessionProvider,
      settingsRepository,
      userRepository,
      notificationLogRepository,
      messagingService,
    } = createRuntimeDependencies();
    const authorization = request.headers.get('authorization');
    if (authorization !== `Bearer ${config.secretToken}`) {
      logger.warn('Rejected unauthorized wake-up request');
      return errorResponse('Unauthorized', 401);
    }

    logger.info('Received wake-up request');
    const payload = await request.json();
    const triggerType = payload && typeof payload === 'object' && 'trigger_type' in payload
      ? payload.trigger_type
      : null;

    if (typeof triggerType !== 'string' || triggerType.length === 0) {
      return errorResponse('Missing trigger_type.', 400);
    }

    logger.info('Dispatching wake-up trigger', { triggerType });
    const useCase = new WakeUpUseCase(
      sessionProvider,
      settingsRepository,
      userRepository,
      messagingService,
      notificationLogRepository,
      {
        enforceWeeklyDigestWindow: !config.disableWeeklyDigestWindow,
        enforceSessionReminderWindow: !config.disableSessionReminderWindow,
      },
    );

    const result = await useCase.execute(triggerType);
    logger.info('Completed wake-up trigger', {
      triggerType,
      actionTaken: typeof result.action_taken === 'string' ? result.action_taken : null,
      messagesSent: typeof result.messages_sent === 'number' ? result.messages_sent : null,
      durationMs: Date.now() - startedAt,
    });
    return jsonResponse(result);
  } catch (error) {
    logger.error('Wake-up endpoint error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return jsonResponse({
      status: 'error',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}
