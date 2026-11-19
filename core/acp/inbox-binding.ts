/** Mint and verify the decision-only credential for a host's inbox. */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { acpBindingPath } from "../../shared/acp/binding";
import { ACP_INBOX_FORMAT, acpInboxBindingSchema, acpInboxDirectory, acpInboxRecordPath, acpInboxRecordSchema } from "../../shared/acp/inbox-binding";
import { writeOwnedJson } from "../machine/owned-file.mjs";
import { digest } from "../store/store";
import { UnauthorizedCallbackError } from "../store/store-auth";

/** A new mint replaces the authority record and revokes the prior inbox credential. */
export function mintAcpInbox(input: { dataHome: string; socketPath: string; hostId: string; ignorePattern?: string; holdPattern?: string }) {
  const directory = acpInboxDirectory(input.dataHome, input.hostId);
  const sessionId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const binding = acpInboxBindingSchema.parse({ format: ACP_INBOX_FORMAT, version: 1, kind: "inbox", hostId: input.hostId,
    sessionId, socketPath: input.socketPath, token,
    ...(input.ignorePattern ? { ignorePattern: input.ignorePattern } : {}),
    ...(input.holdPattern ? { holdPattern: input.holdPattern } : {}) });
  const record = acpInboxRecordSchema.parse({ format: binding.format, version: binding.version, kind: binding.kind,
    hostId: binding.hostId, sessionId, tokenHash: digest(token), createdAt: new Date().toISOString() });
  const recordPath = acpInboxRecordPath(input.dataHome, input.hostId);
  const bindingPath = acpBindingPath(input.dataHome, directory);
  for (const dir of [directory, dirname(recordPath), dirname(bindingPath)]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeOwnedJson(recordPath, record, { syncDirectory: "required" });
  writeOwnedJson(bindingPath, binding, { syncDirectory: "required" });
  return { sessionId, hostId: binding.hostId, directory, bindingPath };
}

export function verifyAcpInbox(input: { dataHome: string; hostId: string; sessionId: string }, token: string) {
  try {
    const record = acpInboxRecordSchema.parse(JSON.parse(readFileSync(acpInboxRecordPath(input.dataHome, input.hostId), "utf8")));
    if (record.hostId === input.hostId && record.sessionId === input.sessionId && record.tokenHash === digest(token)) return record;
  } catch { /* An unknown or malformed record is the same refusal as a wrong credential. */ }
  throw new UnauthorizedCallbackError();
}
