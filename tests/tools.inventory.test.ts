import { describe, it, expect } from 'vitest';
import { inventoryTools } from '../src/tools/inventory.js';
import { HeorthClient } from '../src/upstream/heorth.js';
import type { McpTool, McpToolContext } from '../src/mcp/types.js';
import { createFakeUpstream, type ScriptedResponse } from './helpers/fake-upstream.js';

const CALLER = 'Bearer he_test';

function tool(name: string): McpTool {
  const found = inventoryTools.find((t) => t.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
}

async function call(
  name: string,
  input: Record<string, unknown>,
  principal: McpToolContext['principal'] = { userId: 'fingerprint' },
  ...script: ScriptedResponse[]
) {
  const fake = createFakeUpstream(...script);
  const heorth = new HeorthClient({
    baseUrl: 'http://heorth.test',
    authorization: CALLER,
    fetch: fake.fetch,
  });
  const ctx: McpToolContext = { principal, requestId: 'req-1', upstreams: { heorth } };
  const res = await tool(name).handler(ctx, input);
  const request = fake.requests[0];
  return {
    request,
    payload: JSON.parse(res.content[0]?.text ?? 'null'),
    body: request?.body ? JSON.parse(request.body) : undefined,
  };
}

describe('inventory tool registry', () => {
  it('exposes the four frozen tool names', () => {
    expect(inventoryTools.map((t) => t.name)).toEqual([
      'inventory.list_items',
      'inventory.get_item',
      'inventory.record_item',
      'inventory.decommission_item',
    ]);
  });
});

describe('inventory.list_items', () => {
  it('GETs /inventory/items and recombines data + meta into the flat old shape', async () => {
    const { request, payload } = await call(
      'inventory.list_items',
      { status: 'active', category: 'tools', q: 'drill', limit: 10, offset: 20 },
      undefined,
      { body: { data: [{ id: 'it1' }], meta: { total: 42, limit: 10, offset: 20 } } }
    );

    expect(request?.method).toBe('GET');
    const url = new URL(request?.url ?? '');
    expect(url.pathname).toBe('/api/v1/inventory/items');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: 'active',
      category: 'tools',
      q: 'drill',
      limit: '10',
      offset: '20',
    });
    expect(payload).toEqual({ rows: [{ id: 'it1' }], total: 42, limit: 10, offset: 20 });
  });
});

describe('inventory.get_item', () => {
  it('GETs the item by id and unwraps data', async () => {
    const { request, payload } = await call('inventory.get_item', { id: 'it1' }, undefined, {
      body: { data: { id: 'it1', name: 'Drill' } },
    });

    expect(request?.url).toBe('http://heorth.test/api/v1/inventory/items/it1');
    expect(payload).toEqual({ id: 'it1', name: 'Drill' });
  });

  it('surfaces 404 NOT_FOUND where the old tool returned an isError result', async () => {
    await expect(
      call('inventory.get_item', { id: 'gone' }, undefined, {
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'Item not found' } },
      })
    ).rejects.toThrow('NOT_FOUND');
  });
});

describe('inventory.record_item', () => {
  it('POSTs the body to /inventory/items and unwraps data', async () => {
    const input = { name: 'Drill', category: 'tools', purchasePrice: 99.5 };
    const { request, body, payload } = await call('inventory.record_item', input, undefined, {
      status: 201,
      body: { data: { id: 'it9', name: 'Drill' } },
    });

    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('http://heorth.test/api/v1/inventory/items');
    expect(body).toEqual(input);
    expect(payload).toEqual({ id: 'it9', name: 'Drill' });
  });

  it('does not gate on the local principal role — the route carries requireRole', async () => {
    // A child principal still reaches upstream: heorth-mcp never asserts a role
    // it did not verify, and Heorth answers 403 itself when the caller may not write.
    const { request } = await call(
      'inventory.record_item',
      { name: 'Drill' },
      { userId: 'fingerprint', role: 'child' },
      { status: 201, body: { data: { id: 'it9' } } }
    );
    expect(request?.method).toBe('POST');
  });

  it('passes a 403 FORBIDDEN from the route through', async () => {
    await expect(
      call('inventory.record_item', { name: 'Drill' }, undefined, {
        status: 403,
        body: { error: { code: 'FORBIDDEN', message: 'Not allowed' } },
      })
    ).rejects.toThrow('FORBIDDEN');
  });
});

describe('inventory.decommission_item', () => {
  it('puts id in the path and the rest in the body', async () => {
    const { request, body, payload } = await call(
      'inventory.decommission_item',
      { id: 'it1', date: '2026-08-18', reason: 'sold', proceeds: 20 },
      undefined,
      { body: { data: { id: 'it1', decommissionReason: 'sold' } } }
    );

    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('http://heorth.test/api/v1/inventory/items/it1/decommission');
    expect(body).toEqual({ date: '2026-08-18', reason: 'sold', proceeds: 20 });
    expect(body).not.toHaveProperty('id');
    expect(payload).toEqual({ id: 'it1', decommissionReason: 'sold' });
  });

  it('passes 409 ALREADY_DECOMMISSIONED through', async () => {
    await expect(
      call(
        'inventory.decommission_item',
        { id: 'it1', date: '2026-08-18', reason: 'lost' },
        undefined,
        { status: 409, body: { error: { code: 'ALREADY_DECOMMISSIONED', message: 'already' } } }
      )
    ).rejects.toThrow('ALREADY_DECOMMISSIONED');
  });
});
