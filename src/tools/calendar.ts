import { z } from 'zod';
import type { McpTool, McpToolContext, McpToolResult } from '../mcp/types.js';
import type { HeorthClient } from '../upstream/heorth.js';

/** Wrap any JSON-serialisable value as an MCP text tool-result. */
function result(data: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function heorth(ctx: McpToolContext): HeorthClient {
  const client = ctx.upstreams.heorth;
  if (!client) throw new Error('HEORTH_NOT_CONFIGURED');
  return client;
}

/** Heorth's `{ data, meta }` response envelope (`@wyrhta/core/http`). */
interface Envelope<T> {
  data: T;
}

/** How far ahead `calendar.list_upcoming` looks. */
const UPCOMING_WINDOW_DAYS = 90;

const eventInput = {
  title: z.string().min(1),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  allDay: z.boolean().optional().default(false),
  location: z.string().nullish(),
  notes: z.string().nullish(),
  category: z.string().nullish(),
  color: z.string().nullish(),
  recurrence: z.string().nullish(),
  attendeeIds: z.array(z.string().uuid()).optional().default([]),
};

export const calendarTools: McpTool[] = [
  {
    name: 'calendar.list_events',
    description: 'List calendar events expanded across a date range (from/to ISO timestamps).',
    inputSchema: {
      from: z.string().datetime(),
      to: z.string().datetime(),
      member_id: z.string().uuid().optional(),
    },
    async handler(ctx, input) {
      const i = input as { from: string; to: string; member_id?: string };
      // Query keys are snake_case here, while event *bodies* are camelCase.
      const res = await heorth(ctx).get<Envelope<unknown[]>>('/events', {
        from: i.from,
        to: i.to,
        member_id: i.member_id,
      });
      return result({ events: res.data });
    },
  },
  {
    name: 'calendar.create_event',
    description: 'Create a calendar event, optionally recurring, with attendees.',
    inputSchema: eventInput,
    async handler(ctx, input) {
      // `createdBy` is derived from the authenticated caller upstream — never sent.
      const res = await heorth(ctx).post<Envelope<unknown>>('/events', input);
      return result(res.data);
    },
  },
  {
    name: 'calendar.update_event',
    description: 'Update fields of an existing event.',
    inputSchema: {
      id: z.string().uuid(),
      title: z.string().min(1).optional(),
      startAt: z.string().datetime().optional(),
      endAt: z.string().datetime().optional(),
      allDay: z.boolean().optional(),
      location: z.string().nullish(),
      notes: z.string().nullish(),
      category: z.string().nullish(),
      color: z.string().nullish(),
      recurrence: z.string().nullish(),
      attendeeIds: z.array(z.string().uuid()).optional(),
    },
    async handler(ctx, input) {
      const { id, ...rest } = input as { id: string } & Record<string, unknown>;
      // The route runs `assertCanMutate` itself (mirrored events read-only,
      // children only their own) — do not re-implement it here.
      const res = await heorth(ctx).patch<Envelope<unknown>>(`/events/${id}`, rest);
      return result(res.data);
    },
  },
  {
    name: 'calendar.move_event',
    description: 'Reschedule an event to a new start (and optional end) time.',
    inputSchema: {
      id: z.string().uuid(),
      startAt: z.string().datetime(),
      endAt: z.string().datetime().optional(),
    },
    async handler(ctx, input) {
      const i = input as { id: string; startAt: string; endAt?: string };
      const body: Record<string, unknown> = { startAt: i.startAt };
      if (i.endAt !== undefined) body['endAt'] = i.endAt;
      const res = await heorth(ctx).post<Envelope<unknown>>(`/events/${i.id}/move`, body);
      return result(res.data);
    },
  },
  {
    name: 'calendar.list_upcoming',
    description: 'List the next N upcoming event occurrences, optionally for one member.',
    inputSchema: {
      member_id: z.string().uuid().optional(),
      limit: z.number().int().positive().max(50).optional().default(10),
    },
    async handler(ctx, input) {
      const i = input as { member_id?: string; limit?: number };
      // The window is built into the *request* — arithmetic on the query, not
      // filtering of the answer, so nothing is compensated for here.
      const now = new Date();
      const to = new Date(now.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const res = await heorth(ctx).get<Envelope<unknown[]>>('/events', {
        from: now.toISOString(),
        to: to.toISOString(),
        limit: i.limit ?? 10,
        member_id: i.member_id,
      });
      return result({ events: res.data });
    },
  },
];
