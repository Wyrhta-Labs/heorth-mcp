import type { AppConfig } from '../config/env.js';
import type { McpTool } from '../mcp/types.js';

/**
 * Assemble the tool registry from the upstreams that are configured. With
 * neither configured this returns `[]` and the server serves an empty tool list
 * — a valid, running container (CLAUDE.md, "Each upstream is optional").
 *
 * The tool modules themselves (`src/tools/<area>.ts`, one registry array each)
 * arrive with the port of the Heorth and KithLedger tools — see
 * `docs/spec/tool-surface.md` and steps 3–4 of `docs/spec/migration.md`.
 */
export function buildRegistry(config: AppConfig): McpTool[] {
  const tools: McpTool[] = [];
  if (config.heorth) {
    // household.*, calendar.*, meals.*, library.*, inventory.*, tasks.*, feoh.*
  }
  if (config.kith) {
    // kith.*
  }
  return tools;
}
