import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueRuntime } from "../service/runtime-owner";
import { RuntimePlanning } from "../core/runtime/planning";
import { git } from "../core/git/index";
import { leadSubmit } from "../shared/contracts";
import { briefDigest } from "../core/planning/brief";
import type { Adapter } from "../core/host";
import { hostIdFromDataDir } from "../shared/host-operation";
import { formatAgentId } from "../shared/agent-identity";

const title = "Submit the fixture";
const body = `---\ntitle: ${title}\nqueue:\n  complexity: medium\n---\n\n## Outcome\nBuild the fixture.\n`;
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "submit-"));
  const repo = join(root, "repo");
  await git(
    root,
    "init",
    "--bare",
    "--initial-branch=main",
    join(root, "origin.git"),
  );
  await git(root, "clone", join(root, "origin.git"), repo);
  await git(repo, "config", "user.name", "Queue test");
  await git(repo, "config", "user.email", "queue@example.invalid");
  await mkdir(join(repo, ".paseo"));
  await writeFile(
    join(repo, ".paseo/queue.json"),
    JSON.stringify({
      schema: "paseo.queue.control.v5",
      closeout: "queue",
      hooks: [],
    }),
  );
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "fixture");
  await git(repo, "push", "origin", "main");
  const adapter = {
    client: { isConnected: true },
    isConnected: () => true,
    hostId: "fixture-host",
    socketPath: join(root, "callback.sock"),
    helperPath: join(root, "helper.mjs"),
    connect: async () => {},
    close: async () => {},
    catalog: async () => ({ providers: [] }),
    originAgent: async (id: string) => ({
      id,
      workspaceId: "origin-ws",
      archived: false,
    }),
  } as unknown as Adapter;
  const runtime = new QueueRuntime({
    dataDir: join(root, "data"),
    adapterFactory: () => adapter,
    timers: false,
  });
  t.after(() => runtime.drain());
  await runtime.started;
  await runtime.bootstrap;
  runtime.store.setMeta("paused", true);
  const input = leadSubmit.input.parse({
    repository: { origin: repo, path: repo },
    title,
    body,
    agent: "planner",
    note: "Tom authorized this fixture",
  });
  return { runtime, input, repo };
}

test("one submission checks, records exact approval and returns the promoted task; repeating returns it", async (t) => {
  const { runtime, input } = await fixture(t);
  const result = leadSubmit.output.parse(await runtime.submitLead(input));
  assert.ok("taskId" in result);
  const task = runtime.store.task(result.taskId);
  assert.equal(task.title, title);
  assert.equal(result.reference, task.reference);
  const lead = runtime.listLeads({ state: "promoted" })[0];
  assert.equal(lead.approval?.note, input.note);
  assert.equal(lead.approval?.approver, input.agent);
  assert.equal(lead.approval?.relayed, true);
  assert.equal(lead.approval?.digest, briefDigest(body));
  assert.equal(lead.approval?.planningCommit, task.planningCommit);
  assert.deepEqual(await runtime.submitLead(input), result);
  assert.equal(runtime.store.tasks().length, 1);
  // Completed and removed tasks still fence same-title submissions through permanent numbering.
  runtime.store.update(task.id, {
    phase: "done",
    removedAt: new Date().toISOString(),
    reason: "Fixture complete",
  });
  assert.deepEqual(await runtime.submitLead(input), result);
});

test("BB lead submission and promotion use verified ingress identity while tasks keep the work host", async (t) => {
  const { runtime, input, repo } = await fixture(t);
  const bbDataDir = join(repo, "..", "bb-data");
  const bbHostId = hostIdFromDataDir(bbDataDir);
  const caller = formatAgentId(bbHostId, "thr_submitter");
  const connectedAt = new Date().toISOString();
  assert.deepEqual(
    runtime.bbHostVerified({
      hostId: bbHostId,
      dataDir: bbDataDir,
      bbVersion: "0.49.0",
      sdkVersion: "0.6.132",
      hostIds: ["host_synthetic"],
      connectedAt,
    }),
    { ok: true },
  );
  runtime.store.setMeta("operatorDefaultHostKind", "paseo");

  const ingressSelections: Array<{
    plannerHostId?: string;
    result: ReturnType<typeof runtime.engine.selectIngressSelection>;
  }> = [];
  const selectIngressSelection = runtime.engine.selectIngressSelection.bind(
    runtime.engine,
  );
  runtime.engine.selectIngressSelection = (
    explicit,
    repoPath,
    origin,
    plannerHostId,
  ) => {
    const result = selectIngressSelection(
      explicit,
      repoPath,
      origin,
      plannerHostId,
    );
    ingressSelections.push({ plannerHostId, result });
    return result;
  };

  const submitted = leadSubmit.output.parse(
    await runtime.submitLead({
      ...input,
      hostId: bbHostId,
      agent: caller,
      identitySource: { agent: caller, hostId: bbHostId },
    }),
  );
  assert.ok("taskId" in submitted);
  const submittedTask = runtime.store.task(submitted.taskId);
  assert.equal(submittedTask.originAgentId, caller);
  assert.equal(submittedTask.originHostId, bbHostId);
  assert.equal(
    submittedTask.hostId,
    "fixture-host",
    "the BB caller does not become a task work host",
  );
  assert.equal(submittedTask.hostSelection?.hostId, "fixture-host");
  assert.ok(
    ingressSelections.some(
      (selection) =>
        selection.result?.hostId === bbHostId &&
        selection.result.basis === "explicit",
    ),
    "lead.submit selected the verified BB host for ingress",
  );

  const draftBody = body.replace(title, "Direct BB promotion");
  const lead = await runtime.addLead({
    repositories: [{ origin: repo, path: repo }],
    title: "Direct BB promotion",
    body: draftBody,
    lanes: [],
    author: caller,
  });
  assert.equal(lead.check?.ok, true, lead.check?.message);
  runtime.store.setMeta("operatorDefaultHostKind", null);
  const promoted = await runtime.promoteLeadToTask({
    id: lead.id,
    repository: repo,
    agent: caller,
    note: input.note,
    board: false,
    identitySource: { agent: caller, hostId: bbHostId },
  });
  assert.ok("taskId" in promoted);
  const promotedTask = runtime.store.task(promoted.taskId);
  assert.equal(promotedTask.originHostId, bbHostId);
  assert.equal(promotedTask.hostId, "fixture-host");
  assert.deepEqual(promotedTask.hostSelection, {
    hostId: "fixture-host",
    basis: "sole_online_host",
  });
  assert.ok(
    ingressSelections
      .filter((selection) => selection.plannerHostId === bbHostId)
      .some(
        (selection) =>
          selection.result?.hostId === bbHostId &&
          selection.result.basis === "planner_host",
      ),
    "promotion preserved the nested request identity source for ingress selection",
  );

  runtime.bbHostReleased({
    hostId: bbHostId,
    connectedAt,
    reason: "synthetic disconnect",
  });
  runtime.store.setMeta("operatorDefaultHostKind", "paseo");
  const offlineLead = await runtime.addLead({
    repositories: [{ origin: repo, path: repo }],
    title: "Offline BB promotion",
    body: body.replace(title, "Offline BB promotion"),
    lanes: [],
    author: caller,
  });
  assert.equal(offlineLead.check?.ok, true, offlineLead.check?.message);
  await assert.rejects(
    runtime.promoteLeadToTask({
      id: offlineLead.id,
      repository: repo,
      agent: caller,
      note: input.note,
      board: false,
      identitySource: { agent: caller, hostId: bbHostId },
    }),
    (error) => {
      assert.match(String(error), new RegExp(bbHostId));
      assert.match(
        String(error),
        /invalid_input|offline or unavailable for ingress/u,
      );
      return true;
    },
  );
});

test("BB callers submit and promote to a BB repository host, and an offline BB host refuses promotion", async (t) => {
  const { runtime, input, repo } = await fixture(t);
  const bbDataDir = join(repo, "..", "bb-work-data");
  const bbHostId = hostIdFromDataDir(bbDataDir);
  const caller = formatAgentId(bbHostId, "thr_bb_work_planner");
  const connectedAt = new Date().toISOString();
  assert.deepEqual(
    runtime.bbHostVerified({
      hostId: bbHostId,
      dataDir: bbDataDir,
      bbVersion: "0.49.0",
      sdkVersion: "0.6.132",
      hostIds: ["host_synthetic"],
      connectedAt,
    }),
    { ok: true },
  );
  runtime.store.setMeta("operatorDefaultHostKind", "paseo");
  runtime.store.putRepository(
    { origin: null, path: repo },
    null,
    "",
    null,
    null,
    null,
    undefined,
    undefined,
    "bb",
  );

  const submitted = leadSubmit.output.parse(
    await runtime.submitLead({
      ...input,
      hostId: bbHostId,
      agent: caller,
      identitySource: { agent: caller, hostId: bbHostId },
    }),
  );
  assert.ok("taskId" in submitted);
  const submittedTask = runtime.store.task(submitted.taskId);
  assert.equal(submittedTask.originHostId, bbHostId);
  assert.equal(submittedTask.hostId, bbHostId);
  assert.deepEqual(submittedTask.hostSelection, {
    hostId: bbHostId,
    basis: "repository_override",
    reason: "Repository host override bb",
  });

  const promotionTitle = "Promote to configured BB work host";
  const lead = await runtime.addLead({
    repositories: [{ origin: repo, path: repo }],
    title: promotionTitle,
    body: body.replace(title, promotionTitle),
    lanes: [],
    author: caller,
  });
  assert.equal(lead.check?.ok, true, lead.check?.message);
  const promoted = await runtime.promoteLeadToTask({
    id: lead.id,
    repository: repo,
    agent: caller,
    note: input.note,
    board: false,
    identitySource: { agent: caller, hostId: bbHostId },
  });
  assert.ok("taskId" in promoted);
  const promotedTask = runtime.store.task(promoted.taskId);
  assert.equal(promotedTask.originHostId, bbHostId);
  assert.equal(promotedTask.hostId, bbHostId);
  assert.deepEqual(promotedTask.hostSelection, {
    hostId: bbHostId,
    basis: "repository_override",
    reason: "Repository host override bb",
  });

  const offlineTitle = "Refuse offline BB work host";
  const offlineLead = await runtime.addLead({
    repositories: [{ origin: repo, path: repo }],
    title: offlineTitle,
    body: body.replace(title, offlineTitle),
    lanes: [],
    author: caller,
  });
  assert.equal(offlineLead.check?.ok, true, offlineLead.check?.message);
  runtime.bbHostReleased({
    hostId: bbHostId,
    connectedAt,
    reason: "synthetic disconnect",
  });
  const taskCount = runtime.store.tasks().length;
  await assert.rejects(
    runtime.promoteLeadToTask({
      id: offlineLead.id,
      repository: repo,
      agent: caller,
      note: input.note,
      board: false,
      identitySource: { agent: caller, hostId: bbHostId },
    }),
    (error) => {
      assert.equal((error as { code?: string }).code, "invalid_input");
      assert.match(String(error), new RegExp(bbHostId));
      return true;
    },
  );
  assert.equal(
    runtime.store.tasks().length,
    taskCount,
    "an offline BB work host cannot create a promoted task",
  );
});

test("failed brief checks return their findings and never approve or promote", async (t) => {
  const { runtime, input } = await fixture(t);
  const result = await runtime.submitLead({
    ...input,
    body: body.replace("complexity: medium", "complexity: invalid"),
  });
  assert.ok("lead" in result);
  assert.equal(result.lead.check?.ok, false);
  assert.match(result.lead.check?.message ?? "", /complexity/);
  assert.equal(result.lead.approval, null);
  assert.equal(runtime.store.tasks().length, 0);
});

test("resubmitting a lead rechecks a completed transient brief-check failure", async (t) => {
  const { runtime, input } = await fixture(t);
  const preview = runtime.engine.hooks.previewPreDispatch.bind(
    runtime.engine.hooks,
  );
  runtime.engine.hooks.previewPreDispatch = async () => {
    throw new Error("temporary hook failure");
  };
  const first = await runtime.submitLead(input);
  assert.ok("lead" in first);
  assert.equal(first.lead.check?.ok, false);
  runtime.engine.hooks.previewPreDispatch = preview;
  const second = await runtime.submitLead(input);
  assert.ok("taskId" in second);
  assert.equal(runtime.store.tasks().length, 1);
});

test("submission resumes an open lead with the same brief and refuses a different brief", async (t) => {
  const { runtime, input } = await fixture(t);
  const start = runtime.engine.startOperation.bind(runtime.engine);
  runtime.engine.startOperation = async () => {
    throw new Error("temporary check failure");
  };
  const first = await runtime.submitLead(input);
  assert.ok("lead" in first);
  runtime.engine.startOperation = start;
  await assert.rejects(
    runtime.submitLead({ ...input, body: body + "Different" }),
    new RegExp(`Lead ${first.lead.id}.*lead.edit`),
  );
  const result = await runtime.submitLead(input);
  assert.ok("taskId" in result);
  assert.equal(result.reference, runtime.store.task(result.taskId).reference);
});

test("concurrent identical submissions share promotion for new and open leads", async (t) => {
  const { runtime, input } = await fixture(t);
  const fresh = await Promise.all([
    runtime.submitLead(input),
    runtime.submitLead(input),
  ]);
  assert.ok("taskId" in fresh[0]);
  assert.deepEqual(fresh[1], fresh[0]);
  const request = {
    ...input,
    title: "Open fixture",
    body: body.replace(title, "Open fixture"),
  };
  const start = runtime.engine.startOperation.bind(runtime.engine);
  runtime.engine.startOperation = async () => {
    throw new Error("temporary check failure");
  };
  const open = await runtime.submitLead(request);
  assert.ok("lead" in open);
  runtime.engine.startOperation = start;
  const resumed = await Promise.all([
    runtime.submitLead(request),
    runtime.submitLead(request),
  ]);
  assert.ok("taskId" in resumed[0]);
  assert.deepEqual(resumed[1], resumed[0]);
  assert.equal(runtime.store.tasks().length, 2);
});

test("submission waits past compatibility responses for both check and promotion", async (t) => {
  const { runtime, input } = await fixture(t);
  const planning = (runtime as any).planning as RuntimePlanning;
  const original = runtime.engine.awaitOperation.bind(runtime.engine);
  const waits: number[] = [];
  runtime.engine.awaitOperation = async (id, timeout) => {
    waits.push(timeout!);
    // A compatibility response may still say pending even if the executor is fast.
    if (timeout !== Infinity) return runtime.store.operation(id)!;
    return original(id, 8_000);
  };
  const result = await planning.submitLead(input);
  assert.ok("taskId" in result);
  assert.equal(waits.filter((wait) => wait === Infinity).length, 2);
});

test("submission refuses missing authorization and board impersonation before creating a lead", () => {
  const input = {
    repository: "owner/repo",
    title,
    body,
    agent: "planner",
    note: "Authorized",
  };
  assert.equal(leadSubmit.input.safeParse(input).success, true);
  assert.equal(
    leadSubmit.input.safeParse({ ...input, note: " " }).success,
    false,
  );
  assert.equal(
    leadSubmit.input.safeParse({ ...input, agent: "operator (board)" }).success,
    false,
  );
});
