import type { KithUpstreamConfig } from '../config/env.js';
import { RestTransport, type QueryValue } from './http.js';

/**
 * ── CREDENTIAL SEAM ─────────────────────────────────────────────────────────
 * How a `kith.*` call authenticates. Today (ADR 0002 Phase A) it is one `kl_`
 * service key for the whole process, so every `kith.*` tool acts as a single
 * service principal rather than as the calling member.
 *
 * That changes: issue Wyrhta-Labs/wyrhta-labs#1 decision 9 / task B11 replaces
 * it with a member JWT minted per caller. This indirection is the only thing
 * that has to change when it does — the credential is resolved per request and
 * may be async, so a token exchange fits here without touching the client or
 * any tool. Nothing else in the repo may reach for `KITH_API_KEY`.
 */
export interface KithCredential {
  /** The `Authorization` header value for one request. */
  authorization(): string | Promise<string>;
}

/** Phase A: the static `kl_` service key from `KITH_API_KEY`. */
export function serviceKeyCredential(apiKey: string): KithCredential {
  return { authorization: () => `Bearer ${apiKey}` };
}

export interface KithClientOptions {
  baseUrl: string;
  credential: KithCredential;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Typed REST client for KithLedger's `/api/v1/*` surface. */
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

export function createKithClient(
  cfg: KithUpstreamConfig,
  opts: { timeoutMs?: number; fetch?: typeof fetch } = {}
): KithClient {
  return new KithClient({
    baseUrl: cfg.baseUrl,
    credential: serviceKeyCredential(cfg.apiKey),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
  });
}
