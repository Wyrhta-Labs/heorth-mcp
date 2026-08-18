import { serve } from '@hono/node-server';
import { loadConfig } from './config/env.js';
import { createUpstreamRuntime, setUpstreamRuntime } from './upstream/index.js';
import { createApp } from './app.js';
import { logEvent } from './lib/logger.js';

function main(): void {
  const config = loadConfig();
  setUpstreamRuntime(createUpstreamRuntime(config));

  logEvent({
    event: 'mcp.boot',
    heorth_upstream: config.heorth !== null,
    kith_upstream: config.kith !== null,
  });

  serve({ fetch: createApp().fetch, port: config.port }, (info) => {
    console.log(`heorth-mcp listening on http://localhost:${info.port}/mcp`);
  });
}

// Only auto-run when executed directly (not when imported by tests).
if (process.env['VITEST'] === undefined) {
  try {
    main();
  } catch (err) {
    console.error('Fatal error during startup:', err);
    process.exit(1);
  }
}
