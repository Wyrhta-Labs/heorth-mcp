import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config/env.js';

describe('loadConfig', () => {
  it('starts with neither upstream configured', () => {
    const config = loadConfig({});
    expect(config.heorth).toBeNull();
    expect(config.kith).toBeNull();
    expect(config.port).toBe(3200);
  });

  it('enables each upstream independently', () => {
    expect(loadConfig({ HEORTH_BASE_URL: 'http://heorth:3000' })).toMatchObject({
      heorth: { baseUrl: 'http://heorth:3000' },
      kith: null,
    });
    expect(
      loadConfig({ KITH_BASE_URL: 'http://kith:3000', KITH_API_KEY: 'kl_x' })
    ).toMatchObject({ heorth: null, kith: { baseUrl: 'http://kith:3000', apiKey: 'kl_x' } });
  });

  it('rejects a KithLedger base URL without its service key', () => {
    expect(() => loadConfig({ KITH_BASE_URL: 'http://kith:3000' })).toThrow(/KITH_API_KEY/);
  });

  it('rejects a non-URL base URL and a bad port', () => {
    expect(() => loadConfig({ HEORTH_BASE_URL: 'heorth' })).toThrow(/HEORTH_BASE_URL/);
    expect(() => loadConfig({ PORT: '0' })).toThrow(/PORT/);
  });
});
