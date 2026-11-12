import type { CreationOwner } from '../host/types';
export type { CreationOwner } from '../host/types';
import { writeOwnedJson } from "../machine/owned-file.mjs";
import { wireLabels } from "../../shared/wire-labels";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HostAgentAttempt, HostAgentSpec } from "../../shared/host";
import type { Profile, Run, Task } from "../../shared/contracts";
import { sharedCargoEnvironment } from "../machine/cargo-cache";
import { mergeAdmissionLaunchEnv } from "../qa/effigy-admission";
import { runPrompt } from "./prompts";
import { runTemporaryEnvironment, type RunScratchPlacement } from "../workspaces/run-scratch";
import { materializeLaneDocuments } from "../planning/brief-lane-documents";

type CallbackPaths = Pick<CreationOwner, "socketPath" | "helperPath">;

/** Deterministic ticket path for a run; the prompt can name it before the write. */
export function runTicketPath(paths: Pick<CallbackPaths, "helperPath">, runId: string): string {
  return join(dirname(paths.helperPath), "tickets", `${runId}.json`);
}

/** The run ticket the authenticated fallback reads: its socket, identity, token and any coordinator generation. */
export function writeRunTicket(paths: CallbackPaths, task: Task, run: { id: string; role: Run["role"] | "worker"; generation: number }, token: string): string {
  const directory = join(dirname(paths.helperPath), "tickets"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = runTicketPath(paths, run.id);
  // A coordinative run's generation never changes after creation, so the ticket can bind it for the
  // authenticated fallback: the helper sends it when the payload omits it. Other roles need no binding.
  const generation = ['closeout', 'recovery', 'executor'].includes(run.role) ? { coordinatorGeneration: run.generation } : {};
  writeOwnedJson(path, { socketPath: paths.socketPath, taskId: task.id, runId: run.id, token, ...generation });
  return path;
}

/** The MCP reporting binding for one key, written atomically so the helper never reads a torn file. */
export function writeMcpBinding(paths: CallbackPaths, key: string, task: Task, runId: string, token: string): string {
  const dir = join(dirname(paths.helperPath), "tickets"); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `mcp-${key}.json`);
  writeOwnedJson(path, { socketPath: paths.socketPath, taskId: task.id, runId, token });
  return path;
}

/** Removes a binding a host refused to attach, so the socket-only retry leaves no reporting credential behind. */
export function removeMcpBinding(path: string): void {
  rmSync(path, { force: true });
}

/** The callback environment carries routing data only; the ticket owns the credential. */
export function callbackEnvironment(paths: CallbackPaths, task: Task, runId: string): Record<string, string> {
  const values = { SOCKET: paths.socketPath, TASK_ID: task.id, RUN_ID: runId,
    HELPER: paths.helperPath, BRANCH: task.branch, BASE_BRANCH: task.baseBranch };
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [`NUCLEUS_${key}`, value]));
}

/** The launch environment for one create: shared cargo, the run's scratch, the callback and the admission hook. */
function launchEnvironment(owner: CreationOwner, task: Task, runId: string, temporaryDirectory: string | undefined, ticket: string): Record<string, string> {
  return mergeAdmissionLaunchEnv({ ...sharedCargoEnvironment(), ...runTemporaryEnvironment(runId, owner.scratchPlacement(task), temporaryDirectory), ...callbackEnvironment(owner, task, runId), NUCLEUS_TICKET: ticket }, owner.admissionLaunchEnv);
}

/**
 * A worker's agent: the caller's prompts, the run's stable identities and the
 * binding it reports through. `attempt` is read by the host at each create, so
 * the owner's launch admission is the one in force at that moment.
 */
export function workerAgentSpec(owner: () => CreationOwner, task: Task, token: string, prompt: string, legacyPrompt: string): HostAgentSpec {
  const runId = task.runId!;
  const ticket = writeRunTicket(owner(), task, { id: runId, role: "worker", generation: 0 }, token);
  const mcpBindingPath = owner().reportingViaMcp ? writeMcpBinding(owner(), runId, task, runId, token) : null;
  return {
    workspaceId: task.workspaceId!, profile: task.profile!, title: task.title, taskNumber: task.number, mcpBindingPath,
    attempt: (mcp, retry): HostAgentAttempt => {
      const current = owner();
      // A host that takes no per-thread environment (T3) gets an empty one and
      // manages its own scratch (task 1105): the launch environment, with its
      // recorded-directory validation and creation, is computed only when the
      // host will use it (the task 1126 hoist computed it either way).
      const environment = current.perThreadEnvironment === false ? {} : launchEnvironment(current, task, runId, task.temporaryDirectory, ticket);
      materializeLaneDocuments(task.temporaryDirectory, task.laneDocumentPins);
      return {
        requestId: retry ? `ns-agent-${runId}-socket` : `ns-agent-${runId}`,
        prompt: retry ? legacyPrompt : prompt,
        labels: wireLabels({ task: task.id, run: runId, ...(mcp ? { mcpBinding: runId, mcpBindingPath: mcpBindingPath ?? undefined } : {}) }),
        environment,
      };
    },
  };
}

/**
 * A reviewer, coordinator or other run's agent. Writes the run ticket first and
 * then the MCP binding, the order the ticket-bearing prompt needs. The run's
 * prompt is built per attempt, because it differs with MCP reporting.
 */
export function runAgentSpec(owner: () => CreationOwner, task: Task, run: Run, token: string, profile: Profile,
  guard: HostAgentSpec["guard"] | undefined, context: RunPromptContext, ownerContext: RunPromptOwnerContext): HostAgentSpec {
  const ticket = writeRunTicket(owner(), task, run, token);
  const mcpBindingPath = owner().reportingViaMcp ? writeMcpBinding(owner(), run.id, task, run.id, token) : null;
  return {
    workspaceId: run.workspaceId, profile, title: `${run.role}: ${task.title}`, taskNumber: task.number, mcpBindingPath, guard,
    attempt: (mcp, retry): HostAgentAttempt => {
      const current = owner();
      // Same task 1105 shape as the worker spec: no per-thread environment, no
      // launch-environment computation; lane docs materialize at the recorded
      // run directory the host manages.
      const environment = current.perThreadEnvironment === false ? {} : launchEnvironment(current, task, run.id, run.temporaryDirectory, ticket);
      const effectiveRun = { ...run, temporaryDirectory: current.perThreadEnvironment === false ? run.temporaryDirectory : environment.TMPDIR };
      materializeLaneDocuments(effectiveRun.temporaryDirectory, task.laneDocumentPins);
      return {
        requestId: retry ? `ns-run-${run.id}-socket` : `ns-run-${run.id}`,
        prompt: runPrompt(task, effectiveRun, current.helperPath, ticket, mcp, context, ownerContext),
        labels: wireLabels({ task: task.id, run: run.id, role: run.role, ...(mcp ? { mcpBinding: run.id, mcpBindingPath: mcpBindingPath ?? undefined } : {}) }),
        environment,
      };
    },
  };
}

type RunPromptContext = Parameters<typeof runPrompt>[5];
type RunPromptOwnerContext = Parameters<typeof runPrompt>[6];
