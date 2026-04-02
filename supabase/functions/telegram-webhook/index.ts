import { handleTelegramWebhook } from '../_shared/entrypoints.ts';

Deno.serve((request) => handleTelegramWebhook(request));
