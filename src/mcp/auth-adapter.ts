import { createHash } from 'node:crypto';
import type { AuthAdapter, McpPrincipal } from './types.js';

/**
 * A stable, non-reversible id for the presented key — enough to correlate a
 * caller's log lines, useless to anyone reading them. Key material is never
 * logged (CLAUDE.md, "Auth").
 */
export function keyFingerprint(authorization: string): string {
  return `key:${createHash('sha256').update(authorization).digest('hex').slice(0, 12)}`;
}

/**
 * The caller-bound auth adapter for one HTTP request.
 *
 * heorth-mcp does not validate the key: it has no Heorth credential, no member
 * table, and no business deciding who a `he_` key belongs to — Heorth answers
 * that on the forwarded call. So this only asserts that a caller presented one
 * at all, which is what lets a tool call fail before any upstream request when
 * the `Authorization` header is missing or malformed.
 */
export function createPassThroughAuthAdapter(authorization: string | undefined): AuthAdapter {
  return {
    async resolve(): Promise<McpPrincipal> {
      if (!authorization) throw new Error('MCP_UNAUTHORIZED');
      return { userId: keyFingerprint(authorization) };
    },
  };
}
