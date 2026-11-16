/**
 * The reverse host-operation channel (Spec 062, phase 0).
 *
 * Contract 007's owner-only socket already carries authenticated requests in one
 * direction: a client writes a `ServiceRequest` and the service answers with a
 * `ServiceResponse`. A BB host needs the opposite direction, because the BB plugin
 * is the only supported executor of `bb.sdk` operations (Spec 062, decision 1).
 *
 * The addition is a role, not a shape: after the credential handshake a connection
 * declares `service.host-executor`, and on that same connection the service writes
 * ordinary `ServiceRequest` frames whose method is `host.op`, which the plugin
 * answers with ordinary `ServiceResponse` frames. Nothing in the framing changes,
 * so a client that never declares the role sees exactly the service it saw before,
 * and the presence claim, roll recovery and the catalogue path are untouched.
 *
 * This module is the vocabulary both ends share: the operation names, the
 * declaration, the identity derivation, the bounded result envelope and the
 * workspace handle shape. It carries no schema library so the plugin build can
 * import it without a dependency; `shared/service/host-channel.ts` owns the
 * strict schemas the service validates with.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

/** The role a connection declares to become a host executor. */
export const HOST_EXECUTOR_ROLE = "host-executor";
/** The handshake method a connection uses to declare that role. */
export const HOST_EXECUTOR_METHOD = "service.host-executor";
/** The method the service writes in the reverse direction on that connection. */
export const HOST_OPERATION_METHOD = "host.op";

/** The host-kind prefix; no host kind is registered in phase 0. */
export const BB_HOST_ID_PREFIX = "bb:";

/**
 * One operation's deadline. A BB call that has not answered by then settles the
 * operation as unknown delivery; it never settles the connection (Spec 062,
 * "Faults").
 */
export const HOST_OPERATION_DEADLINE_MS = 20_000;

/**
 * The bounded operation set this phase implements. Each name is one reverse
 * request; the plugin answers with one bounded projection, never a raw SDK row.
 */
export const HOST_OPERATIONS = [
  "identity.probe",
  "workspace.create",
  "workspace.inspect",
  "run.attach",
  "thread.observe",
  "thread.stop",
  "thread.cascade",
  "thread.archive",
  "thread.inventory",
  "thread.read",
  "thread.metadata",
  "thread.title",
  "thread.send",
  "provider.catalog",
  "environment.list",
  "terminal.create",
  "terminal.list",
  "terminal.close",
  "call.counters",
] as const;

export type HostOperationName = (typeof HOST_OPERATIONS)[number];

/** A terminal's target, matching the SDK's exclusive scope union. */
export type HostTerminalScope =
  | { kind: "thread"; threadId: string }
  | { kind: "environment"; environmentId: string }
  | { kind: "host_path"; hostId: string; cwd?: string | null };

/** What a plugin announces when it declares the executor role. */
export interface HostExecutorDeclaration {
  role: typeof HOST_EXECUTOR_ROLE;
  host: {
    /** The BB server's data directory as the plugin reads it. */
    dataDir: string;
    bbVersion: string;
    sdkVersion: string;
  };
}

/** The service's answer to a declaration. */
export interface HostExecutorAcceptance {
  ok: true;
  /** `bb:<sha256 of the real data directory>`; the adapter's host identity. */
  hostId: string;
  dataDir: string;
  acceptedAt: string;
}

/**
 * Counters the plugin keeps per SDK call since it loaded. They are evidence, not
 * control flow: one step's delta proves a claim such as "zero `threads.spawn`
 * calls when the workspace was created".
 */
export type HostCallCounters = Record<string, number>;

/** One bounded operation answer. */
export interface HostOperationOutcome {
  operation: HostOperationName;
  at: string;
  calls: HostCallCounters;
  value: unknown;
}

/** Every code a plugin may answer an operation with. */
export const HOST_OPERATION_ERROR_CODES = ["invalid_input", "refused", "unavailable", "internal"] as const;

export type HostOperationErrorCode = (typeof HOST_OPERATION_ERROR_CODES)[number];

/**
 * The only codes that prove an operation's write could not have landed.
 *
 * `invalid_input` is refused before anything is written, and `refused` is a policy
 * answer the plugin proves before its write. Everything else is unknown delivery:
 * `unavailable` and `internal` are reported after a call that may already have
 * committed, and a `threads.spawn` whose environment id never arrived is exactly
 * that case — the thread exists, so resending it would duplicate the spawn (Spec
 * 062, decision 6).
 */
export const HOST_OPERATION_NON_DELIVERY_CODES = ["invalid_input", "refused"] as const;

export type HostOperationNonDeliveryCode = (typeof HOST_OPERATION_NON_DELIVERY_CODES)[number];

export function isHostOperationNonDelivery(code: HostOperationErrorCode): code is HostOperationNonDeliveryCode {
  return (HOST_OPERATION_NON_DELIVERY_CODES as readonly string[]).includes(code);
}

/** One operation refusal, carried in a `ServiceResponse` error like any protocol refusal. */
export interface HostOperationFailure {
  code: HostOperationErrorCode;
  message: string;
}

/** The workspace handle shape decision 2 mints; a handle from another host never resolves. */
export const WORKSPACE_HANDLE_PATTERN = /^bb-worktree-[a-f0-9]{40}$/;

/** The real path of a data directory, or the path itself when it does not resolve. */
function realDataDir(dataDir: string): string {
  try {
    return realpathSync(dataDir);
  } catch {
    // A path that does not exist still names itself; only a trailing separator
    // must not change the identity.
    return dataDir.replace(/\/+$/, "") || "/";
  }
}

/**
 * The host identity decision 1 derives from the BB server's data directory: the
 * same real directory always answers the same id, and a different directory never
 * answers an existing one.
 */
export function hostIdFromDataDir(dataDir: string): string {
  const digest = createHash("sha256").update(realDataDir(dataDir)).digest("hex");
  return `${BB_HOST_ID_PREFIX}${digest.slice(0, 32)}`;
}

export function isBbHostId(value: unknown): value is string {
  return typeof value === "string" && /^bb:[a-f0-9]{32}$/.test(value);
}

/**
 * The Nucleus-owned workspace handle for one canonical worktree directory
 * (decision 2). It is a Nucleus record, never a BB environment id: BB has no
 * standalone environment create, so the handle exists before any thread does.
 */
export function workspaceHandleForPath(directory: string): string {
  const digest = createHash("sha256").update(realDataDir(directory)).digest("hex");
  return `bb-worktree-${digest.slice(0, 40)}`;
}
