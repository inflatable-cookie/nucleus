/** Contract 010 run-token keys, claims and signing. */
import { createHmac } from "node:crypto";
import { z } from "zod";
import { defaultHostRunStateDir, readCheckedHostRunFile } from "./host-run-files";
export const HOST_RUN_KEYS_FORMAT = "host.run.keys";

// Contract 010 at 16fcb59: RFC 4648 §4 padded standard base64 of exactly 32 bytes (44 characters).
const KEY_B64 = /^[A-Za-z0-9+/]{43}=$/;
const hostRunKeySchema = z.object({ epoch: z.number().int().positive(),
  keyB64: z.string().regex(KEY_B64, "keyB64 must be 44-character padded base64 of 32 bytes").refine(value => Buffer.from(value, "base64").length === 32, "keyB64 must decode to 32 bytes") }).strict();
export const hostRunTokenKeysSchema = z.object({
  format: z.literal(HOST_RUN_KEYS_FORMAT),
  version: z.literal(1),
  current: hostRunKeySchema,
  previous: hostRunKeySchema.optional(),
}).strict();
export type HostRunTokenKeys = z.infer<typeof hostRunTokenKeysSchema>;

export const hostRunTokenClaimsSchema = z.object({
  runId: z.string().min(1).max(160),
  epoch: z.number().int().positive(),
  class: z.enum(["heavy", "light"]),
  root: z.string().min(1),
  exp: z.number().int().positive(),
}).strict();
export type HostRunTokenClaims = z.infer<typeof hostRunTokenClaimsSchema>;

/** Read the token key file under the same strict checks. */
export function readHostRunTokenKeys(stateDir = defaultHostRunStateDir()): HostRunTokenKeys | null {
  const raw = readCheckedHostRunFile(stateDir, ["token.key"]);
  if (!raw) return null;
  try { return hostRunTokenKeysSchema.parse(JSON.parse(raw.toString("utf8"))); }
  catch { return null; }
}

const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");
const hmac = (keyB64: string, payload: string) => createHmac("sha256", Buffer.from(keyB64, "base64")).update(payload).digest();

/** `base64url(JSON claims)` `.` `base64url(HMAC-SHA256(first part))`. */
export function signRunToken(claims: HostRunTokenClaims, keyB64: string): string {
  const payload = b64url(JSON.stringify(hostRunTokenClaimsSchema.parse(claims)));
  return `${payload}.${b64url(hmac(keyB64, payload))}`;
}

/** Sign a Queue-internal launch with the same current key used by client submissions. */
export function issueHostRunToken(stateDir: string, claims: HostRunTokenClaims): string {
  const parsed = hostRunTokenClaimsSchema.parse(claims);
  const keys = readHostRunTokenKeys(stateDir);
  if (!keys || keys.current.epoch !== parsed.epoch)
    throw new Error(`Host-run token key is unavailable for authority epoch ${parsed.epoch}`);
  return signRunToken(parsed, keys.current.keyB64);
}

/** Keep a process from persisting its own launch credential in captured output. */
export function redactHostRunToken(text: string, token: string | undefined): string {
  return token ? text.split(token).join("[REDACTED]") : text;
}

