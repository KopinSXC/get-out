import type { WorldDefinition } from 'cortico/world.ts';
import { describeTools } from 'cortico/world.ts';
import { OcrWorld, TOOL_SPECS, TOOL_SUMMARIES, WORLD_ID, defaultConfig, type OcrConfig } from './world.ts';

const definition: WorldDefinition<OcrConfig> = {
  id: WORLD_ID,
  label: '屏幕 OCR',
  defaults: () => defaultConfig(),
  create: (ctx) => new OcrWorld({ cfg: ctx.cfg, timezone: ctx.timezone, dataDir: ctx.dataDir }),
  describe: { tools: describeTools(TOOL_SPECS, TOOL_SUMMARIES), events: [] },
};

export default definition;
