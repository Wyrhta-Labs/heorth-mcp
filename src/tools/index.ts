import type { AppConfig } from '../config/env.js';
import type { McpTool } from '../mcp/types.js';
import { householdTools } from './household.js';
import { calendarTools } from './calendar.js';
import { mealsTools } from './meals.js';
import { libraryTools } from './library.js';
import { inventoryTools } from './inventory.js';
import { tasksTools } from './tasks.js';
import { feohTools } from './feoh.js';

/**
 * Assemble the tool registry from the upstreams that are configured. With
 * neither configured this returns `[]` and the server serves an empty tool list
 * — a valid, running container (CLAUDE.md, "Each upstream is optional").
 *
 * Each `src/tools/<area>.ts` exports one registry array. The Heorth areas are
 * ported (task A5); `kith.*` follows once member context reaches KithLedger
 * (task B11) — see `docs/spec/tool-surface.md` and `docs/spec/migration.md`.
 */
export function buildRegistry(config: AppConfig): McpTool[] {
  const tools: McpTool[] = [];
  if (config.heorth) {
    tools.push(
      ...householdTools,
      ...calendarTools,
      ...mealsTools,
      ...libraryTools,
      ...inventoryTools,
      ...tasksTools,
      ...feohTools
    );
  }
  if (config.kith) {
    // kith.*
  }
  return tools;
}
