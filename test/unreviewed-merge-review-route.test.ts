import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueRuntime } from "../service/runtime-owner";
import {
  externalMerge,
  merged as forgeMerged,
  publishReview,
  syncMain,
  verifyCloseoutPublication,
  verifyMergedReviewSource,
  verifyPrIdentity,
  verifyReview,
} from "../core/forge/index";
import { verifyPr } from "../core/git/index";
import { collectOwnerVerbFacts, ownerTaskNext } from "../core/verbs/owner-verbs";
import {
  submissionSchema,
  taskControlInputSchema,
  type Profile,
  type Run,
  type Task,
} from "../shared/contracts";
import type { Adapter, AgentObservation } from "../core/host";
import { toolTimelinePage } from "./support/tool-timeline";

const workerProfile: Profile = {
  id: "worker",
  name: "Worker",
  provider: "test",
  model: "test/worker",
  notes: "",
  available: true,
  problem: "",
  supportedThinking: [],
};
const reviewerProfile: Profile = {
  ...workerProfile,
  id: "reviewer",
  name: "Reviewer",
  model: "test/reviewer",
};
const coordinatorProfile: Profile = {
  ...workerProfile,
  id: "coordinator",
  name: "Coordinator",
  model: "test/coordinator",
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const GH_ORIGIN = "ssh://git@github.com/example/repo.git";

interface PullPayload {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  html_url: string;
  merge_commit_sha: string | null;
  head: { sha: string; ref: string; repo: { full_name: string } };
  base: { ref: string; repo: { full_name: string } };
}

/**
 * Private realistic local Git + local `gh` forge fixture (nucleus#1425).
 * Runs the real `QueueRuntime`, real `core/git` (`verifyPr`), real `core/forge`
 * (`externalMerge`, `verifyMergedReviewSource`, `verifyPrIdentity`, `publishReview`,
 * `verifyReview`, `syncMain`, `verifyCloseout`) against a real bare origin,
 * integration checkout, task worktree, and separate writer clone under `TMPDIR`.
 */
async function createPrivateForgeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-unreviewed-merge-route-")));
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  const writer = join(root, "writer");
  const statePath = join(root, "gh-state.json");
  const ghBin = join(root, "gh");

  git(root, "init", "--bare", origin);
  git(root, "init", "-b", "main", repo);
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.test");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "origin", "main");
  git(repo, "config", "remote.origin.url", GH_ORIGIN);

  /** Temporarily enable local bare-repo transport for git push/fetch while keeping GitHub URL for forge reads. */
  const withLocalTransport = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    git(repo, "config", `url.${origin}.insteadOf`, GH_ORIGIN);
    try {
      return await fn();
    } finally {
      git(repo, "config", "--unset-all", `url.${origin}.insteadOf`);
    }
  };

  const ghScript = `#!/usr/bin/env node
const fs = require("node:fs");
const statePath = ${JSON.stringify(statePath)};
const args = process.argv.slice(2);
const readState = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const writeState = (s) => fs.writeFileSync(statePath, JSON.stringify(s));
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };

if (args[0] === "pr" && args[1] === "view") {
  const s = readState();
  const p = s.pull;
  const [owner, name] = p.head.repo.full_name.split("/");
  out({
    number: p.number,
    url: p.html_url,
    state: p.merged ? "MERGED" : p.state.toUpperCase(),
    isDraft: p.draft,
    headRefName: p.head.ref,
    baseRefName: p.base.ref,
    headRefOid: p.head.sha,
    headRepository: { name },
    headRepositoryOwner: { login: owner },
    isCrossRepository: p.head.repo.full_name !== p.base.repo.full_name,
  });
}

if (args[0] === "api") {
  const endpoint = args[1] || "";
  const s = readState();
  if (endpoint === "user") out({ login: "fixture-reviewer" });
  if (endpoint === "repos/example/repo/pulls/41") out(s.pull);
  if (endpoint.startsWith("repos/example/repo/issues/41/comments")) {
    const isPost = args.includes("-X") && args[args.indexOf("-X") + 1] === "POST";
    if (isPost) {
      const fIdx = args.indexOf("-f");
      const raw = fIdx >= 0 ? args[fIdx + 1] : "";
      const body = raw.startsWith("body=") ? raw.slice(5) : raw;
      const id = s.nextCommentId++;
      const comment = {
        id,
        issue_url: "https://api.github.com/repos/example/repo/issues/41",
        user: { login: "fixture-reviewer" },
        body,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      s.comments.push(comment);
      writeState(s);
      out(comment);
    }
    if (args.includes("--slurp")) out([s.comments]);
    out(s.comments);
  }
  const single = endpoint.match(/^repos\\/example\\/repo\\/issues\\/comments\\/(\\d+)$/);
  if (single) {
    const id = Number(single[1]);
    const comment = s.comments.find((c) => c.id === id);
    if (!comment) { process.stderr.write("Not Found\\n"); process.exit(1); }
    out(comment);
  }
}
process.stderr.write("Unsupported gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`;
  writeFileSync(ghBin, ghScript);
  chmodSync(ghBin, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${root}:${oldPath ?? ""}`;

  let workspace = "";
  let workspaceId = "";
  let workerAgentId = "";
  let workerToken = "";
  let reviewerRunId = "";
  let reviewerToken = "";
  let closeoutRunId = "";
  let closeoutToken = "";
  let head = "";
  let mergeCalls = 0;
  let workerCreates = 0;
  let reviewerCreates = 0;
  let closeoutCreates = 0;
  const idleState: Partial<AgentObservation> = {
    status: "idle",
    active: false,
    permissions: false,
    activeTurnId: null,
  };

  const setPull = (pull: PullPayload) => {
    let existing = { nextCommentId: 700, comments: [] as unknown[] };
    if (existsSync(statePath)) {
      const parsed = JSON.parse(readFileSync(statePath, "utf8"));
      existing = { nextCommentId: parsed.nextCommentId ?? 700, comments: parsed.comments ?? [] };
    }
    writeFileSync(statePath, JSON.stringify({ ...existing, pull }));
  };

  const adapter = {
    hostProcessListing: async () => [],
    client: { isConnected: true },
    isConnected: () => true,
    hostId: "fixture",
    socketPath: join(root, "cb.sock"),
    helperPath: join(root, "helper.mjs"),
    connect: async () => {},
    close: async () => {},
    profiles: async () => [workerProfile, reviewerProfile, coordinatorProfile],
    validate: async () => base,
    createWorkspace: async (t: Task) => {
      workspace = join(root, t.branch);
      workspaceId = "workspace-1";
      git(repo, "worktree", "add", "-b", t.branch, workspace, "main");
      return { id: workspaceId, directory: workspace };
    },
    findWorkspaces: async () => (workspace ? [{ id: workspaceId, directory: workspace }] : []),
    verifyWorkspace: async (t: Task) => t.branch,
    createAgent: async (t: Task, value: string) => {
      workerCreates++;
      workerToken = value;
      workerAgentId = `worker-${workerCreates}`;
      return { id: workerAgentId, workspaceId: t.workspaceId };
    },
    observe: async (id: string) => ({
      id,
      workspaceId: workspaceId || "owner-workspace",
      error: "",
      ...idleState,
    }),
    agentTimelinePage: async () => toolTimelinePage([]),
    verifyPr: async (t: Task, n: number) => verifyPr(t, n),
    verifyPrIdentity: async (t: Task, n: number, opts?: { allowDraft?: boolean }) =>
      verifyPrIdentity(t, n, opts),
    verifyMergedReviewSource: async (t: Task, route: { prNumber: number; head: string; commit: string }) =>
      verifyMergedReviewSource(t, route),
    externalMerge: async (t: Task, accept?: boolean, retained?: boolean) =>
      externalMerge(t, accept, retained),
    publishReview: async (store: any, t: Task, run: Run, status: string, text: string, allowed?: () => boolean) =>
      publishReview(store, t, run, status, text, allowed),
    verifyReview: async (t: Task, run: Run, result: any) => verifyReview(t, run, result),
    syncMain: async (t: Task, allowed?: () => boolean) => withLocalTransport(() => syncMain(t, allowed)),
    verifyCloseout: async (t: Task, result?: any) => {
      const p = await forgeMerged(t);
      if (!p.merged || p.commit !== t.resolution.mergedCommit || p.head !== t.resolution.mergeHead)
        throw new Error("Closeout merge evidence changed");
      return withLocalTransport(() => verifyCloseoutPublication(t, result));
    },
    merge: async () => {
      mergeCalls++;
      throw new Error("Queue must never merge an already-merged PR");
    },
    archiveAgent: async () => {},
    notify: async () => {},
    findAgents: async () => [],
    findRunAgents: async () => [],
    createRun: async (_task: Task, run: Run, value: string) => {
      if (run.role === "reviewer") {
        reviewerCreates++;
        reviewerRunId = run.id;
        reviewerToken = value;
        return { id: `reviewer-${reviewerCreates}`, workspaceId: run.workspaceId };
      }
      if (run.role === "closeout") {
        closeoutCreates++;
        closeoutRunId = run.id;
        closeoutToken = value;
        return { id: `closeout-${closeoutCreates}`, workspaceId: run.workspaceId };
      }
      workerCreates++;
      workerToken = value;
      return { id: `worker-${workerCreates}`, workspaceId: run.workspaceId };
    },
    sendRun: async () => {},
  } as unknown as Adapter;

  const runtime = new QueueRuntime({
    dataDir: join(root, "data"),
    adapterFactory: () => adapter,
    timers: false,
  });
  await runtime.started;
  await runtime.bootstrap;
  runtime.engine.profiles = [workerProfile, reviewerProfile, coordinatorProfile];
  runtime.store.setMeta("pool", [
    {
      profileId: "worker",
      enabled: true,
      group: "worker",
      weight: "default",
      scopes: ["general"],
      roles: ["worker"],
    },
    {
      profileId: "reviewer",
      enabled: true,
      group: "reviewer",
      weight: "default",
      scopes: ["general"],
      roles: ["reviewer"],
    },
    {
      profileId: "coordinator",
      enabled: true,
      group: "coordinator",
      weight: "default",
      scopes: ["general"],
      roles: ["coordinator"],
    },
  ]);
  runtime.store.setMeta("paused", false);

  const task = runtime.store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Private realistic merged PR observation",
      repoPath: repo,
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin-planner",
    }),
    "fixture",
    "fixture",
    base,
    {},
    undefined,
    "example/repo",
  );
  const project = runtime.store.projectFor(repo, "example/repo")!;
  runtime.store.setProjectPlanner({
    key: project.key,
    agentId: "origin-planner",
    setBy: "test",
    note: "Fixture planner",
  });

  // Launch worker, commit initial source head H1, push to origin, open PR #41, and report ready_for_review.
  await runtime.engine.wake();
  let current = runtime.store.task(task.id);
  assert.equal(current.phase, "working", current.reason);
  writeFileSync(join(workspace, "feature.txt"), "initial implementation\n");
  git(workspace, "add", "feature.txt");
  git(workspace, "commit", "-m", "initial implementation");
  head = git(workspace, "rev-parse", "HEAD");
  await withLocalTransport(() => git(workspace, "push", "origin", current.branch));
  const basePull = (overrides: Partial<PullPayload> = {}): PullPayload => ({
    number: 41,
    state: "open",
    merged: false,
    draft: false,
    html_url: "https://github.com/example/repo/pull/41",
    merge_commit_sha: null,
    head: { sha: head, ref: current.branch, repo: { full_name: "example/repo" } },
    base: { ref: "main", repo: { full_name: "example/repo" } },
    ...overrides,
  });
  setPull(basePull());

  runtime.store.setMeta("paused", true);
  await runtime.engine.complete(
    {
      eventId: randomUUID(),
      taskId: task.id,
      runId: current.runId!,
      status: "ready_for_review",
      summary: "Implemented feature at exact head",
      prNumber: 41,
      head,
    },
    workerToken,
  );
  runtime.store.setMeta("paused", false);
  await runtime.engine.wake();
  current = runtime.store.task(task.id);
  assert.equal(current.prHead, head);
  assert.equal(current.prUrl, "https://github.com/example/repo/pull/41");

  // Clone a separate writer checkout of the bare origin to perform external merges / pushes.
  git(root, "clone", origin, writer);
  git(writer, "config", "user.name", "External Merger");
  git(writer, "config", "user.email", "merger@example.test");

  const mergeExternally = (mode: "merge" | "squash" | "changed-head"): { finalHead: string; mergeCommit: string } => {
    let finalHead = head;
    if (mode === "changed-head") {
      git(writer, "checkout", current.branch);
      writeFileSync(join(writer, "feature.txt"), "external follow-up commit\n");
      git(writer, "add", "feature.txt");
      git(writer, "commit", "-m", "external follow-up");
      finalHead = git(writer, "rev-parse", "HEAD");
      git(writer, "push", "origin", current.branch);
    }
    git(writer, "checkout", "main");
    let mergeCommit: string;
    if (mode === "squash") {
      git(writer, "merge", "--squash", `origin/${current.branch}`);
      git(writer, "commit", "-m", "Squash merge PR #41");
      mergeCommit = git(writer, "rev-parse", "HEAD");
    } else {
      git(writer, "merge", "--no-ff", finalHead, "-m", "Merge PR #41");
      mergeCommit = git(writer, "rev-parse", "HEAD");
    }
    git(writer, "push", "origin", "main");
    setPull(
      basePull({
        state: "closed",
        merged: true,
        merge_commit_sha: mergeCommit,
        head: { sha: finalHead, ref: current.branch, repo: { full_name: "example/repo" } },
      }),
    );
    return { finalHead, mergeCommit };
  };

  const close = async () => {
    runtime.store.setMeta("paused", true);
    await runtime.engine.wake();
    await runtime.engine.stop();
    const classes = ["callback", "control", "observation", "title", "cleanup", "inventory", "workspace"] as const;
    const idle = () => {
      const snap = runtime.admission.snapshot();
      return classes.every((cls) => snap[cls].running === 0 && snap[cls].waiting === 0);
    };
    const deadline = Date.now() + 10_000;
    while (!idle()) {
      if (Date.now() >= deadline) throw new Error("Fixture admission did not drain before teardown");
      await new Promise<void>((r) => setTimeout(r, 10));
    }
    await runtime.drain();
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  };

  return {
    runtime,
    repo,
    workspace,
    taskId: task.id,
    head,
    basePull,
    setPull,
    mergeExternally,
    current: () => runtime.store.task(task.id),
    reviewerRun: () => ({ runId: reviewerRunId, token: reviewerToken }),
    closeoutRun: () => ({ runId: closeoutRunId, token: closeoutToken }),
    counts: () => ({ mergeCalls, workerCreates, reviewerCreates, closeoutCreates }),
    nextReviewVerb: () =>
      ownerTaskNext(collectOwnerVerbFacts(runtime.store, runtime.store.task(task.id))).verbs.find(
        (v) => v.verb === "move" && v.args?.to === "review",
      ),
    close,
  };
}

test(
  "private realistic squash merge: escalation -> move to=review -> ready_to_merge -> sync -> closeout -> done (nucleus#1425)",
  { timeout: 90000 },
  async () => {
    const f = await createPrivateForgeFixture();
    try {
      const { mergeCommit } = f.mergeExternally("squash");
      // Squash commit is distinct from the source head and does not have source head as a git parent.
      assert.notEqual(mergeCommit, f.head);
      assert.throws(() => git(f.repo, "merge-base", "--is-ancestor", f.head, mergeCommit));

      // Strict open-PR proof genuinely refuses the merged PR.
      await assert.rejects(
        verifyPr(f.current(), 41),
        /PR must be open, ready, and match the task's branch and base/,
      );

      // External merge probe observes the squash merge, records unreviewedMerge, stops and escalates.
      f.runtime.engine.resolution.externalMergeProbeMs = 0;
      assert.equal(await f.runtime.engine.resolution.recoverExternalMerge(f.current()), true);
      assert.equal(f.current().phase, "blocked");
      assert.deepEqual(f.current().resolution.unreviewedMerge, {
        prNumber: 41,
        head: f.head,
        commit: mergeCommit,
      });

      // `next` offers `move to=review` with the exact merged source note.
      const offered = f.nextReviewVerb();
      assert.equal(offered?.available, true);
      assert.match(offered?.note ?? "", new RegExp(f.head));
      assert.match(offered?.note ?? "", new RegExp(mergeCommit));

      // Planner takes the offered `move to=review` route.
      await f.runtime.taskControl(
        taskControlInputSchema.parse({
          taskId: f.taskId,
          version: f.current().version,
          action: "move",
          to: "review",
          reason: "Review the squash-merged source at its exact head",
          caller: "origin-planner",
        }),
      );
      await f.runtime.engine.wake();
      assert.equal(f.current().phase, "reviewing");
      const { runId, token } = f.reviewerRun();
      assert.ok(runId && token);
      assert.equal(f.runtime.store.run(runId)?.head, f.head);

      // Reviewer submits genuine ready_to_merge verdict at the exact merged head; real publishReview + verifyReview run.
      await f.runtime.engine.complete(
        {
          eventId: randomUUID(),
          taskId: f.taskId,
          runId,
          status: "ready_to_merge",
          head: f.head,
          summary: "Verified squash-merged source at exact head",
          reviewText: "Reviewed the exact merged source commit; changes are sound.",
        },
        token,
      );
      f.runtime.engine.resolution.externalMergeProbeMs = 0;
      await f.runtime.engine.wake();

      // Reconciles the observed squash merge once without calling merge(), syncs local main to the squash commit, and closes out to done.
      assert.equal(f.current().resolution.mergedCommit, mergeCommit);
      assert.equal(f.current().resolution.externalMerge, true);
      assert.equal(f.current().resolution.syncedCommit, mergeCommit);
      assert.equal(f.counts().mergeCalls, 0);
      assert.equal(git(f.repo, "rev-parse", "HEAD"), mergeCommit);
      assert.equal(f.current().phase, "done");
      assert.equal(f.current().resolution.review?.status, "ready_to_merge");
      assert.equal(f.current().resolution.review?.head, f.head);
      assert.ok(f.current().resolution.review?.reviewCommentId, "real review comment was published on the merged PR");
    } finally {
      await f.close();
    }
  },
);

test(
  "private realistic merge commit: escalation -> move to=review -> ready_to_merge -> closeout -> done (nucleus#1425)",
  { timeout: 90000 },
  async () => {
    const f = await createPrivateForgeFixture();
    try {
      const { mergeCommit } = f.mergeExternally("merge");
      assert.notEqual(mergeCommit, f.head);

      f.runtime.engine.resolution.externalMergeProbeMs = 0;
      assert.equal(await f.runtime.engine.resolution.recoverExternalMerge(f.current()), true);
      assert.equal(f.current().phase, "blocked");
      assert.deepEqual(f.current().resolution.unreviewedMerge, {
        prNumber: 41,
        head: f.head,
        commit: mergeCommit,
      });

      await f.runtime.taskControl(
        taskControlInputSchema.parse({
          taskId: f.taskId,
          version: f.current().version,
          action: "move",
          to: "review",
          reason: "Review the externally merged source at exact head",
          caller: "origin-planner",
        }),
      );
      await f.runtime.engine.wake();
      const { runId, token } = f.reviewerRun();
      await f.runtime.engine.complete(
        {
          eventId: randomUUID(),
          taskId: f.taskId,
          runId,
          status: "ready_to_merge",
          head: f.head,
          summary: "Approved merged source",
          reviewText: "Exact-head review passed.",
        },
        token,
      );
      f.runtime.engine.resolution.externalMergeProbeMs = 0;
      await f.runtime.engine.wake();
      assert.equal(f.current().phase, "done");
      assert.equal(f.current().resolution.mergedCommit, mergeCommit);
      assert.equal(f.current().resolution.externalMerge, true);
      assert.equal(f.current().resolution.syncedCommit, mergeCommit);
      assert.equal(git(f.repo, "rev-parse", "HEAD"), mergeCommit);
      assert.equal(f.counts().mergeCalls, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "private realistic changed final head: external merge at a newer head refuses unreviewed review route and never invents acceptance (nucleus#1425)",
  { timeout: 90000 },
  async () => {
    const f = await createPrivateForgeFixture();
    try {
      const { finalHead, mergeCommit } = f.mergeExternally("changed-head");
      assert.notEqual(finalHead, f.head);

      // Automatic probe rejects the mismatched head instead of recording unreviewedMerge for an unverified final head.
      f.runtime.engine.resolution.externalMergeProbeMs = 0;
      assert.equal(await f.runtime.engine.resolution.recoverExternalMerge(f.current()), true);
      assert.equal(f.current().resolution.unreviewedMerge, null);
      assert.equal(f.current().resolution.mergedCommit, null);
      assert.match(f.current().reason, /External merge head differs from recorded task work/);

      // `move to=review` hits strict open-PR verification and refuses the merged PR.
      await assert.rejects(
        f.runtime.taskControl(
          taskControlInputSchema.parse({
            taskId: f.taskId,
            version: f.current().version,
            action: "move",
            to: "review",
            reason: "Attempt review of changed final head",
            caller: "origin-planner",
          }),
        ),
        /PR must be open, ready, and match the task's branch and base/,
      );
      assert.equal(f.current().resolution.mergedCommit, null);
      assert.equal(f.counts().mergeCalls, 0);

      // Even if a task had stopped on H1/M1, a subsequent forge drift to a different merge commit or head refuses admission.
      f.runtime.store.update(f.taskId, {
        phase: "blocked",
        resolution: {
          ...f.current().resolution,
          attention: false,
          unreviewedMerge: { prNumber: 41, head: f.head, commit: mergeCommit },
        },
      });
      await assert.rejects(
        f.runtime.taskControl(
          taskControlInputSchema.parse({
            taskId: f.taskId,
            version: f.current().version,
            action: "move",
            to: "review",
            reason: "Attempt review after head changed on forge",
            caller: "origin-planner",
          }),
        ),
        /External merge head differs from recorded task work/,
      );
      assert.equal(f.current().resolution.mergedCommit, null);
      assert.equal(f.counts().mergeCalls, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "private realistic insufficient-evidence and negative-verdict refusals keep the stop honest with zero extra merges or revisions (nucleus#1425)",
  { timeout: 90000 },
  async () => {
    const f = await createPrivateForgeFixture();
    try {
      const { mergeCommit } = f.mergeExternally("squash");
      f.runtime.engine.resolution.externalMergeProbeMs = 0;
      assert.equal(await f.runtime.engine.resolution.recoverExternalMerge(f.current()), true);
      assert.equal(f.current().phase, "blocked");

      // 1. Insufficient forge evidence (missing merge_commit_sha) refuses `move to=review`.
      f.setPull(
        f.basePull({
          state: "closed",
          merged: true,
          merge_commit_sha: null,
        }),
      );
      await assert.rejects(
        f.runtime.taskControl(
          taskControlInputSchema.parse({
            taskId: f.taskId,
            version: f.current().version,
            action: "move",
            to: "review",
            reason: "Attempt review with missing merge commit",
            caller: "origin-planner",
          }),
        ),
        /no longer observed merged at source/,
      );
      assert.equal(f.current().phase, "blocked");
      assert.equal(f.current().resolution.mergedCommit, null);

      // 2. Stale recorded task head refuses in both `next` and `move to=review`.
      f.setPull(
        f.basePull({
          state: "closed",
          merged: true,
          merge_commit_sha: mergeCommit,
        }),
      );
      f.runtime.store.update(f.taskId, { prHead: "e".repeat(40) });
      assert.notEqual(f.nextReviewVerb()?.available, true);
      await assert.rejects(
        f.runtime.taskControl(
          taskControlInputSchema.parse({
            taskId: f.taskId,
            version: f.current().version,
            action: "move",
            to: "review",
            reason: "Attempt review with stale recorded head",
            caller: "origin-planner",
          }),
        ),
        /fresh review route needs the recorded merged source/,
      );

      // Restore recorded head and run a fresh review that returns a negative verdict (`changes_required`).
      f.runtime.store.update(f.taskId, { prHead: f.head });
      await f.runtime.taskControl(
        taskControlInputSchema.parse({
          taskId: f.taskId,
          version: f.current().version,
          action: "move",
          to: "review",
          reason: "Review the merged source",
          caller: "origin-planner",
        }),
      );
      await f.runtime.engine.wake();
      const workersBefore = f.counts().workerCreates;
      const { runId, token } = f.reviewerRun();
      await f.runtime.engine.complete(
        {
          eventId: randomUUID(),
          taskId: f.taskId,
          runId,
          status: "changes_required",
          head: f.head,
          summary: "Found a defect in the merged source",
          reviewText: "The merged source has an unhandled edge case.",
          reviewResponsibility: "author",
        },
        token,
      );
      f.runtime.engine.resolution.externalMergeProbeMs = 0;
      await f.runtime.engine.wake();
      assert.equal(f.current().resolution.mergedCommit, null);
      assert.equal(f.current().resolution.externalMerge, false);
      assert.equal(f.counts().mergeCalls, 0);
      assert.equal(
        f.counts().workerCreates,
        workersBefore,
        "no revision worker is created against an already-merged PR",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "private realistic reobserved merge honors an answered stop-and-keep disposition instead of reopening it (nucleus#1425)",
  { timeout: 90000 },
  async () => {
    const f = await createPrivateForgeFixture();
    try {
      f.mergeExternally("squash");
      f.runtime.engine.resolution.externalMergeProbeMs = 0;
      assert.equal(await f.runtime.engine.resolution.recoverExternalMerge(f.current()), true);
      assert.equal(f.current().phase, "blocked");

      const escalations = () =>
        f.runtime.store.events(f.taskId).filter((e) => e.kind === "planner_escalation");
      const id = escalations()[0]!.detail.split(":", 1)[0]!;
      await f.runtime.engine.resolution.settlePlannerEscalation(
        f.current(),
        id,
        "Stop and keep the work",
        "origin-planner",
      );
      const answered = f.current();
      const opened = escalations().length;

      assert.equal(await f.runtime.engine.resolution.recoverExternalMerge(f.current()), true);
      assert.equal(escalations().length, opened, "the answered stop-and-keep cause is not asked again");
      assert.equal(f.current().phase, answered.phase);
      assert.equal(f.current().resolution.stop?.reason, answered.resolution.stop?.reason);
      assert.equal(f.current().resolution.mergedCommit, null);
      assert.equal(f.counts().mergeCalls, 0);
    } finally {
      await f.close();
    }
  },
);
