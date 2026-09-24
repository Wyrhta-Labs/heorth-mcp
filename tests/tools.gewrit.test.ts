import { describe, it, expect } from 'vitest';
import { gewritTools } from '../src/tools/gewrit.js';
import { HeorthClient } from '../src/upstream/heorth.js';
import type { McpTool, McpToolContext } from '../src/mcp/types.js';
import { createFakeUpstream, type ScriptedResponse } from './helpers/fake-upstream.js';

const CALLER = 'Bearer he_test';
const ASSET = '11111111-1111-4111-8111-111111111111';

function tool(name: string): McpTool {
  const found = gewritTools.find((t) => t.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
}

async function call(name: string, input: Record<string, unknown>, ...script: ScriptedResponse[]) {
  const fake = createFakeUpstream(...script);
  const heorth = new HeorthClient({ baseUrl: 'http://heorth.test', authorization: CALLER, fetch: fake.fetch });
  const ctx: McpToolContext = { principal: { userId: 'fingerprint' }, requestId: 'req-1', upstreams: { heorth } };
  const res = await tool(name).handler(ctx, input);
  return { request: fake.requests[0], payload: JSON.parse(res.content[0]?.text ?? 'null') };
}

describe('gewrit tool registry', () => {
  it('exposes the two frozen tool names, in order', () => {
    expect(gewritTools.map((t) => t.name)).toEqual(['gewrit.list_documents', 'gewrit.search']);
  });
});

describe('gewrit tools', () => {
  it('lists an asset\'s documents and surfaces stale', async () => {
    const { request, payload } = await call('gewrit.list_documents', { assetId: ASSET }, {
      status: 200, body: { data: [{ id: 'l1', role: 'manual' }], meta: { stale: true, staleReason: 'unavailable' } },
    });
    expect(request!.method).toBe('GET');
    expect(request!.url).toBe(`http://heorth.test/api/v1/gewrit/assets/${ASSET}/documents`);
    // HttpClient sends `Authorization` and the fake records keys verbatim.
    expect(request!.headers['Authorization']).toBe(CALLER);
    expect(payload).toEqual({ links: [{ id: 'l1', role: 'manual' }], stale: true, staleReason: 'unavailable' });
  });

  it('surfaces staleReason auth for a rejected credential, and null when not stale', async () => {
    const auth = await call('gewrit.list_documents', { assetId: ASSET }, {
      status: 200, body: { data: [], meta: { stale: true, staleReason: 'auth' } },
    });
    expect(auth.payload).toEqual({ links: [], stale: true, staleReason: 'auth' });

    const fresh = await call('gewrit.list_documents', { assetId: ASSET }, {
      status: 200, body: { data: [], meta: { stale: false, staleReason: null } },
    });
    expect(fresh.payload).toEqual({ links: [], stale: false, staleReason: null });
  });

  it('lists a place\'s documents', async () => {
    const { request } = await call('gewrit.list_documents', { placeId: ASSET }, { status: 200, body: { data: [], meta: { stale: false } } });
    expect(request!.url).toBe(`http://heorth.test/api/v1/gewrit/places/${ASSET}/documents`);
  });

  it('refuses neither or both ids without calling Heorth', async () => {
    await expect(call('gewrit.list_documents', {})).rejects.toThrow(/exactly one/);
    await expect(call('gewrit.list_documents', { assetId: ASSET, placeId: ASSET })).rejects.toThrow(/exactly one/);
  });

  it('searches with q as a query parameter', async () => {
    const { request, payload } = await call('gewrit.search', { q: 'Rechnung & Garantie' }, {
      status: 200, body: { data: [{ externalId: '412', title: 'x' }] },
    });
    expect(new URL(request!.url).searchParams.get('q')).toBe('Rechnung & Garantie');
    expect(payload).toEqual([{ externalId: '412', title: 'x' }]);
  });
});
