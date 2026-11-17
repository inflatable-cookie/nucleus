/**
 * Spec 065: the one way an ACP session is bound to a Nucleus task.
 *
 * The agent is launched by an ACP client that knows nothing about Nucleus, so it
 * cannot receive a task identity: free text in a prompt is never evidence. Nucleus
 * mints the binding instead — one owner-only record per task, holding a hash of a
 * fresh random token, plus one owner-only pointer in that task's checkout. The agent
 * finds the pointer by its working directory (the task's worktree), presents the
 * token, and the service answers only for the task the record names.
 *
 * Both files live under `<data home>/acp/`: never in the checkout, so a bound
 * session cannot appear in `git status` or be committed by accident. Credentials are
 * owner-only and are never logged, returned over an RPC, or printed by the CLI.
 *
 * Two files rather than one is what makes revocation and relaunch work:
 * - `sessions/<task id>.json` is the authority. Minting again for the same task
 *   overwrites it, so every earlier token stops working at once.
 * - `bindings/<sha256(directory)>.json` is the pointer the agent reads. It is
 *   derived from the checkout, so a relaunched agent finds the same session.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeOwnedJson } from "../machine/owned-file.mjs";
import { digest } from "../store/store";
import { UnauthorizedCallbackError } from "../store/store-auth";

export const ACP_SESSION_FORMAT = "nucleus.acp.session";
export const ACP_BINDING_FORMAT = "nucleus.acp.binding";

/** The task id names the session file, so it is bounded to a filename-safe alphabet. */
const taskIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/, "A task id is a bounded identifier");

/** The authority record: one per task, replaced whenever a session is minted again. */
export const acpSessionRecordSchema = z
  .object({
    format: z.literal(ACP_SESSION_FORMAT),
    version: z.literal(1),
    sessionId: z.string().uuid(),
    taskId: taskIdSchema,
    /** `sha256(token)`; the token itself is never stored here. */
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type AcpSessionRecord = z.infer<typeof acpSessionRecordSchema>;

/** The pointer the agent reads: the credential plus how to reach the service. */
export const acpBindingSchema = z
  .object({
    format: z.literal(ACP_BINDING_FORMAT),
    version: z.literal(1),
    sessionId: z.string().uuid(),
    taskId: taskIdSchema,
    socketPath: z.string().min(1),
    token: z.string().min(1),
    /**
     * An optional regular-expression source, supplied by whichever host minted the
     * binding: prompts that match it are the host waking its own thread, not a person
     * speaking to the task. It is the agent's only host-shaped rule, and it arrives as
     * configuration rather than parsed text.
     */
    ignorePattern: z.string().min(1).max(400).optional(),
  })
  .strict();
export type AcpBinding = z.infer<typeof acpBindingSchema>;

/** Every ACP file lives here, directly under the data home. */
export const acpRoot = (dataHome: string): string => join(dataHome, "acp");
export const acpSessionsDir = (dataHome: string): string => join(acpRoot(dataHome), "sessions");
export const acpBindingsDir = (dataHome: string): string => join(acpRoot(dataHome), "bindings");

const fileKey = (value: string): string => createHash("sha256").update(value).digest("hex");

/** The authority record for one task. */
export const acpSessionPath = (dataHome: string, taskId: string): string =>
  join(acpSessionsDir(dataHome), `${taskIdSchema.parse(taskId)}.json`);

/**
 * The pointer for one checkout. It is keyed by the absolute directory the client
 * launches the agent in, so it needs no thread or host identity — the same rule
 * works for any ACP-capable app.
 */
export const acpBindingPath = (dataHome: string, directory: string): string =>
  join(acpBindingsDir(dataHome), `${fileKey(canonicalPath(directory))}.json`);

/**
 * The checkout's canonical path when it exists, so a symlinked temporary directory and
 * the worktree the host records name the same binding. A checkout that does not exist
 * yet keeps the path as given.
 */
function canonicalPath(directory: string): string {
  try { return realpathSync(directory); }
  catch { return directory; }
}

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

export interface AcpSessionBinding {
  sessionId: string;
  taskId: string;
  /** Where the agent finds its credential; the token is in the file, never in this value. */
  bindingPath: string;
}

/**
 * Mint the one session a task may have. The record is written first: a crash between
 * the two writes leaves an authority no agent has read yet, which the next mint
 * replaces. The reverse order would leave a pointer to a token nothing accepts.
 */
export function mintAcpSession(input: MintAcpSessionInput): AcpSessionBinding {
  const taskId = taskIdSchema.parse(input.taskId);
  const directory = z.string().min(1).parse(input.directory);
  const sessionId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const record: AcpSessionRecord = acpSessionRecordSchema.parse({
    format: ACP_SESSION_FORMAT,
    version: 1,
    sessionId,
    taskId,
    tokenHash: digest(token),
    createdAt: (input.now ?? (() => new Date().toISOString()))(),
  });
  const bindingPath = acpBindingPath(input.dataHome, directory);
  for (const dir of [acpSessionsDir(input.dataHome), acpBindingsDir(input.dataHome)]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeOwnedJson(acpSessionPath(input.dataHome, taskId), record, { syncDirectory: "required" });
  writeOwnedJson(bindingPath, acpBindingSchema.parse({
    format: ACP_BINDING_FORMAT, version: 1, sessionId, taskId, socketPath: input.socketPath, token,
    ...(input.ignorePattern ? { ignorePattern: input.ignorePattern } : {}),
  }), { syncDirectory: "required" });
  return { sessionId, taskId, bindingPath };
}

/** A refusal that names the file, so an operator can see which checkout has no binding. */
export class AcpBindingError extends Error {
  constructor(message: string) { super(message); this.name = "AcpBindingError"; }
}

/** Read one binding pointer. A missing or malformed file refuses; it is never guessed. */
export function readAcpBinding(path: string): AcpBinding {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT")
      throw new AcpBindingError(`No Nucleus ACP binding at ${path}; Nucleus mints one when it opens the task's thread, and never from text in a prompt`);
    throw new AcpBindingError(`Nucleus ACP binding at ${path} could not be read (${code ?? "error"})`);
  }
  try { return acpBindingSchema.parse(JSON.parse(text)); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AcpBindingError(`Nucleus ACP binding at ${path} is not a binding Nucleus minted: ${detail}`);
  }
}

/** Which binding file the agent should read: the explicit override, else the checkout's own. */
export function acpBindingPathFor(directory: string, dataHome: string, override?: string | null): string {
  const chosen = typeof override === "string" ? override.trim() : "";
  return chosen ? chosen : acpBindingPath(dataHome, directory);
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
