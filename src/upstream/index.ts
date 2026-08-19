import type { AppConfig } from '../config/env.js';
import { createHeorthClient, type HeorthClient } from './heorth.js';
import { createKithClient, type KithClient } from './kith.js';
import { SatelliteTokenExchange } from './exchange.js';

export * from './errors.js';
export * from './http.js';
export * from './heorth.js';
export * from './kith.js';
export * from './exchange.js';

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
 * Runtime — the process-wide part of the upstream wiring: the validated config,
 * the `fetch` used to reach upstreams, and the satellite token cache. Neither
 * upstream *client* is here: both are bound to a caller's credential and are
 * therefore built per request.
 *
 * Same `get*Runtime`/`set*Runtime` seam as Heorth's `src/modules/kith/runtime.ts`,
 * so tests install a fake-upstream-backed runtime and never touch the network.
 */
export interface UpstreamRuntime {
  config: AppConfig;
  fetch: typeof fetch;
  /**
   * Process-scoped because the *cache* is process-scoped (ADR 0009) — but every
   * entry in it is keyed to one caller, and the client built from it is not.
   */
  exchange: SatelliteTokenExchange | null;
}

export function createUpstreamRuntime(
  config: AppConfig,
  fetchImpl: typeof fetch = fetch
): UpstreamRuntime {
  return {
    config,
    fetch: fetchImpl,
    // `config.kith` is non-null only when Heorth is configured too (see
    // src/config/env.ts) — `kith.*` cannot authenticate without the exchange.
    exchange:
      config.kith && config.heorth
        ? new SatelliteTokenExchange({
            heorthBaseUrl: config.heorth.baseUrl,
            audience: config.kith.audience,
            timeoutMs: config.timeoutMs,
            fetch: fetchImpl,
          })
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
  // KithLedger is reached with a member token exchanged for *this* caller's
  // credential (ADR 0009), so its client is per request too — and the exchange
  // is lazy: no token is minted unless a `kith.*` tool is actually called.
  if (rt.config.kith && rt.exchange && authorization) {
    upstreams.kith = createKithClient(rt.config.kith, rt.exchange.credentialFor(authorization), {
      timeoutMs: rt.config.timeoutMs,
      fetch: rt.fetch,
    });
  }
  return upstreams;
}
