import { describe, it, expect } from 'vitest';
import { tasksTools } from '../src/tools/tasks.js';
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
  const found = tasksTools.find((t) => t.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
};

const payload = (res: McpToolResult): unknown => JSON.parse(res.content[0]!.text);
const body = (raw: string | undefined): unknown => (raw === undefined ? undefined : JSON.parse(raw));

describe('tasks tools', () => {
  it('registers exactly the three frozen tool names', () => {
    expect(tasksTools.map((t) => t.name)).toEqual(['tasks.list', 'tasks.complete', 'tasks.create']);
  });

  it('tasks.list passes every filter through as a snake_case query key', async () => {
    const rows = [{ id: 't1' }];
    const { fake, run } = harness({ body: { data: rows, meta: { total: 1 } } });

    const res = await run(tool('tasks.list'), {
      status: 'open',
      member_id: '55555555-5555-4555-8555-555555555555',
      list_id: 'AAMk',
      due_from: '2026-01-01T00:00:00.000Z',
      due_to: '2026-02-01T00:00:00.000Z',
    });

    const url = new URL(fake.requests[0]!.url);
    expect(fake.requests[0]?.method).toBe('GET');
    expect(url.pathname).toBe('/api/v1/tasks');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: 'open',
      member_id: '55555555-5555-4555-8555-555555555555',
      list_id: 'AAMk',
      due_from: '2026-01-01T00:00:00.000Z',
      due_to: '2026-02-01T00:00:00.000Z',
    });
    expect(payload(res)).toEqual({ tasks: rows });
  });

  it('tasks.list omits filters that were not given', async () => {
    const { fake, run } = harness({ body: { data: [] } });

    await run(tool('tasks.list'), {});

    expect(fake.requests[0]?.url).toBe('http://heorth.test/api/v1/tasks');
  });

  it('tasks.complete POSTs /tasks/:id/complete and always sends `completed`', async () => {
    const row = { id: 't1', status: 'completed' };
    const { fake, run } = harness({ body: { data: row } }, { body: { data: row } });

    // Explicit false, and the omitted case (the REST schema has no default).
    await run(tool('tasks.complete'), { id: '66666666-6666-4666-8666-666666666666', completed: false });
    const res = await run(tool('tasks.complete'), { id: '66666666-6666-4666-8666-666666666666' });

    expect(fake.requests[0]?.method).toBe('POST');
    expect(new URL(fake.requests[0]!.url).pathname).toBe(
      '/api/v1/tasks/66666666-6666-4666-8666-666666666666/complete'
    );
    expect(body(fake.requests[0]?.body)).toEqual({ completed: false });
    expect(body(fake.requests[1]?.body)).toEqual({ completed: true });
    expect(payload(res)).toEqual(row);
  });

  it('tasks.complete surfaces the upstream NOT_FOUND code', async () => {
    const { run } = harness({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Task not found' } } });

    await expect(
      run(tool('tasks.complete'), { id: '66666666-6666-4666-8666-666666666666' })
    ).rejects.toThrow('NOT_FOUND');
  });

  it('tasks.create POSTs a camelCase body with nulls for the absent fields', async () => {
    const row = { id: 't2', title: 'Milch kaufen' };
    const { fake, run } = harness({ status: 201, body: { data: row } });

    const res = await run(tool('tasks.create'), { title: 'Milch kaufen' });

    expect(fake.requests[0]?.method).toBe('POST');
    expect(new URL(fake.requests[0]!.url).pathname).toBe('/api/v1/tasks');
    expect(body(fake.requests[0]?.body)).toEqual({ title: 'Milch kaufen', notes: null, dueAt: null });
    expect(payload(res)).toEqual(row);
  });

  it('tasks.create passes a classified provider failure through unchanged', async () => {
    const { run } = harness({
      status: 409,
      body: { error: { code: 'NEEDS_REAUTH', message: 'Reconnect Microsoft To Do' } },
    });

    await expect(run(tool('tasks.create'), { title: 'x' })).rejects.toThrow('NEEDS_REAUTH');
  });
});
