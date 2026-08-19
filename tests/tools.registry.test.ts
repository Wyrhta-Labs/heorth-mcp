import { describe, it, expect } from 'vitest';
import { buildRegistry } from '../src/tools/index.js';
import { loadConfig } from '../src/config/env.js';

const BOTH = { HEORTH_BASE_URL: 'http://heorth:3000', KITH_BASE_URL: 'http://kith:3000' };

describe('tool registry', () => {
  it('serves nothing with neither upstream configured', () => {
    expect(buildRegistry(loadConfig({}))).toHaveLength(0);
  });

  it('registers the 37 Heorth tools alone when only Heorth is configured', () => {
    const tools = buildRegistry(loadConfig({ HEORTH_BASE_URL: 'http://heorth:3000' }));

    expect(tools).toHaveLength(37);
    expect(tools.filter((t) => t.name.startsWith('kith.'))).toHaveLength(0);
  });

  it('registers all 50 tools with both upstreams configured', () => {
    const tools = buildRegistry(loadConfig(BOTH));

    expect(tools).toHaveLength(50);
    expect(tools.filter((t) => t.name.startsWith('kith.'))).toHaveLength(13);
  });

  it('has no duplicate tool names — they are a frozen public contract', () => {
    const names = buildRegistry(loadConfig(BOTH)).map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
