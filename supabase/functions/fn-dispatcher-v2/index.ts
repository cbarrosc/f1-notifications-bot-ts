import { handleDispatcherV2 } from '../_shared/v2-entrypoints.ts';

Deno.serve((request) => handleDispatcherV2(request));
