import { z } from 'zod';
import type { HeorthClient } from '../upstream/heorth.js';
import type { McpTool, McpToolResult } from '../mcp/types.js';

/**
 * `library.*` — ported from Heorth's `src/modules/library/mcp.ts`, mounted at
 * `/api/v1/library`.
 *
 * Names, descriptions and input schemas are verbatim; the handlers call REST.
 * Note the query keys are **camelCase** here (`mediaType`, `memberId`) — the
 * library validator differs from calendar's and tasks' snake_case on purpose
 * (docs/spec/tool-surface.md).
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

/** Mirrors Heorth's `src/modules/library/schema.ts` constants — inlined because
 *  heorth-mcp never imports Heorth code (CLAUDE.md, "The one rule"). */
const PROVIDERS = ['trakt', 'librarything'] as const;
const MEDIA_TYPES = ['book', 'ebook', 'movie', 'series'] as const;
const ITEM_STATUSES = ['unread', 'reading', 'read', 'watching', 'watched'] as const;
const STANDARD_LISTS = ['later', 'favorites'] as const;

export const libraryTools: McpTool[] = [
  {
    name: 'library.list_items',
    description: 'List library items across the household, filtered by media type, member, provider, status, or standard list (later/favorites).',
    inputSchema: {
      mediaType: z.enum(MEDIA_TYPES).optional(),
      memberId: z.string().uuid().optional(),
      provider: z.enum(PROVIDERS).optional(),
      status: z.enum(ITEM_STATUSES).optional(),
      list: z.enum(STANDARD_LISTS).optional(),
      tag: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    async handler(ctx, input) {
      const i = input as {
        mediaType?: string;
        memberId?: string;
        provider?: string;
        status?: string;
        list?: string;
        tag?: string;
        limit?: number;
      };
      // camelCase query keys — the library validator spells them this way.
      const res = await heorth(ctx.upstreams).get<Envelope<unknown[]>>('/library/items', {
        mediaType: i.mediaType,
        memberId: i.memberId,
        provider: i.provider,
        status: i.status,
        list: i.list,
        tag: i.tag,
        limit: i.limit,
      });
      return result({ items: res.data, total: res.meta?.['total'] });
    },
  },
  {
    name: 'library.search',
    description: 'Full-text search library items by title or creator.',
    inputSchema: { q: z.string().min(1) },
    async handler(ctx, input) {
      // `q` is required: the endpoint 400s (VALIDATION_ERROR) without it.
      const res = await heorth(ctx.upstreams).get<Envelope<unknown[]>>('/library/items/search', {
        q: (input as { q: string }).q,
      });
      return result({ items: res.data });
    },
  },
  {
    name: 'library.get_item',
    description: 'Get one library item by id, including owning member and source link.',
    inputSchema: { id: z.string().uuid() },
    async handler(ctx, input) {
      // A missing item is a 404 `NOT_FOUND` upstream, which passes through as
      // the tool error text — the embedded tool threw 'Item not found'.
      const res = await heorth(ctx.upstreams).get<Envelope<unknown>>(
        `/library/items/${encodeURIComponent((input as { id: string }).id)}`
      );
      return result(res.data);
    },
  },
  {
    name: 'library.list_connections',
    description: 'List connected library accounts and their sync status (never returns credentials).',
    inputSchema: {},
    async handler(ctx) {
      const res = await heorth(ctx.upstreams).get<Envelope<unknown[]>>('/library/connections');
      return result({ connections: res.data });
    },
  },
  {
    name: 'library.sync_connection',
    description: 'Trigger a manual sync of one connected account.',
    inputSchema: { id: z.string().uuid() },
    async handler(ctx, input) {
      // A provider failure is a 502 `SYNC_FAILED` — a domain code, so it reaches
      // the client unchanged rather than collapsing into a generic error.
      const res = await heorth(ctx.upstreams).post<Envelope<unknown>>(
        `/library/connections/${encodeURIComponent((input as { id: string }).id)}/sync`
      );
      return result(res.data);
    },
  },
];
