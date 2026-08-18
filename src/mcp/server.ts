import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { getUpstreamRuntime, upstreamsForRequest, type Upstreams } from '../upstream/index.js';
import { callerAuthorization } from '../upstream/heorth.js';
import { buildRegistry } from '../tools/index.js';
import { createPassThroughAuthAdapter } from './auth-adapter.js';
import { createMcpServer } from './scaffold.js';

/**
 * The MCP endpoint as a Web `fetch` handler.
 *
 * `createMcpServer` returns an SDK `McpServer` (not a `fetch` handler), and its
 * `AuthAdapter` resolves a single caller with no per-call argument — so a
 * stateless MCP server + Web Standard Streamable HTTP transport is built fresh
 * for each incoming request, bound to that request's
 * `Authorization: Bearer he_...`. Heorth's `src/mcp/server.ts` had this shape
 * and it is kept deliberately: it is what makes the caller's key, and the
 * Heorth client built from it, request-scoped rather than process-scoped.
 *
 * What changed on the way over: the registry is assembled from whichever
 * upstreams are configured (`buildRegistry`) rather than from Heorth's module
 * registry, and there is no local key validation — see auth-adapter.ts.
 */
export function buildMcpServer(): { fetch(req: Request): Promise<Response> } {
  return {
    async fetch(req: Request): Promise<Response> {
      const runtime = getUpstreamRuntime();
      const authorization = callerAuthorization(req);

      // Without a usable header there is no caller-bound Heorth client to build.
      // The tool call still fails closed: the auth adapter throws
      // `MCP_UNAUTHORIZED` before any handler — and so before any upstream call.
      let upstreams: Upstreams = {};
      if (authorization) upstreams = upstreamsForRequest(runtime, authorization);

      const server = createMcpServer(
        buildRegistry(runtime.config),
        createPassThroughAuthAdapter(authorization),
        upstreams,
        { name: 'heorth-mcp', version: '0.1.0' }
      );
      const transport = new WebStandardStreamableHTTPServerTransport();
      await server.connect(transport);
      return transport.handleRequest(req);
    },
  };
}
