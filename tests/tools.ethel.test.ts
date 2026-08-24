import { describe, it, expect } from 'vitest';
import { ethelTools } from '../src/tools/ethel.js';
import { HeorthClient } from '../src/upstream/heorth.js';
import type { McpTool, McpToolContext } from '../src/mcp/types.js';
import { createFakeUpstream, type ScriptedResponse } from './helpers/fake-upstream.js';

const CALLER = 'Bearer he_test';

function tool(name: string): McpTool {
  const found = ethelTools.find((t) => t.name === name);
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

describe('ethel tool registry', () => {
  it('exposes the ten frozen tool names', () => {
    expect(ethelTools.map((t) => t.name)).toEqual([
      'ethel.list_assets',
      'ethel.get_asset',
      'ethel.record_asset',
      'ethel.decommission_asset',
      'ethel.list_places',
      'ethel.record_place',
      'ethel.update_place',
      'ethel.delete_place',
      'ethel.set_vehicle_details',
      'ethel.set_facility_details',
    ]);
  });
});

describe('ethel.list_assets', () => {
  it('GETs /ethel/assets and recombines data + meta into the flat old shape', async () => {
    const { request, payload } = await call(
      'ethel.list_assets',
      { status: 'active', category: 'tools', q: 'drill', limit: 10, offset: 20 },
      undefined,
      { body: { data: [{ id: 'it1' }], meta: { total: 42, limit: 10, offset: 20 } } }
    );

    expect(request?.method).toBe('GET');
    const url = new URL(request?.url ?? '');
    expect(url.pathname).toBe('/api/v1/ethel/assets');
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

describe('ethel.get_asset', () => {
  it('GETs the asset by id and unwraps data', async () => {
    const { request, payload } = await call('ethel.get_asset', { id: 'it1' }, undefined, {
      body: { data: { id: 'it1', name: 'Drill' } },
    });

    expect(request?.url).toBe('http://heorth.test/api/v1/ethel/assets/it1');
    expect(payload).toEqual({ id: 'it1', name: 'Drill' });
  });

  it('surfaces 404 NOT_FOUND where the old tool returned an isError result', async () => {
    await expect(
      call('ethel.get_asset', { id: 'gone' }, undefined, {
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'Asset not found' } },
      })
    ).rejects.toThrow('NOT_FOUND');
  });
});

describe('ethel.record_asset', () => {
  it('POSTs the body to /ethel/assets and unwraps data', async () => {
    const input = { name: 'Drill', category: 'tools', purchasePrice: 99.5 };
    const { request, body, payload } = await call('ethel.record_asset', input, undefined, {
      status: 201,
      body: { data: { id: 'it9', name: 'Drill' } },
    });

    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('http://heorth.test/api/v1/ethel/assets');
    expect(body).toEqual(input);
    expect(payload).toEqual({ id: 'it9', name: 'Drill' });
  });

  it('declares locationNote, and no longer location, in the schema an MCP client reads', () => {
    // Asserted against `inputSchema`, not just the forwarded body: the schema is
    // what a client builds its call from, so an implementation that still
    // advertised `location` would pass a body-only test while every client kept
    // sending the old key.
    const keys = Object.keys(tool('ethel.record_asset').inputSchema);
    expect(keys).toContain('locationNote');
    expect(keys).not.toContain('location');
  });

  it('accepts locationNote (the renamed location column)', async () => {
    const input = { name: 'Drill', locationNote: 'Garage shelf 3' };
    const { body } = await call('ethel.record_asset', input, undefined, {
      status: 201,
      body: { data: { id: 'it9' } },
    });
    expect(body).toEqual(input);
  });

  it('does not gate on the local principal role — the route carries requireRole', async () => {
    // A child principal still reaches upstream: heorth-mcp never asserts a role
    // it did not verify, and Heorth answers 403 itself when the caller may not write.
    const { request } = await call(
      'ethel.record_asset',
      { name: 'Drill' },
      { userId: 'fingerprint', role: 'child' },
      { status: 201, body: { data: { id: 'it9' } } }
    );
    expect(request?.method).toBe('POST');
  });

  it('passes a 403 FORBIDDEN from the route through', async () => {
    await expect(
      call('ethel.record_asset', { name: 'Drill' }, undefined, {
        status: 403,
        body: { error: { code: 'FORBIDDEN', message: 'Not allowed' } },
      })
    ).rejects.toThrow('FORBIDDEN');
  });
});

describe('ethel.decommission_asset', () => {
  it('puts id in the path and the rest in the body', async () => {
    const { request, body, payload } = await call(
      'ethel.decommission_asset',
      { id: 'it1', date: '2026-08-18', reason: 'sold', proceeds: 20 },
      undefined,
      { body: { data: { id: 'it1', decommissionReason: 'sold' } } }
    );

    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('http://heorth.test/api/v1/ethel/assets/it1/decommission');
    expect(body).toEqual({ date: '2026-08-18', reason: 'sold', proceeds: 20 });
    expect(body).not.toHaveProperty('id');
    expect(payload).toEqual({ id: 'it1', decommissionReason: 'sold' });
  });

  it('passes 409 ALREADY_DECOMMISSIONED through', async () => {
    await expect(
      call(
        'ethel.decommission_asset',
        { id: 'it1', date: '2026-08-18', reason: 'lost' },
        undefined,
        { status: 409, body: { error: { code: 'ALREADY_DECOMMISSIONED', message: 'already' } } }
      )
    ).rejects.toThrow('ALREADY_DECOMMISSIONED');
  });
});

describe('ethel.list_places', () => {
  it('GETs /ethel/places and returns the flat rows', async () => {
    const { request, payload } = await call(
      'ethel.list_places',
      {},
      { userId: 'fingerprint' },
      { body: { data: [{ id: 'p1', name: 'House', kind: 'building', parentId: null }] } }
    );
    expect(request?.method).toBe('GET');
    expect(request!.url).toContain('/ethel/places');
    expect(payload.rows.length).toBe(1);
  });
});

describe('ethel.record_place', () => {
  it('POSTs to /ethel/places with the body', async () => {
    const { request, body } = await call(
      'ethel.record_place',
      { name: 'Utility room', kind: 'room' },
      { userId: 'fingerprint' },
      { body: { data: { id: 'p9', name: 'Utility room' } } }
    );
    expect(request!.method).toBe('POST');
    expect(request!.url).toContain('/ethel/places');
    expect(body).toEqual({ name: 'Utility room', kind: 'room' });
  });

  it('passes the upstream place invariants through as domain codes rather than re-checking them here', async () => {
    await expect(
      call(
        'ethel.record_place',
        { name: 'Cellar', kind: 'room', parentId: '77777777-7777-7777-7777-777777777777' },
        { userId: 'fingerprint' },
        { status: 400, body: { error: { code: 'PLACE_TOO_DEEP', message: 'too deep' } } }
      )
    ).rejects.toThrow('PLACE_TOO_DEEP');
  });
});

describe('ethel.update_place', () => {
  it('PATCHes /ethel/places/:id with the id in the path, not the body', async () => {
    const { request, body } = await call(
      'ethel.update_place',
      { id: '55555555-5555-5555-5555-555555555555', name: 'Scullery' },
      { userId: 'fingerprint' },
      { body: { data: { id: '55555555-5555-5555-5555-555555555555' } } }
    );
    expect(request!.method).toBe('PATCH');
    expect(request!.url).toContain('/ethel/places/55555555-5555-5555-5555-555555555555');
    expect(body).not.toHaveProperty('id');
    expect(body).toEqual({ name: 'Scullery' });
  });

  it('passes 400 PLACE_CYCLE through, because the cycle check is upstream, not here', async () => {
    await expect(
      call(
        'ethel.update_place',
        { id: '55555555-5555-5555-5555-555555555555', parentId: '55555555-5555-5555-5555-555555555555' },
        { userId: 'fingerprint' },
        { status: 400, body: { error: { code: 'PLACE_CYCLE', message: 'cycle' } } }
      )
    ).rejects.toThrow('PLACE_CYCLE');
  });
});

describe('ethel.delete_place', () => {
  it('DELETEs /ethel/places/:id with the id in the path and no body', async () => {
    const { request, body } = await call(
      'ethel.delete_place',
      { id: '11111111-1111-1111-1111-111111111111' },
      { userId: 'fingerprint' },
      { body: { data: { id: '11111111-1111-1111-1111-111111111111' } } }
    );
    expect(request!.method).toBe('DELETE');
    expect(request!.url).toContain('/ethel/places/11111111-1111-1111-1111-111111111111');
    expect(body).toBeUndefined();
  });

  it('reports the unassignment in its result text, so the caller cannot be surprised', async () => {
    const { payload } = await call(
      'ethel.delete_place',
      { id: '11111111-1111-1111-1111-111111111111' },
      { userId: 'fingerprint' },
      { body: { data: { id: '11111111-1111-1111-1111-111111111111' } } }
    );
    expect(JSON.stringify(payload)).toMatch(/unassigned/i);
  });
});

describe('ethel.set_vehicle_details', () => {
  it('PUTs to /ethel/assets/:id/vehicle with the assetId in the path, not the body', async () => {
    const { request, body } = await call(
      'ethel.set_vehicle_details',
      {
        assetId: '66666666-6666-6666-6666-666666666666',
        registration: 'AB12 CDE',
        serviceIntervalMonths: 12,
      },
      { userId: 'fingerprint' },
      { body: { data: { assetId: '66666666-6666-6666-6666-666666666666' } } }
    );
    expect(request!.method).toBe('PUT');
    expect(request!.url).toContain('/ethel/assets/66666666-6666-6666-6666-666666666666/vehicle');
    expect(body).not.toHaveProperty('assetId');
    expect(body).toEqual({ registration: 'AB12 CDE', serviceIntervalMonths: 12 });
  });

  it('says in the serviceIntervalMonths description that recording it schedules nothing', () => {
    const schema = tool('ethel.set_vehicle_details').inputSchema;
    expect(Object.keys(schema)).toContain('serviceIntervalMonths');
    expect(schema['serviceIntervalMonths']?.description).toMatch(/does not schedule/i);
  });

  it('passes 409 ASSET_DETAIL_CONFLICT through, because the one-detail rule is upstream', async () => {
    await expect(
      call(
        'ethel.set_vehicle_details',
        { assetId: '66666666-6666-6666-6666-666666666666', registration: 'AB12 CDE' },
        { userId: 'fingerprint' },
        { status: 409, body: { error: { code: 'ASSET_DETAIL_CONFLICT', message: 'has facility' } } }
      )
    ).rejects.toThrow('ASSET_DETAIL_CONFLICT');
  });
});

describe('ethel.set_facility_details', () => {
  it('PUTs to /ethel/assets/:id/facility with the id in the path, not the body', async () => {
    const { request, body } = await call(
      'ethel.set_facility_details',
      { assetId: '22222222-2222-2222-2222-222222222222', kind: 'heating', servesPlaceIds: [] },
      { userId: 'fingerprint' },
      { body: { data: { assetId: '22222222-2222-2222-2222-222222222222', kind: 'heating' } } }
    );
    expect(request!.method).toBe('PUT');
    expect(request!.url).toContain('/ethel/assets/22222222-2222-2222-2222-222222222222/facility');
    expect(body).not.toHaveProperty('assetId');
    expect(body).toEqual({ kind: 'heating', servesPlaceIds: [] });
  });

  it('says in the serviceIntervalMonths description that recording it schedules nothing', () => {
    const schema = tool('ethel.set_facility_details').inputSchema;
    expect(schema['serviceIntervalMonths']?.description).toMatch(/does not schedule/i);
  });
});

describe('ethel.list_assets place and facility filters', () => {
  it('forwards the place filters', async () => {
    const { request } = await call(
      'ethel.list_assets',
      { placeId: '44444444-4444-4444-4444-444444444444', includeDescendants: true },
      { userId: 'fingerprint' },
      { body: { data: [], meta: { total: 0 } } }
    );
    expect(request!.url).toContain('placeId=44444444');
    // Serialised as the string the server's z.enum(['true','false']) expects.
    expect(request!.url).toContain('includeDescendants=true');
  });

  it('forwards includeDescendants=false rather than dropping it', async () => {
    const { request } = await call(
      'ethel.list_assets',
      { placeId: '44444444-4444-4444-4444-444444444444', includeDescendants: false },
      { userId: 'fingerprint' },
      { body: { data: [], meta: { total: 0 } } }
    );
    expect(request!.url).toContain('includeDescendants=false');
  });

  it('forwards the facility filters', async () => {
    const { request } = await call(
      'ethel.list_assets',
      { hasFacility: true, servesPlaceId: '33333333-3333-3333-3333-333333333333' },
      { userId: 'fingerprint' },
      { body: { data: [], meta: { total: 0 } } }
    );
    expect(request!.url).toContain('hasFacility=true');
    expect(request!.url).toContain('servesPlaceId=33333333');
  });

  it('omits every filter when the caller passes none', async () => {
    const { request } = await call(
      'ethel.list_assets',
      {},
      { userId: 'fingerprint' },
      { body: { data: [], meta: { total: 0 } } }
    );
    const url = new URL(request?.url ?? '');
    expect([...url.searchParams.keys()]).toEqual([]);
  });

  it('lets the upstream reject includeDescendants without placeId rather than pre-empting it', async () => {
    await expect(
      call(
        'ethel.list_assets',
        { includeDescendants: true },
        { userId: 'fingerprint' },
        {
          status: 400,
          body: { error: { code: 'VALIDATION_ERROR', message: 'includeDescendants requires placeId' } },
        }
      )
    ).rejects.toThrow('VALIDATION_ERROR');
  });
});
