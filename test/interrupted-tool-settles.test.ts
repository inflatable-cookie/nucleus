/**
 * bovine#6928 (Spec 068 batch 5b): a T3 thread stopped by the user leaves its
 * last `command_execution` item `interrupted` inside an interrupted run. That is
 * a finished call once the turn is proven over, so the owned-tool proof no longer
 * holds a released run forever. A command kind that can outlive its turn still
 * takes the owned-process proof, so a background child that survived holds.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "../hosts/t3code";
import { liveToolIssueFact, readToolTimeline } from "../core/recovery/stall";
import {
  STAMP,
  syntheticRun,
  syntheticTurnItem,
  t3Fake,
} from "./support/t3code-fake";
import { acpStub, serveNucleusProvider } from "./support/t3code-acp";

async function interruptedThread(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "t3int-")));
  const server = await t3Fake(t, directory);
  const acp = acpStub(server.threads);
  const host = createHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    probeThreadId: "synthetic-probe",
    statePath: join(directory, "hosts", "t3code.json"),
    timeoutMs: 2_000,
    acp: () => acp.surface,
    reentryTimeoutMs: 200,
  });
  t.after(() => host.close());
  await host.connect();
  await serveNucleusProvider(host, server);
  const workspace = await host.createWorkspace({
    title: "Synthetic worktree",
    requestId: "workspace",
    directory,
    project: { projectId: "synthetic-project" },
  });
  const agent = await host.createAgent({
    workspaceId: workspace.id,
    title: "Synthetic reviewer",
    mcpBindingPath: null,
    profile: {
      id: "profile",
      name: "Synthetic",
      provider: "synthetic-provider",
      model: "synthetic-model",
      notes: "",
      available: true,
      problem: "",
      supportedThinking: [],
    },
    attempt: () => ({
      requestId: "create-thread",
      prompt: "Synthetic prompt",
      labels: { "nucleus.task": "synthetic" },
      environment: {},
    }),
  });
  const projection = server.threads.get(agent.id)!;
  const at = (seconds: number) =>
    new Date(Date.parse(STAMP) + seconds * 1_000).toISOString();
  // The recorded shape: the reviewer's run was stopped by the user, and its
  // last command execution went with it.
  projection.runs = [
    syntheticRun(agent.id, 1, {
      id: "synthetic-run-1",
      status: "interrupted",
      completedAt: at(30),
    }),
  ];
  projection.turnItems = [
    syntheticTurnItem(agent.id, 1, {
      runId: "synthetic-run-1",
      updatedAt: at(10),
      type: "assistant_message",
      text: "Reviewing the head.",
    }),
    syntheticTurnItem(agent.id, 2, {
      runId: "synthetic-run-1",
      createdAt: at(20),
      updatedAt: at(30),
      type: "command_execution",
      status: "interrupted",
      title: "Ran command",
      input: "git diff --stat origin/main...HEAD",
    }),
  ];
  const read = await readToolTimeline(host, agent.id);
  assert.ok("entries" in read, JSON.stringify(read));
  return { host, agent, workspace, read };
}

const idleObservation = (id: string, workspaceId: string) => ({
  id,
  workspaceId,
  status: "idle" as const,
  active: false,
  permissions: false,
  error: "",
  activeTurnId: null,
});

test("an interrupted T3 command is read as interrupted; once the turn is over it needs only the process proof", async (t) => {
  const { agent, read } = await interruptedThread(t);
  const call = read.entries.find((entry) => entry.item.type === "tool_call")!;
  assert.equal(call.item.status, "interrupted");
  assert.equal(call.item.detail?.type, "shell");
  assert.equal(call.item.detail?.nativeType, "command_execution");
  // Without turn proof the call is not settled evidence.
  assert.equal(liveToolIssueFact(read.entries)?.kind, "live");
  // With the turn proven over, a shell call still owes the process proof: it is
  // the one shape the process tree settles, exactly as a running one is.
  const issue = liveToolIssueFact(
    read.entries,
    idleObservation(agent.id, "unused"),
  );
  assert.equal(issue?.kind, "live");
  assert.equal(issue && "status" in issue ? issue.status : null, "interrupted");
  // A kind that cannot outlive its turn is simply finished.
  const edit = read.entries.map((entry) =>
    entry.item.type === "tool_call"
      ? {
          ...entry,
          item: {
            ...entry.item,
            detail: { ...entry.item.detail, type: "edit" },
          },
        }
      : entry,
  );
  assert.equal(
    liveToolIssueFact(edit, idleObservation(agent.id, "unused")),
    null,
  );
});
