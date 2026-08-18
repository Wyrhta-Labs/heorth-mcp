import { describe, it, expect } from 'vitest';
import { KithClient, createKithClient, serviceKeyCredential } from '../src/upstream/kith.js';
import { createFakeUpstream } from './helpers/fake-upstream.js';

const CFG = { baseUrl: 'http://kith.test', apiKey: 'kl_service_key' };

describe('KithClient', () => {
  it('authenticates with the configured service key', async () => {
    const fake = createFakeUpstream({ body: { data: [] } });
    await createKithClient(CFG, { fetch: fake.fetch }).get('/people', { search: 'ada' });

    expect(fake.requests[0]?.headers['Authorization']).toBe('Bearer kl_service_key');
    expect(fake.requests[0]?.url).toBe('http://kith.test/api/v1/people?search=ada');
  });

  it('resolves its credential per request — the seam ADR 0002 Phase B replaces', async () => {
    // Task B11 swaps the static service key for a per-caller member JWT. Only
    // the credential changes; the client and every tool stay as they are.
    const fake = createFakeUpstream({ body: {} }, { body: {} });
    const issued: string[] = [];
    let n = 0;
    const client = new KithClient({
      baseUrl: CFG.baseUrl,
      fetch: fake.fetch,
      credential: {
        async authorization() {
          const token = `Bearer member.jwt.${++n}`;
          issued.push(token);
          return token;
        },
      },
    });

    await client.get('/people');
    await client.get('/people');

    expect(issued).toEqual(['Bearer member.jwt.1', 'Bearer member.jwt.2']);
    expect(fake.requests.map((r) => r.headers['Authorization'])).toEqual(issued);
  });

  it('maps upstream error codes through and genericises the rest', async () => {
    const fake = createFakeUpstream(
      { status: 409, body: { error: { code: 'DUPLICATE_PERSON', message: 'exists' } } },
      { status: 500, body: { message: 'boom' } }
    );
    const client = createKithClient(CFG, { fetch: fake.fetch });

    await expect(client.post('/people', { name: 'Ada' })).rejects.toMatchObject({
      message: 'DUPLICATE_PERSON',
      upstream: 'kith',
    });
    await expect(client.get('/people')).rejects.toMatchObject({ message: 'tool error' });
  });

  it('classifies timeout and connection failure', async () => {
    const fake = createFakeUpstream({ hang: true }, { throws: new TypeError('fetch failed') });
    const client = createKithClient(CFG, { fetch: fake.fetch, timeoutMs: 20 });

    await expect(client.get('/reminders')).rejects.toMatchObject({ message: 'UPSTREAM_TIMEOUT' });
    await expect(client.get('/reminders')).rejects.toMatchObject({
      message: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it('never carries key material in an error message', async () => {
    const fake = createFakeUpstream({ status: 401, body: { error: { code: 'unauthorized' } } });
    const error = await createKithClient(CFG, { fetch: fake.fetch })
      .get('/people')
      .catch((e: Error) => e);

    expect(error.message).toBe('tool error');
    expect(error.message).not.toContain('kl_');
  });

  it('serviceKeyCredential builds a Bearer header', async () => {
    expect(await serviceKeyCredential('kl_x').authorization()).toBe('Bearer kl_x');
  });
});
