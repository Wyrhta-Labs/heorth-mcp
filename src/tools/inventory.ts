import { z } from 'zod';
import type { HeorthClient } from '../upstream/heorth.js';
import type { McpTool, McpToolResult } from '../mcp/types.js';

/**
 * `inventory.*` — ported from Heorth's `src/modules/inventory/mcp.ts`, mounted
 * at `/api/v1/inventory`.
 *
 * The embedded tool carried a local `assertCanWrite` role gate. It is **not**
 * ported: the REST routes are wrapped in `requireRole('admin','adult')`
 * themselves and derive the actor from the authenticated caller, while
 * heorth-mcp's `McpPrincipal.userId` is only a key fingerprint and carries no
 * role. Re-adding a check here would guess at an identity this process never
 * verified (CLAUDE.md, "Auth"; docs/spec/tool-surface.md).
 */

/** Wrap any JSON-serialisable value as an MCP text tool-result. */
function result(data: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

interface Envelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

function heorth(upstreams: { heorth?: HeorthClient }): HeorthClient {
  const client = upstreams.heorth;
  if (!client) throw new Error('UPSTREAM_UNAVAILABLE');
  return client;
}

/** Mirrors Heorth's `decommissionReasons` (src/modules/inventory/validators.ts). */
const decommissionReasons = ['broken', 'sold', 'given_away', 'worn_out', 'lost', 'other'] as const;

export const inventoryTools: McpTool[] = [
  {
    name: 'inventory.list_items',
    description: 'List household inventory items (filter by status/category/search).',
    inputSchema: {
      status: z.enum(['active', 'decommissioned']).optional(),
      category: z.string().optional(),
      q: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async handler(ctx, input) {
      const i = input as {
        status?: string;
        category?: string;
        q?: string;
        limit?: number;
        offset?: number;
      };
      const res = await heorth(ctx.upstreams).get<Envelope<unknown[]>>('/inventory/items', {
        status: i.status,
        category: i.category,
        q: i.q,
        limit: i.limit,
        offset: i.offset,
      });
      // The embedded tool returned the service's flat `{ rows, total, limit,
      // offset }`; REST splits it into `data` + `meta`, so recombine.
      return result({
        rows: res.data,
        total: res.meta?.['total'],
        limit: res.meta?.['limit'],
        offset: res.meta?.['offset'],
      });
    },
  },
  {
    name: 'inventory.get_item',
    description: 'Get one inventory item by id (lifecycle fields included).',
    inputSchema: { id: z.string().uuid() },
    async handler(ctx, input) {
      // Divergence, deliberate: the embedded tool answered with an `isError`
      // "Item not found" result; REST 404s with `NOT_FOUND`, which passes
      // through as the tool error text.
      const res = await heorth(ctx.upstreams).get<Envelope<unknown>>(
        `/inventory/items/${encodeURIComponent((input as { id: string }).id)}`
      );
      return result(res.data);
    },
  },
  {
    name: 'inventory.record_item',
    description: 'Create an inventory item (name required; purchase fields optional).',
    inputSchema: {
      name: z.string().min(1),
      category: z.string().optional().nullable(),
      manufacturer: z.string().optional().nullable(),
      model: z.string().optional().nullable(),
      serialNumber: z.string().optional().nullable(),
      location: z.string().optional().nullable(),
      notes: z.string().optional().nullable(),
      warrantyUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
      purchasePrice: z.number().nonnegative().optional().nullable(),
      purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    },
    async handler(ctx, input) {
      const res = await heorth(ctx.upstreams).post<Envelope<unknown>>('/inventory/items', input);
      return result(res.data);
    },
  },
  {
    name: 'inventory.decommission_item',
    description: 'Decommission an item (date, reason; optional proceeds). Inventory fields only - link a sale transaction separately via feoh.link_item_cost.',
    inputSchema: {
      id: z.string().uuid(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reason: z.enum(decommissionReasons),
      proceeds: z.number().nonnegative().optional(),
    },
    async handler(ctx, input) {
      // `id` addresses the item in the path and must not travel in the body.
      const { id, ...rest } = input as {
        id: string;
        date: string;
        reason: string;
        proceeds?: number;
      };
      // 409 ALREADY_DECOMMISSIONED and 404 NOT_FOUND are raised by the route and
      // pass through as domain codes.
      const res = await heorth(ctx.upstreams).post<Envelope<unknown>>(
        `/inventory/items/${encodeURIComponent(id)}/decommission`,
        rest
      );
      return result(res.data);
    },
  },
];
