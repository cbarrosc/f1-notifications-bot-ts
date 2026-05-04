import {
  buildV2SupabaseClient,
  OpenF1PlannerSource,
  SupabaseDeliveryLogRepository,
  SupabaseNotificationQueueRepository,
  SupabaseSessionCacheRepository,
} from './v2-adapters.ts';
import { DispatcherV2UseCase, PlannerV2UseCase } from './v2-application.ts';
import {
  SupabaseSettingsRepository,
  SupabaseUserRepository,
  TelegramMessagingService,
} from './adapters.ts';
import { getRuntimeConfig } from './env.ts';
import { errorResponse, jsonResponse } from './responses.ts';
import type { PlannerMode } from './v2-domain.ts';

const logger = console;

function createRuntimeDependencies() {
  const config = getRuntimeConfig();
  const supabaseClient = buildV2SupabaseClient();

  return {
    config,
    settingsRepository: new SupabaseSettingsRepository(supabaseClient),
    userRepository: new SupabaseUserRepository(supabaseClient),
    messagingService: new TelegramMessagingService(config.telegramToken),
    queueRepository: new SupabaseNotificationQueueRepository(supabaseClient),
    sessionCacheRepository: new SupabaseSessionCacheRepository(supabaseClient),
    deliveryLogRepository: new SupabaseDeliveryLogRepository(supabaseClient),
    plannerSource: new OpenF1PlannerSource(config.openF1BaseUrl),
  };
}

export async function handlePlannerV2(request: Request): Promise<Response> {
  try {
    if (request.method === 'GET') {
      return jsonResponse({ status: 'online', function: 'fn-planner-v2' });
    }

    if (request.method !== 'POST') {
      return errorResponse('Method Not Allowed', 405);
    }

    const {
      config,
      settingsRepository,
      plannerSource,
      sessionCacheRepository,
      queueRepository,
    } = createRuntimeDependencies();

    const authorization = request.headers.get('authorization');
    if (authorization !== `Bearer ${config.secretToken}`) {
      logger.warn('Rejected unauthorized planner v2 request');
      return errorResponse('Unauthorized', 401);
    }

    const payload = await request.json().catch(() => ({}));
    const mode = isPlannerMode(payload?.mode) ? payload.mode : 'weekly';
    const useCase = new PlannerV2UseCase(
      plannerSource,
      settingsRepository,
      sessionCacheRepository,
      queueRepository,
    );

    return jsonResponse(await useCase.execute(mode));
  } catch (error) {
    logger.error('Planner V2 error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return errorResponse(error instanceof Error ? error.message : 'Unknown error', 500);
  }
}

export async function handleDispatcherV2(request: Request): Promise<Response> {
  try {
    if (request.method === 'GET') {
      return jsonResponse({ status: 'online', function: 'fn-dispatcher-v2' });
    }

    if (request.method !== 'POST') {
      return errorResponse('Method Not Allowed', 405);
    }

    const {
      config,
      settingsRepository,
      userRepository,
      messagingService,
      queueRepository,
      sessionCacheRepository,
      deliveryLogRepository,
      plannerSource,
    } = createRuntimeDependencies();

    const authorization = request.headers.get('authorization');
    if (authorization !== `Bearer ${config.secretToken}`) {
      logger.warn('Rejected unauthorized dispatcher v2 request');
      return errorResponse('Unauthorized', 401);
    }

    const payload = await request.json().catch(() => ({}));
    const batchSize = typeof payload?.batch_size === 'number' && payload.batch_size > 0
      ? payload.batch_size
      : config.dispatcherV2BatchSize;
    const useCase = new DispatcherV2UseCase(
      queueRepository,
      sessionCacheRepository,
      deliveryLogRepository,
      userRepository,
      settingsRepository,
      messagingService,
      plannerSource,
      {
        dryRun: config.dispatcherV2DryRun,
        allowlist: new Set(config.dispatcherV2Allowlist),
        maxRetries: 3,
      },
    );

    return jsonResponse(await useCase.execute(batchSize));
  } catch (error) {
    logger.error('Dispatcher V2 error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return errorResponse(error instanceof Error ? error.message : 'Unknown error', 500);
  }
}

function isPlannerMode(value: unknown): value is PlannerMode {
  return value === 'weekly' || value === 'rebuild';
}
