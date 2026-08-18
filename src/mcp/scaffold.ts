import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logEvent, logError } from '../lib/logger.js';
import type { Upstreams } from '../upstream/index.js';
import type { AuthAdapter, McpTool } from './types.js';

/**
 * Tool handlers signal domain errors by throwing a bare `Error` whose message is
 * an UPPER_SNAKE_CASE code (e.g. `throw new Error('NOT_FOUND')`). Upstream
 * `{ error: { code, message } }` envelopes are rethrown the same way, so an
 * upstream `code` reaches the client as the tool error text. Only messages
 * matching this shape are safe to surface; anything else (upstream URLs,
 * headers, stack traces, Zod internals) stays generic.
 */
const DOMAIN_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function toolErrorText(error: unknown): string {
  if (error instanceof Error && DOMAIN_ERROR_CODE.test(error.message)) {
    return error.message;
  }
  return 'tool error';
}

/**
 * Assemble an MCP server from a tool registry. Every tool call runs through the
 * same auth (`authAdapter.resolve`) and the same audit logger, then delegates to
 * the tool's handler with a typed context carrying this request's upstream
 * clients.
 */
export function createMcpServer(
  registry: McpTool[],
  authAdapter: AuthAdapter,
  upstreams: Upstreams,
  info: { name: string; version: string } = { name: 'heorth-mcp', version: '0.1.0' }
): McpServer {
  const server = new McpServer(info);

  // The SDK installs its `tools/list` handler lazily, on the first
  // `registerTool` — so a server with no tools would answer `tools/list` with
  // "Method not found" instead of an empty list. With both upstreams
  // unconfigured that is exactly the state we must serve (CLAUDE.md, "Each
  // upstream is optional"), so install the handlers by registering a tool and
  // removing it again; the capability stays, the tool does not.
  if (registry.length === 0) {
    server.registerTool('_bootstrap', { description: 'never listed' }, async () => ({
      content: [{ type: 'text' as const, text: '' }],
    })).remove();
  }

  for (const tool of registry) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (input: Record<string, unknown>) => {
        const requestId = randomUUID();

        // Auth failures must stay generic — never leak why resolution failed.
        let principal;
        try {
          principal = await authAdapter.resolve();
        } catch (error) {
          logError(`mcp tool ${tool.name} failed`, error);
          return {
            content: [{ type: 'text' as const, text: 'Unauthorized or tool error' }],
            isError: true,
          };
        }

        logEvent({
          event: 'mcp.tool.call',
          request_id: requestId,
          tool: tool.name,
          user_id: principal.userId,
        });

        try {
          return await tool.handler({ principal, requestId, upstreams }, input);
        } catch (error) {
          logError(`mcp tool ${tool.name} failed`, error);
          return {
            content: [{ type: 'text' as const, text: toolErrorText(error) }],
            isError: true,
          };
        }
      }
    );
  }

  return server;
}
