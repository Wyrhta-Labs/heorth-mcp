import { Hono } from 'hono';
import { buildMcpServer } from './mcp/server.js';

/**
 * The HTTP surface: the MCP endpoint, and a health check for the container.
 * There is no REST API here — heorth-mcp is a client of other services' APIs,
 * not a provider of one.
 */
export function createApp(): Hono {
  const app = new Hono();
  const mcpServer = buildMcpServer();

  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.all('/mcp', (c) => mcpServer.fetch(c.req.raw));

  return app;
}
