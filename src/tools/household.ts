import type { McpTool, McpToolContext, McpToolResult } from '../mcp/types.js';
import type { HeorthClient } from '../upstream/heorth.js';

/** Wrap any JSON-serialisable value as an MCP text tool-result. */
function result(data: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/**
 * The caller-bound Heorth client for this request. Absent only if the tool was
 * registered without Heorth configured — a wiring bug, not a runtime condition.
 */
function heorth(ctx: McpToolContext): HeorthClient {
  const client = ctx.upstreams.heorth;
  if (!client) throw new Error('HEORTH_NOT_CONFIGURED');
  return client;
}

/** Heorth's `{ data, meta }` response envelope (`@wyrhta/core/http`). */
interface Envelope<T> {
  data: T;
}

export const householdTools: McpTool[] = [
  {
    name: 'household.get_members',
    description: 'List every member of the household with their role and profile.',
    inputSchema: {},
    async handler(ctx) {
      const res = await heorth(ctx).get<Envelope<unknown[]>>('/members');
      return result({ members: res.data });
    },
  },
  {
    name: 'household.whoami',
    description: 'Return the member identity behind the current API key.',
    inputSchema: {},
    async handler(ctx) {
      // The route derives the member from the authenticated caller — the
      // principal's id here is a key fingerprint, never a member id.
      const res = await heorth(ctx).get<Envelope<unknown>>('/auth/whoami');
      return result(res.data);
    },
  },
];
