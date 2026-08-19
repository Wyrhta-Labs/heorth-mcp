import { createHash } from 'node:crypto';
import { UpstreamError } from './errors.js';
import { RestTransport } from './http.js';
import type { KithCredential } from './kith.js';

/**
 * ── SATELLITE TOKEN EXCHANGE (ADR 0009) ─────────────────────────────────────
 *
 * An MCP client presents `Authorization: Bearer he_...`. KithLedger requires a
 * **member** JWT, because ADR 0004 enforces per-member access control and none
 * of KithLedger's three credential kinds carries the calling member's identity
 * (a `member`-kinded `kl_` key reads as the issuing account's personal scope, a
 * `household` one sees only the household slice, an `ops` one has no data
 * access at all). Only Heorth can bridge the two — it is the sole authority on
 * who the household's members are.
 *
 * So this module trades the caller's credential for a short-lived,
 * audience-bound member token:
 *
 *   POST {HEORTH_BASE_URL}/api/v1/auth/satellite-token
 *   Authorization: <the caller's own header, verbatim>
 *   { "audience": "kithledger" }
 *   -> { data: { token, expires_in, audience } }
 *
 * **heorth-mcp stays unmintable.** It holds no signing key and must never
 * acquire one: it only asks Heorth, with a credential the caller supplied, and
 * forwards the answer. A full compromise of this container yields at most the
 * tokens of members who called it inside the cache window.
 */

/** Where Heorth mints satellite tokens, below its `/api/v1` prefix. */
export const SATELLITE_TOKEN_PATH = '/auth/satellite-token';

/**
 * ADR 0009: evict at `exp - 30s`. The margin covers the in-flight KithLedger
 * call, so a token handed out here is still valid when it is verified there.
 */
export const CACHE_EVICTION_MARGIN_MS = 30_000;

/** Heorth's response body for a successful exchange. */
interface SatelliteTokenEnvelope {
  data?: { token?: unknown; expires_in?: unknown; audience?: unknown };
}

interface CacheEntry {
  token: string;
  /** Epoch ms after which this entry is no longer served (`exp - 30s`). */
  usableUntil: number;
}

export interface SatelliteTokenExchangeOptions {
  /** Heorth's base URL — the identity authority, not KithLedger's. */
  heorthBaseUrl: string;
  /** The satellite this token is for; must be registered in Heorth. */
  audience: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Injectable clock, so expiry is testable without waiting. */
  now?: () => number;
}

/**
 * Exchanges caller credentials for satellite tokens, with the cache ADR 0009
 * mandates.
 *
 * **The cache rules are security requirements, not optimisations:**
 *
 * - **In memory only.** A `Map` on this instance — never written to disk, never
 *   logged, never serialised into an error message.
 * - **Keyed by `sha256(presented credential)` plus the audience.** Anything
 *   coarser (one entry per process, per audience alone, per upstream) would let
 *   one member act as another, because two callers would share one token. The
 *   hash is what is held, so the cache separates callers without ever storing
 *   their keys.
 * - **Evicted at `exp - 30s`**, computed from the `expires_in` Heorth returns —
 *   the token itself is never parsed here.
 *
 * The instance is process-scoped (it *is* the cache), but every entry is bound
 * to one caller, and the `KithClient` built from it is per request: see
 * `credentialFor`.
 */
export class SatelliteTokenExchange {
  private readonly cache = new Map<string, CacheEntry>();
  /** One in-flight exchange per cache key, so a burst mints once, not N times. */
  private readonly inFlight = new Map<string, Promise<CacheEntry>>();
  private readonly transport: RestTransport;
  private readonly audience: string;
  private readonly now: () => number;

  constructor(opts: SatelliteTokenExchangeOptions) {
    this.audience = opts.audience;
    this.now = opts.now ?? Date.now;
    this.transport = new RestTransport({
      baseUrl: opts.heorthBaseUrl,
      upstream: 'heorth',
      // Supplied per call by `mint`: the caller's own header is what
      // authenticates the exchange, so it cannot be bound at construction —
      // this transport is shared by every caller.
      authorization: () => {
        throw new UpstreamError('TOKEN_EXCHANGE_FAILED', 'heorth', 'bad_response');
      },
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
    });
  }

  /**
   * The `KithCredential` for one caller. Handing out a credential rather than a
   * token is what keeps the exchange lazy: it happens on the first `kith.*`
   * call the caller actually makes, and a cache hit costs nothing.
   */
  credentialFor(callerAuthorization: string): KithCredential {
    return { authorization: () => this.authorizationFor(callerAuthorization) };
  }

  /** The `Authorization` header KithLedger sees — never the caller's `he_` key. */
  async authorizationFor(callerAuthorization: string): Promise<string> {
    const key = this.cacheKey(callerAuthorization);
    const hit = this.cache.get(key);
    if (hit && hit.usableUntil > this.now()) return `Bearer ${hit.token}`;

    const pending =
      this.inFlight.get(key) ??
      this.mint(callerAuthorization)
        .then((entry) => {
          this.cache.set(key, entry);
          return entry;
        })
        .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);

    return `Bearer ${(await pending).token}`;
  }

  /** Drop every cached token. For tests, and for a deliberate flush. */
  clear(): void {
    this.cache.clear();
  }

  /**
   * `sha256(credential)` plus the audience. The credential is hashed, not
   * stored, and the audience is part of the key because one caller may hold
   * tokens for several satellites at once.
   */
  private cacheKey(callerAuthorization: string): string {
    const digest = createHash('sha256').update(callerAuthorization).digest('hex');
    return `${digest}|${this.audience}`;
  }

  /**
   * One exchange. Every failure becomes a domain code — `kith.*` tools fail
   * cleanly when Heorth is unreachable (an accepted cost of ADR 0009: Heorth is
   * the identity authority) rather than with a stack trace, and no token or key
   * material can reach the message.
   */
  private async mint(callerAuthorization: string): Promise<CacheEntry> {
    let body: SatelliteTokenEnvelope;
    try {
      body = await this.transport.request<SatelliteTokenEnvelope>({
        method: 'POST',
        path: SATELLITE_TOKEN_PATH,
        body: { audience: this.audience },
        authorization: callerAuthorization,
      });
    } catch (error) {
      throw exchangeError(error);
    }

    const token = body?.data?.token;
    const expiresIn = body?.data?.expires_in;
    if (typeof token !== 'string' || token.length === 0 || typeof expiresIn !== 'number') {
      // Heorth answered 2xx with something that is not a token. Nothing of the
      // body reaches the message.
      throw new UpstreamError('TOKEN_EXCHANGE_FAILED', 'heorth', 'bad_response');
    }

    return { token, usableUntil: this.now() + expiresIn * 1000 - CACHE_EVICTION_MARGIN_MS };
  }
}

/**
 * Classify an exchange failure into a code an MCP client can act on.
 *
 * - Heorth unreachable or slow -> `IDENTITY_UNAVAILABLE`. Distinct from
 *   `UPSTREAM_UNAVAILABLE` on purpose: KithLedger may be perfectly healthy and
 *   it is still the identity hop that failed.
 * - A refusal Heorth named (`UNKNOWN_AUDIENCE`, `SATELLITE_SIGNING_UNAVAILABLE`,
 *   an auth code) passes through as itself.
 * - Anything else -> `TOKEN_EXCHANGE_FAILED`.
 */
function exchangeError(error: unknown): UpstreamError {
  if (error instanceof UpstreamError) {
    if (error.kind === 'timeout' || error.kind === 'network') {
      return new UpstreamError('IDENTITY_UNAVAILABLE', 'heorth', error.kind, error.status, error);
    }
    if (error.message === 'tool error') {
      return new UpstreamError('TOKEN_EXCHANGE_FAILED', 'heorth', error.kind, error.status, error);
    }
    return error;
  }
  return new UpstreamError('TOKEN_EXCHANGE_FAILED', 'heorth', 'bad_response', undefined, error);
}
