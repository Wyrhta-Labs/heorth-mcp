import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../src/app.js';
import { createUpstreamRuntime, setUpstreamRuntime } from '../src/upstream/index.js';
import { loadConfig } from '../src/config/env.js';
import { createFakeUpstream } from './helpers/fake-upstream.js';

const MIB = 1024 * 1024;

function post(body: string): Request {
  return new Request('http://local/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer he_x',
    },
    body,
  });
}

/** A syntactically valid `initialize` request padded to roughly `size` bytes. */
function initializeOfSize(size: number): string {
  const base = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
      padding: '',
    },
  };
  const overhead = JSON.stringify(base).length;
  base.params.padding = 'x'.repeat(Math.max(0, size - overhead));
  return JSON.stringify(base);
}

/** The SSE-framed JSON-RPC answer of a Streamable-HTTP response. */
async function rpcResult(res: Response): Promise<any> {
  const line = (await res.text()).split('\n').find((l) => l.startsWith('data:'));
  if (!line) throw new Error('no SSE data line');
  return JSON.parse(line.slice('data:'.length).trim());
}

afterEach(() => setUpstreamRuntime(null));

// /mcp caps request bodies (Heorth#6). The cap sits at 2 MiB, not Heorth's
// 1 MiB: feoh.import_csv forwards its CSV to Heorth as the raw body, but here
// that CSV arrives JSON-escaped inside a JSON-RPC envelope — every newline and
// quote doubles — so a CSV Heorth accepts can be well over 1 MiB on this hop.
describe('/mcp request body limit', () => {
  it('rejects a body above 2 MiB with 413 before the MCP transport sees it', async () => {
    setUpstreamRuntime(createUpstreamRuntime(loadConfig({}), createFakeUpstream().fetch));
    const res = await createApp().fetch(post(initializeOfSize(2 * MIB + 1)));
    expect(res.status).toBe(413);
  });

  it('passes a CSV Heorth would take, though escaping puts the request over 1 MiB', async () => {
    const row = '2026-01-01,"Baker","bread ""sourdough""",-4.20,Groceries,Chequing\n';
    const csv = 'date,payee,memo,amount,envelope,account\n'
      + row.repeat(Math.floor((MIB - 64) / Buffer.byteLength(row)));
    const fake = createFakeUpstream({ status: 201, body: { data: { imported: 1, skipped: 0 } } });
    setUpstreamRuntime(createUpstreamRuntime(loadConfig({ HEORTH_BASE_URL: 'http://heorth.test' }), fake.fetch));

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'feoh.import_csv', arguments: { csv } },
    });
    expect(Buffer.byteLength(csv)).toBeLessThan(MIB);
    expect(Buffer.byteLength(body)).toBeGreaterThan(MIB);

    const res = await createApp().fetch(post(body));
    expect(res.status).toBe(200);
    expect((await rpcResult(res)).result.isError).toBeFalsy();
    expect(fake.requests[0]?.body).toBe(csv);
  });
});
