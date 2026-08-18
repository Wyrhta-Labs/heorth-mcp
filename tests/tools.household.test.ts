import { describe, it, expect } from 'vitest';
import { householdTools } from '../src/tools/household.js';
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
  const found = householdTools.find((t) => t.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
};

const payload = (res: McpToolResult): unknown => JSON.parse(res.content[0]!.text);

describe('household tools', () => {
  it('registers exactly the two frozen tool names', () => {
    expect(householdTools.map((t) => t.name)).toEqual(['household.get_members', 'household.whoami']);
  });

  it('household.get_members reads GET /members and reshapes to { members }', async () => {
    const rows = [{ id: 'm1', role: 'admin' }, { id: 'm2', role: 'child' }];
    const { fake, run } = harness({ body: { data: rows, meta: { total: 2 } } });

    const res = await run(tool('household.get_members'));

    expect(fake.requests[0]?.method).toBe('GET');
    expect(fake.requests[0]?.url).toBe('http://heorth.test/api/v1/members');
    expect(payload(res)).toEqual({ members: rows });
  });

  it('household.whoami reads GET /auth/whoami and unwraps the envelope', async () => {
    const member = { id: 'm1', name: 'Christian', role: 'admin' };
    const { fake, run } = harness({ body: { data: member } });

    const res = await run(tool('household.whoami'));

    expect(fake.requests[0]?.method).toBe('GET');
    expect(fake.requests[0]?.url).toBe('http://heorth.test/api/v1/auth/whoami');
    // The member id comes from the route, never from the principal fingerprint.
    expect(payload(res)).toEqual(member);
  });

  it('household.whoami surfaces the upstream NOT_FOUND code', async () => {
    const { run } = harness({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Member not found' } } });

    await expect(run(tool('household.whoami'))).rejects.toThrow('NOT_FOUND');
  });
});
