/**
 * nucleus#1392: a retained reviewer's continuation run must see brief-required
 * proof in its prompt floor and read its own context after the prior run was
 * released. A release deletes that run's ticket file and revokes its credential,
 * so the continuation's reads have to name the current run's ticket. These cases
 * drive the real prompt renderer, the real ticket writer and the packaged
 * `nucleus helper report` path against the live callback socket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import type { Adapter } from "../core/host";
import type { Run } from "../shared/contracts";
import { submissionSchema } from "../shared/contracts";
import { runPrompt } from "../core/dispatch/prompts";
import { measureRunPrompt } from "../core/dispatch/prompt-text/measure";
import { buildRunContext, materializeRunContext } from "../core/dispatch/prompt-text/context-store";
import { writeRunTicket } from "../core/dispatch/agent-creation";
import { startCallbacks } from "../service/callbacks/callback";
import { observeIdle } from "./support/fakes";

const head = "b".repeat(40);
const sha256 = "c".repeat(64);

const runOf = (id: string, taskId: string, overrides: Partial<Run> = {}) =>
  ({
    id,
    taskId,
    role: "reviewer",
    status: "running",
    generation: 1,
    head,
    base: head,
    agentId: "reviewer",
    hostId: "host",
    workspaceId: "ws",
    profile: null,
    lastObservedAt: null,
    active: true,
    idleSince: null,
    completion: null,
    released: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  }) as unknown as Run;

async function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ns-proof-context-")));
  const helperPath = join(dir, "worker-report.mjs");
  const socketPath = join(dir, "socket");
  const store = new Store(join(dir, "queue.sqlite"));
  const engine = new Engine(store, {
    observe: observeIdle("ws", "reviewer"),
  } as unknown as Adapter);
  const inserted = store.insert(
    submissionSchema.parse({
      submissionId: "proof-context",
      title: "Proof context",
      repoPath: "/fixture",
      planningCommit: head,
      originAgentId: "origin",
    }),
    "host",
    "brief",
    head,
  );
  const taskId = inserted.id;
  store.update(taskId, {
    phase: "working",
    runId: "run-worker",
    agentId: "worker",
    workspaceId: "ws",
    temporaryDirectory: dir,
    proofFiles: [
      {
        head,
        label: "Wire evidence",
        name: "01-wire-evidence.json",
        path: join(dir, "evidence", "01-wire-evidence.json"),
        sourcePath: "/task/evidence/wire.json",
        sha256,
        bytes: 42,
        runId: "run-revision",
        eventId: "proof-event-1",
        at: new Date().toISOString(),
      },
    ],
  });
  const paths = { socketPath, helperPath };

  // The prior reviewer run: its ticket is written, then the release revokes the
  // credential and deletes the ticket file.
  const priorDirectory = join(dir, "review-1");
  mkdirSync(priorDirectory, { mode: 0o700 });
  store.putRun(runOf("run-review-1", taskId, { temporaryDirectory: priorDirectory }));
  store.setCredential("run-review-1", "review-1-token");
  writeRunTicket(paths, store.task(taskId), { id: "run-review-1", role: "reviewer", generation: 1 }, "review-1-token");
  store.putRun(runOf("run-review-1", taskId, { temporaryDirectory: priorDirectory, released: true }));
  const staleTicket = join(dir, "tickets", "run-review-1.json");
  assert.equal(existsSync(staleTicket), false, "the release deleted the prior run's ticket");

  // The current reviewer run, continued on the same retained thread.
  const currentDirectory = join(dir, "review-2");
  mkdirSync(currentDirectory, { mode: 0o700 });
  store.putRun(runOf("run-review-2", taskId, { temporaryDirectory: currentDirectory }));
  store.setCredential("run-review-2", "review-2-token");
  store.update(taskId, {
    resolution: { ...store.task(taskId).resolution, currentRunId: "run-review-2" },
  });
  const currentTicket = writeRunTicket(paths, store.task(taskId), { id: "run-review-2", role: "reviewer", generation: 1 }, "review-2-token");
  materializeRunContext(currentDirectory, "run-review-2", buildRunContext(store.task(taskId), store.run("run-review-2")!));

  const stop = await startCallbacks(socketPath, helperPath, engine);
  return {
    dir, helperPath, store, taskId, staleTicket, currentTicket, currentDirectory,
    close: async () => {
      await engine.stop();
      await stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The packaged helper command, run as a child so the callback socket stays served here. */
function runHelper(env: Record<string, string>, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), "bin/nucleus.mjs"), "helper", "report", ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("a reviewer continuation sees its proof inline and reads its context through the current ticket", async () => {
  const f = await fixture();
  try {
    const run = f.store.run("run-review-2")!;
    const { prompt, size } = measureRunPrompt((section) =>
      runPrompt(f.store.task(f.taskId), run, f.helperPath, f.currentTicket, false, null, null, undefined, section));

    // The brief-required proof is in the prompt floor: label, local path, sha256 and size on one line.
    assert.match(prompt, /Proof files recorded for exact head/);
    assert.match(prompt, new RegExp(`- Wire evidence \\(recorded head ${head}\\): .*01-wire-evidence\\.json.*sha256 ${sha256}, 42 bytes`));
    assert.ok(size.sections.proofFiles > 0, "the proof section is measured in the prompt");

    // The context commands name the current run's ticket, so a released prior ticket is never read.
    const binding = `NUCLEUS_CONTINUATION_RUN_ID='run-review-2' NUCLEUS_CONTINUATION_TICKET='${f.currentTicket}' nucleus helper report`;
    assert.ok(prompt.includes(`${binding} context [rules|validation|proofs|history]`));

    // What the continuation runs: the prior ticket is still the shell's NUCLEUS_TICKET, and the continuation identity overrides it.
    const env = {
      NUCLEUS_HELPER: f.helperPath,
      NUCLEUS_TICKET: f.staleTicket,
      NUCLEUS_CONTINUATION_RUN_ID: "run-review-2",
      NUCLEUS_CONTINUATION_TICKET: f.currentTicket,
    };
    const proofs = await runHelper(env, ["context", "proofs"]);
    assert.equal(proofs.code, 0, proofs.stderr);
    assert.match(proofs.stdout, /Proof files recorded for exact head/);
    assert.ok(proofs.stdout.includes(sha256));
    const history = await runHelper(env, ["context", "history"]);
    assert.equal(history.code, 0, history.stderr);
    assert.match(history.stdout, /"checkpoints"/);

    // A bare command from a shell that still names the released ticket gets the exit, not an ENOENT.
    const bare = await runHelper({ NUCLEUS_HELPER: f.helperPath, NUCLEUS_TICKET: f.staleTicket }, ["context", "proofs"]);
    assert.equal(bare.code, 1);
    assert.match(bare.stderr, /released/);
    assert.match(bare.stderr, /NUCLEUS_CONTINUATION_TICKET/);
  } finally {
    await f.close();
  }
});

test("a task with no proof gives its reviewer no proof section", async () => {
  const f = await fixture();
  try {
    f.store.update(f.taskId, { proofFiles: [] });
    // The context snapshot is written at dispatch, so the cleared list is materialized again.
    const run = f.store.run("run-review-2")!;
    materializeRunContext(f.currentDirectory, "run-review-2", buildRunContext(f.store.task(f.taskId), run));
    const { prompt, size } = measureRunPrompt((section) =>
      runPrompt(f.store.task(f.taskId), run, f.helperPath, f.currentTicket, false, null, null, undefined, section));
    assert.doesNotMatch(prompt, /Proof files recorded for exact head/);
    assert.equal(size.sections.proofFiles, undefined);
    const env = {
      NUCLEUS_HELPER: f.helperPath,
      NUCLEUS_CONTINUATION_RUN_ID: "run-review-2",
      NUCLEUS_CONTINUATION_TICKET: f.currentTicket,
    };
    const proofs = await runHelper(env, ["context", "proofs"]);
    assert.equal(proofs.code, 0, proofs.stderr);
    assert.equal(proofs.stdout.trim(), "");
  } finally {
    await f.close();
  }
});
