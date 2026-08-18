import { describe, it, expect } from 'vitest';
import { feohTools } from '../src/tools/feoh.js';
import { HeorthClient } from '../src/upstream/heorth.js';
import type { McpTool, McpToolContext } from '../src/mcp/types.js';
import { createFakeUpstream } from './helpers/fake-upstream.js';

const CALLER = 'Bearer he_abc123';
/** What `McpPrincipal.userId` really is: a key fingerprint, never a member id. */
const KEY_FINGERPRINT = 'a'.repeat(64);

function tool(name: string): McpTool {
  const found = feohTools.find((t) => t.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
}

function contextFor(
  fake: ReturnType<typeof createFakeUpstream>,
  role?: 'admin' | 'adult' | 'child'
): McpToolContext {
  return {
    principal: { userId: KEY_FINGERPRINT, ...(role ? { role } : {}) },
    requestId: 'req-1',
    upstreams: {
      heorth: new HeorthClient({
        baseUrl: 'http://heorth.test',
        authorization: CALLER,
        fetch: fake.fetch,
      }),
    },
  };
}

/** The single JSON payload a handler renders. */
function payload(res: { content: Array<{ type: 'text'; text: string }> }): unknown {
  return JSON.parse(res.content[0]!.text);
}

async function call(
  name: string,
  input: Record<string, unknown>,
  fake: ReturnType<typeof createFakeUpstream>,
  role?: 'admin' | 'adult' | 'child'
): Promise<unknown> {
  return payload(await tool(name).handler(contextFor(fake, role), input));
}

describe('feoh tool registry', () => {
  it('exports exactly the twelve frozen tool names', () => {
    expect(feohTools.map((t) => t.name)).toEqual([
      'feoh.list_envelopes',
      'feoh.record_transaction',
      'feoh.get_month_summary',
      'feoh.list_recurring_bills',
      'feoh.import_csv',
      'feoh.export_ledger',
      'feoh.list_occurrences',
      'feoh.link_occurrence',
      'feoh.skip_occurrence',
      'feoh.get_item_costs',
      'feoh.account_ledger',
      'feoh.link_item_cost',
    ]);
  });
});

describe('feoh read tools', () => {
  it('feoh.list_envelopes unwraps data into { envelopes }', async () => {
    const fake = createFakeUpstream({ body: { data: [{ id: 'e1', name: 'Groceries' }] } });
    const out = await call('feoh.list_envelopes', {}, fake);

    expect(fake.requests[0]?.url).toBe('http://heorth.test/api/v1/feoh/envelopes');
    expect(out).toEqual({ envelopes: [{ id: 'e1', name: 'Groceries' }] });
  });

  it('feoh.get_month_summary passes month through and returns data bare', async () => {
    const fake = createFakeUpstream({ body: { data: { month: '2026-01', rows: [] } } });
    const out = await call('feoh.get_month_summary', { month: '2026-01' }, fake);

    expect(fake.requests[0]?.url).toBe('http://heorth.test/api/v1/feoh/summary?month=2026-01');
    expect(out).toEqual({ month: '2026-01', rows: [] });
  });

  it('feoh.list_recurring_bills unwraps data into { bills }', async () => {
    const fake = createFakeUpstream({ body: { data: [{ id: 'b1' }] } });
    expect(await call('feoh.list_recurring_bills', {}, fake)).toEqual({ bills: [{ id: 'b1' }] });
    expect(fake.requests[0]?.url).toBe('http://heorth.test/api/v1/feoh/bills');
  });

  it('feoh.list_occurrences sends camelCase billId and unwraps into { occurrences }', async () => {
    const fake = createFakeUpstream({ body: { data: [{ billId: 'b1', dueDate: '2026-01-05' }] } });
    const out = await call(
      'feoh.list_occurrences',
      { from: '2026-01-01', to: '2026-01-31', billId: 'b1', status: 'overdue' },
      fake
    );

    const url = new URL(fake.requests[0]!.url);
    expect(url.pathname).toBe('/api/v1/feoh/occurrences');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
      billId: 'b1',
      status: 'overdue',
    });
    expect(out).toEqual({ occurrences: [{ billId: 'b1', dueDate: '2026-01-05' }] });
  });

  it('feoh.get_item_costs reads the item id from the path and returns the breakdown bare', async () => {
    const fake = createFakeUpstream({ body: { data: { capital: 100, recurring: 12 } } });
    const out = await call('feoh.get_item_costs', { itemId: 'item-1' }, fake);

    expect(fake.requests[0]?.url).toBe('http://heorth.test/api/v1/feoh/item-costs/item-1');
    expect(out).toEqual({ capital: 100, recurring: 12 });
  });

  it('feoh.get_item_costs surfaces the upstream NOT_FOUND code unchanged', async () => {
    const fake = createFakeUpstream({
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Item not found' } },
    });

    await expect(call('feoh.get_item_costs', { itemId: 'nope' }, fake)).rejects.toThrow('NOT_FOUND');
  });
});

describe('feoh.account_ledger', () => {
  it('recombines the split envelope: data becomes entries, meta stays meta', async () => {
    const entries = [
      { id: 't1', date: '2026-01-02', amount: -4.2, balance: 95.8 },
      { id: 't2', date: '2026-01-09', amount: 10, balance: 105.8 },
    ];
    const meta = { total: 2, limit: 50, offset: 0, openingBalance: 100, endBalance: 105.8 };
    const fake = createFakeUpstream({ body: { data: entries, meta } });

    const out = await call(
      'feoh.account_ledger',
      { accountId: 'acc-1', from: '2026-01-01', to: '2026-01-31' },
      fake
    );

    const url = new URL(fake.requests[0]!.url);
    expect(url.pathname).toBe('/api/v1/feoh/accounts/acc-1/ledger');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
    });
    // The tool has always returned one object — never the `{ data, meta }`
    // envelope, and never the entries alone.
    expect(out).toEqual({ entries, meta });
  });
});

describe('feoh.export_ledger', () => {
  it('always sends format=ledger — the default (csv) is a different export', async () => {
    const ledger = '2026-01-01 Baker\n  Groceries  4.20\n';
    const fake = createFakeUpstream({ text: ledger, contentType: 'text/plain; charset=utf-8' });

    const out = await call('feoh.export_ledger', {}, fake);

    const url = new URL(fake.requests[0]!.url);
    expect(url.pathname).toBe('/api/v1/feoh/export');
    expect(url.searchParams.get('format')).toBe('ledger');
    expect(out).toEqual({ ledger });
  });
});

describe('feoh.import_csv', () => {
  it('sends the CSV as the raw request body, not as JSON { csv }', async () => {
    const csv = 'date,payee,memo,amount,envelope,account\n2026-01-01,Baker,bread,-4.20,Groceries,Chequing\n';
    const fake = createFakeUpstream({ status: 201, body: { data: { imported: 1, skipped: 0 } } });

    const out = await call('feoh.import_csv', { csv }, fake);

    const req = fake.requests[0];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('http://heorth.test/api/v1/feoh/import');
    expect(req?.body).toBe(csv);
    expect(req?.headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(out).toEqual({ imported: 1, skipped: 0 });
  });

  it('surfaces UNKNOWN_REFERENCE from the import route', async () => {
    const fake = createFakeUpstream({
      status: 400,
      body: { error: { code: 'UNKNOWN_REFERENCE', message: 'unknown envelope' } },
    });

    await expect(call('feoh.import_csv', { csv: 'a,b\n' }, fake)).rejects.toThrow(
      'UNKNOWN_REFERENCE'
    );
  });
});

describe('feoh write tools', () => {
  const transaction = {
    date: '2026-01-01',
    payee: 'Baker',
    memo: 'bread',
    amount: 4.2,
    postings: [
      { accountId: 'acc-1', envelopeId: null, debit: 0, credit: 4.2 },
      { accountId: null, envelopeId: 'env-1', debit: 4.2, credit: 0 },
    ],
    splits: [{ memberId: 'mem-1', share: 1 }],
  };

  it('feoh.record_transaction posts the input verbatim and returns data bare', async () => {
    const fake = createFakeUpstream({ status: 201, body: { data: { id: 'tx-1' } } });
    const out = await call('feoh.record_transaction', transaction, fake, 'admin');

    expect(fake.requests[0]?.url).toBe('http://heorth.test/api/v1/feoh/transactions');
    expect(JSON.parse(fake.requests[0]!.body!)).toEqual(transaction);
    expect(out).toEqual({ id: 'tx-1' });
  });

  it('never sends the key fingerprint as an actor — createdBy is Heorth’s to derive', async () => {
    const fake = createFakeUpstream({ status: 201, body: { data: { id: 'tx-1' } } });
    await call('feoh.record_transaction', transaction, fake, 'admin');

    const body = fake.requests[0]!.body!;
    expect(body).not.toContain(KEY_FINGERPRINT);
    expect(JSON.parse(body)).not.toHaveProperty('createdBy');
  });

  it('feoh.link_occurrence and feoh.skip_occurrence unwrap { ok: true }', async () => {
    const fake = createFakeUpstream({ body: { data: { ok: true } } }, { body: { data: { ok: true } } });

    expect(
      await call(
        'feoh.link_occurrence',
        { billId: 'b1', dueDate: '2026-01-05', transactionId: 'tx-1' },
        fake
      )
    ).toEqual({ ok: true });
    expect(await call('feoh.skip_occurrence', { billId: 'b1', dueDate: '2026-01-05' }, fake)).toEqual(
      { ok: true }
    );

    expect(fake.requests.map((r) => r.url)).toEqual([
      'http://heorth.test/api/v1/feoh/occurrences/link',
      'http://heorth.test/api/v1/feoh/occurrences/skip',
    ]);
  });

  it('feoh.link_item_cost posts the link and surfaces its domain codes', async () => {
    const fake = createFakeUpstream(
      { status: 201, body: { data: { id: 'link-1' } } },
      { status: 409, body: { error: { code: 'DUPLICATE_LINK', message: 'already linked' } } }
    );
    const input = { transactionId: 'tx-1', itemId: 'item-1', kind: 'purchase' };

    expect(await call('feoh.link_item_cost', input, fake)).toEqual({ id: 'link-1' });
    expect(JSON.parse(fake.requests[0]!.body!)).toEqual(input);
    await expect(call('feoh.link_item_cost', input, fake)).rejects.toThrow('DUPLICATE_LINK');
  });
});

describe('no local authorization is re-added', () => {
  const writes: Array<[string, Record<string, unknown>]> = [
    [
      'feoh.record_transaction',
      {
        date: '2026-01-01',
        payee: 'Baker',
        amount: 4.2,
        postings: [
          { accountId: 'acc-1', debit: 0, credit: 4.2 },
          { envelopeId: 'env-1', debit: 4.2, credit: 0 },
        ],
        splits: [],
      },
    ],
    ['feoh.import_csv', { csv: 'a,b\n' }],
    ['feoh.link_occurrence', { billId: 'b1', dueDate: '2026-01-05', transactionId: 'tx-1' }],
    ['feoh.skip_occurrence', { billId: 'b1', dueDate: '2026-01-05' }],
    ['feoh.link_item_cost', { transactionId: 'tx-1', itemId: 'item-1', kind: 'purchase' }],
  ];

  // Heorth's routes carry `requireRole('admin','adult')` and the
  // maintenance-admin quarantine on every one of these. A local gate here would
  // have to judge a role heorth-mcp never verified — so every write must reach
  // the upstream and let it answer.
  it.each(writes)('%s reaches the upstream even for a child principal', async (name, input) => {
    const fake = createFakeUpstream({ body: { data: { ok: true } } });
    await call(name, input, fake, 'child');
    expect(fake.requests).toHaveLength(1);
  });

  it.each(writes)('%s reaches the upstream with no role at all', async (name, input) => {
    const fake = createFakeUpstream({ body: { data: { ok: true } } });
    await call(name, input, fake);
    expect(fake.requests).toHaveLength(1);
  });

  it('an upstream FORBIDDEN is what a non-permitted caller gets back', async () => {
    const fake = createFakeUpstream({
      status: 403,
      body: { error: { code: 'FORBIDDEN', message: 'admin or adult required' } },
    });

    await expect(
      call('feoh.skip_occurrence', { billId: 'b1', dueDate: '2026-01-05' }, fake, 'child')
    ).rejects.toThrow('FORBIDDEN');
  });
});
