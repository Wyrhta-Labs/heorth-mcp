import { UpstreamError, mapUpstreamErrorCode } from './errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type QueryValue = string | number | boolean | undefined | null;

export interface UpstreamRequest {
  method: HttpMethod;
  /** Path below the API prefix, e.g. `/calendar` or `/people/${id}`. */
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export interface RestTransportOptions {
  baseUrl: string;
  upstream: 'heorth' | 'kith';
  /**
   * The `Authorization` header value for every request. A function, not a
   * string, so a credential can be resolved per call (see src/upstream/kith.ts).
   */
  authorization: () => string | Promise<string>;
  /** Path prefix below the base URL. Both upstreams serve `/api/v1`. */
  prefix?: string;
  /** Per-request timeout in milliseconds (default 10000). */
  timeoutMs?: number;
  /** Injectable fetch — defaults to the global. Tests pass a fake upstream. */
  fetch?: typeof fetch;
}

/**
 * The transport both upstream clients share: base-URL joining, the
 * `Authorization` header, an `AbortController` timeout, JSON in and out, and
 * classified errors. It is deliberately the only place in this repo that calls
 * `fetch` — tool handlers never do (CLAUDE.md, "Upstream calls").
 */
export class RestTransport {
  private readonly baseUrl: string;
  private readonly prefix: string;
  private readonly upstream: 'heorth' | 'kith';
  private readonly authorization: () => string | Promise<string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RestTransportOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.prefix = opts.prefix ?? '/api/v1';
    this.upstream = opts.upstream;
    this.authorization = opts.authorization;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private url(path: string, query?: Record<string, QueryValue>): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
    const qs = params.toString();
    return `${this.baseUrl}${this.prefix}${path}${qs ? `?${qs}` : ''}`;
  }

  /**
   * Perform one request. Resolves to the parsed JSON body (`undefined` for an
   * empty/`204` response); rejects with an {@link UpstreamError} whose message
   * is already safe to show an MCP client.
   */
  async request<T>(req: UpstreamRequest): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: await this.authorization(),
        Accept: 'application/json',
      };
      if (req.body !== undefined) headers['Content-Type'] = 'application/json';

      const res = await this.fetchImpl(this.url(req.path, req.query), {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: controller.signal,
      });

      const text = await res.text();
      let parsed: unknown;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          if (res.ok) {
            throw new UpstreamError(
              'tool error',
              this.upstream,
              'bad_response',
              res.status,
              e
            );
          }
        }
      }

      if (!res.ok) {
        throw new UpstreamError(
          mapUpstreamErrorCode(parsed),
          this.upstream,
          'domain',
          res.status
        );
      }
      return parsed as T;
    } catch (e: unknown) {
      if (e instanceof UpstreamError) throw e;
      if (controller.signal.aborted) {
        throw new UpstreamError('UPSTREAM_TIMEOUT', this.upstream, 'timeout', undefined, e);
      }
      // Connection refused, DNS failure, TLS error — the upstream is simply not
      // there. The message carries no URL, so nothing leaks to the client.
      throw new UpstreamError('UPSTREAM_UNAVAILABLE', this.upstream, 'network', undefined, e);
    } finally {
      clearTimeout(timer);
    }
  }
}
