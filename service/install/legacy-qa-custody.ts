import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  hostRunInternalRecordSchema,
  projectQaRequestSchema,
  projectQaRunSchema,
  qaFenceRecordSchema,
} from "../../shared/contracts";
import { LEGACY_QA_ROLL_DEFERRED } from "../../shared/service-roll";
import { findProcessByCommandToken } from "../../core/machine/process-identity";
import {
  assertWorkPlacementAvailable,
  liveWorkPlacement,
} from "../../core/workspaces/checkout-volume";
import { getWorkPlacement } from "../../core/workspaces/work-root.mjs";
import { legacyQaRoots } from "../../core/qa/qa-evidence-roots";
import { resolveQaCallerKey } from "../../core/qa/qa-caller-provenance";

function stat(path: string) {
  return lstatSync(path, { throwIfNoEntry: false });
}

function decode(value: unknown): unknown {
  try { return JSON.parse(String(value)); }
  catch { return undefined; }
}

function defer(reason: string): never {
  throw new Error(`${LEGACY_QA_ROLL_DEFERRED} ${reason}. Settle legacy QA on the compatibility build, then retry the roll.`);
}

/**
 * Read the predecessor's durable custody in one snapshot. Warm standby checks
 * before touching the live endpoint; cold startup and the post-drain check
 * also run before opening the writable store. This boundary never repairs data.
 */
export function assertLegacyQaSettled(dataDir: string): void {
  const path = join(dataDir, "queue.sqlite");
  try {
    if (!stat(path)) {
      for (const root of legacyQaRoots(dataDir).roots) checkLegacyQaFiles(root);
      return;
    }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout=1000; BEGIN");
      checkLegacyQa(db, dataDir);
    } finally { db.close(); }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(LEGACY_QA_ROLL_DEFERRED)) throw error;
    defer(`Legacy QA custody could not be verified (${error instanceof Error ? error.message : String(error)})`);
  }
}

function checkLegacyQa(db: DatabaseSync, dataDir: string): void {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  if (tables.has("meta")) {
    const fence = db.prepare("SELECT value FROM meta WHERE key='qaAdmissionFence'").get();
    if (fence) {
      const record = qaFenceRecordSchema.safeParse(decode(fence.value));
      if (!record.success || (record.data.fence && Date.parse(record.data.fence.until) > Date.now()))
        defer("The legacy QA admission fence is active or unreadable");
    }
    for (const row of db.prepare("SELECT key,value FROM meta WHERE key GLOB 'projectQaRequest:*'").iterate()) {
      const request = projectQaRequestSchema.safeParse(decode(row.value));
      if (!request.success || row.key !== `projectQaRequest:${request.data.id}`
          || request.data.state === "preparing"
          || (request.data.state === "admitted" && !request.data.runId))
        defer(`Legacy QA request ${row.key} has unresolved delivery`);
    }
  }

  const runs = new Map<string, ReturnType<typeof projectQaRunSchema.parse>>();
  if (tables.has("project_qa_runs")) {
    for (const row of db.prepare("SELECT id,data FROM project_qa_runs").iterate()) {
      const record = projectQaRunSchema.safeParse(decode(row.data));
      if (!record.success || record.data.id !== row.id) defer(`Legacy QA run ${row.id} is unreadable`);
      const run = record.data;
      if (!run.finishedAt || !Number.isFinite(Date.parse(run.finishedAt)) || run.pid !== null
          || run.state === "queued" || run.state === "running" || run.checkoutCleanupPending)
        defer(`Legacy QA run ${run.id} still owns execution or checkout cleanup`);
      runs.set(run.id, run);
    }
  }

  const released = new Map<string, ReturnType<typeof hostRunInternalRecordSchema.parse>>();
  if (tables.has("host_run_records")) {
    // A generic host run can request the milestone priority. Use the paired
    // QA identity or the reserved internal caller to find legacy envelopes.
    const host = db.prepare(`SELECT id,state,data FROM host_run_records
      WHERE NOT json_valid(data)
        OR json_extract(CASE WHEN json_valid(data) THEN data END,'$.caller') GLOB 'queue:milestone:*'
        ${tables.has("project_qa_runs") ? "OR id IN (SELECT id FROM project_qa_runs)" : ""}`);
    for (const row of host.iterate()) {
      const parsed = hostRunInternalRecordSchema.safeParse(decode(row.data));
      if (!parsed.success || parsed.data.id !== row.id) defer(`Host run ${row.id} cannot be ruled out of legacy QA custody`);
      const run = parsed.data;
      if (row.state !== "settled" || run.state !== "settled" || run.settlement?.runId !== run.id || !run.capacityReleasedAt)
        defer(`Legacy QA host run ${run.id} has unsettled execution or capacity`);
      const qa = runs.get(run.id);
      if (qa && (qa.hostRunEpoch === undefined || qa.hostRunEpoch === run.epoch)
          && !("reason" in resolveQaCallerKey({ runId: run.id, caller: run.caller, qaRun: qa, runRepository: run.repository })))
        released.set(run.id, run);
    }
  }

  for (const run of runs.values()) {
    const host = released.get(run.id);
    const proof = run.escapedDescendantsProvenDeadAt
      ? run.escapedDescendantsProvenDead ?? []
      : host?.escapedDescendantsProvenDeadAt ? host.settlement?.result?.escapedDescendants ?? [] : [];
    const covered = new Set(proof.map(entry => `${entry.pid}:${entry.startIdentity}`));
    if (run.escapedDescendants.some(entry => !covered.has(`${entry.pid}:${entry.startIdentity}`)))
      defer(`Legacy QA run ${run.id} lacks exit proof for its escaped processes`);
    if (!host && run.steps.some(step => step.processGroupEmpty === false || step.terminationError))
      defer(`Legacy QA run ${run.id} lacks process-group settlement`);
  }

  const live = liveWorkPlacement(dataDir);
  const qaRoots = legacyQaRoots(dataDir).roots;
  if (live && (runs.size || qaRoots.some(root => stat(root))))
    assertWorkPlacementAvailable(getWorkPlacement(dataDir));
  for (const root of qaRoots) checkLegacyQaFiles(root);
  for (const run of runs.values()) {
    if (!run.checkoutPath) continue;
    const key = createHash("sha256").update(run.submittedKey ?? run.key).digest("hex").slice(0, 24);
    if (!/^[a-f0-9-]{36}$/.test(run.id)
        || !qaRoots.some(root => run.checkoutPath === join(root, key, run.id)))
      defer(`Legacy QA run ${run.id} has an unverified checkout allocation`);
    if (stat(run.checkoutPath))
      defer(`Legacy QA run ${run.id} still owns its checkout`);
  }
}

function checkLegacyQaFiles(directory: string): void {
  const info = stat(directory);
  if (!info) return;
  if (!info.isDirectory()) defer("The legacy QA evidence root is unreadable");
  for (const key of readdirSync(directory, { withFileTypes: true })) {
    if (!/^[a-f0-9]{24}$/.test(key.name)) continue;
    if (!key.isDirectory()) defer("A legacy QA repository directory is unreadable");
    const parent = join(directory, key.name);
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (/^[a-f0-9-]{36}$/.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink()))
        defer(`Legacy QA checkout ${entry.name} is still present`);
      if (entry.name.endsWith(".plan.json") || entry.name.endsWith(".supervisor.json")) {
        // These files are removed on settlement, whereas results and logs stay.
        // A crash between committing settlement and removing supervision files
        // leaves an uncertain cleanup for the compatibility build to reap.
        defer(`Legacy QA supervision file ${entry.name} still has custody`);
      }
    }
  }
  // A process may outlive the service between writing a terminal row and
  // exiting. The supervisor's command includes the path to its owned plan.
  if (findProcessByCommandToken(directory + "/").state !== "absent")
    defer("Legacy QA process exit is unverified");
}
