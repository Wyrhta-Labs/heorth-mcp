import type { AppConfig } from '../config/env.js';
import type { McpTool } from '../mcp/types.js';
import { householdTools } from './household.js';
import { calendarTools } from './calendar.js';
import { mealsTools } from './meals.js';
import { libraryTools } from './library.js';
import { inventoryTools } from './inventory.js';
import { tasksTools } from './tasks.js';
import { feohTools } from './feoh.js';
import { kithTools } from './kith.js';

/**
 * Assemble the tool registry from the upstreams that are configured. With
 * neither configured this returns `[]` and the server serves an empty tool list
 * — a valid, running container (CLAUDE.md, "Each upstream is optional").
 *
 * Each `src/tools/<area>.ts` exports one registry array: 37 Heorth tools (task
 * A5) and 13 `kith.*` tools (task B11), 50 in all — see
 * `docs/spec/tool-surface.md` and `docs/spec/migration.md`.
 *
 * `config.kith` is non-null only when *both* upstreams are configured, because
 * a `kith.*` call authenticates with a member token exchanged at Heorth
 * (ADR 0009). That is enforced at boot in `src/config/env.ts`; here it is
 * simply the branch condition.
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
    tools.push(...kithTools);
  }
  return tools;
}
