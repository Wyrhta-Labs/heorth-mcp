/**
 * The one error type upstream clients throw.
 *
 * Its `message` is what the MCP scaffold shows the caller, so it may only ever
 * be an UPPER_SNAKE_CASE code or the generic `tool error` — never an upstream
 * URL, header, body, or stack trace. Diagnostics live in the (never-rendered)
 * `status`/`upstream`/`cause` fields and in the server log.
 */
export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly upstream: 'heorth' | 'kith',
    public readonly kind: 'domain' | 'timeout' | 'network' | 'bad_response',
    public readonly status?: number,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/** The same convention the MCP scaffold enforces on tool error text. */
const DOMAIN_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * Map an upstream `{ error: { code, message } }` envelope onto tool error text.
 * A well-formed `code` passes straight through; anything else — a missing
 * envelope, an HTML error page, a lowercase or over-long code — becomes the
 * generic `tool error`, which is also what the scaffold would render for it.
 */
export function mapUpstreamErrorCode(body: unknown): string {
  const code =
    typeof body === 'object' && body !== null
      ? (body as { error?: { code?: unknown } }).error?.code
      : undefined;
  return typeof code === 'string' && DOMAIN_ERROR_CODE.test(code) ? code : 'tool error';
}
