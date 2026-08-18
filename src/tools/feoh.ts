import { z } from 'zod';
import type { HeorthClient } from '../upstream/heorth.js';
import type { McpTool, McpToolContext, McpToolResult } from '../mcp/types.js';

/**
 * `feoh.*` — the household's finances, as a REST client over Heorth's
 * `/api/v1/feoh` router.
 *
 * Two things about the port are deliberate and must stay that way:
 *
 * 1. **No local role gate.** The embedded version of these tools carried an
 *    `assertCanWrite` (`role !== 'admin' && role !== 'adult'`) and a
 *    maintenance-admin quarantine, and derived the actor from
 *    `ctx.principal.userId`. All of it is dropped here. Heorth's
 *    `src/modules/feoh/routes.ts` wraps *every* finance mutation in
 *    `requireRole('admin','adult')` plus the same quarantine, and takes the
 *    actor from `c.get('auth').userId` — so no guard is lost. Re-adding one
 *    here would be worse than redundant: `McpPrincipal.userId` is a SHA-256
 *    fingerprint of the presented key, not a member id, and using it as an
 *    actor would write wrong attribution into finance records (CLAUDE.md,
 *    "Auth").
 * 2. **No domain logic.** Handlers translate input to one REST call and reshape
 *    the `{ data, meta }` envelope back into the shape the tool has always
 *    returned. Upstream error codes travel out untouched — the scaffold renders
 *    an `UpstreamError`'s message as the tool error text.
 */

/** The `{ data, meta }` envelope every JSON route answers with. */
interface Envelope<T, M = unknown> {
  data: T;
  meta?: M;
}

/** Wrap any JSON-serialisable value as an MCP text tool-result. */
function result(data: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/**
 * The caller-bound Heorth client for this request. Absent only if the tool was
 * registered without its upstream configured, which `buildRegistry` prevents.
 */
function heorth(ctx: McpToolContext): HeorthClient {
  const client = ctx.upstreams.heorth;
  if (!client) throw new Error('UPSTREAM_NOT_CONFIGURED');
  return client;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const feohTools: McpTool[] = [
  {
    name: 'feoh.list_envelopes',
    description: 'List budget envelopes with their monthly budgets.',
    inputSchema: {},
    async handler(ctx) {
      const res = await heorth(ctx).get<Envelope<unknown[]>>('/feoh/envelopes');
      return result({ envelopes: res.data });
    },
  },
  {
    name: 'feoh.record_transaction',
    description: 'Record a balanced double-entry transaction (postings must balance).',
    inputSchema: {
      date: z.string().regex(DATE),
      payee: z.string().min(1),
      memo: z.string().nullish(),
      amount: z.number(),
      postings: z
        .array(
          z.object({
            accountId: z.string().uuid().nullish(),
            envelopeId: z.string().uuid().nullish(),
            debit: z.number().nonnegative().default(0),
            credit: z.number().nonnegative().default(0),
          })
        )
        .min(2),
      splits: z.array(z.object({ memberId: z.string().uuid(), share: z.number() })).default([]),
    },
    // `createdBy` is *not* sent: Heorth derives the acting member from the
    // forwarded key (routes.ts:97). See the module note above.
    async handler(ctx, input) {
      const res = await heorth(ctx).post<Envelope<unknown>>('/feoh/transactions', input);
      return result(res.data);
    },
  },
  {
    name: 'feoh.get_month_summary',
    description: 'Return spend per envelope vs budget for a month (YYYY-MM).',
    inputSchema: { month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) },
    async handler(ctx, input) {
      const { month } = input as { month: string };
      const res = await heorth(ctx).get<Envelope<unknown>>('/feoh/summary', { month });
      return result(res.data);
    },
  },
  {
    name: 'feoh.list_recurring_bills',
    description: 'List recurring bills with cadence and next due date.',
    inputSchema: {},
    async handler(ctx) {
      const res = await heorth(ctx).get<Envelope<unknown[]>>('/feoh/bills');
      return result({ bills: res.data });
    },
  },
  {
    name: 'feoh.import_csv',
    description: 'Import transactions from CSV text (date,payee,memo,amount,envelope,account).',
    inputSchema: { csv: z.string().min(1) },
    // `POST /feoh/import` reads `c.req.text()`, not `c.req.json()`: the CSV is
    // the whole request body, sent as `text/csv` — hence `postText`.
    async handler(ctx, input) {
      const { csv } = input as { csv: string };
      const res = await heorth(ctx).postText<Envelope<unknown>>(
        '/feoh/import',
        csv,
        'text/csv; charset=utf-8'
      );
      return result(res.data);
    },
  },
  {
    name: 'feoh.export_ledger',
    description: 'Export all transactions as a readable plaintext ledger.',
    inputSchema: {},
    // `format=ledger` is not optional. The route defaults to `format=csv`,
    // which answers 200 with a *transaction CSV* — omitting it would return
    // silently wrong data rather than an error.
    async handler(ctx) {
      const ledger = await heorth(ctx).getText('/feoh/export', { format: 'ledger' });
      return result({ ledger });
    },
  },
  {
    name: 'feoh.list_occurrences',
    description:
      'List recurring-bill occurrences (planned/paid/overdue/skipped) in a date window. The "what is overdue" tool.',
    inputSchema: {
      from: z.string().regex(DATE).optional(),
      to: z.string().regex(DATE).optional(),
      billId: z.string().uuid().optional(),
      status: z.enum(['planned', 'paid', 'overdue', 'skipped', 'unknown']).optional(),
    },
    async handler(ctx, input) {
      const { from, to, billId, status } = input as {
        from?: string;
        to?: string;
        billId?: string;
        status?: string;
      };
      // Query keys are camelCase in feoh (`billId`) — see the spec's note on
      // Heorth's mixed conventions.
      const res = await heorth(ctx).get<Envelope<unknown[]>>('/feoh/occurrences', {
        from,
        to,
        billId,
        status,
      });
      return result({ occurrences: res.data });
    },
  },
  {
    name: 'feoh.link_occurrence',
    description: 'Mark an occurrence paid by linking the settling transaction.',
    inputSchema: {
      billId: z.string().uuid(),
      dueDate: z.string().regex(DATE),
      transactionId: z.string().uuid(),
    },
    async handler(ctx, input) {
      const res = await heorth(ctx).post<Envelope<unknown>>('/feoh/occurrences/link', input);
      return result(res.data);
    },
  },
  {
    name: 'feoh.skip_occurrence',
    description: 'Skip one occurrence of a recurring bill.',
    inputSchema: {
      billId: z.string().uuid(),
      dueDate: z.string().regex(DATE),
    },
    async handler(ctx, input) {
      const res = await heorth(ctx).post<Envelope<unknown>>('/feoh/occurrences/skip', input);
      return result(res.data);
    },
  },
  {
    name: 'feoh.get_item_costs',
    description:
      'Return the total-cost-of-ownership breakdown (capital, tier-2 costs, recurring, proceeds) for an inventory item.',
    inputSchema: { itemId: z.string().uuid() },
    async handler(ctx, input) {
      const { itemId } = input as { itemId: string };
      const res = await heorth(ctx).get<Envelope<unknown>>(
        `/feoh/item-costs/${encodeURIComponent(itemId)}`
      );
      return result(res.data);
    },
  },
  {
    name: 'feoh.account_ledger',
    description:
      "Return an account's ledger entries with a running balance, plus opening/end balance for the window (read-only).",
    inputSchema: {
      accountId: z.string().uuid(),
      from: z.string().regex(DATE).optional(),
      to: z.string().regex(DATE).optional(),
    },
    // The route splits the ledger across the envelope — `ok(c, ledger.entries,
    // ledger.meta)` — while the tool has always returned the single object
    // `{ entries, meta }`. Recombine, do not pass the envelope through.
    async handler(ctx, input) {
      const { accountId, from, to } = input as { accountId: string; from?: string; to?: string };
      const res = await heorth(ctx).get<Envelope<unknown[], Record<string, unknown>>>(
        `/feoh/accounts/${encodeURIComponent(accountId)}/ledger`,
        { from, to }
      );
      return result({ entries: res.data, meta: res.meta });
    },
  },
  {
    name: 'feoh.link_item_cost',
    description:
      'Link a transaction to an inventory item as a cost (purchase, disposal, repair, maintenance, accessory).',
    inputSchema: {
      transactionId: z.string().uuid(),
      itemId: z.string().uuid(),
      kind: z.enum(['purchase', 'disposal', 'repair', 'maintenance', 'accessory']),
    },
    async handler(ctx, input) {
      const res = await heorth(ctx).post<Envelope<unknown>>('/feoh/item-costs', input);
      return result(res.data);
    },
  },
];
