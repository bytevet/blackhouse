/**
 * Egress enforcement (Phase 6).
 *
 * - `allowlist.ts`     the pure, security-critical matcher (mirrored into the proxy)
 * - `rules.ts`         effective allowlist resolution + the policy key
 * - `proxy-manager.ts` internal networks and the shared CONNECT proxy
 * - `attach.ts`        policy to container configuration, and the enforcement gate
 */

export * from "./allowlist.js";
export * from "./rules.js";
export * from "./proxy-manager.js";
export * from "./attach.js";
