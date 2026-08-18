/**
 * Structured JSON logging — the same `logEvent`/`logError` shape `@wyrhta/core`
 * ships, kept local because heorth-mcp does not depend on core (ADR 0008).
 *
 * Never log key material: no `Authorization` header, no raw `he_`/`kl_` key.
 */
export interface LogEvent {
  timestamp?: string;
  event: string;
  request_id?: string;
  user_id?: string;
  tool?: string;
  upstream?: string;
  [key: string]: unknown;
}

export function logEvent(event: LogEvent): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...event }));
}

export function logError(message: string, error: unknown): void {
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(
    JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', message, stack })
  );
}
