import { describe, it, expect } from 'vitest';
import { calendarTools } from '../src/tools/calendar.js';
import { HeorthClient } from '../src/upstream/heorth.js';
import type { McpTool, McpToolContext, McpToolResult } from '../src/mcp/types.js';
import { createFakeUpstream, type ScriptedResponse } from './helpers/fake-upstream.js';

const CALLER = 'Bearer he_test';

/** Run a tool handler against a faked Heorth — no network, no database. */
function harness(...responses: ScriptedResponse[]) {
  const fake = createFakeUpstream(...responses);
  const ctx: McpToolContext = {
    principal: { userId: 'sha256-fingerprint-not-a-member-id' },
    requestId: 'req-1',
    upstreams: {
      heorth: new HeorthClient({ baseUrl: 'http://heorth.test', authorization: CALLER, fetch: fake.fetch }),
    },
  };
  const run = (tool: McpTool, input: Record<string, unknown> = {}) => tool.handler(ctx, input);
  return { fake, run };
}

const tool = (name: string): McpTool => {
  const found = calendarTools.find((t) => t.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
};

const payload = (res: McpToolResult): unknown => JSON.parse(res.content[0]!.text);
const body = (raw: string | undefined): unknown => (raw === undefined ? undefined : JSON.parse(raw));

describe('calendar tools', () => {
  it('registers exactly the five frozen tool names', () => {
    expect(calendarTools.map((t) => t.name)).toEqual([
      'calendar.list_events',
      'calendar.create_event',
      'calendar.update_event',
      'calendar.move_event',
      'calendar.list_upcoming',
    ]);
  });

  it('calendar.list_events hits /events (not /calendar) with snake_case member_id', async () => {
    const rows = [{ id: 'e1' }, { id: 'e2' }];
    const { fake, run } = harness({ body: { data: rows, meta: { total: 2, limit: 50, offset: 0 } } });

    const res = await run(tool('calendar.list_events'), {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-31T00:00:00.000Z',
      member_id: '11111111-1111-4111-8111-111111111111',
    });

    const url = new URL(fake.requests[0]!.url);
    expect(fake.requests[0]?.method).toBe('GET');
    expect(url.pathname).toBe('/api/v1/events');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-31T00:00:00.000Z',
      member_id: '11111111-1111-4111-8111-111111111111',
    });
    expect(payload(res)).toEqual({ events: rows });
  });

  it('calendar.create_event POSTs the camelCase body and unwraps the envelope', async () => {
    const event = { id: 'e1', title: 'Zahnarzt' };
    const { fake, run } = harness({ status: 201, body: { data: event } });

    const res = await run(tool('calendar.create_event'), {
      title: 'Zahnarzt',
      startAt: '2026-02-01T09:00:00.000Z',
      endAt: '2026-02-01T10:00:00.000Z',
      allDay: false,
      attendeeIds: [],
    });

    expect(fake.requests[0]?.method).toBe('POST');
    expect(new URL(fake.requests[0]!.url).pathname).toBe('/api/v1/events');
    expect(body(fake.requests[0]?.body)).toEqual({
      title: 'Zahnarzt',
      startAt: '2026-02-01T09:00:00.000Z',
      endAt: '2026-02-01T10:00:00.000Z',
      allDay: false,
      attendeeIds: [],
    });
    // `createdBy` is never sent — the route derives it from the caller.
    expect(body(fake.requests[0]?.body)).not.toHaveProperty('createdBy');
    expect(payload(res)).toEqual(event);
  });

  it('calendar.update_event PATCHes /events/:id with the id stripped from the body', async () => {
    const event = { id: 'e1', title: 'Neu' };
    const { fake, run } = harness({ body: { data: event } });

    const res = await run(tool('calendar.update_event'), {
      id: '22222222-2222-4222-8222-222222222222',
      title: 'Neu',
      notes: null,
    });

    expect(fake.requests[0]?.method).toBe('PATCH');
    expect(new URL(fake.requests[0]!.url).pathname).toBe(
      '/api/v1/events/22222222-2222-4222-8222-222222222222'
    );
    expect(body(fake.requests[0]?.body)).toEqual({ title: 'Neu', notes: null });
    expect(payload(res)).toEqual(event);
  });

  it('calendar.update_event lets the route own the mutation guard', async () => {
    const { fake, run } = harness({
      status: 403,
      body: { error: { code: 'EVENT_READ_ONLY', message: 'Mirrored M365 events are read-only' } },
    });

    await expect(
      run(tool('calendar.update_event'), { id: '22222222-2222-4222-8222-222222222222', title: 'x' })
    ).rejects.toThrow('EVENT_READ_ONLY');
    // The call went upstream — nothing was blocked locally.
    expect(fake.requests).toHaveLength(1);
  });

  it('calendar.move_event POSTs /events/:id/move with startAt (and optional endAt)', async () => {
    const { fake, run } = harness({ body: { data: { id: 'e1' } } }, { body: { data: { id: 'e1' } } });

    await run(tool('calendar.move_event'), {
      id: '33333333-3333-4333-8333-333333333333',
      startAt: '2026-03-01T09:00:00.000Z',
    });
    await run(tool('calendar.move_event'), {
      id: '33333333-3333-4333-8333-333333333333',
      startAt: '2026-03-01T09:00:00.000Z',
      endAt: '2026-03-01T10:00:00.000Z',
    });

    expect(fake.requests[0]?.method).toBe('POST');
    expect(new URL(fake.requests[0]!.url).pathname).toBe(
      '/api/v1/events/33333333-3333-4333-8333-333333333333/move'
    );
    expect(body(fake.requests[0]?.body)).toEqual({ startAt: '2026-03-01T09:00:00.000Z' });
    expect(body(fake.requests[1]?.body)).toEqual({
      startAt: '2026-03-01T09:00:00.000Z',
      endAt: '2026-03-01T10:00:00.000Z',
    });
  });

  it('calendar.list_upcoming builds a now → now+90d window in the request', async () => {
    const rows = [{ id: 'occ1' }];
    const { fake, run } = harness({ body: { data: rows, meta: { total: 1 } } });

    const before = Date.now();
    const res = await run(tool('calendar.list_upcoming'), {
      limit: 5,
      member_id: '44444444-4444-4444-8444-444444444444',
    });
    const after = Date.now();

    const url = new URL(fake.requests[0]!.url);
    expect(fake.requests[0]?.method).toBe('GET');
    expect(url.pathname).toBe('/api/v1/events');

    const from = Date.parse(url.searchParams.get('from')!);
    const to = Date.parse(url.searchParams.get('to')!);
    expect(from).toBeGreaterThanOrEqual(before);
    expect(from).toBeLessThanOrEqual(after);
    expect(to - from).toBe(90 * 24 * 60 * 60 * 1000);
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('member_id')).toBe('44444444-4444-4444-8444-444444444444');

    expect(payload(res)).toEqual({ events: rows });
  });

  it('calendar.list_upcoming defaults limit to 10 and omits an absent member_id', async () => {
    const { fake, run } = harness({ body: { data: [] } });

    await run(tool('calendar.list_upcoming'), {});

    const url = new URL(fake.requests[0]!.url);
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.has('member_id')).toBe(false);
  });
});
