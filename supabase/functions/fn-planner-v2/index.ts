import { handlePlannerV2 } from '../_shared/v2-entrypoints.ts';

Deno.serve((request) => handlePlannerV2(request));
