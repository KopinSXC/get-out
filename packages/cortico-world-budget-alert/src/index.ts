import type { WorldDefinition } from 'cortico/world.ts';
import { describeTools } from 'cortico/world.ts';
import { BudgetWorld, EVENTS, TOOL_SPECS, TOOL_SUMMARIES, WORLD_ID, defaultConfig, type BudgetConfig } from './world.ts';

const definition: WorldDefinition<BudgetConfig> = {
  id: WORLD_ID,
  label: '预算告警',
  defaults: () => defaultConfig(),
  create: (ctx) => new BudgetWorld({ cfg: ctx.cfg, timezone: ctx.timezone, dataDir: ctx.dataDir, persist: (patch) => ctx.persist(patch) }),
  describe: { tools: describeTools(TOOL_SPECS, TOOL_SUMMARIES), events: EVENTS },
};

export default definition;
