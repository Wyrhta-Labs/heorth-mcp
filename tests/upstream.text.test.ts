import { describe, it, expect } from 'vitest';
import { HeorthClient } from '../src/upstream/heorth.js';
import { UpstreamError } from '../src/upstream/errors.js';
import { createFakeUpstream } from './helpers/fake-upstream.js';

const CALLER = 'Bearer he_abc123';

function client(fake: ReturnType<typeof createFakeUpstream>, timeoutMs?: number) {
  return new HeorthClient({
    baseUrl: 'http://heorth.test',
    authorization: CALLER,
    fetch: fake.fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe('RestTransport — raw text request body', () => {
  it('sends the body verbatim with a non-JSON Content-Type', async () => {
    const fake = createFakeUpstream({ status: 201, body: { data: { imported: 2 } } });
    const csv = 'date,payee,memo,amount\n2026-01-01,Baker,bread,-4.20\n';

    const res = await client(fake).postText<{ data: { imported: number } }>(
      '/feoh/import',
      csv,
      'text/csv; charset=utf-8'
    );

    const req = fake.requests[0];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('http://heorth.test/api/v1/feoh/import');
    expect(req?.headers['Content-Type']).toBe('text/csv; charset=utf-8');
    // Verbatim: not JSON-stringified, not wrapped in `{ csv }`.
    expect(req?.body).toBe(csv);
    expect(res.data.imported).toBe(2);
  });

  it('defaults to text/plain when no Content-Type is given', async () => {
    const fake = createFakeUpstream({ body: { data: {} } });
    await client(fake).postText('/feoh/import', 'a,b\n');

    expect(fake.requests[0]?.headers['Content-Type']).toBe('text/plain; charset=utf-8');
  });

  it('still classifies an error envelope on the text-body path', async () => {
    const fake = createFakeUpstream({
      status: 400,
      body: { error: { code: 'UNKNOWN_REFERENCE', message: 'unknown envelope' } },
    });

    await expect(client(fake).postText('/feoh/import', 'x')).rejects.toMatchObject({
      message: 'UNKNOWN_REFERENCE',
      kind: 'domain',
      status: 400,
    });
  });

  it('leaves the JSON path untouched', async () => {
    const fake = createFakeUpstream({ body: { data: { ok: true } } });
    await client(fake).post('/feoh/occurrences/skip', { billId: 'b' });

    expect(fake.requests[0]?.headers['Content-Type']).toBe('application/json');
    expect(fake.requests[0]?.headers['Accept']).toBe('application/json');
    expect(fake.requests[0]?.body).toBe(JSON.stringify({ billId: 'b' }));
  });
});

describe('RestTransport — text response', () => {
  it('returns a text/plain body as a string, without JSON parsing', async () => {
    const ledger = '2026-01-01 Baker\n  Groceries   4.20\n  Chequing   -4.20\n';
    const fake = createFakeUpstream({ text: ledger, contentType: 'text/plain; charset=utf-8' });

    const out = await client(fake).getText('/feoh/export', { format: 'ledger' });

    expect(out).toBe(ledger);
    expect(fake.requests[0]?.url).toBe('http://heorth.test/api/v1/feoh/export?format=ledger');
  });

  it('a non-JSON 200 is not a bad_response on the text path (it is on the JSON path)', async () => {
    const fake = createFakeUpstream(
      { text: 'not json', contentType: 'text/plain' },
      { text: 'not json', contentType: 'text/plain' }
    );

    await expect(client(fake).getText('/feoh/export')).resolves.toBe('not json');
    await expect(client(fake).get('/feoh/export')).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });

  it('maps an error envelope on the text path exactly as on the JSON path', async () => {
    const fake = createFakeUpstream({
      status: 403,
      body: { error: { code: 'FORBIDDEN', message: 'nope' } },
    });

    await expect(client(fake).getText('/feoh/export', { format: 'ledger' })).rejects.toMatchObject({
      message: 'FORBIDDEN',
      kind: 'domain',
      status: 403,
    });
  });

  it('classifies a timeout and a dead upstream the same way, and leaks nothing', async () => {
    const hanging = createFakeUpstream({ hang: true });
    const dead = createFakeUpstream({ throws: new TypeError('fetch failed: http://secret/api') });

    await expect(client(hanging, 5).getText('/feoh/export')).rejects.toThrow('UPSTREAM_TIMEOUT');
    const failure = await client(dead)
      .getText('/feoh/export')
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UpstreamError);
    expect((failure as UpstreamError).message).toBe('UPSTREAM_UNAVAILABLE');
    expect((failure as UpstreamError).message).not.toContain('secret');
  });
});
