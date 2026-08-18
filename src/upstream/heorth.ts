import type { HeorthUpstreamConfig } from '../config/env.js';
import { RestTransport, type QueryValue } from './http.js';

/**
 * Thrown when the caller presented no usable `Authorization` header. It fails
 * the request *before* any upstream call, and its message is a domain code, so
 * the client learns it is unauthorized and nothing more.
 */
export class MissingCallerKeyError extends Error {
  constructor() {
    super('MCP_UNAUTHORIZED');
    this.name = 'MissingCallerKeyError';
  }
}

/**
 * Extract the caller's `Authorization` header value, verbatim.
 *
 * heorth-mcp holds no Heorth credential of its own: the caller's
 * `Bearer he_...` is what reaches Heorth, so per-member permissions and
 * Heorth's audit log stay intact end to end. Only the *shape* is checked here —
 * whether the key is valid, and what member it belongs to, is Heorth's answer
 * to give.
 */
export function callerAuthorization(req: Request): string | undefined {
  const header = req.headers.get('Authorization');
  if (!header) return undefined;
  if (!/^Bearer\s+\S+$/.test(header)) return undefined;
  return header;
}

export interface HeorthClientOptions {
  baseUrl: string;
  /** The caller's `Authorization` header, forwarded verbatim. */
  authorization: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Typed REST client for Heorth's `/api/v1/*` surface, bound to one caller's key.
 *
 * It is request-scoped by construction — never hoist an instance to process
 * scope, or one member's key would serve another's call.
 */
export class HeorthClient {
  private readonly transport: RestTransport;

  constructor(opts: HeorthClientOptions) {
    if (!/^Bearer\s+\S+$/.test(opts.authorization ?? '')) throw new MissingCallerKeyError();
    const authorization = opts.authorization;
    this.transport = new RestTransport({
      baseUrl: opts.baseUrl,
      upstream: 'heorth',
      authorization: () => authorization,
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

  /**
   * `GET` a route whose success body is plain text, not the JSON envelope
   * (`/feoh/export`). Errors still arrive as the envelope and are classified
   * identically to every other call.
   */
  getText(path: string, query?: Record<string, QueryValue>): Promise<string> {
    return this.transport.requestText({ method: 'GET', path, ...(query ? { query } : {}) });
  }

  /**
   * `POST` a raw text body to a route that reads `c.req.text()` rather than
   * `c.req.json()` (`/feoh/import`). The response is still the JSON envelope.
   */
  postText<T>(path: string, content: string, contentType?: string): Promise<T> {
    return this.transport.request<T>({
      method: 'POST',
      path,
      textBody: { content, ...(contentType === undefined ? {} : { contentType }) },
    });
  }

  delete<T>(path: string): Promise<T> {
    return this.transport.request<T>({ method: 'DELETE', path });
  }
}

/** Build a caller-bound Heorth client, or throw `MCP_UNAUTHORIZED`. */
export function createHeorthClient(
  cfg: HeorthUpstreamConfig,
  authorization: string | undefined,
  opts: { timeoutMs?: number; fetch?: typeof fetch } = {}
): HeorthClient {
  if (!authorization) throw new MissingCallerKeyError();
  return new HeorthClient({
    baseUrl: cfg.baseUrl,
    authorization,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
  });
}
