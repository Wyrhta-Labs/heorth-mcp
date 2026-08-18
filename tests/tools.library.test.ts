import { describe, it, expect } from 'vitest';
import { libraryTools } from '../src/tools/library.js';
import { HeorthClient } from '../src/upstream/heorth.js';
import type { McpTool, McpToolContext } from '../src/mcp/types.js';
import { createFakeUpstream, type ScriptedResponse } from './helpers/fake-upstream.js';

const CALLER = 'Bearer he_test';

function tool(name: string): McpTool {
  const found = libraryTools.find((t) => t.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
}

async function call(name: string, input: Record<string, unknown>, ...script: ScriptedResponse[]) {
  const fake = createFakeUpstream(...script);
  const heorth = new HeorthClient({
    baseUrl: 'http://heorth.test',
    authorization: CALLER,
    fetch: fake.fetch,
  });
  const ctx: McpToolContext = {
    principal: { userId: 'fingerprint' },
    requestId: 'req-1',
    upstreams: { heorth },
  };
  const res = await tool(name).handler(ctx, input);
  const request = fake.requests[0];
  return {
    request,
    payload: JSON.parse(res.content[0]?.text ?? 'null'),
    body: request?.body ? JSON.parse(request.body) : undefined,
  };
}

describe('library tool registry', () => {
  it('exposes the five frozen tool names', () => {
    expect(libraryTools.map((t) => t.name)).toEqual([
      'library.list_items',
      'library.search',
      'library.get_item',
      'library.list_connections',
      'library.sync_connection',
    ]);
  });
});

describe('library.list_items', () => {
  it('uses camelCase query keys and returns { items, total }', async () => {
    const { request, payload } = await call(
      'library.list_items',
      {
        mediaType: 'book',
        memberId: '11111111-1111-4111-8111-111111111111',
        provider: 'librarything',
        status: 'reading',
        list: 'later',
        tag: 'scifi',
        limit: 20,
      },
      { body: { data: [{ id: 'i1' }], meta: { total: 7, limit: 20, offset: 0 } } }
    );

    expect(request?.method).toBe('GET');
    const url = new URL(request?.url ?? '');
    expect(url.pathname).toBe('/api/v1/library/items');
    // camelCase, unlike calendar's and tasks' snake_case — a real upstream split.
    expect(Object.fromEntries(url.searchParams)).toEqual({
      mediaType: 'book',
      memberId: '11111111-1111-4111-8111-111111111111',
      provider: 'librarything',
      status: 'reading',
      list: 'later',
      tag: 'scifi',
      limit: '20',
    });
    expect(url.searchParams.has('media_type')).toBe(false);
    expect(url.searchParams.has('member_id')).toBe(false);
    expect(payload).toEqual({ items: [{ id: 'i1' }], total: 7 });
  });
});

describe('library.search', () => {
  it('GETs /library/items/search with the required q and returns { items }', async () => {
    const { request, payload } = await call(
      'library.search',
      { q: 'dune' },
      { body: { data: [{ id: 'i2' }] } }
    );

    expect(request?.url).toBe('http://heorth.test/api/v1/library/items/search?q=dune');
    expect(payload).toEqual({ items: [{ id: 'i2' }] });
  });

  it('surfaces the 400 the endpoint raises when q is missing', async () => {
    await expect(
      call('library.search', { q: '' }, {
        status: 400,
        body: { error: { code: 'VALIDATION_ERROR', message: 'q is required' } },
      })
    ).rejects.toThrow('VALIDATION_ERROR');
  });
});

describe('library.get_item', () => {
  it('GETs the item by id and unwraps data', async () => {
    const { request, payload } = await call(
      'library.get_item',
      { id: 'abc' },
      { body: { data: { id: 'abc', title: 'Dune' } } }
    );

    expect(request?.url).toBe('http://heorth.test/api/v1/library/items/abc');
    expect(payload).toEqual({ id: 'abc', title: 'Dune' });
  });

  it('passes 404 NOT_FOUND through', async () => {
    await expect(
      call('library.get_item', { id: 'nope' }, {
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'Item not found' } },
      })
    ).rejects.toThrow('NOT_FOUND');
  });
});

describe('library.list_connections', () => {
  it('GETs /library/connections and returns { connections }', async () => {
    const { request, payload } = await call('library.list_connections', {}, {
      body: { data: [{ id: 'c1', provider: 'trakt' }] },
    });

    expect(request?.method).toBe('GET');
    expect(request?.url).toBe('http://heorth.test/api/v1/library/connections');
    expect(payload).toEqual({ connections: [{ id: 'c1', provider: 'trakt' }] });
  });
});

describe('library.sync_connection', () => {
  it('POSTs to /library/connections/:id/sync and unwraps data', async () => {
    const { request, payload } = await call(
      'library.sync_connection',
      { id: 'c1' },
      { body: { data: { imported: 3 } } }
    );

    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('http://heorth.test/api/v1/library/connections/c1/sync');
    expect(payload).toEqual({ imported: 3 });
  });

  it('passes a 502 SYNC_FAILED through instead of swallowing it', async () => {
    await expect(
      call('library.sync_connection', { id: 'c1' }, {
        status: 502,
        body: { error: { code: 'SYNC_FAILED', message: 'provider down' } },
      })
    ).rejects.toThrow('SYNC_FAILED');
  });
});
