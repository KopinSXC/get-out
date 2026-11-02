import type { WorldDefinition } from 'cortico/world.ts';
import { describeTools } from 'cortico/world.ts';
import { SnapshotWorld, TOOL_SPECS, TOOL_SUMMARIES, WORLD_ID, defaultConfig, type SnapshotConfig } from './world.ts';

const definition: WorldDefinition<SnapshotConfig> = {
  id: WORLD_ID,
  label: '工作区快照',
  defaults: () => defaultConfig(),
  create: (ctx) => new SnapshotWorld({ cfg: ctx.cfg, timezone: ctx.timezone, dataDir: ctx.dataDir, botDir: ctx.botDir }),
  describe: { tools: describeTools(TOOL_SPECS, TOOL_SUMMARIES), events: [] },
};

export default definition;
