import { describe, it, expect } from 'vitest';
import { weorcTools } from '../src/tools/weorc.js';
import { HeorthClient } from '../src/upstream/heorth.js';
import type { McpTool, McpToolContext } from '../src/mcp/types.js';
import { createFakeUpstream, type ScriptedResponse } from './helpers/fake-upstream.js';

const CALLER = 'Bearer he_test';

function tool(name: string): McpTool {
  const found = weorcTools.find((t) => t.name === name);
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
    text: res.content[0]?.text ?? '',
    payload: JSON.parse(res.content[0]?.text ?? 'null'),
    body: request?.body ? JSON.parse(request.body) : undefined,
  };
}

describe('weorc tool registry', () => {
  it('exposes the seven frozen tool names, in order', () => {
    expect(weorcTools.map((t) => t.name)).toEqual([
      'weorc.list_routines',
      'weorc.record_routine',
      'weorc.update_routine',
      'weorc.delete_routine',
      'weorc.list_due',
      'weorc.complete_occurrence',
      'weorc.skip_occurrence',
    ]);
  });
});

describe('weorc tools', () => {
  it('sends active as the STRING true/false', async () => {
    // Heorth reads z.enum(['true','false']), never a coerced boolean, because
    // Boolean('false') is true.
    const { request } = await call('weorc.list_routines', { active: false }, undefined, {
      status: 200,
      body: { data: [], meta: { total: 0 } },
    });
    expect(request!.url).toContain('active=false');
  });

  it('sends list_routines filters with Heorth snake_case query names', async () => {
    const { request } = await call(
      'weorc.list_routines',
      {
        anchorAssetId: '11111111-1111-1111-1111-111111111111',
        anchorPlaceId: '22222222-2222-2222-2222-222222222222',
        ownerMemberId: '33333333-3333-3333-3333-333333333333',
      },
      undefined,
      { body: { data: [], meta: { total: 0, limit: 50, offset: 0 } } }
    );
    const url = new URL(request!.url);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      anchor_asset_id: '11111111-1111-1111-1111-111111111111',
      anchor_place_id: '22222222-2222-2222-2222-222222222222',
      owner_member_id: '33333333-3333-3333-3333-333333333333',
    });
    expect(url.searchParams.has('anchorAssetId')).toBe(false);
    expect(url.searchParams.has('anchorPlaceId')).toBe(false);
    expect(url.searchParams.has('ownerMemberId')).toBe(false);
  });

  it('POSTs a routine body through unchanged', async () => {
    const input = {
      name: 'Put the bins out',
      mode: 'fixed',
      intervalUnit: 'week',
      intervalCount: 1,
      anchorDate: '2026-09-01',
    };
    const { request, body } = await call('weorc.record_routine', input, undefined, {
      status: 201,
      body: { data: { id: 'r1', ...input } },
    });
    expect(request!.method).toBe('POST');
    expect(request!.url).toContain('/weorc/routines');
    expect(body).toMatchObject(input);
  });

  it('PATCHes a routine with the id in the path, not the body', async () => {
    const { request, body } = await call(
      'weorc.update_routine',
      { id: 'r1', name: 'Bins and recycling', active: false },
      undefined,
      { body: { data: { id: 'r1', name: 'Bins and recycling', active: false } } }
    );
    expect(request!.method).toBe('PATCH');
    expect(request!.url).toContain('/weorc/routines/r1');
    expect(body).toEqual({ name: 'Bins and recycling', active: false });
  });

  it('DELETEs a routine by id', async () => {
    const { request, body, payload } = await call('weorc.delete_routine', { id: 'r1' }, undefined, {
      body: { data: { deleted: true } },
    });
    expect(request!.method).toBe('DELETE');
    expect(request!.url).toContain('/weorc/routines/r1');
    expect(body).toBeUndefined();
    expect(payload).toEqual({ deleted: true });
  });

  it('list_due asks for open occurrences', async () => {
    const { request } = await call('weorc.list_due', {}, undefined, {
      status: 200,
      body: { data: [], meta: { total: 0 } },
    });
    expect(request!.url).toContain('/weorc/occurrences');
    expect(request!.url).toContain('status=due');
  });

  it('sends list_due filters with Heorth snake_case query names', async () => {
    const { request } = await call(
      'weorc.list_due',
      {
        routineId: '44444444-4444-4444-4444-444444444444',
        dueTo: '2026-09-08',
      },
      undefined,
      { body: { data: [], meta: { total: 0 } } }
    );
    const url = new URL(request!.url);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      status: 'due',
      routine_id: '44444444-4444-4444-4444-444444444444',
      due_to: '2026-09-08',
    });
    expect(url.searchParams.has('routineId')).toBe(false);
    expect(url.searchParams.has('dueTo')).toBe(false);
  });

  it('complete_occurrence reports the projection outcome', async () => {
    // A conversational caller has no other way to learn that the completion was
    // recorded but the write-back to To Do failed.
    const { text } = await call('weorc.complete_occurrence', { id: 'o1' }, undefined, {
      status: 200,
      body: {
        data: {
          occurrence: { id: 'o1', status: 'completed' },
          next: { id: 'o2', dueOn: '2026-09-08' },
          projection: { ok: false, reason: 'needs_reauth' },
        },
      },
    });
    expect(text).toContain('needs_reauth');
  });

  it('skip_occurrence posts the note and returns the upstream projection object', async () => {
    const { request, body, text } = await call(
      'weorc.skip_occurrence',
      { id: 'o1', note: 'Away' },
      undefined,
      {
        status: 200,
        body: {
          data: {
            occurrence: { id: 'o1', status: 'skipped', note: 'Away' },
            next: null,
            projection: { ok: false },
          },
        },
      }
    );
    expect(request!.method).toBe('POST');
    expect(request!.url).toContain('/weorc/occurrences/o1/skip');
    expect(body).toEqual({ note: 'Away' });
    expect(text).toContain('"projection"');
  });

  it('passes an upstream ROUTINE_HAS_HISTORY through unchanged', async () => {
    await expect(
      call('weorc.delete_routine', { id: 'r1' }, undefined, {
        status: 409,
        body: { error: { code: 'ROUTINE_HAS_HISTORY', message: 'This routine has completion history' } },
      })
    ).rejects.toThrow('ROUTINE_HAS_HISTORY');
  });

  it('passes an upstream ANCHOR_CONFLICT through unchanged', async () => {
    await expect(
      call(
        'weorc.record_routine',
        {
          name: 'Bad',
          mode: 'fixed',
          intervalUnit: 'week',
          intervalCount: 1,
          anchorDate: '2026-09-01',
          anchorAssetId: '11111111-1111-1111-1111-111111111111',
          anchorPlaceId: '22222222-2222-2222-2222-222222222222',
        },
        undefined,
        {
          status: 400,
          body: { error: { code: 'ANCHOR_CONFLICT', message: 'A routine anchors to an asset or a place, not both' } },
        }
      )
    ).rejects.toThrow('ANCHOR_CONFLICT');
  });

  it('does not gate writes on the local principal role', async () => {
    const { request } = await call(
      'weorc.record_routine',
      {
        name: 'Water plants',
        mode: 'from_completion',
        intervalUnit: 'day',
        intervalCount: 3,
        anchorDate: '2026-09-01',
      },
      { userId: 'fingerprint', role: 'child' },
      { status: 201, body: { data: { id: 'r2' } } }
    );
    expect(request!.method).toBe('POST');
  });
});
