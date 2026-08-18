import type { z } from 'zod';
import type { Upstreams } from '../upstream/index.js';

/**
 * The caller behind one MCP request.
 *
 * heorth-mcp never validates a key itself — it forwards the caller's
 * `Authorization` header to Heorth, which resolves the member. So the id here is
 * an opaque, non-reversible fingerprint of the presented key, good for
 * correlating log lines and nothing else; the real identity comes from
 * `household.whoami` upstream. `role` is likewise unknown here: per-member
 * permission checks happen in Heorth, on the REST call the tool makes.
 */
export interface McpPrincipal {
  userId: string;
  role?: 'admin' | 'adult' | 'child';
}

export interface McpToolContext {
  principal: McpPrincipal;
  requestId: string;
  /**
   * The upstream clients for *this* request. Heorth's client is bound to the
   * caller's key, so it cannot be hoisted to process scope — that is why a
   * fresh MCP server is built per request (see src/mcp/server.ts).
   */
  upstreams: Upstreams;
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  // MCP SDK's CallToolResult carries an index signature; mirror it so tool
  // handler returns are structurally assignable to `registerTool`.
  [key: string]: unknown;
}

export interface McpTool {
  name: string;
  description: string;
  /** Zod raw shape (object of Zod types), as `registerTool` expects. */
  inputSchema: z.ZodRawShape;
  handler: (ctx: McpToolContext, input: Record<string, unknown>) => Promise<McpToolResult>;
}

/** App-provided bridge that resolves the authenticated caller. */
export interface AuthAdapter {
  resolve: () => Promise<McpPrincipal>;
}
