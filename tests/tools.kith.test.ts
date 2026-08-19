import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { kithTools } from '../src/tools/kith.js';
import { KithClient } from '../src/upstream/kith.js';
import { SatelliteTokenExchange } from '../src/upstream/exchange.js';
import type { McpTool, McpToolContext, McpToolResult } from '../src/mcp/types.js';
import { createFakeUpstream, type ScriptedResponse } from './helpers/fake-upstream.js';

const CALLER = 'Bearer he_caller_key';
const PERSON = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/**
 * Run a `kith.*` handler against a faked KithLedger, with a static member token
 * standing in for the exchange. The exchange itself is exercised separately in
 * `upstream.exchange.test.ts` and end to end in the last block below.
 */
function harness(...responses: ScriptedResponse[]) {
  const fake = createFakeUpstream(...responses);
  const ctx: McpToolContext = {
    principal: { userId: 'sha256-fingerprint-not-a-member-id' },
    requestId: 'req-1',
    upstreams: {
      kith: new KithClient({
        baseUrl: 'http://kith.test',
        credential: { authorization: () => 'Bearer member.jwt' },
        fetch: fake.fetch,
      }),
    },
  };
  const run = (t: McpTool, input: Record<string, unknown> = {}) => t.handler(ctx, input);
  return { fake, run };
}

const tool = (name: string): McpTool => {
  const found = kithTools.find((t) => t.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
};

const payload = (res: McpToolResult): any => JSON.parse(res.content[0]!.text);
const body = (raw: string | undefined): any => (raw === undefined ? undefined : JSON.parse(raw));
const query = (url: string) => Object.fromEntries(new URL(url).searchParams);

afterEach(() => vi.restoreAllMocks());

describe('kith tools', () => {
  it('registers exactly the 13 frozen tool names', () => {
    expect(kithTools.map((t) => t.name)).toEqual([
      'kith.list_people',
      'kith.get_person',
      'kith.create_person',
      'kith.update_person',
      'kith.get_person_graph',
      'kith.list_interactions',
      'kith.log_interaction',
      'kith.list_relationships',
      'kith.create_relationship',
      'kith.list_reminders',
      'kith.create_reminder',
      'kith.complete_reminder',
      'kith.snooze_reminder',
    ]);
  });

  it('never re-implements ADR 0004 locally: no handler inspects the principal', () => {
    // KithLedger enforces per-member visibility itself, on the member token.
    // A local check here could only ever be a second, weaker copy of it.
    for (const t of kithTools) {
      expect(t.handler.toString()).not.toContain('principal');
    }
  });

  it('kith.list_people sends the snake_case query and reshapes the envelope', async () => {
    const rows = [{ id: PERSON }];
    const { fake, run } = harness({
      body: { data: rows, meta: { total: 1, limit: 20, offset: 0 } },
    });

    const res = await run(tool('kith.list_people'), {
      q: 'ada',
      tags: 'family,work',
      birthday_month: 3,
      sort: 'name',
      order: 'asc',
      limit: 20,
      offset: 0,
    });

    expect(new URL(fake.requests[0]!.url).pathname).toBe('/api/v1/people');
    expect(query(fake.requests[0]!.url)).toEqual({
      q: 'ada',
      tags: 'family,work',
      birthday_month: '3',
      sort: 'name',
      order: 'asc',
      limit: '20',
      offset: '0',
    });
    expect(payload(res)).toEqual({ items: rows, total: 1, limit: 20, offset: 0 });
  });

  it('kith.get_person surfaces the upstream NOT_FOUND code', async () => {
    const { run } = harness({
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Person not found' } },
    });

    await expect(run(tool('kith.get_person'), { id: PERSON })).rejects.toThrow('NOT_FOUND');
  });

  it('kith.create_person POSTs a camelCase body and returns the row alone', async () => {
    const row = { id: PERSON, name: 'Ada' };
    const { fake, run } = harness({ status: 201, body: { data: row } });

    const res = await run(tool('kith.create_person'), {
      name: 'Ada',
      avatarUrl: 'https://example.test/ada.png',
      tags: ['family'],
      visibility: 'private',
    });

    expect(fake.requests[0]?.method).toBe('POST');
    expect(body(fake.requests[0]?.body)).toEqual({
      name: 'Ada',
      avatarUrl: 'https://example.test/ada.png',
      tags: ['family'],
      visibility: 'private',
    });
    expect(payload(res)).toEqual(row);
  });

  it('kith.update_person PATCHes /people/:id and never puts `id` in the body', async () => {
    const row = { id: PERSON, name: 'Ada L.' };
    const { fake, run } = harness({ body: { data: row } });

    const res = await run(tool('kith.update_person'), { id: PERSON, name: 'Ada L.', notes: 'x' });

    expect(fake.requests[0]?.method).toBe('PATCH');
    expect(new URL(fake.requests[0]!.url).pathname).toBe(`/api/v1/people/${PERSON}`);
    expect(body(fake.requests[0]?.body)).toEqual({ name: 'Ada L.', notes: 'x' });
    expect(body(fake.requests[0]?.body)).not.toHaveProperty('id');
    expect(payload(res)).toEqual(row);
  });

  it('kith.get_person_graph passes depth and returns the graph alone', async () => {
    const graph = { nodes: [], edges: [] };
    const { fake, run } = harness({
      body: { data: graph, meta: { root_person_id: PERSON, depth: 2 } },
    });

    const res = await run(tool('kith.get_person_graph'), { id: PERSON, depth: 2 });

    expect(new URL(fake.requests[0]!.url).pathname).toBe(`/api/v1/people/${PERSON}/graph`);
    expect(query(fake.requests[0]!.url)).toEqual({ depth: '2' });
    expect(payload(res)).toEqual(graph);
  });

  it('kith.list_interactions queries person_id while kith.log_interaction posts personId', async () => {
    const { fake, run } = harness({ body: { data: [], meta: { total: 0 } } }, { status: 201, body: { data: { id: 'i1' } } });

    await run(tool('kith.list_interactions'), { person_id: PERSON, type: 'call' });
    await run(tool('kith.log_interaction'), {
      personId: PERSON,
      occurredAt: '2026-08-01T10:00:00.000Z',
      type: 'call',
      channel: 'phone',
    });

    expect(query(fake.requests[0]!.url)).toEqual({ person_id: PERSON, type: 'call' });
    expect(body(fake.requests[1]?.body)).toEqual({
      personId: PERSON,
      occurredAt: '2026-08-01T10:00:00.000Z',
      type: 'call',
      channel: 'phone',
    });
  });

  it('kith.create_relationship posts both endpoints and lets the route enforce its refine', async () => {
    const { fake, run } = harness(
      { status: 201, body: { data: { id: 'r1' } } },
      {
        status: 400,
        body: { error: { code: 'VALIDATION_ERROR', message: 'must be different' } },
      }
    );

    await run(tool('kith.create_relationship'), {
      fromPersonId: PERSON,
      toPersonId: OTHER,
      type: 'family',
      isMutual: true,
    });

    expect(body(fake.requests[0]?.body)).toEqual({
      fromPersonId: PERSON,
      toPersonId: OTHER,
      type: 'family',
      isMutual: true,
    });
    // A self-relationship is refused upstream, not here.
    await expect(
      run(tool('kith.create_relationship'), {
        fromPersonId: PERSON,
        toPersonId: PERSON,
        type: 'family',
      })
    ).rejects.toThrow('VALIDATION_ERROR');
  });

  it('kith.list_reminders re-joins `statuses` and keeps `overdue` a string', async () => {
    const { fake, run } = harness({ body: { data: [], meta: { total: 0 } } });
    // The input schema splits `statuses` on commas; the REST query wants it back.
    const parsed = z.object(tool('kith.list_reminders').inputSchema).parse({
      statuses: 'pending, snoozed',
      overdue: 'true',
      due_before: '2026-09-01T00:00:00.000Z',
    });
    expect(parsed['statuses']).toEqual(['pending', 'snoozed']);

    await run(tool('kith.list_reminders'), parsed);

    expect(query(fake.requests[0]!.url)).toEqual({
      statuses: 'pending,snoozed',
      overdue: 'true',
      due_before: '2026-09-01T00:00:00.000Z',
    });
  });

  it('kith.complete_reminder POSTs the id path and returns the row', async () => {
    const row = { id: 'rem1', status: 'done' };
    const { fake, run } = harness({ body: { data: row } });

    const res = await run(tool('kith.complete_reminder'), { id: PERSON });

    expect(fake.requests[0]?.method).toBe('POST');
    expect(new URL(fake.requests[0]!.url).pathname).toBe(`/api/v1/reminders/${PERSON}/complete`);
    expect(payload(res)).toEqual(row);
  });

  it('kith.snooze_reminder sends snake_case `snooze_until` in the BODY', async () => {
    const row = { id: 'rem1', status: 'snoozed' };
    const { fake, run } = harness({ body: { data: row } });

    const res = await run(tool('kith.snooze_reminder'), {
      id: PERSON,
      snooze_until: '2026-09-01T09:00:00.000Z',
    });

    expect(new URL(fake.requests[0]!.url).pathname).toBe(`/api/v1/reminders/${PERSON}/snooze`);
    expect(body(fake.requests[0]?.body)).toEqual({ snooze_until: '2026-09-01T09:00:00.000Z' });
    expect(body(fake.requests[0]?.body)).not.toHaveProperty('snoozeUntil');
    expect(payload(res)).toEqual(row);
  });

  it('kith.create_reminder posts a camelCase body', async () => {
    const { fake, run } = harness({ status: 201, body: { data: { id: 'rem1' } } });

    await run(tool('kith.create_reminder'), {
      personId: PERSON,
      dueAt: '2026-09-01T09:00:00.000Z',
      title: 'Anrufen',
      kind: 'birthday',
      leadDays: 3,
    });

    expect(body(fake.requests[0]?.body)).toEqual({
      personId: PERSON,
      dueAt: '2026-09-01T09:00:00.000Z',
      title: 'Anrufen',
      kind: 'birthday',
      leadDays: 3,
    });
  });

  it('kith.list_relationships queries person_id and reshapes the list', async () => {
    const rows = [{ id: 'r1' }];
    const { fake, run } = harness({ body: { data: rows, meta: { total: 1, limit: 50, offset: 0 } } });

    const res = await run(tool('kith.list_relationships'), { person_id: PERSON, limit: 50 });

    expect(query(fake.requests[0]!.url)).toEqual({ person_id: PERSON, limit: '50' });
    expect(payload(res)).toEqual({ items: rows, total: 1, limit: 50, offset: 0 });
  });
});

describe('kith tools over the token exchange', () => {
  it('presents the exchanged member token to KithLedger, never the caller key', async () => {
    // One fake serves both hosts: Heorth mints, then KithLedger answers.
    const fake = createFakeUpstream(
      { body: { data: { token: 'member.jwt.alice', expires_in: 300, audience: 'kithledger' } } },
      { body: { data: [], meta: { total: 0 } } },
      { body: { data: [], meta: { total: 0 } } }
    );
    const exchange = new SatelliteTokenExchange({
      heorthBaseUrl: 'http://heorth.test',
      audience: 'kithledger',
      fetch: fake.fetch,
    });
    const ctx: McpToolContext = {
      principal: { userId: 'key:fingerprint' },
      requestId: 'req-1',
      upstreams: {
        kith: new KithClient({
          baseUrl: 'http://kith.test',
          credential: exchange.credentialFor(CALLER),
          fetch: fake.fetch,
        }),
      },
    };

    await tool('kith.list_people').handler(ctx, {});
    await tool('kith.list_people').handler(ctx, {});

    const toHeorth = fake.requests.filter((r) => r.url.startsWith('http://heorth.test'));
    const toKith = fake.requests.filter((r) => r.url.startsWith('http://kith.test'));

    // One exchange for two tool calls: the second came from the cache.
    expect(toHeorth).toHaveLength(1);
    expect(toKith).toHaveLength(2);
    for (const req of toKith) {
      expect(req.headers['Authorization']).toBe('Bearer member.jwt.alice');
      expect(req.headers['Authorization']).not.toContain('he_');
    }
  });

  it('fails a kith tool with IDENTITY_UNAVAILABLE when Heorth cannot be reached', async () => {
    const fake = createFakeUpstream({ throws: new TypeError('fetch failed') });
    const exchange = new SatelliteTokenExchange({
      heorthBaseUrl: 'http://heorth.test',
      audience: 'kithledger',
      fetch: fake.fetch,
    });
    const ctx: McpToolContext = {
      principal: { userId: 'key:fingerprint' },
      requestId: 'req-1',
      upstreams: {
        kith: new KithClient({
          baseUrl: 'http://kith.test',
          credential: exchange.credentialFor(CALLER),
          fetch: fake.fetch,
        }),
      },
    };

    const error = await tool('kith.list_people')
      .handler(ctx, {})
      .catch((e: Error) => e);

    expect((error as Error).message).toBe('IDENTITY_UNAVAILABLE');
    // No KithLedger call was attempted without an identity.
    expect(fake.requests.filter((r) => r.url.startsWith('http://kith.test'))).toHaveLength(0);
  });

  it('leaks no credential material through a failed tool call', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = createFakeUpstream(
      { body: { data: { token: 'member.jwt.alice', expires_in: 300, audience: 'kithledger' } } },
      { status: 500, body: { message: 'boom' } }
    );
    const exchange = new SatelliteTokenExchange({
      heorthBaseUrl: 'http://heorth.test',
      audience: 'kithledger',
      fetch: fake.fetch,
    });
    const ctx: McpToolContext = {
      principal: { userId: 'key:fingerprint' },
      requestId: 'req-1',
      upstreams: {
        kith: new KithClient({
          baseUrl: 'http://kith.test',
          credential: exchange.credentialFor(CALLER),
          fetch: fake.fetch,
        }),
      },
    };

    const error = await tool('kith.list_people')
      .handler(ctx, {})
      .catch((e: Error) => e);

    expect((error as Error).message).toBe('tool error');
    const written = [...log.mock.calls, ...errorLog.mock.calls].flat().join('\n');
    expect(written).not.toContain('member.jwt.alice');
    expect(written).not.toContain('he_caller_key');
  });
});
