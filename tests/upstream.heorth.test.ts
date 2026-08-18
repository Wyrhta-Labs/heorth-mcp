import { describe, it, expect } from 'vitest';
import {
  HeorthClient,
  MissingCallerKeyError,
  callerAuthorization,
  createHeorthClient,
} from '../src/upstream/heorth.js';
import { UpstreamError } from '../src/upstream/errors.js';
import { createFakeUpstream } from './helpers/fake-upstream.js';

const CALLER = 'Bearer he_abc123';

function client(fake: ReturnType<typeof createFakeUpstream>, timeoutMs?: number) {
  return new HeorthClient({
    baseUrl: 'http://heorth.test/',
    authorization: CALLER,
    fetch: fake.fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe('callerAuthorization', () => {
  const header = (value?: string) =>
    new Request('http://mcp.test/mcp', value ? { headers: { Authorization: value } } : {});

  it('returns the header verbatim', () => {
    expect(callerAuthorization(header(CALLER))).toBe(CALLER);
  });

  it('rejects a missing or malformed header', () => {
    expect(callerAuthorization(header())).toBeUndefined();
    expect(callerAuthorization(header('he_abc123'))).toBeUndefined();
    expect(callerAuthorization(header('Bearer'))).toBeUndefined();
    expect(callerAuthorization(header('Basic dXNlcjpwdw=='))).toBeUndefined();
  });
});

describe('HeorthClient', () => {
  it('forwards the caller Authorization header verbatim and holds no key of its own', async () => {
    const fake = createFakeUpstream({ body: { data: [] } });
    await client(fake).get('/household');

    expect(fake.requests[0]?.headers['Authorization']).toBe(CALLER);
    expect(fake.requests[0]?.url).toBe('http://heorth.test/api/v1/household');
  });

  it('fails before any upstream call when the caller presented no key', () => {
    const fake = createFakeUpstream();
    expect(() => createHeorthClient({ baseUrl: 'http://heorth.test' }, undefined, { fetch: fake.fetch }))
      .toThrow(MissingCallerKeyError);
    expect(() => createHeorthClient({ baseUrl: 'http://heorth.test' }, 'nonsense', { fetch: fake.fetch }))
      .toThrow('MCP_UNAUTHORIZED');
    expect(fake.requests).toHaveLength(0);
  });

  it('builds query strings, dropping empty values', async () => {
    const fake = createFakeUpstream({ body: { data: [] } });
    await client(fake).get('/calendar', { from: '2026-01-01', limit: 10, memberId: undefined, q: '' });

    expect(fake.requests[0]?.url).toBe(
      'http://heorth.test/api/v1/calendar?from=2026-01-01&limit=10'
    );
  });

  it('sends JSON bodies on writes', async () => {
    const fake = createFakeUpstream({ status: 201, body: { data: { id: 'e1' } } });
    const res = await client(fake).post<{ data: { id: string } }>('/calendar', { title: 'Dinner' });

    expect(res.data.id).toBe('e1');
    expect(fake.requests[0]?.method).toBe('POST');
    expect(fake.requests[0]?.body).toBe('{"title":"Dinner"}');
    expect(fake.requests[0]?.headers['Content-Type']).toBe('application/json');
  });

  it('maps a well-formed upstream error code through as the tool error text', async () => {
    const fake = createFakeUpstream({
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'no such event at /api/v1/calendar/e1' } },
    });

    await expect(client(fake).get('/calendar/e1')).rejects.toMatchObject({
      message: 'NOT_FOUND',
      status: 404,
      upstream: 'heorth',
      kind: 'domain',
    });
  });

  it('genericises a malformed code and never leaks the upstream message', async () => {
    const fake = createFakeUpstream({
      status: 500,
      body: { error: { code: 'not a code', message: 'Error: connect ECONNREFUSED 10.0.0.5:5432' } },
    });

    const error = await client(fake).get('/feoh/envelopes').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).message).toBe('tool error');
    expect((error as UpstreamError).message).not.toContain('ECONNREFUSED');
  });

  it('genericises an error body that is not the envelope at all', async () => {
    const fake = createFakeUpstream({ status: 502, text: '<html>Bad Gateway at http://heorth:3000</html>' });

    await expect(client(fake).get('/household')).rejects.toMatchObject({ message: 'tool error' });
  });

  it('classifies a connection failure without naming the upstream URL', async () => {
    const fake = createFakeUpstream({ throws: new TypeError('fetch failed: http://heorth.test') });

    const error = await client(fake).get('/household').catch((e: unknown) => e as UpstreamError);
    expect(error.message).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.kind).toBe('network');
    expect(error.message).not.toContain('heorth.test');
  });

  it('aborts and classifies a hung upstream as a timeout', async () => {
    const fake = createFakeUpstream({ hang: true });

    await expect(client(fake, 20).get('/household')).rejects.toMatchObject({
      message: 'UPSTREAM_TIMEOUT',
      kind: 'timeout',
    });
  });

  it('accepts an empty body (204) as undefined rather than failing to parse', async () => {
    const fake = createFakeUpstream({ status: 204 });
    await expect(client(fake).post('/tasks/t1/complete')).resolves.toBeUndefined();
  });
});
