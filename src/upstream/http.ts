import { UpstreamError, mapUpstreamErrorCode } from './errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type QueryValue = string | number | boolean | undefined | null;

export interface UpstreamRequest {
  method: HttpMethod;
  /** Path below the API prefix, e.g. `/calendar` or `/people/${id}`. */
  path: string;
  query?: Record<string, QueryValue>;
  /** JSON request body — `JSON.stringify`d and sent as `application/json`. */
  body?: unknown;
  /**
   * Raw request body, sent verbatim with a non-JSON `Content-Type`. For the
   * upstream routes that read `c.req.text()` instead of `c.req.json()` —
   * today only `POST /feoh/import`. Wins over {@link UpstreamRequest.body};
   * set one or the other, never both.
   */
  textBody?: TextBody;
  /**
   * `Authorization` for this one request, overriding the transport's own.
   * Needed by the satellite token exchange (`src/upstream/exchange.ts`), whose
   * transport is shared by every caller while the credential that authenticates
   * an exchange is the *caller's* — it cannot be bound at construction.
   */
  authorization?: string;
}

/** A raw (non-JSON) request body and the `Content-Type` it is sent under. */
export interface TextBody {
  content: string;
  /** Default `text/plain; charset=utf-8`. */
  contentType?: string;
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
    const { res, text } = await this.exchange(req, 'application/json');
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      // A 2xx that is not JSON where JSON was expected: the route answered, but
      // not with the envelope this client speaks.
      throw new UpstreamError('tool error', this.upstream, 'bad_response', res.status, e);
    }
  }

  /**
   * Perform one request whose *successful* response is plain text rather than
   * the `{ data, meta }` envelope — `GET /feoh/export`, which answers
   * `text/plain`. Errors are unchanged: a non-2xx still carries the JSON error
   * envelope and is classified exactly as on the JSON path.
   */
  async requestText(req: UpstreamRequest): Promise<string> {
    const { text } = await this.exchange(req, 'text/plain, application/json');
    return text;
  }

  /**
   * The one place this repo calls `fetch`: URL joining, the `Authorization`
   * header, the timeout, and error classification. It returns the raw response
   * text and leaves the decoding to the caller, so the JSON and text paths
   * differ only in how a *successful* body is read — a non-2xx is mapped
   * through {@link mapUpstreamErrorCode} either way.
   *
   * Nothing that could carry upstream URLs, headers, bodies or key material
   * ever reaches an `UpstreamError` message.
   */
  private async exchange(
    req: UpstreamRequest,
    accept: string
  ): Promise<{ res: Response; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: req.authorization ?? (await this.authorization()),
        Accept: accept,
      };

      let body: string | undefined;
      if (req.textBody !== undefined) {
        body = req.textBody.content;
        headers['Content-Type'] = req.textBody.contentType ?? 'text/plain; charset=utf-8';
      } else if (req.body !== undefined) {
        body = JSON.stringify(req.body);
        headers['Content-Type'] = 'application/json';
      }

      const res = await this.fetchImpl(this.url(req.path, req.query), {
        method: req.method,
        headers,
        body,
        signal: controller.signal,
      });

      const text = await res.text();

      if (!res.ok) {
        let parsed: unknown;
        if (text.length > 0) {
          try {
            parsed = JSON.parse(text);
          } catch {
            // An error page that is not the envelope — `mapUpstreamErrorCode`
            // turns that into the generic `tool error`.
          }
        }
        throw new UpstreamError(
          mapUpstreamErrorCode(parsed),
          this.upstream,
          'domain',
          res.status
        );
      }

      return { res, text };
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
