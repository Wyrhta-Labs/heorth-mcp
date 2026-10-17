import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
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
  // Twice Heorth's 1 MiB /api/* cap: feoh.import_csv's CSV is forwarded raw,
  // but arrives here JSON-escaped in a JSON-RPC envelope, so a CSV Heorth would
  // take can exceed 1 MiB on this hop. Anything bigger is only work.
  app.use('/mcp', bodyLimit({ maxSize: 2 * 1024 * 1024 }));
  app.all('/mcp', (c) => mcpServer.fetch(c.req.raw));

  return app;
}
