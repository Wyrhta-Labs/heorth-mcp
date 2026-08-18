import { describe, it, expect, afterEach } from 'vitest';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { buildMcpServer } from '../src/mcp/server.js';
import { createMcpServer, toolErrorText } from '../src/mcp/scaffold.js';
import { createPassThroughAuthAdapter, keyFingerprint } from '../src/mcp/auth-adapter.js';
import type { McpTool } from '../src/mcp/types.js';
import {
  createUpstreamRuntime,
  setUpstreamRuntime,
  upstreamsForRequest,
} from '../src/upstream/index.js';
import { loadConfig } from '../src/config/env.js';
import { createFakeUpstream } from './helpers/fake-upstream.js';

/** Parse a Streamable-HTTP SSE response body into its single JSON-RPC message. */
function parseSse(body: string): any {
  const line = body.split('\n').find((l) => l.startsWith('data:'));
  if (!line) throw new Error(`no SSE data line in body: ${body}`);
  return JSON.parse(line.slice('data:'.length).trim());
}

async function rpc(
  handler: { fetch(req: Request): Promise<Response> },
  authorization: string | undefined,
  message: unknown
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (authorization) headers['Authorization'] = authorization;
  const res = await handler.fetch(
    new Request('http://local/mcp', { method: 'POST', headers, body: JSON.stringify(message) })
  );
  const text = await res.text();
  return { status: res.status, json: text.trim() ? parseSse(text) : undefined };
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  },
};

afterEach(() => setUpstreamRuntime(null));

describe('MCP over HTTP', () => {
  it('serves an empty tool list with neither upstream configured', async () => {
    setUpstreamRuntime(createUpstreamRuntime(loadConfig({}), createFakeUpstream().fetch));
    const handler = buildMcpServer();

    const init = await rpc(handler, 'Bearer he_x', INIT);
    expect(init.status).toBe(200);
    expect(init.json.result.serverInfo).toEqual({ name: 'heorth-mcp', version: '0.1.0' });

    const list = await rpc(handler, 'Bearer he_x', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.json.result.tools).toEqual([]);
  });

  it('answers the handshake even with no Authorization header', async () => {
    setUpstreamRuntime(createUpstreamRuntime(loadConfig({}), createFakeUpstream().fetch));

    const { status, json } = await rpc(buildMcpServer(), undefined, INIT);
    expect(status).toBe(200);
    expect(json.result.protocolVersion).toBeTruthy();
  });
});

/** Drive an arbitrary registry through the same per-request transport shape. */
function handlerFor(registry: McpTool[], authorization: string | undefined) {
  return {
    async fetch(req: Request): Promise<Response> {
      const server = createMcpServer(registry, createPassThroughAuthAdapter(authorization), {});
      const transport = new WebStandardStreamableHTTPServerTransport();
      await server.connect(transport);
      return transport.handleRequest(req);
    },
  };
}

const echoTool = (fn: () => never | Promise<unknown>): McpTool => ({
  name: 'test.echo',
  description: 'test tool',
  inputSchema: { value: z.string() },
  handler: async (ctx) => {
    await fn();
    return { content: [{ type: 'text', text: ctx.principal.userId }] };
  },
});

describe('tool call auth and error mapping', () => {
  it('refuses a tool call with no caller key, before the handler runs', async () => {
    let ran = false;
    const handler = handlerFor(
      [
        echoTool(async () => {
          ran = true;
        }),
      ],
      undefined
    );

    await rpc(handler, undefined, INIT);
    const { json } = await rpc(handler, undefined, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'test.echo', arguments: { value: 'x' } },
    });

    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toBe('Unauthorized or tool error');
    expect(ran).toBe(false);
  });

  it('identifies the caller by key fingerprint only, never by key material', async () => {
    const handler = handlerFor([echoTool(async () => undefined)], 'Bearer he_secret');

    await rpc(handler, 'Bearer he_secret', INIT);
    const { json } = await rpc(handler, 'Bearer he_secret', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'test.echo', arguments: { value: 'x' } },
    });

    expect(json.result.content[0].text).toBe(keyFingerprint('Bearer he_secret'));
    expect(json.result.content[0].text).not.toContain('he_secret');
  });

  it('surfaces a domain error code and genericises anything else', async () => {
    expect(toolErrorText(new Error('NOT_FOUND'))).toBe('NOT_FOUND');
    expect(toolErrorText(new Error('CHILD_WRITE_FORBIDDEN'))).toBe('CHILD_WRITE_FORBIDDEN');
    expect(toolErrorText(new Error('lowercase'))).toBe('tool error');
    expect(toolErrorText(new Error('Error: connect ECONNREFUSED 10.0.0.5:5432'))).toBe('tool error');
    expect(toolErrorText(new Error('A'.repeat(65)))).toBe('tool error');
    expect(toolErrorText('nope')).toBe('tool error');
  });
});

describe('per-request upstream binding', () => {
  it('binds the Heorth client to this request key and refuses without one', () => {
    const fake = createFakeUpstream();
    const runtime = createUpstreamRuntime(
      loadConfig({ HEORTH_BASE_URL: 'http://heorth:3000' }),
      fake.fetch
    );

    expect(upstreamsForRequest(runtime, 'Bearer he_x').heorth).toBeDefined();
    expect(() => upstreamsForRequest(runtime, undefined)).toThrow('MCP_UNAUTHORIZED');
    expect(fake.requests).toHaveLength(0);
  });

  it('exposes only the configured upstreams', () => {
    const fake = createFakeUpstream();
    const kithOnly = createUpstreamRuntime(
      loadConfig({ KITH_BASE_URL: 'http://kith:3000', KITH_API_KEY: 'kl_x' }),
      fake.fetch
    );
    const upstreams = upstreamsForRequest(kithOnly, undefined);

    expect(upstreams.heorth).toBeUndefined();
    expect(upstreams.kith).toBeDefined();
  });
});
