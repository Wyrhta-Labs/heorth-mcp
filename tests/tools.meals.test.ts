import { describe, it, expect } from 'vitest';
import { mealsTools } from '../src/tools/meals.js';
import { HeorthClient } from '../src/upstream/heorth.js';
import type { McpTool, McpToolContext } from '../src/mcp/types.js';
import { createFakeUpstream, type ScriptedResponse } from './helpers/fake-upstream.js';

const CALLER = 'Bearer he_test';

function tool(name: string): McpTool {
  const found = mealsTools.find((t) => t.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
}

/** Run one tool against a scripted fake upstream; return the parsed payload. */
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
    isError: res.isError,
  };
}

describe('meals tool registry', () => {
  it('exposes the six frozen tool names', () => {
    expect(mealsTools.map((t) => t.name)).toEqual([
      'meals.list_recipes',
      'meals.create_recipe',
      'meals.plan_meal',
      'meals.get_week_plan',
      'meals.generate_shopping_list',
      'meals.check_off_item',
    ]);
  });
});

describe('meals.list_recipes', () => {
  it('GETs /recipes (not /meals) and returns { recipes }', async () => {
    const { request, payload } = await call(
      'meals.list_recipes',
      { tag: 'quick', limit: 5 },
      { body: { data: [{ id: 'r1' }], meta: { total: 1, limit: 5, offset: 0 } } }
    );

    expect(request?.method).toBe('GET');
    expect(request?.url).toBe('http://heorth.test/api/v1/recipes?tag=quick&limit=5');
    expect(payload).toEqual({ recipes: [{ id: 'r1' }] });
  });

  it('omits absent filters', async () => {
    const { request } = await call('meals.list_recipes', {}, { body: { data: [], meta: {} } });
    expect(request?.url).toBe('http://heorth.test/api/v1/recipes');
  });
});

describe('meals.create_recipe', () => {
  it('POSTs the body to /recipes and unwraps data', async () => {
    const input = { title: 'Soup', servings: 2, ingredients: [], steps: [], tags: ['x'] };
    const { request, body, payload } = await call('meals.create_recipe', input, {
      status: 201,
      body: { data: { id: 'r9', title: 'Soup' } },
    });

    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('http://heorth.test/api/v1/recipes');
    expect(body).toEqual(input);
    // The author is derived from the caller upstream, never sent from here.
    expect(body).not.toHaveProperty('createdBy');
    expect(payload).toEqual({ id: 'r9', title: 'Soup' });
  });
});

describe('meals.plan_meal', () => {
  it('POSTs to /meals/plan and unwraps data', async () => {
    const input = { date: '2026-08-18', slot: 'supper', recipeId: null, freeText: 'Pizza' };
    const { request, body, payload } = await call('meals.plan_meal', input, {
      status: 201,
      body: { data: { id: 'p1' } },
    });

    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('http://heorth.test/api/v1/meals/plan');
    expect(body).toEqual(input);
    expect(payload).toEqual({ id: 'p1' });
  });
});

describe('meals.get_week_plan', () => {
  it('GETs /meals/plan with from/to and returns { entries }', async () => {
    const { request, payload } = await call(
      'meals.get_week_plan',
      { from: '2026-08-17', to: '2026-08-23' },
      { body: { data: [{ id: 'p1' }] } }
    );

    expect(request?.method).toBe('GET');
    expect(request?.url).toBe(
      'http://heorth.test/api/v1/meals/plan?from=2026-08-17&to=2026-08-23'
    );
    expect(payload).toEqual({ entries: [{ id: 'p1' }] });
  });
});

describe('meals.generate_shopping_list', () => {
  it('sends from/to as QUERY parameters on the POST, not in the body', async () => {
    const { request, body, payload } = await call(
      'meals.generate_shopping_list',
      { from: '2026-08-17', to: '2026-08-23' },
      { status: 201, body: { data: [{ id: 's1', name: 'Milk' }] } }
    );

    expect(request?.method).toBe('POST');
    expect(request?.url).toBe(
      'http://heorth.test/api/v1/meals/shopping-list/generate?from=2026-08-17&to=2026-08-23'
    );
    expect(body).toEqual({});
    expect(payload).toEqual({ items: [{ id: 's1', name: 'Milk' }] });
  });
});

describe('meals.check_off_item', () => {
  it('PATCHes the item and always sends `checked` explicitly', async () => {
    const { request, body, payload } = await call(
      'meals.check_off_item',
      { id: 'aaa-bbb', checked: true },
      { body: { data: { id: 'aaa-bbb', checked: true } } }
    );

    expect(request?.method).toBe('PATCH');
    expect(request?.url).toBe('http://heorth.test/api/v1/meals/shopping-list/aaa-bbb');
    expect(body).toEqual({ checked: true });
    expect(payload).toEqual({ id: 'aaa-bbb', checked: true });
  });

  it('passes a NOT_FOUND domain code through as the tool error', async () => {
    await expect(
      call(
        'meals.check_off_item',
        { id: 'missing', checked: false },
        { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Item not found' } } }
      )
    ).rejects.toThrow('NOT_FOUND');
  });
});
