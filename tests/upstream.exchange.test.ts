import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SatelliteTokenExchange,
  CACHE_EVICTION_MARGIN_MS,
} from '../src/upstream/exchange.js';
import { createFakeUpstream, type ScriptedResponse } from './helpers/fake-upstream.js';

const CALLER_A = 'Bearer he_alice_key';
const CALLER_B = 'Bearer he_bob_key';

/** Heorth's answer to a mint, `{ data: { token, expires_in, audience } }`. */
function minted(token: string, expiresIn = 300): ScriptedResponse {
  return { body: { data: { token, expires_in: expiresIn, audience: 'kithledger' } } };
}

function harness(clock: { now: number }, ...responses: ScriptedResponse[]) {
  const fake = createFakeUpstream(...responses);
  const exchange = new SatelliteTokenExchange({
    heorthBaseUrl: 'http://heorth.test',
    audience: 'kithledger',
    fetch: fake.fetch,
    now: () => clock.now,
  });
  return { fake, exchange };
}

afterEach(() => vi.restoreAllMocks());

describe('satellite token exchange', () => {
  it('exchanges the caller credential at Heorth and returns the minted token', async () => {
    const clock = { now: 1_000_000 };
    const { fake, exchange } = harness(clock, minted('jwt.alice'));

    const header = await exchange.authorizationFor(CALLER_A);

    expect(header).toBe('Bearer jwt.alice');
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.method).toBe('POST');
    expect(fake.requests[0]?.url).toBe('http://heorth.test/api/v1/auth/satellite-token');
    // Authenticated by the CALLER's own credential — heorth-mcp holds none.
    expect(fake.requests[0]?.headers['Authorization']).toBe(CALLER_A);
    expect(JSON.parse(fake.requests[0]?.body ?? '{}')).toEqual({ audience: 'kithledger' });
  });

  it('exchanges once and serves the second call from the cache', async () => {
    const clock = { now: 1_000_000 };
    const { fake, exchange } = harness(clock, minted('jwt.alice'), minted('jwt.alice.2'));

    const first = await exchange.authorizationFor(CALLER_A);
    clock.now += 60_000;
    const second = await exchange.authorizationFor(CALLER_A);

    expect(first).toBe('Bearer jwt.alice');
    expect(second).toBe('Bearer jwt.alice');
    expect(fake.requests).toHaveLength(1);
  });

  it('gives two different callers two different tokens — the key-separation rule', async () => {
    // ADR 0009: keyed by the hash of the PRESENTING CREDENTIAL plus the
    // audience. A coarser key would let one member act as another.
    const clock = { now: 1_000_000 };
    const { fake, exchange } = harness(clock, minted('jwt.alice'), minted('jwt.bob'));

    const alice = await exchange.authorizationFor(CALLER_A);
    const bob = await exchange.authorizationFor(CALLER_B);
    const aliceAgain = await exchange.authorizationFor(CALLER_A);

    expect(alice).toBe('Bearer jwt.alice');
    expect(bob).toBe('Bearer jwt.bob');
    expect(aliceAgain).toBe('Bearer jwt.alice');
    // Two mints for two callers, and no third: each caller has its own entry.
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests.map((r) => r.headers['Authorization'])).toEqual([CALLER_A, CALLER_B]);
  });

  it('separates the cache by audience as well as by caller', async () => {
    const clock = { now: 1_000_000 };
    const fake = createFakeUpstream(minted('jwt.kith'), minted('jwt.other'));
    const opts = { heorthBaseUrl: 'http://heorth.test', fetch: fake.fetch, now: () => clock.now };
    const kith = new SatelliteTokenExchange({ ...opts, audience: 'kithledger' });
    const other = new SatelliteTokenExchange({ ...opts, audience: 'ethel' });

    expect(await kith.authorizationFor(CALLER_A)).toBe('Bearer jwt.kith');
    expect(await other.authorizationFor(CALLER_A)).toBe('Bearer jwt.other');
    expect(JSON.parse(fake.requests[1]?.body ?? '{}')).toEqual({ audience: 'ethel' });
  });

  it('refreshes a token that is within 30s of expiry, and not a moment earlier', async () => {
    const clock = { now: 1_000_000 };
    const { fake, exchange } = harness(clock, minted('jwt.first', 300), minted('jwt.second', 300));

    await exchange.authorizationFor(CALLER_A);

    // One millisecond before `exp - 30s`: still served from the cache.
    clock.now += 300_000 - CACHE_EVICTION_MARGIN_MS - 1;
    expect(await exchange.authorizationFor(CALLER_A)).toBe('Bearer jwt.first');
    expect(fake.requests).toHaveLength(1);

    // At `exp - 30s`: evicted, so the next call mints again.
    clock.now += 1;
    expect(await exchange.authorizationFor(CALLER_A)).toBe('Bearer jwt.second');
    expect(fake.requests).toHaveLength(2);
  });

  it('mints once for a burst from the same caller', async () => {
    const clock = { now: 1_000_000 };
    const { fake, exchange } = harness(clock, minted('jwt.alice'), minted('jwt.alice.2'));

    const headers = await Promise.all([
      exchange.authorizationFor(CALLER_A),
      exchange.authorizationFor(CALLER_A),
      exchange.authorizationFor(CALLER_A),
    ]);

    expect(headers).toEqual(['Bearer jwt.alice', 'Bearer jwt.alice', 'Bearer jwt.alice']);
    expect(fake.requests).toHaveLength(1);
  });

  it('fails cleanly with IDENTITY_UNAVAILABLE when Heorth is unreachable', async () => {
    const clock = { now: 1_000_000 };
    const { exchange } = harness(clock, { throws: new TypeError('fetch failed') });

    const error = await exchange.authorizationFor(CALLER_A).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('IDENTITY_UNAVAILABLE');
    expect((error as Error).message).not.toMatch(/heorth\.test|he_/);
  });

  it('fails cleanly with IDENTITY_UNAVAILABLE when Heorth does not answer in time', async () => {
    const fake = createFakeUpstream({ hang: true });
    const exchange = new SatelliteTokenExchange({
      heorthBaseUrl: 'http://heorth.test',
      audience: 'kithledger',
      fetch: fake.fetch,
      timeoutMs: 20,
    });

    await expect(exchange.authorizationFor(CALLER_A)).rejects.toThrow('IDENTITY_UNAVAILABLE');
  });

  it('does not cache a failed exchange', async () => {
    const clock = { now: 1_000_000 };
    const { fake, exchange } = harness(
      clock,
      { throws: new TypeError('fetch failed') },
      minted('jwt.alice')
    );

    await expect(exchange.authorizationFor(CALLER_A)).rejects.toThrow('IDENTITY_UNAVAILABLE');
    expect(await exchange.authorizationFor(CALLER_A)).toBe('Bearer jwt.alice');
    expect(fake.requests).toHaveLength(2);
  });

  it('passes a refusal Heorth named through as its own code', async () => {
    const clock = { now: 1_000_000 };
    const { exchange } = harness(clock, {
      status: 400,
      body: { error: { code: 'UNKNOWN_AUDIENCE', message: 'Unknown satellite audience' } },
    });

    await expect(exchange.authorizationFor(CALLER_A)).rejects.toThrow('UNKNOWN_AUDIENCE');
  });

  it('genericises an unnamed failure and a 2xx that carries no token', async () => {
    const clock = { now: 1_000_000 };
    const { exchange } = harness(
      clock,
      { status: 500, text: '<html>nginx</html>', contentType: 'text/html' },
      { body: { data: { expires_in: 300 } } }
    );

    await expect(exchange.authorizationFor(CALLER_A)).rejects.toThrow('TOKEN_EXCHANGE_FAILED');
    await expect(exchange.authorizationFor(CALLER_A)).rejects.toThrow('TOKEN_EXCHANGE_FAILED');
  });

  it('logs no token and no key material, on success or on failure', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const clock = { now: 1_000_000 };
    const { exchange } = harness(clock, minted('jwt.alice.secret'), {
      throws: new TypeError('fetch failed'),
    });

    await exchange.authorizationFor(CALLER_A);
    clock.now += 300_000;
    const failure = await exchange.authorizationFor(CALLER_A).catch((e: Error) => e);

    const written = [...log.mock.calls, ...error.mock.calls].flat().join('\n');
    expect(written).not.toContain('jwt.alice.secret');
    expect(written).not.toContain('he_alice_key');
    expect(JSON.stringify(failure)).not.toContain('jwt.alice.secret');
    expect(JSON.stringify(failure)).not.toContain('he_alice_key');
  });
});
