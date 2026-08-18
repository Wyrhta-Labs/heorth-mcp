import type { AppConfig } from '../config/env.js';
import { createHeorthClient, type HeorthClient } from './heorth.js';
import { createKithClient, type KithClient } from './kith.js';

export * from './errors.js';
export * from './http.js';
export * from './heorth.js';
export * from './kith.js';

/**
 * The upstream clients available to a tool handler. A client is present exactly
 * when its upstream is configured — and the tools for an unconfigured upstream
 * are never registered, so a handler that finds its client missing is a bug, not
 * a runtime condition to handle politely.
 */
export interface Upstreams {
  heorth?: HeorthClient;
  kith?: KithClient;
}

/**
 * Runtime — the process-wide part of the upstream wiring: the validated config
 * and the `fetch` used to reach upstreams. The Heorth client itself is *not*
 * here: it is bound to a caller's key and therefore built per request.
 *
 * Same `get*Runtime`/`set*Runtime` seam as Heorth's `src/modules/kith/runtime.ts`,
 * so tests install a fake-upstream-backed runtime and never touch the network.
 */
export interface UpstreamRuntime {
  config: AppConfig;
  fetch: typeof fetch;
  /** Process-scoped because its credential is process-scoped (ADR 0002 Phase A). */
  kith: KithClient | null;
}

export function createUpstreamRuntime(
  config: AppConfig,
  fetchImpl: typeof fetch = fetch
): UpstreamRuntime {
  return {
    config,
    fetch: fetchImpl,
    kith: config.kith
      ? createKithClient(config.kith, { timeoutMs: config.timeoutMs, fetch: fetchImpl })
      : null,
  };
}

let runtime: UpstreamRuntime | null = null;

export function getUpstreamRuntime(): UpstreamRuntime {
  if (!runtime) throw new Error('UPSTREAM_RUNTIME_NOT_INITIALISED');
  return runtime;
}

/** Install a runtime (production wiring at boot; a fake upstream in tests). */
export function setUpstreamRuntime(next: UpstreamRuntime | null): void {
  runtime = next;
}

/**
 * Assemble the per-request upstream set. The caller's `Authorization` header is
 * required as soon as Heorth is configured — a missing or malformed one throws
 * `MCP_UNAUTHORIZED` here, before any upstream call.
 */
export function upstreamsForRequest(
  rt: UpstreamRuntime,
  authorization: string | undefined
): Upstreams {
  const upstreams: Upstreams = {};
  if (rt.config.heorth) {
    upstreams.heorth = createHeorthClient(rt.config.heorth, authorization, {
      timeoutMs: rt.config.timeoutMs,
      fetch: rt.fetch,
    });
  }
  if (rt.kith) upstreams.kith = rt.kith;
  return upstreams;
}
