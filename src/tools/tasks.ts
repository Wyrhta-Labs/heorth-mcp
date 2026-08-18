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

/** Mirrors Heorth's `TASK_STATUSES`; the values are part of the tool schema. */
const TASK_STATUSES = ['open', 'completed'] as const;

export const tasksTools: McpTool[] = [
  {
    name: 'tasks.list',
    description: 'List household tasks mirrored from Microsoft To Do, with optional filters.',
    inputSchema: {
      status: z.enum(TASK_STATUSES).optional(),
      member_id: z.string().uuid().optional(),
      list_id: z.string().optional(),
      due_from: z.string().datetime().optional(),
      due_to: z.string().datetime().optional(),
    },
    async handler(ctx, input) {
      const i = input as {
        status?: (typeof TASK_STATUSES)[number];
        member_id?: string;
        list_id?: string;
        due_from?: string;
        due_to?: string;
      };
      // The REST query keys are snake_case, same as the tool's own parameters.
      const res = await heorth(ctx).get<Envelope<unknown[]>>('/tasks', {
        status: i.status,
        member_id: i.member_id,
        list_id: i.list_id,
        due_from: i.due_from,
        due_to: i.due_to,
      });
      return result({ tasks: res.data });
    },
  },
  {
    name: 'tasks.complete',
    description: 'Complete or uncomplete a task (writes back to Microsoft To Do).',
    inputSchema: {
      id: z.string().uuid(),
      completed: z.boolean().optional().default(true),
    },
    async handler(ctx, input) {
      const i = input as { id: string; completed?: boolean };
      // The REST body schema has no default — always send `completed` explicitly.
      const res = await heorth(ctx).post<Envelope<unknown>>(`/tasks/${i.id}/complete`, {
        completed: i.completed ?? true,
      });
      return result(res.data);
    },
  },
  {
    name: 'tasks.create',
    description: 'Create a task in the shared household To Do list.',
    inputSchema: {
      title: z.string().min(1),
      notes: z.string().nullish(),
      dueAt: z.string().datetime().nullish(),
    },
    async handler(ctx, input) {
      const i = input as { title: string; notes?: string | null; dueAt?: string | null };
      // The author is derived from the authenticated caller upstream.
      const res = await heorth(ctx).post<Envelope<unknown>>('/tasks', {
        title: i.title,
        notes: i.notes ?? null,
        dueAt: i.dueAt ?? null,
      });
      return result(res.data);
    },
  },
];
