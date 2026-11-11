import { createHmac, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { hostRunTokenClaimsSchema, type HostRunTokenKeys, type HostRunTokenClaims } from "../service/callbacks/host-run-endpoint";
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const b64url = (value: Buffer) => value.toString("base64url");
const hmac = (key: string, value: string) => createHmac("sha256", Buffer.from(key, "base64")).update(value).digest();

export type HostRunTokenVerification =
  | { valid: true; claims: HostRunTokenClaims; key: "current" | "previous" }
  | { valid: false; reason: "malformed" | "expired" | "wrong_root" | "bad_signature" | "epoch" | "unknown_run" };

export interface VerifyRunTokenOptions {
  keys: HostRunTokenKeys;
  /** The authority file's current epoch. */
  epoch: number;
  /** The client's cwd, compared after `realpath`. */
  cwd: string;
  now?: number;
  /** Contract 010: a previous-epoch token is valid only when the run is running under the new holder. */
  takeover?: (runId: string) => boolean;
}

/** Contract 010 compares paths only after `realpath`; a path that cannot be resolved is invalid. */
function canonicalPath(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}
const withinRoot = (cwd: string, root: string) => cwd === root || cwd.startsWith(root + "/");

export function verifyRunToken(token: string, options: VerifyRunTokenOptions): HostRunTokenVerification {
  const parts = token.split(".");
  // Contract 010 at 16fcb59: both parts are unpadded RFC 4648 §5 base64url; other spellings are refused.
  if (parts.length !== 2 || !BASE64URL.test(parts[0]) || !BASE64URL.test(parts[1])) return { valid: false, reason: "malformed" };
  let claims: HostRunTokenClaims;
  try { claims = hostRunTokenClaimsSchema.parse(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"))); }
  catch { return { valid: false, reason: "malformed" }; }
  const now = options.now ?? Date.now();
  // Valid only while now_ms < exp: a token expires at exp exactly.
  if (now >= claims.exp) return { valid: false, reason: "expired" };
  const root = canonicalPath(claims.root);
  const cwd = canonicalPath(options.cwd);
  if (!root || !cwd || !withinRoot(cwd, root)) return { valid: false, reason: "wrong_root" };
  const expected = b64url(hmac(options.keys.current.keyB64, parts[0]));
  if (claims.epoch === options.keys.current.epoch && claims.epoch === options.epoch && sameSignature(parts[1], expected))
    return { valid: true, claims, key: "current" };
  const previous = options.keys.previous;
  if (previous && claims.epoch === previous.epoch && claims.epoch === options.epoch - 1) {
    const previousExpected = b64url(hmac(previous.keyB64, parts[0]));
    if (sameSignature(parts[1], previousExpected)) {
      if (!options.takeover) return { valid: false, reason: "epoch" };
      return options.takeover(claims.runId) ? { valid: true, claims, key: "previous" } : { valid: false, reason: "unknown_run" };
    }
  }
  if (claims.epoch !== options.epoch) return { valid: false, reason: "epoch" };
  return { valid: false, reason: "bad_signature" };
}

function sameSignature(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

