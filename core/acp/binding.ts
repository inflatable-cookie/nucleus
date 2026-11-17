/**
 * Spec 065: minting and verifying a task's ACP session.
 *
 * `shared/acp/binding.ts` holds the shapes, the paths and the pointer read. This
 * half is the service's authority over them, so it is where the store's token digest
 * and its one unauthorized-callback refusal live.
 *
 * Minting writes the authority record first: a crash between the two writes leaves a
 * record no agent has read yet, which the next mint replaces. The reverse order would
 * leave a pointer to a token nothing accepts.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { ACP_BINDING_FORMAT, ACP_SESSION_FORMAT, acpBindingPath, acpBindingSchema, acpBindingsDir, acpSessionPath, acpSessionRecordSchema, acpSessionsDir,
  type AcpSessionRecord, type AcpBinding } from "../../shared/acp/binding";
import type { AcpSessionBinding } from "../../shared/acp/surface";
import { writeOwnedJson } from "../machine/owned-file.mjs";
import { digest } from "../store/store";
import { UnauthorizedCallbackError } from "../store/store-auth";

export interface MintAcpSessionInput {
  dataHome: string;
  socketPath: string;
  taskId: string;
  /** The checkout the agent will be launched in: the task's worktree. */
  directory: string;
  /** A host's own waking-prompt rule for this session (see `acpBindingSchema`). */
  ignorePattern?: string;
  now?: () => string;
}

/** Mint the one session a task may have, with its owner-only pointer. */
export function mintAcpSession(input: MintAcpSessionInput): AcpSessionBinding {
  const sessionId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const record: AcpSessionRecord = acpSessionRecordSchema.parse({
    format: ACP_SESSION_FORMAT,
    version: 1,
    sessionId,
    taskId: input.taskId,
    tokenHash: digest(token),
    createdAt: (input.now ?? (() => new Date().toISOString()))(),
  });
  const binding: AcpBinding = acpBindingSchema.parse({
    format: ACP_BINDING_FORMAT, version: 1, sessionId, taskId: record.taskId,
    socketPath: input.socketPath, token,
    ...(input.ignorePattern ? { ignorePattern: input.ignorePattern } : {}),
  });
  const bindingPath = acpBindingPath(input.dataHome, input.directory);
  for (const dir of [acpSessionsDir(input.dataHome), acpBindingsDir(input.dataHome)]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeOwnedJson(acpSessionPath(input.dataHome, record.taskId), record, { syncDirectory: "required" });
  writeOwnedJson(bindingPath, binding, { syncDirectory: "required" });
  return { sessionId, taskId: record.taskId, bindingPath };
}

export interface VerifyAcpSessionInput { dataHome: string; taskId: string; sessionId: string }

/**
 * Authenticate one session request. The answer comes from the record, never from the
 * request: a token for a replaced session, another task's record, or an unknown task
 * all refuse as the store's one unauthorized-callback class, so the socket answers
 * 401 and no refusal text distinguishes "wrong token" from "no session".
 */
export function verifyAcpSession(input: VerifyAcpSessionInput, token: string): AcpSessionRecord {
  let record: AcpSessionRecord;
  try {
    record = acpSessionRecordSchema.parse(JSON.parse(readFileSync(acpSessionPath(input.dataHome, input.taskId), "utf8")));
  } catch {
    throw new UnauthorizedCallbackError();
  }
  if (record.taskId !== input.taskId || record.sessionId !== input.sessionId || record.tokenHash !== digest(token))
    throw new UnauthorizedCallbackError();
  return record;
}
