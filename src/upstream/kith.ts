import type { KithUpstreamConfig } from '../config/env.js';
import { RestTransport, type QueryValue } from './http.js';

/**
 * ── CREDENTIAL SEAM ─────────────────────────────────────────────────────────
 * How a `kith.*` call authenticates: with a **Heorth-issued member JWT**,
 * exchanged per caller (ADR 0009, task B11).
 *
 * There is no service key here any more. KithLedger enforces ADR 0004's
 * per-member access control, and none of its three credential kinds is the
 * calling member: a `member`-kinded `kl_` key reads as the *issuing account's*
 * personal scope, a `household` one sees only the household slice, and an `ops`
 * one has no data access at all. Only a token minted for the caller expresses
 * "this member is asking".
 *
 * The credential is resolved per request and may be async — that is what lets
 * `src/upstream/exchange.ts` sit behind this seam without the client or any
 * tool knowing an exchange happened.
 */
export interface KithCredential {
  /** The `Authorization` header value for one request. */
  authorization(): string | Promise<string>;
}

export interface KithClientOptions {
  baseUrl: string;
  credential: KithCredential;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Typed REST client for KithLedger's `/api/v1/*` surface.
 *
 * Request-scoped by construction, exactly like `HeorthClient`: its credential
 * belongs to one caller, so hoisting an instance to process scope would make
 * one member's token serve another member's call.
 */
export class KithClient {
  private readonly transport: RestTransport;

  constructor(opts: KithClientOptions) {
    this.transport = new RestTransport({
      baseUrl: opts.baseUrl,
      upstream: 'kith',
      authorization: () => opts.credential.authorization(),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
    });
  }

  get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.transport.request<T>({ method: 'GET', path, ...(query ? { query } : {}) });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.transport.request<T>({ method: 'POST', path, body: body ?? {} });
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.transport.request<T>({ method: 'PATCH', path, body: body ?? {} });
  }

  delete<T>(path: string): Promise<T> {
    return this.transport.request<T>({ method: 'DELETE', path });
  }
}

/**
 * Build a caller-bound KithLedger client. The credential comes from the
 * satellite token exchange — see `src/upstream/index.ts`, which is the only
 * place that pairs the two.
 */
export function createKithClient(
  cfg: KithUpstreamConfig,
  credential: KithCredential,
  opts: { timeoutMs?: number; fetch?: typeof fetch } = {}
): KithClient {
  return new KithClient({
    baseUrl: cfg.baseUrl,
    credential,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
  });
}
