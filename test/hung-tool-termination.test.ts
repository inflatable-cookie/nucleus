/**
 * Spec 068 batch 5b (Decisions 3 and 4): a participant's shell command with no
 * output past the repository's tool limit is terminated by its own process
 * identity, and a pending permission in a task run is declined with a message.
 * The provider, its report helper and the turn are never touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readProcessSubset } from "../core/machine/host-process-listing";
import { pidAlive } from "../core/machine/pid";
import { selectHungTool, terminateHungTool } from "../core/machine/hung-tool";
import { HUNG_TOOL_TERMINATED, HUNG_TOOL_UNTERMINATED } from "../core/recovery/hung-tools";
import { PERMISSION_DENIAL_INTENT, PERMISSION_DENIAL_UNKNOWN, PERMISSION_DENIED } from "../core/recovery/permission-policy";
import type { TimelineEntry } from "../core/recovery/stall";
import type { HostProcessFact } from "../core/host/types";
import { minutesAgo, running, selfHealingFixture, type SelfHealingFixture } from "./support/self-healing-fixture";

interface ProviderTree {
  provider: ChildProcess;
  pids: { provider: number; helper: number; shell: number; command: number };
  command: string;
  read: () => Promise<HostProcessFact[] | null>;
}

/**
 * A real provider shape: the provider runs the run's MCP report helper and one
 * shell tool call that runs a silent command, as a provider's shell tool does.
 * `detached` puts the shell in its own process group.
 */
async function providerTree(t: { after: (cb: () => Promise<void> | void) => void }, f: SelfHealingFixture, detached: boolean): Promise<ProviderTree> {
  const marker = `quiet-${process.pid}-${Date.now()}`;
  await writeFile(join(f.root, "mcp-report.mjs"), "setInterval(() => {}, 1000);\n");
  await writeFile(join(f.root, "quiet.mjs"), `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n`);
  const pidFile = join(f.root, `${marker}.pid`);
  const commandLine = `${process.execPath} ${join(f.root, "quiet.mjs")} ${pidFile} ${marker}; true`;
  await writeFile(join(f.root, "provider.mjs"), `import { spawn } from 'node:child_process';
const helper = spawn(process.execPath, [process.argv[2], process.argv[3]], { cwd: process.cwd() });
const shell = spawn('/bin/sh', ['-c', process.argv[4]], { cwd: process.cwd(), detached: process.argv[5] === 'detached', stdio: 'ignore' });
process.on('SIGTERM', () => { helper.kill(); try { process.kill(-shell.pid, 'SIGKILL'); } catch {} try { shell.kill('SIGKILL'); } catch {} process.exit(); });
console.log(JSON.stringify([process.pid, helper.pid, shell.pid])); setInterval(() => {}, 1000);\n`);
  const provider = spawn(process.execPath, [join(f.root, "provider.mjs"), join(f.root, "mcp-report.mjs"), join(f.root, "mcp-initial.json"), commandLine, detached ? "detached" : "attached"],
    { cwd: f.directory, stdio: ["ignore", "pipe", "pipe"] });
  const [ready] = await once(provider.stdout!, "data");
  const [providerPid, helper, shell] = JSON.parse(String(ready)) as number[];
  let commandPid = 0;
  for (const deadline = Date.now() + 5_000; !commandPid && Date.now() < deadline; ) {
    commandPid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
    if (!commandPid) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(commandPid > 0, "the quiet command started");
  t.after(async () => {
    for (const pid of [commandPid, shell]) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    if (provider.exitCode === null) {
      provider.kill();
      await once(provider, "exit");
    }
  });
  const pids = { provider: providerPid!, helper: helper!, shell: shell!, command: commandPid };
  return {
    provider, pids, command: commandLine,
    read: async () => {
      const listing = await readProcessSubset(Object.values(pids));
      return listing.state === "listed" ? listing.processes : null;
    },
  };
}

const shellCall = (command: string, startedMinutesAgo: number, lastOutputAt: string | null = null): TimelineEntry => ({
  timestamp: minutesAgo(startedMinutesAgo),
  turnId: "worker-turn-1",
  item: {
    type: "tool_call",
    callId: "call-quiet",
    status: "running",
    name: "Bash",
    detail: { type: "shell", command, startedAt: minutesAgo(startedMinutesAgo), ...(lastOutputAt ? { lastOutputAt } : {}) },
  },
});

/**
 * The worker's turn is 40 minutes old and quiet for 35: past the stall
 * threshold and the 30-minute tool limit. By default the host showed the
 * call's output once, 35 minutes ago, so its silence since is known.
 */
function quietTurn(f: SelfHealingFixture, tree: ProviderTree, lastOutputAt: string | null = minutesAgo(35)) {
  f.setObservation(running({ updatedAt: minutesAgo(35), turnStartedAt: minutesAgo(40) }));
  f.setTimeline([shellCall(tree.command, 35, lastOutputAt)]);
  f.setProcesses(tree.read);
  f.engine.resolution.stalls.hungTools.graceMs = 500;
}

const events = (f: SelfHealingFixture, kind: string) => f.store.eventsAll(f.task.id).filter((event) => event.kind === kind);

test("a command quiet past the tool limit is terminated by its own group; the provider and turn continue", async (t) => {
  const f = await selfHealingFixture(t);
  const tree = await providerTree(t, f, true);
  quietTurn(f, tree);
  await f.engine.wake();
  const terminated = events(f, HUNG_TOOL_TERMINATED);
  assert.equal(terminated.length, 1, JSON.stringify(f.store.eventsAll(f.task.id).map((event) => event.kind)));
  const detail = JSON.parse(terminated[0]!.detail);
  assert.equal(detail.kind, "group");
  assert.equal(detail.pid, tree.pids.shell);
  assert.equal(detail.callId, "call-quiet");
  assert.equal(detail.limitMinutes, 30);
  assert.equal(pidAlive(tree.pids.command), false, "the quiet command is gone");
  assert.equal(pidAlive(tree.pids.shell), false, "its shell is gone");
  assert.equal(pidAlive(tree.pids.provider), true, "the provider is never signalled");
  assert.equal(pidAlive(tree.pids.helper), true, "the report helper is never signalled");
  const task = f.store.task(f.task.id);
  assert.equal(task.phase, "working");
  assert.equal(task.agentId, "worker", "the agent keeps its turn");
  assert.notEqual(task.resolution.stop?.reason, "run_stalled", "a terminated tool is not a stalled turn");
  // A second pass with the provider still showing the call writes nothing new and signals nothing.
  f.engine.resolution.stalls.peekTtlMs = 0;
  await f.engine.wake();
  assert.equal(events(f, HUNG_TOOL_TERMINATED).length, 1);
});

test("a command sharing the provider's group is terminated pid by pid", async (t) => {
  const f = await selfHealingFixture(t);
  const tree = await providerTree(t, f, false);
  quietTurn(f, tree);
  await f.engine.wake();
  const terminated = events(f, HUNG_TOOL_TERMINATED);
  assert.equal(terminated.length, 1);
  assert.equal(JSON.parse(terminated[0]!.detail).kind, "tree");
  assert.equal(pidAlive(tree.pids.command), false);
  assert.equal(pidAlive(tree.pids.provider), true);
  assert.equal(pidAlive(tree.pids.helper), true);
});

test("a command that produced output inside the limit is left alone", async (t) => {
  const f = await selfHealingFixture(t);
  const tree = await providerTree(t, f, true);
  quietTurn(f, tree, minutesAgo(2));
  await f.engine.wake();
  assert.equal(events(f, HUNG_TOOL_TERMINATED).length, 0);
  assert.equal(events(f, HUNG_TOOL_UNTERMINATED).length, 0);
  assert.equal(pidAlive(tree.pids.command), true);
  assert.equal(pidAlive(tree.pids.shell), true);
});

test("a running command whose output the host never showed is unknown, never quiet, and is left alone", async (t) => {
  const f = await selfHealingFixture(t);
  const tree = await providerTree(t, f, true);
  // A provider that returns shell output only when the command ends shows none
  // while a 35-minute test lane prints all along.
  quietTurn(f, tree, null);
  await f.engine.wake();
  assert.equal(events(f, HUNG_TOOL_TERMINATED).length, 0);
  assert.equal(events(f, HUNG_TOOL_UNTERMINATED).length, 0);
  assert.equal(pidAlive(tree.pids.command), true);
  assert.equal(pidAlive(tree.pids.shell), true);
});

test("a host that declares it streams running output makes a call with no output shown quiet", async (t) => {
  const f = await selfHealingFixture(t);
  const tree = await providerTree(t, f, true);
  f.adapter.capabilities = () => ({ reportingViaMcp: true, supportsCoordinatorRecovery: true, streamsRunningToolOutput: true });
  quietTurn(f, tree, null);
  await f.engine.wake();
  assert.equal(events(f, HUNG_TOOL_TERMINATED).length, 1);
  assert.equal(pidAlive(tree.pids.command), false);
  assert.equal(pidAlive(tree.pids.provider), true);
});

test("the repository's toolQuietLimitMinutes raises the limit", async (t) => {
  const f = await selfHealingFixture(t);
  const tree = await providerTree(t, f, true);
  f.store.patchRepository({ origin: null, path: f.task.repoPath }, { toolQuietLimitMinutes: 60 });
  quietTurn(f, tree);
  await f.engine.wake();
  assert.equal(events(f, HUNG_TOOL_TERMINATED).length, 0);
  assert.equal(pidAlive(tree.pids.command), true);
});

test("a reused pid with a different start identity is never signalled", async (t) => {
  const f = await selfHealingFixture(t);
  const tree = await providerTree(t, f, true);
  quietTurn(f, tree);
  // The listing names the command's pids under an earlier birth: the pids now
  // belong to processes the listing never saw.
  const reborn = new Set([tree.pids.shell, tree.pids.command]);
  f.setProcesses(async () => (await tree.read())?.map((process) =>
    reborn.has(process.pid) ? { ...process, startIdentity: `${process.pid}@Mon Jan  1 00:00:00 2001` } : process) ?? null);
  await f.engine.wake();
  assert.equal(events(f, HUNG_TOOL_TERMINATED).length, 0);
  const unterminated = events(f, HUNG_TOOL_UNTERMINATED);
  assert.equal(unterminated.length, 1);
  assert.match(JSON.parse(unterminated[0]!.detail).reason, /no longer carries start identity .*; nothing was signalled/);
  assert.equal(pidAlive(tree.pids.command), true);
  assert.equal(pidAlive(tree.pids.shell), true);
});

test("termination re-reads each identity before every signal", async (t) => {
  const f = await selfHealingFixture(t);
  const tree = await providerTree(t, f, false);
  const selection = selectHungTool("initial", tree.command, await tree.read());
  assert.ok("target" in selection, JSON.stringify(selection));
  const sent: Array<[number, string]> = [];
  const wrong = { ...selection.target, root: { ...selection.target.root, startIdentity: `${tree.pids.shell}@Mon Jan  1 00:00:00 2001` },
    members: selection.target.members.map((member) => ({ ...member, startIdentity: `${member.pid}@Mon Jan  1 00:00:00 2001` })) };
  const result = await terminateHungTool(wrong, { graceMs: 50, signal: (pid, signal) => { sent.push([pid, signal]); } });
  assert.equal(result.outcome, "identity_changed");
  assert.deepEqual(sent, []);
  assert.equal(pidAlive(tree.pids.command), true);
});

test("an ambiguous or missing command match stops nothing", async (t) => {
  const f = await selfHealingFixture(t);
  const tree = await providerTree(t, f, false);
  const processes = await tree.read();
  assert.match((selectHungTool("initial", "npm run something-else", processes) as { refusal: string }).refusal, /no process/);
  assert.match((selectHungTool("other-run", tree.command, processes) as { refusal: string }).refusal, /helper is missing/);
  assert.match((selectHungTool("initial", "ab", processes) as { refusal: string }).refusal, /too short/);
});

test("a pending permission in a task run is declined with a message and an event, once", async (t) => {
  const f = await selfHealingFixture(t);
  f.setObservation(running({
    permissions: true, updatedAt: minutesAgo(35), turnStartedAt: minutesAgo(40),
    pendingRequest: { id: "request-1", kind: "command", firstLine: null }, pendingPermissionKinds: ["command"],
  }));
  await f.engine.wake();
  assert.equal(f.permissionAnswers.length, 1);
  const [agentId, workspaceId, requestId, decision, intentId] = f.permissionAnswers[0]!;
  assert.deepEqual([agentId, workspaceId, requestId, decision], ["worker", "task-ws", "request-1", "decline"]);
  assert.match(String(intentId), /^ns-permission-deny-initial-request-1$/);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0]!.agentId, "worker");
  assert.match(f.messages[0]!.text, /declined your command permission request.*Carry on without that permission.*report it as a blocker/s);
  assert.equal(events(f, PERMISSION_DENIAL_INTENT).length, 1);
  const denied = events(f, PERMISSION_DENIED);
  assert.equal(denied.length, 1);
  assert.match(denied[0]!.detail, /"message":"delivered"/);
  const task = f.store.task(f.task.id);
  assert.notEqual(task.resolution.stop?.reason, "run_stalled", "a declined permission is not a stalled turn");
  assert.equal(task.resolution.attention, false);
  // The host still lists the request on the next pass: nothing is answered twice.
  await f.engine.wake();
  assert.equal(f.permissionAnswers.length, 1);
  assert.equal(f.messages.length, 1);
});

const pendingPermission = () => running({
  permissions: true, updatedAt: minutesAgo(35), turnStartedAt: minutesAgo(40),
  pendingRequest: { id: "request-1", kind: "command", firstLine: null }, pendingPermissionKinds: ["command"],
});

test("a decline with an unknown outcome is never resent, and a request still listed goes to stall detection", async (t) => {
  const f = await selfHealingFixture(t);
  let sends = 0;
  f.adapter.answerNativePermission = async () => { sends++; throw new Error("socket closed mid-send"); };
  f.setObservation(pendingPermission());
  await f.engine.wake();
  assert.equal(sends, 1);
  assert.equal(events(f, PERMISSION_DENIAL_UNKNOWN).length, 1);
  const task = f.store.task(f.task.id);
  assert.ok(task.resolution.stop || task.resolution.attention, "the unanswered request is raised, not silenced");
  assert.match(task.reason, /request-1/);
  await f.engine.wake();
  assert.equal(sends, 1, "an unknown decline is never resent");
});

test("a decline intent with no recorded outcome is never resent, and the request goes to stall detection", async (t) => {
  const f = await selfHealingFixture(t);
  // The service stopped between writing the intent and sending.
  f.store.event(f.task.id, PERMISSION_DENIAL_INTENT,
    `ns-permission-deny-initial-request-1: ${JSON.stringify({ runId: "initial", agentId: "worker", requestId: "request-1", kind: "command" })}`);
  f.setObservation(pendingPermission());
  await f.engine.wake();
  assert.equal(f.permissionAnswers.length, 0);
  const task = f.store.task(f.task.id);
  assert.ok(task.resolution.stop || task.resolution.attention, "the unanswered request is raised, not silenced");
  assert.match(task.reason, /request-1/);
});

test("a native question is not a permission and is never declined", async (t) => {
  const f = await selfHealingFixture(t);
  f.setObservation(running({
    permissions: true, pendingRequest: { id: "question-1", kind: "question", firstLine: null }, pendingPermissionKinds: ["question"],
  }));
  await f.engine.wake();
  assert.equal(f.permissionAnswers.length, 0);
  assert.equal(events(f, PERMISSION_DENIAL_INTENT).length, 0);
});
