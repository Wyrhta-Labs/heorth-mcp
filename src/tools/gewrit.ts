import { z } from 'zod';
import type { HeorthClient } from '../upstream/heorth.js';
import type { McpTool, McpToolResult } from '../mcp/types.js';

/**
 * `gewrit.*` — Heorth's Gewrit module (ADR 0017), mounted at `/api/v1/gewrit`.
 * Read-only in v1. There is no preview tool: an agent has no use for PDF bytes,
 * and each link already carries `externalUrl` for a human to open.
 *
 * Search is admin/adult upstream (`requireRole`); no local role check, for the
 * reason given in ethel.ts. Gewrit is optional per deployment: with it off,
 * Heorth answers 404 NOT_FOUND and the tool surfaces that error.
 */

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

export const gewritTools: McpTool[] = [
  {
    name: 'gewrit.list_documents',
    description:
      'List the Paperless documents linked to one household asset or place — manuals, warranties, invoices, contracts, certificates — with role, note, document date and a link to open each in Paperless. Give exactly one of assetId or placeId. `stale: true` means Paperless was unreachable and the details are the last known ones; `staleReason` says why — `auth` for a rejected credential, `unavailable` for any other outage, `null` when not stale.',
    inputSchema: {
      assetId: z.string().uuid().optional().describe('An Ethel asset id.'),
      placeId: z.string().uuid().optional().describe('An Ethel place id.'),
    },
    async handler(ctx, input) {
      const i = input as { assetId?: string; placeId?: string };
      if ((i.assetId === undefined) === (i.placeId === undefined)) {
        throw new Error('Give exactly one of assetId or placeId');
      }
      const path = i.assetId !== undefined
        ? `/gewrit/assets/${i.assetId}/documents`
        : `/gewrit/places/${i.placeId}/documents`;
      const res = await heorth(ctx.upstreams).get<Envelope<unknown[]>>(path);
      const staleReason = res.meta?.['staleReason'];
      return result({
        links: res.data,
        stale: res.meta?.['stale'] === true,
        staleReason: staleReason === 'auth' || staleReason === 'unavailable' ? staleReason : null,
      });
    },
  },
  {
    name: 'gewrit.search',
    description:
      "Search the household's Paperless documents by text. Returns up to 25 hits (externalId, title, type, correspondent, date), text only. Admins and adults only. Linking is done by a member in Heorth; use externalId to say which document.",
    inputSchema: {
      q: z.string().min(2).max(200).describe('Search text, 2 to 200 characters.'),
    },
    async handler(ctx, input) {
      const i = input as { q: string };
      const res = await heorth(ctx.upstreams).get<Envelope<unknown[]>>('/gewrit/documents/search', { q: i.q });
      return result(res.data);
    },
  },
];
