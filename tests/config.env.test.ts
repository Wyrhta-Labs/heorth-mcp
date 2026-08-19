import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config/env.js';

describe('loadConfig', () => {
  it('starts with neither upstream configured', () => {
    const config = loadConfig({});
    expect(config.heorth).toBeNull();
    expect(config.kith).toBeNull();
    expect(config.port).toBe(3200);
  });

  it('enables Heorth on its own', () => {
    expect(loadConfig({ HEORTH_BASE_URL: 'http://heorth:3000' })).toMatchObject({
      heorth: { baseUrl: 'http://heorth:3000' },
      kith: null,
    });
  });

  it('enables KithLedger only alongside Heorth, and holds no KithLedger credential', () => {
    const config = loadConfig({
      HEORTH_BASE_URL: 'http://heorth:3000',
      KITH_BASE_URL: 'http://kith:3000',
    });

    expect(config.kith).toEqual({ baseUrl: 'http://kith:3000', audience: 'kithledger' });
    // Nothing in the config is a KithLedger credential — `kith.*` authenticates
    // with a member token exchanged at Heorth (ADR 0009, task B11).
    expect(Object.keys(config.kith ?? {})).not.toContain('apiKey');
  });

  it('takes the satellite audience from the environment', () => {
    expect(
      loadConfig({
        HEORTH_BASE_URL: 'http://heorth:3000',
        KITH_BASE_URL: 'http://kith:3000',
        KITH_AUDIENCE: 'kith-staging',
      }).kith
    ).toMatchObject({ audience: 'kith-staging' });
  });

  it('rejects a KithLedger base URL without Heorth: nothing could mint its token', () => {
    expect(() => loadConfig({ KITH_BASE_URL: 'http://kith:3000' })).toThrow(/HEORTH_BASE_URL/);
  });

  it('ignores a leftover KITH_API_KEY rather than using it as a credential', () => {
    // The A2-era service key is gone. A stale deployment variable must not
    // resurrect it, and must not break boot either.
    const config = loadConfig({
      HEORTH_BASE_URL: 'http://heorth:3000',
      KITH_BASE_URL: 'http://kith:3000',
      KITH_API_KEY: 'kl_stale',
    });

    expect(JSON.stringify(config)).not.toContain('kl_stale');
  });

  it('rejects a non-URL base URL and a bad port', () => {
    expect(() => loadConfig({ HEORTH_BASE_URL: 'heorth' })).toThrow(/HEORTH_BASE_URL/);
    expect(() => loadConfig({ PORT: '0' })).toThrow(/PORT/);
  });
});
