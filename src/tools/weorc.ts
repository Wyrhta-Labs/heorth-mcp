import { z } from 'zod';
import type { HeorthClient } from '../upstream/heorth.js';
import type { McpTool, McpToolResult } from '../mcp/types.js';

/**
 * `weorc.*` — mounted at `/api/v1/weorc`.
 *
 * The REST routes are wrapped in Heorth's own auth and write gates, deriving
 * the actor from the authenticated caller. No role check belongs here:
 * heorth-mcp's `McpPrincipal.userId` is only a key fingerprint.
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

/**
 * Render a boolean query flag the way Heorth reads it: the query validators
 * spell these as `z.enum(['true','false'])`, never a coerced boolean, because
 * `Boolean('false')` is true.
 */
function flag(value: boolean | undefined): 'true' | 'false' | undefined {
  return value === undefined ? undefined : value ? 'true' : 'false';
}

/** Mirrors Heorth's `ROUTINE_MODES` (src/modules/weorc/schema.ts). */
const routineModes = ['from_completion', 'fixed'] as const;

/** Mirrors Heorth's `INTERVAL_UNITS` (src/modules/weorc/schema.ts). */
const intervalUnits = ['day', 'week', 'month'] as const;

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Two things an agent must not infer. Weorc holds the DEFINITION and the
 *  history; the thing a member ticks off day to day is a Task in the external
 *  task service (ADR 0001), so this is not where you look for today's list. And
 *  an occurrence that is not projected is NORMAL - a household with no task
 *  provider still has chores. */
const NOT_A_TASK_LIST_NOTE =
  'Weorc holds recurring definitions and their history. The day-to-day list a member works from is Tasks, not this.';

const UNPROJECTED_NOTE =
  'An occurrence with no linked task is normal: the household may have no task provider connected. It is still due and still completable here.';

function projectionOutcome(data: unknown): string {
  if (!data || typeof data !== 'object' || !('projection' in data)) {
    return 'Completion was recorded locally; no projection result was returned.';
  }
  const projection = (data as { projection?: { ok?: boolean; reason?: string } }).projection;
  if (projection?.ok) return 'Completion was recorded locally and task write-back succeeded.';
  if (projection?.reason) {
    return `Completion was recorded locally, but task write-back failed: ${projection.reason}.`;
  }
  return `Completion was recorded locally. ${UNPROJECTED_NOTE}`;
}

export const weorcTools: McpTool[] = [
  {
    name: 'weorc.list_routines',
    description: `List recurring chore definitions, with next due/open occurrence context. ${NOT_A_TASK_LIST_NOTE}`,
    inputSchema: {
      active: z.boolean().optional(),
      anchorAssetId: z.string().uuid().optional(),
      anchorPlaceId: z.string().uuid().optional(),
      ownerMemberId: z.string().uuid().optional(),
      limit: z.number().int().positive().max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async handler(ctx, input) {
      const i = input as {
        active?: boolean;
        anchorAssetId?: string;
        anchorPlaceId?: string;
        ownerMemberId?: string;
        limit?: number;
        offset?: number;
      };
      const res = await heorth(ctx.upstreams).get<Envelope<unknown[]>>('/weorc/routines', {
        active: flag(i.active),
        anchor_asset_id: i.anchorAssetId,
        anchor_place_id: i.anchorPlaceId,
        owner_member_id: i.ownerMemberId,
        limit: i.limit,
        offset: i.offset,
      });
      return result({
        rows: res.data,
        total: res.meta?.['total'],
        limit: res.meta?.['limit'],
        offset: res.meta?.['offset'],
      });
    },
  },
  {
    name: 'weorc.record_routine',
    description:
      'Create a recurring chore definition. The upstream route validates anchors and write permission; ANCHOR_CONFLICT, ASSET_NOT_FOUND and PLACE_NOT_FOUND pass through unchanged.',
    inputSchema: {
      name: z.string().min(1),
      notes: z.string().optional().nullable(),
      mode: z.enum(routineModes),
      intervalUnit: z.enum(intervalUnits),
      intervalCount: z.number().int().positive(),
      anchorDate: dateOnly,
      leadDays: z.number().int().min(0).optional(),
      ownerMemberId: z.string().uuid().optional().nullable(),
      anchorAssetId: z.string().uuid().optional().nullable(),
      anchorPlaceId: z.string().uuid().optional().nullable(),
    },
    async handler(ctx, input) {
      const res = await heorth(ctx.upstreams).post<Envelope<unknown>>('/weorc/routines', input);
      return result(res.data);
    },
  },
  {
    name: 'weorc.update_routine',
    description:
      'Update a recurring chore definition. The id goes in the path only. Existing projected open occurrences may be left unchanged by Heorth and reported as openOccurrenceUnchanged.',
    inputSchema: {
      id: z.string().uuid(),
      name: z.string().min(1).optional(),
      notes: z.string().optional().nullable(),
      mode: z.enum(routineModes).optional(),
      intervalUnit: z.enum(intervalUnits).optional(),
      intervalCount: z.number().int().positive().optional(),
      anchorDate: dateOnly.optional(),
      leadDays: z.number().int().min(0).optional(),
      ownerMemberId: z.string().uuid().optional().nullable(),
      anchorAssetId: z.string().uuid().optional().nullable(),
      anchorPlaceId: z.string().uuid().optional().nullable(),
      active: z.boolean().optional(),
    },
    async handler(ctx, input) {
      const { id, ...rest } = input as { id: string };
      const res = await heorth(ctx.upstreams).patch<Envelope<unknown>>(
        `/weorc/routines/${encodeURIComponent(id)}`,
        rest
      );
      return result(res.data);
    },
  },
  {
    name: 'weorc.delete_routine',
    description:
      'Delete a routine definition that has no completed/skipped history. Routines with history are refused upstream with ROUTINE_HAS_HISTORY; deactivate them instead.',
    inputSchema: { id: z.string().uuid() },
    async handler(ctx, input) {
      const { id } = input as { id: string };
      const res = await heorth(ctx.upstreams).delete<Envelope<unknown>>(
        `/weorc/routines/${encodeURIComponent(id)}`
      );
      return result(res.data);
    },
  },
  {
    name: 'weorc.list_due',
    description: `List due Weorc occurrences, not the member's task list. ${NOT_A_TASK_LIST_NOTE} ${UNPROJECTED_NOTE}`,
    inputSchema: {
      routineId: z.string().uuid().optional(),
      dueTo: dateOnly.optional(),
    },
    async handler(ctx, input) {
      const i = input as { routineId?: string; dueTo?: string };
      const res = await heorth(ctx.upstreams).get<Envelope<unknown[]>>('/weorc/occurrences', {
        status: 'due',
        routine_id: i.routineId,
        due_to: i.dueTo,
      });
      return result({
        rows: res.data,
        total: res.meta?.['total'],
      });
    },
  },
  {
    name: 'weorc.complete_occurrence',
    description:
      `Complete a due Weorc occurrence and advance the routine. ${UNPROJECTED_NOTE} The result includes projectionOutcome so callers can tell whether the local completion was written back to the task service.`,
    inputSchema: {
      id: z.string().uuid(),
      completedAt: z.string().datetime().optional(),
      note: z.string().optional().nullable(),
    },
    async handler(ctx, input) {
      const { id, ...rest } = input as { id: string };
      const res = await heorth(ctx.upstreams).post<Envelope<unknown>>(
        `/weorc/occurrences/${encodeURIComponent(id)}/complete`,
        rest
      );
      return result({ ...(res.data as Record<string, unknown>), projectionOutcome: projectionOutcome(res.data) });
    },
  },
  {
    name: 'weorc.skip_occurrence',
    description: 'Skip a due Weorc occurrence and advance the routine. ALREADY_TERMINAL and NOT_FOUND pass through unchanged.',
    inputSchema: {
      id: z.string().uuid(),
      note: z.string().optional().nullable(),
    },
    async handler(ctx, input) {
      const { id, ...rest } = input as { id: string };
      const res = await heorth(ctx.upstreams).post<Envelope<unknown>>(
        `/weorc/occurrences/${encodeURIComponent(id)}/skip`,
        rest
      );
      return result(res.data);
    },
  },
];
