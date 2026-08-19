import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Load .env from the working directory for local dev. Never overrides variables
// already present in the environment — exported vars always win. Full-line
// comments only (no inline `#`).
try {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1] && process.env[m[1]] === undefined) {
      process.env[m[1]] = (m[2] ?? '').replace(/^(["'])(.*)\1$/, '$2');
    }
  }
} catch {
  // no .env file — rely on the real environment (CI, docker, production)
}

const envSchema = z
  .object({
    // Both upstreams are optional: with neither configured the container still
    // starts and serves an empty tool list (CLAUDE.md, "Each upstream is optional").
    HEORTH_BASE_URL: z.string().url().optional(),
    KITH_BASE_URL: z.string().url().optional(),
    /**
     * The satellite audience Heorth mints `kith.*` tokens for. Must be one of
     * the slugs in Heorth's `SATELLITE_AUDIENCES` and match KithLedger's
     * `SATELLITE_AUDIENCE`, or every exchange is refused `UNKNOWN_AUDIENCE`.
     */
    KITH_AUDIENCE: z.string().min(1).default('kithledger'),
    PORT: z.coerce.number().int().positive().default(3200),
    UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  })
  .superRefine((env, ctx) => {
    // heorth-mcp holds NO KithLedger credential (task B11, ADR 0009). A
    // `kith.*` call authenticates with a member token exchanged at Heorth, so
    // KithLedger is only reachable when Heorth is configured too — without it
    // the `kith.*` tools could never authenticate at all. Registering tools
    // that can only ever fail is worse than refusing to boot.
    if (env.KITH_BASE_URL && !env.HEORTH_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['HEORTH_BASE_URL'],
        message:
          'HEORTH_BASE_URL is required when KITH_BASE_URL is set: `kith.*` tools authenticate with a member token exchanged at Heorth (ADR 0009)',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface HeorthUpstreamConfig {
  baseUrl: string;
}

export interface KithUpstreamConfig {
  baseUrl: string;
  /** The audience of the exchanged member token; no credential is held here. */
  audience: string;
}

export interface AppConfig {
  port: number;
  timeoutMs: number;
  /** null when HEORTH_BASE_URL is unset — the Heorth tools are not registered. */
  heorth: HeorthUpstreamConfig | null;
  /**
   * null unless KITH_BASE_URL *and* HEORTH_BASE_URL are both set — the `kith.*`
   * tools need Heorth for their member token, so both upstreams or no tools.
   */
  kith: KithUpstreamConfig | null;
}

/** Parse an explicit environment. Exported so tests need not touch `process.env`. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid environment variables: ${JSON.stringify(issues)}`);
  }
  const env = parsed.data;
  return {
    port: env.PORT,
    timeoutMs: env.UPSTREAM_TIMEOUT_MS,
    heorth: env.HEORTH_BASE_URL ? { baseUrl: env.HEORTH_BASE_URL } : null,
    kith:
      env.KITH_BASE_URL && env.HEORTH_BASE_URL
        ? { baseUrl: env.KITH_BASE_URL, audience: env.KITH_AUDIENCE }
        : null,
  };
}
