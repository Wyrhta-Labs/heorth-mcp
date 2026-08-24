import { z } from 'zod';
import type { HeorthClient } from '../upstream/heorth.js';
import type { McpTool, McpToolResult } from '../mcp/types.js';

/**
 * `ethel.*` — ported from Heorth's former `src/modules/inventory/mcp.ts`,
 * mounted at `/api/v1/ethel`.
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

/** Mirrors Heorth's `decommissionReasons` (src/modules/ethel/validators.ts). */
const decommissionReasons = ['broken', 'sold', 'given_away', 'worn_out', 'lost', 'other'] as const;

/** Mirrors Heorth's `placeKinds` (src/modules/ethel/schema.ts). */
const placeKinds = ['building', 'floor', 'room', 'outdoor', 'storage'] as const;

/** Mirrors Heorth's `facilityKinds` (src/modules/ethel/schema.ts). */
const facilityKinds = [
  'heating',
  'water',
  'electrical',
  'solar',
  'sewage',
  'ventilation',
  'network',
  'other',
] as const;

/**
 * Render a boolean query flag the way Heorth reads it: the query validators
 * spell these as `z.enum(['true','false'])`, never a coerced boolean, because
 * `Boolean('false')` is true.
 */
function flag(value: boolean | undefined): 'true' | 'false' | undefined {
  return value === undefined ? undefined : value ? 'true' : 'false';
}

/**
 * The one thing an agent must not infer from `serviceIntervalMonths`: it is a
 * fact copied off the manufacturer's plate, not a reminder. Scheduling the
 * routine is Weorc's job (ADR 0014).
 */
const SERVICE_INTERVAL_NOTE =
  'Months between services as stated by the manufacturer. Recording it does not schedule anything and creates no reminder or due date.';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ethelTools: McpTool[] = [
  {
    name: 'ethel.list_assets',
    description:
      'List household assets. Filter by status/category/search, by the place they sit in (optionally including the places inside it), and by whether they are a facility or serve a given place.',
    inputSchema: {
      status: z.enum(['active', 'decommissioned']).optional(),
      category: z.string().optional(),
      q: z.string().optional(),
      placeId: z.string().uuid().optional().describe('Only assets assigned to this place.'),
      includeDescendants: z
        .boolean()
        .optional()
        .describe(
          'Also return assets in the places nested inside placeId ("what is in the garage, shelves included"). Requires placeId; without it the request is rejected upstream.'
        ),
      hasFacility: z
        .boolean()
        .optional()
        .describe('Only assets that carry facility details (heating, water, solar, ...).'),
      servesPlaceId: z
        .string()
        .uuid()
        .optional()
        .describe('Only facilities that serve this place.'),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async handler(ctx, input) {
      const i = input as {
        status?: string;
        category?: string;
        q?: string;
        placeId?: string;
        includeDescendants?: boolean;
        hasFacility?: boolean;
        servesPlaceId?: string;
        limit?: number;
        offset?: number;
      };
      const res = await heorth(ctx.upstreams).get<Envelope<unknown[]>>('/ethel/assets', {
        status: i.status,
        category: i.category,
        q: i.q,
        placeId: i.placeId,
        // Heorth validates both flags as z.enum(['true','false']), so they go
        // over the wire as those strings. Converted explicitly rather than
        // leaning on `String(true)` happening to match.
        includeDescendants: flag(i.includeDescendants),
        hasFacility: flag(i.hasFacility),
        servesPlaceId: i.servesPlaceId,
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
    name: 'ethel.get_asset',
    description: 'Get one asset by id (lifecycle fields included).',
    inputSchema: { id: z.string().uuid() },
    async handler(ctx, input) {
      // Divergence, deliberate: the embedded tool answered with an `isError`
      // "Item not found" result; REST 404s with `NOT_FOUND`, which passes
      // through as the tool error text.
      const res = await heorth(ctx.upstreams).get<Envelope<unknown>>(
        `/ethel/assets/${encodeURIComponent((input as { id: string }).id)}`
      );
      return result(res.data);
    },
  },
  {
    name: 'ethel.record_asset',
    description: 'Create an asset (name required; purchase fields optional).',
    inputSchema: {
      name: z.string().min(1),
      category: z.string().optional().nullable(),
      manufacturer: z.string().optional().nullable(),
      model: z.string().optional().nullable(),
      serialNumber: z.string().optional().nullable(),
      locationNote: z.string().optional().nullable(),
      notes: z.string().optional().nullable(),
      warrantyUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
      purchasePrice: z.number().nonnegative().optional().nullable(),
      purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    },
    async handler(ctx, input) {
      const res = await heorth(ctx.upstreams).post<Envelope<unknown>>('/ethel/assets', input);
      return result(res.data);
    },
  },
  {
    name: 'ethel.decommission_asset',
    description: 'Decommission an asset (date, reason; optional proceeds). Asset fields only - link a sale transaction separately via feoh.link_item_cost.',
    inputSchema: {
      id: z.string().uuid(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reason: z.enum(decommissionReasons),
      proceeds: z.number().nonnegative().optional(),
    },
    async handler(ctx, input) {
      // `id` addresses the asset in the path and must not travel in the body.
      const { id, ...rest } = input as {
        id: string;
        date: string;
        reason: string;
        proceeds?: number;
      };
      // 409 ALREADY_DECOMMISSIONED and 404 NOT_FOUND are raised by the route and
      // pass through as domain codes.
      const res = await heorth(ctx.upstreams).post<Envelope<unknown>>(
        `/ethel/assets/${encodeURIComponent(id)}/decommission`,
        rest
      );
      return result(res.data);
    },
  },
  {
    name: 'ethel.list_places',
    description:
      'List every place in the house (buildings, floors, rooms, outdoor areas, storage), each with its parentId, so the tree can be rebuilt by the caller.',
    inputSchema: {},
    async handler(ctx) {
      // `GET /ethel/places` answers with the whole flat list and no meta - the
      // tree is small enough that paging it would only cost the caller a
      // second call.
      const res = await heorth(ctx.upstreams).get<Envelope<unknown[]>>('/ethel/places');
      return result({ rows: res.data });
    },
  },
  {
    name: 'ethel.record_place',
    description:
      'Create a place. Give parentId to nest it inside another place (a room inside a floor, a shelf inside a room).',
    inputSchema: {
      name: z.string().min(1),
      kind: z.enum(placeKinds),
      parentId: z
        .string()
        .uuid()
        .optional()
        .nullable()
        .describe('The place this one sits inside. Omit for a top-level place.'),
      notes: z.string().optional().nullable(),
    },
    async handler(ctx, input) {
      // The place invariants - the cycle check, the six-deep cap, the
      // name-unique-per-parent rule - live in Heorth and arrive here as
      // PLACE_CYCLE / PLACE_TOO_DEEP / PLACE_NAME_TAKEN / PLACE_NOT_FOUND.
      // They are deliberately NOT re-checked here: heorth-mcp is a REST
      // client, and a second copy of a rule is a rule that drifts.
      const res = await heorth(ctx.upstreams).post<Envelope<unknown>>('/ethel/places', input);
      return result(res.data);
    },
  },
  {
    name: 'ethel.update_place',
    description:
      'Rename a place, change its kind or notes, or move it under a different parent.',
    inputSchema: {
      id: z.string().uuid(),
      name: z.string().min(1).optional(),
      kind: z.enum(placeKinds).optional(),
      parentId: z
        .string()
        .uuid()
        .optional()
        .nullable()
        .describe('New parent; null lifts the place to the top level.'),
      notes: z.string().optional().nullable(),
    },
    async handler(ctx, input) {
      // `id` addresses the place in the path and must not travel in the body.
      const { id, ...rest } = input as { id: string };
      const res = await heorth(ctx.upstreams).patch<Envelope<unknown>>(
        `/ethel/places/${encodeURIComponent(id)}`,
        rest
      );
      return result(res.data);
    },
  },
  {
    name: 'ethel.delete_place',
    description:
      'Delete a place. Assets that sat in it are UNASSIGNED, not deleted - they stay in the inventory with no place. A place that still has places inside it is refused (PLACE_HAS_CHILDREN); move or delete those first.',
    inputSchema: { id: z.string().uuid() },
    async handler(ctx, input) {
      const { id } = input as { id: string };
      const res = await heorth(ctx.upstreams).delete<Envelope<{ id: string }>>(
        `/ethel/places/${encodeURIComponent(id)}`
      );
      // Said in the result, not only in the description: the column is
      // ON DELETE SET NULL, so the unassignment is otherwise silent and this
      // is the only place a conversational caller ever learns it happened
      // (ADR 0013 SS5).
      return result({
        ...res.data,
        deleted: true,
        assets:
          'Assets that were in this place have been unassigned, not deleted. They remain in the inventory with no place.',
      });
    },
  },
  {
    name: 'ethel.set_vehicle_details',
    description:
      'Record or replace the vehicle details of an asset (registration, VIN, odometer, service interval). Replaces the details wholesale rather than merging, so omitted fields are cleared. An asset may carry vehicle OR facility details, never both.',
    inputSchema: {
      assetId: z.string().uuid(),
      registration: z.string().min(1).optional().nullable(),
      vin: z.string().min(1).optional().nullable(),
      firstRegisteredOn: dateOnly.optional().nullable(),
      odometer: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .nullable()
        .describe('Must be given together with odometerReadAt.'),
      odometerReadAt: dateOnly
        .optional()
        .nullable()
        .describe('The date the odometer reading was taken. Must be given together with odometer.'),
      serviceIntervalMonths: z
        .number()
        .int()
        .positive()
        .optional()
        .nullable()
        .describe(SERVICE_INTERVAL_NOTE),
    },
    async handler(ctx, input) {
      // `assetId` addresses the asset in the path and must not travel in the
      // body (same rule as decommission_asset).
      const { assetId, ...rest } = input as { assetId: string };
      // 409 ASSET_DETAIL_CONFLICT (the asset already has facility details),
      // 409 VEHICLE_REGISTRATION_TAKEN / VEHICLE_VIN_TAKEN and 404 NOT_FOUND
      // are the route's to raise; they pass through as domain codes.
      const res = await heorth(ctx.upstreams).put<Envelope<unknown>>(
        `/ethel/assets/${encodeURIComponent(assetId)}/vehicle`,
        rest
      );
      return result(res.data);
    },
  },
  {
    name: 'ethel.set_facility_details',
    description:
      'Record or replace the facility details of an asset (heating, water, solar, ...), including which places it serves. Replaces the details and the served-place set wholesale rather than merging, so removing a served place is one call. An asset may carry facility OR vehicle details, never both.',
    inputSchema: {
      assetId: z.string().uuid(),
      kind: z.enum(facilityKinds),
      commissionedOn: dateOnly.optional().nullable(),
      serviceIntervalMonths: z
        .number()
        .int()
        .positive()
        .optional()
        .nullable()
        .describe(SERVICE_INTERVAL_NOTE),
      servesPlaceIds: z
        .array(z.string().uuid())
        .optional()
        .describe('The places this facility serves. Replaces the whole set; omit or pass [] for none.'),
    },
    async handler(ctx, input) {
      const { assetId, ...rest } = input as { assetId: string };
      // 409 ASSET_DETAIL_CONFLICT and 400 PLACE_NOT_FOUND come from the route.
      const res = await heorth(ctx.upstreams).put<Envelope<unknown>>(
        `/ethel/assets/${encodeURIComponent(assetId)}/facility`,
        rest
      );
      return result(res.data);
    },
  },
];
