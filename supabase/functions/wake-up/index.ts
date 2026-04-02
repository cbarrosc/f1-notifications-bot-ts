import { handleWakeUp } from '../_shared/entrypoints.ts';

Deno.serve((request) => handleWakeUp(request));
