import { z } from 'zod';
import type { McpTool, McpToolContext, McpToolResult } from '../mcp/types.js';
import type { KithClient } from '../upstream/kith.js';

/**
 * The 13 `kith.*` tools, ported from KithLedger's `src/mcp/tools/*.ts` onto its
 * REST API (task B11, ADR 0008).
 *
 * **Names, descriptions and input schemas are verbatim** — they are a frozen
 * public contract with MCP clients. What changed is only the other side: a
 * handler no longer calls a service with a `memberScope`, it makes one HTTP
 * call and reshapes the `{ data, meta }` envelope back into the shape the old
 * tool returned.
 *
 * **No access control lives here.** KithLedger enforces ADR 0004 itself, on the
 * member token this client presents (ADR 0009 — see `src/upstream/exchange.ts`).
 * An item outside the caller's scope is simply absent, and `NOT_FOUND` for an
 * invisible item is the upstream's answer, not ours.
 *
 * Wire-format traps this file exists to get right, per `docs/spec/tool-surface.md`:
 * KithLedger's **query** parameters are snake_case, its **bodies** camelCase —
 * except `snooze_until`, the one snake_case body field in either upstream — and
 * `kith.update_person` must not forward `id` in the body.
 */

/** Wrap any JSON-serialisable value as an MCP text tool-result. */
function result(data: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function kith(ctx: McpToolContext): KithClient {
  const client = ctx.upstreams.kith;
  if (!client) throw new Error('KITH_NOT_CONFIGURED');
  return client;
}

/** KithLedger's `{ data, meta }` response envelope (`@wyrhta/core/http`). */
interface Envelope<T, M = unknown> {
  data: T;
  meta?: M;
}

interface ListMeta {
  total?: number;
  limit?: number;
  offset?: number;
}

/**
 * The list shape every `kith.list_*` tool returned before the port: rows under
 * `items`, with the paging counters alongside rather than under `meta`.
 */
function listResult(res: Envelope<unknown[], ListMeta>): McpToolResult {
  return result({
    items: res.data,
    total: res.meta?.total,
    limit: res.meta?.limit,
    offset: res.meta?.offset,
  });
}

/**
 * Take exactly the keys of `shape` off the validated input — the request body,
 * derived from the schema that defines it. `kith.update_person` gets its "no
 * `id` in the body" property from this and not from a hand-maintained list.
 */
function bodyOf(shape: z.ZodRawShape, input: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    if (input[key] !== undefined) body[key] = input[key];
  }
  return body;
}

/**
 * ADR 0004 §1/§4's two governance fields, on every create schema — verbatim
 * from KithLedger's `src/validators/visibility.ts`. Omitting `visibility` on
 * create leaves the default (`household`) to the upstream column, so the
 * default lives in exactly one place and it is not this one.
 */
const visibilityFields = {
  visibility: z.enum(['private', 'shared', 'household']).optional(),
  sharedWith: z.array(z.string().uuid()).optional(),
};

// ── people ──────────────────────────────────────────────────────────────────

const createPersonShape = {
  name: z.string().min(1),
  email: z.string().email().max(254).optional().nullable(),
  phone: z.string().optional().nullable(),
  birthday: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(
      (val) => {
        const date = new Date(val + 'T00:00:00Z');
        return !isNaN(date.getTime()) && date <= new Date();
      },
      { message: 'Birthday must be a valid date and not in the future' }
    )
    .optional()
    .nullable(),
  tags: z.array(z.string()).optional().default([]),
  notes: z.string().optional().nullable(),
  avatarUrl: z
    .string()
    .url()
    .refine(
      (val) => {
        try {
          const { protocol } = new URL(val);
          return protocol === 'http:' || protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'Avatar URL must use http or https protocol' }
    )
    .optional()
    .nullable(),
  ...visibilityFields,
} satisfies z.ZodRawShape;

/** `createPersonSchema.partial()` upstream — the PATCH body, `id` excluded. */
const updatePersonShape = z.object(createPersonShape).partial().shape;

const listPeopleQueryShape = {
  q: z.string().optional(),
  tags: z.string().optional(), // comma-separated
  birthday_month: z.coerce.number().int().min(1).max(12).optional(),
  sort: z.enum(['name', 'created_at', 'updated_at', 'birthday']).optional().default('name'),
  order: z.enum(['asc', 'desc']).optional().default('asc'),
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
} satisfies z.ZodRawShape;

const peopleTools: McpTool[] = [
  {
    name: 'kith.list_people',
    description: 'List people, optionally filtered by search, tags, or birthday month.',
    inputSchema: listPeopleQueryShape,
    async handler(ctx, input) {
      const i = input as {
        q?: string;
        tags?: string;
        birthday_month?: number;
        sort?: string;
        order?: string;
        limit?: number;
        offset?: number;
      };
      const res = await kith(ctx).get<Envelope<unknown[], ListMeta>>('/people', {
        q: i.q,
        tags: i.tags,
        birthday_month: i.birthday_month,
        sort: i.sort,
        order: i.order,
        limit: i.limit,
        offset: i.offset,
      });
      return listResult(res);
    },
  },
  {
    name: 'kith.get_person',
    description: 'Get a single person by id.',
    inputSchema: { id: z.string().uuid() },
    async handler(ctx, input) {
      const { id } = input as { id: string };
      const res = await kith(ctx).get<Envelope<unknown>>(`/people/${id}`);
      return result(res.data);
    },
  },
  {
    name: 'kith.create_person',
    description: 'Create a new person.',
    inputSchema: createPersonShape,
    async handler(ctx, input) {
      const res = await kith(ctx).post<Envelope<unknown>>(
        '/people',
        bodyOf(createPersonShape, input)
      );
      return result(res.data);
    },
  },
  {
    name: 'kith.update_person',
    description: 'Update an existing person.',
    inputSchema: { id: z.string().uuid(), ...updatePersonShape },
    async handler(ctx, input) {
      const { id } = input as { id: string };
      // `id` belongs in the path only. Upstream's Zod stripped it from the body;
      // this repo must not send it at all — `bodyOf` takes only the PATCH shape's
      // own keys, and `id` is not one of them.
      const res = await kith(ctx).patch<Envelope<unknown>>(
        `/people/${id}`,
        bodyOf(updatePersonShape, input)
      );
      return result(res.data);
    },
  },
  {
    name: 'kith.get_person_graph',
    description: 'Get the relationship graph around a person.',
    inputSchema: {
      id: z.string().uuid(),
      depth: z.coerce.number().int().min(1).max(3).optional().default(1),
    },
    async handler(ctx, input) {
      const i = input as { id: string; depth?: number };
      // The route's meta echoes `root_person_id`/`depth`, both of which the
      // caller supplied; the tool returned the graph alone, so it still does.
      const res = await kith(ctx).get<Envelope<unknown>>(`/people/${i.id}/graph`, {
        depth: i.depth ?? 1,
      });
      return result(res.data);
    },
  },
];

// ── interactions ────────────────────────────────────────────────────────────

const INTERACTION_TYPES = ['meeting', 'call', 'message', 'email', 'other'] as const;
const CHANNELS = ['in-person', 'phone', 'sms', 'email', 'video', 'social'] as const;
const SENTIMENTS = ['positive', 'neutral', 'negative'] as const;

const createInteractionShape = {
  personId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  type: z.enum(INTERACTION_TYPES),
  channel: z.enum(CHANNELS).optional().nullable(),
  notes: z.string().optional().nullable(),
  sentiment: z.enum(SENTIMENTS).optional().nullable(),
  ...visibilityFields,
} satisfies z.ZodRawShape;

const listInteractionsQueryShape = {
  person_id: z.string().uuid().optional(),
  type: z.enum(INTERACTION_TYPES).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
} satisfies z.ZodRawShape;

const interactionTools: McpTool[] = [
  {
    name: 'kith.list_interactions',
    description: 'List interactions, optionally filtered by person, type, or date range.',
    inputSchema: listInteractionsQueryShape,
    async handler(ctx, input) {
      const i = input as {
        person_id?: string;
        type?: string;
        from?: string;
        to?: string;
        limit?: number;
        offset?: number;
      };
      // Snake_case in the query, camelCase `personId` in the create body below.
      const res = await kith(ctx).get<Envelope<unknown[], ListMeta>>('/interactions', {
        person_id: i.person_id,
        type: i.type,
        from: i.from,
        to: i.to,
        limit: i.limit,
        offset: i.offset,
      });
      return listResult(res);
    },
  },
  {
    name: 'kith.log_interaction',
    description: 'Log a new interaction with a person.',
    inputSchema: createInteractionShape,
    async handler(ctx, input) {
      const res = await kith(ctx).post<Envelope<unknown>>(
        '/interactions',
        bodyOf(createInteractionShape, input)
      );
      return result(res.data);
    },
  },
];

// ── relationships ───────────────────────────────────────────────────────────

const RELATIONSHIP_TYPES = ['friend', 'family', 'colleague', 'acquaintance', 'other'] as const;

const createRelationshipShape = {
  fromPersonId: z.string().uuid(),
  toPersonId: z.string().uuid(),
  type: z.enum(RELATIONSHIP_TYPES),
  label: z.string().optional().nullable(),
  isMutual: z.boolean().optional().default(true),
  notes: z.string().optional().nullable(),
  ...visibilityFields,
} satisfies z.ZodRawShape;

const listRelationshipsQueryShape = {
  person_id: z.string().uuid().optional(),
  type: z.enum(RELATIONSHIP_TYPES).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
} satisfies z.ZodRawShape;

const relationshipTools: McpTool[] = [
  {
    name: 'kith.list_relationships',
    description: 'List relationships, optionally filtered by person or type.',
    inputSchema: listRelationshipsQueryShape,
    async handler(ctx, input) {
      const i = input as { person_id?: string; type?: string; limit?: number; offset?: number };
      const res = await kith(ctx).get<Envelope<unknown[], ListMeta>>('/relationships', {
        person_id: i.person_id,
        type: i.type,
        limit: i.limit,
        offset: i.offset,
      });
      return listResult(res);
    },
  },
  {
    name: 'kith.create_relationship',
    description: 'Create a relationship between two people.',
    // Upstream wraps this schema in `.refine()` (from and to must differ) and
    // the old tool reached past the ZodEffects for the raw shape. The route
    // enforces the refine itself, so it is not duplicated here — a
    // self-relationship comes back as the route's own VALIDATION_ERROR.
    inputSchema: createRelationshipShape,
    async handler(ctx, input) {
      const res = await kith(ctx).post<Envelope<unknown>>(
        '/relationships',
        bodyOf(createRelationshipShape, input)
      );
      return result(res.data);
    },
  },
];

// ── reminders ───────────────────────────────────────────────────────────────

const REMINDER_STATUSES = ['pending', 'done', 'snoozed', 'dismissed'] as const;
const REMINDER_KINDS = ['generic', 'birthday'] as const;

const createReminderShape = {
  personId: z.string().uuid(),
  dueAt: z.string().datetime(),
  title: z.string().min(1),
  notes: z.string().optional().nullable(),
  recurrence: z.string().optional().nullable(), // ISO 8601 duration
  kind: z.enum(REMINDER_KINDS).optional().default('generic'),
  /** Days before the birthday; only meaningful when kind='birthday'. */
  leadDays: z.number().int().min(0).max(365).optional().nullable(),
  ...visibilityFields,
} satisfies z.ZodRawShape;

const listRemindersQueryShape = {
  person_id: z.string().uuid().optional(),
  status: z.enum(REMINDER_STATUSES).optional(),
  kind: z.enum(REMINDER_KINDS).optional(),
  /**
   * Comma-separated statuses, for callers that need more than one. Takes
   * precedence over `status` when both are supplied.
   */
  statuses: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined))
    .refine((v) => !v || v.every((s) => (REMINDER_STATUSES as readonly string[]).includes(s)), {
      message: `statuses must be a comma-separated subset of: ${REMINDER_STATUSES.join(', ')}`,
    }),
  due_before: z.string().datetime().optional(),
  /** A string enum upstream, not a boolean — `"true"` / `"false"`. */
  overdue: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
} satisfies z.ZodRawShape;

const snoozeReminderShape = {
  snooze_until: z.string().datetime(),
} satisfies z.ZodRawShape;

const reminderTools: McpTool[] = [
  {
    name: 'kith.list_reminders',
    description: 'List reminders, optionally filtered by person, status, or due date.',
    inputSchema: listRemindersQueryShape,
    async handler(ctx, input) {
      const i = input as {
        person_id?: string;
        status?: string;
        kind?: string;
        statuses?: string[] | string;
        due_before?: string;
        overdue?: string;
        limit?: number;
        offset?: number;
      };
      // The schema's transform splits `statuses` into an array; the REST query
      // wants the comma-separated string back.
      const statuses = Array.isArray(i.statuses) ? i.statuses.join(',') : i.statuses;
      const res = await kith(ctx).get<Envelope<unknown[], ListMeta>>('/reminders', {
        person_id: i.person_id,
        status: i.status,
        kind: i.kind,
        statuses,
        due_before: i.due_before,
        overdue: i.overdue,
        limit: i.limit,
        offset: i.offset,
      });
      return listResult(res);
    },
  },
  {
    name: 'kith.create_reminder',
    description: 'Create a new reminder for a person.',
    inputSchema: createReminderShape,
    async handler(ctx, input) {
      const res = await kith(ctx).post<Envelope<unknown>>(
        '/reminders',
        bodyOf(createReminderShape, input)
      );
      return result(res.data);
    },
  },
  {
    name: 'kith.complete_reminder',
    description: 'Mark a reminder as done, generating the next occurrence if recurring.',
    inputSchema: { id: z.string().uuid() },
    async handler(ctx, input) {
      const { id } = input as { id: string };
      const res = await kith(ctx).post<Envelope<unknown>>(`/reminders/${id}/complete`);
      return result(res.data);
    },
  },
  {
    name: 'kith.snooze_reminder',
    description: 'Snooze a reminder until a later date.',
    inputSchema: { id: z.string().uuid(), ...snoozeReminderShape },
    async handler(ctx, input) {
      const i = input as { id: string; snooze_until: string };
      // `snooze_until` is snake_case IN THE BODY — the one such field in either
      // upstream. Sending `snoozeUntil` here would be a 400, not a silent no-op.
      const res = await kith(ctx).post<Envelope<unknown>>(`/reminders/${i.id}/snooze`, {
        snooze_until: i.snooze_until,
      });
      return result(res.data);
    },
  },
];

/** The 13 `kith.*` tools, in the order KithLedger's registry assembled them. */
export const kithTools: McpTool[] = [
  ...peopleTools,
  ...interactionTools,
  ...relationshipTools,
  ...reminderTools,
];
