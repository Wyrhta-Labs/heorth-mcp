import { z } from 'zod';
import type { HeorthClient } from '../upstream/heorth.js';
import type { McpTool, McpToolResult } from '../mcp/types.js';

/**
 * `meals.*` — ported from Heorth's `src/modules/meals/mcp.ts`.
 *
 * Tool names, descriptions and input schemas are copied verbatim: they are the
 * public contract with MCP clients. Only the handler body changes — it calls
 * Heorth's REST API instead of the module's service layer, and reshapes the
 * `{ data, meta }` envelope back into the shape the embedded tool returned.
 *
 * Mount prefixes differ per route group (`src/modules/meals/index.ts`):
 * recipes live under `/api/v1/recipes`, plan and shopping list under
 * `/api/v1/meals`.
 */

/** Wrap any JSON-serialisable value as an MCP text tool-result. */
function result(data: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

interface Envelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

/** The caller's Heorth client. Absent only if a `meals.*` tool was registered
 *  without Heorth configured, which `buildRegistry` never does. */
function heorth(upstreams: { heorth?: HeorthClient }): HeorthClient {
  const client = upstreams.heorth;
  if (!client) throw new Error('UPSTREAM_UNAVAILABLE');
  return client;
}

/** Meal slots, mirroring Heorth's `MEAL_SLOTS` (src/modules/meals/schema.ts).
 *  Inlined because heorth-mcp never imports Heorth code — see CLAUDE.md. */
const MEAL_SLOTS = ['breakfast', 'lunch', 'supper'] as const;

export const mealsTools: McpTool[] = [
  {
    name: 'meals.list_recipes',
    description: 'List recipes, optionally filtered by tag.',
    inputSchema: {
      tag: z.string().optional(),
      limit: z.number().int().positive().max(100).optional(),
    },
    async handler(ctx, input) {
      const i = input as { tag?: string; limit?: number };
      const res = await heorth(ctx.upstreams).get<Envelope<unknown[]>>('/recipes', {
        tag: i.tag,
        limit: i.limit,
      });
      return result({ recipes: res.data });
    },
  },
  {
    name: 'meals.create_recipe',
    description: 'Create a recipe with ingredients, steps, and tags.',
    inputSchema: {
      title: z.string().min(1),
      servings: z.number().int().positive().default(1),
      ingredients: z.array(z.object({ name: z.string(), qty: z.number(), unit: z.string() })).default([]),
      steps: z.array(z.string()).default([]),
      tags: z.array(z.string()).default([]),
    },
    async handler(ctx, input) {
      // The author is derived from the authenticated caller upstream; the port
      // must not send one (heorth-mcp holds no member id — CLAUDE.md, "Auth").
      const res = await heorth(ctx.upstreams).post<Envelope<unknown>>('/recipes', input);
      return result(res.data);
    },
  },
  {
    name: 'meals.plan_meal',
    description: 'Assign a recipe or free-text meal to a date + slot (upserts).',
    inputSchema: {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      slot: z.enum(MEAL_SLOTS),
      recipeId: z.string().uuid().nullish(),
      freeText: z.string().nullish(),
      cook: z.string().uuid().nullish(),
      helper: z.string().uuid().nullish(),
    },
    async handler(ctx, input) {
      const res = await heorth(ctx.upstreams).post<Envelope<unknown>>('/meals/plan', input);
      return result(res.data);
    },
  },
  {
    name: 'meals.get_week_plan',
    description: 'Return meal plan entries between two dates (YYYY-MM-DD).',
    inputSchema: {
      from: z.string(),
      to: z.string(),
    },
    async handler(ctx, input) {
      const i = input as { from: string; to: string };
      const res = await heorth(ctx.upstreams).get<Envelope<unknown[]>>('/meals/plan', {
        from: i.from,
        to: i.to,
      });
      return result({ entries: res.data });
    },
  },
  {
    name: 'meals.generate_shopping_list',
    description: 'Generate (regenerate) the shopping list from planned recipes in a date range.',
    inputSchema: {
      from: z.string(),
      to: z.string(),
    },
    async handler(ctx, input) {
      const i = input as { from: string; to: string };
      // `from`/`to` are QUERY parameters on a POST — the route reads
      // `c.req.query()`, not the body, and 400s without them. They ride in the
      // path because the client's `post` takes a body, not a query.
      const qs = new URLSearchParams({ from: i.from, to: i.to }).toString();
      const res = await heorth(ctx.upstreams).post<Envelope<unknown[]>>(
        `/meals/shopping-list/generate?${qs}`
      );
      return result({ items: res.data });
    },
  },
  {
    name: 'meals.check_off_item',
    description: 'Mark a shopping list item as checked or unchecked.',
    inputSchema: {
      id: z.string().uuid(),
      checked: z.boolean().default(true),
    },
    async handler(ctx, input) {
      const i = input as { id: string; checked: boolean };
      // Send `checked` explicitly: the REST schema has no default, so omitting
      // it would silently update nothing.
      const res = await heorth(ctx.upstreams).patch<Envelope<unknown>>(
        `/meals/shopping-list/${encodeURIComponent(i.id)}`,
        { checked: i.checked }
      );
      return result(res.data);
    },
  },
];
