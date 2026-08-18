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
    KITH_API_KEY: z.string().min(1).optional(),
    PORT: z.coerce.number().int().positive().default(3200),
    UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  })
  .superRefine((env, ctx) => {
    // Heorth needs no credential here (the caller's key is passed through), but
    // KithLedger does — a base URL without a key would register `kith.*` tools
    // that can only ever fail, so fail at boot instead.
    if (env.KITH_BASE_URL && !env.KITH_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['KITH_API_KEY'],
        message: 'KITH_API_KEY is required when KITH_BASE_URL is set',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface HeorthUpstreamConfig {
  baseUrl: string;
}

export interface KithUpstreamConfig {
  baseUrl: string;
  apiKey: string;
}

export interface AppConfig {
  port: number;
  timeoutMs: number;
  /** null when HEORTH_BASE_URL is unset — the Heorth tools are not registered. */
  heorth: HeorthUpstreamConfig | null;
  /** null when KITH_BASE_URL is unset — the `kith.*` tools are not registered. */
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
      env.KITH_BASE_URL && env.KITH_API_KEY
        ? { baseUrl: env.KITH_BASE_URL, apiKey: env.KITH_API_KEY }
        : null,
  };
}
