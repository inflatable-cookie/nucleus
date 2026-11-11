import { fakeAdapter } from './support/fakes';
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { workerPrompt } from "../core/dispatch/prompts";
import { command, git, gitSync } from "../core/git/index";
import { discoverCheckoutSiblings } from "../core/workspaces/checkout-siblings";
import { ownedWorkspacePath, ownedWorkspaceRoot, repoCommonDir } from "../core/workspaces/workspace-allocation";
import { queueWorktreeLinkBlock } from "../core/dispatch/prompts";
import { collectOwnerVerbFacts, ownerTaskNext } from "../core/verbs/owner-verbs";
import {
  WORKTREE_LINKS_LEDGER_MAX_BYTES, WORKTREE_LINKS_MANIFEST_MAX_BYTES, canonicalLinkRoot, declaredWorktreeLinks, placeWorktreeLink,
  provisionWorktreeLinks, resolveSiblingSource, worktreeLinksDue, worktreeLinksForBinding, worktreeLinksForClearedIntent, worktreeLinksForIntent, worktreeSetupScripts, worktreeSiblingSpecs,
  worktreeSiblingTokens, type ConfiguredCheckout,
} from "../core/workspaces/worktree-links";
import { submissionSchema, worktreeLinksSchema, type Profile, type Task, type WorktreeLinks } from "../shared/contracts";
import type { Adapter } from "../core/host";
import { HOOK_TEST_TIMEOUT_MS } from "./support/budgets";

const profile: Profile = { id: "worker", name: "Worker", provider: "test", model: "test", notes: "", available: true, problem: "", supportedThinking: ["low"] };
const PREPARE = "nucleus worktree prepare";

async function repo(path: string, files: Record<string, string>) {
  await mkdir(path, { recursive: true });
  await command("git", ["init", "--initial-branch=main", path], dirname(path));
  await git(path, "config", "user.name", "Queue test");
  await git(path, "config", "user.email", "queue@example.invalid");
  await git(path, "config", "commit.gpgsign", "false");
  await commitFiles(path, "init", files);
}

async function commitFiles(path: string, message: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(path, file)), { recursive: true });
    await writeFile(join(path, file), content);
  }
  await git(path, "add", "-A");
  await git(path, "commit", "--allow-empty", "-m", message);
  return git(path, "rev-parse", "HEAD");
}

const manifest = (setup: unknown) => JSON.stringify({ worktree: { setup } });
const ledger = (paths: string[]) => JSON.stringify({ schema: "effigy.deps.links.v1", schema_version: 1, links: paths.map(library_path => ({ key: { library_path } })) });

/** A primary with `paseo.json`, a configured sibling primary, and Queue's data dir. */
async function fixture(t: TestContext, setup: unknown = `${PREPARE} ../project-j && effigy setup`, extra: Record<string, string> = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nsq-wtlinks-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const primary = join(base, "repos", "primary"), projectJ = join(base, "repos", "project-j"), data = join(base, "data");
  await repo(projectJ, { "README.md": "jet\n" });
  await repo(primary, setup === null ? { "README.md": "primary\n", ...extra } : { "paseo.json": manifest(setup), ...extra });
  await mkdir(data);
  const commonDir = await repoCommonDir(primary);
  const root = ownedWorkspaceRoot(data, commonDir);
  const configured: ConfiguredCheckout[] = [{ origin: null, path: primary }, { origin: null, path: projectJ }];
  const checkout = async (taskId: string, branch = `ns-${taskId}`) => {
    const directory = ownedWorkspacePath(data, commonDir, taskId);
    await mkdir(root, { recursive: true });
    await git(primary, "worktree", "add", "-b", branch, directory, "HEAD");
    return directory;
  };
  return { base, primary, projectJ, data, commonDir, root, configured, checkout };
}

const task = (f: Awaited<ReturnType<typeof fixture>>, directory: string) => ({ repoPath: f.primary, directory, workspaceId: "ws-1" });

test("canonical link root accepts the proved external allocation and preserves the legacy root", async t => {
  const f = await fixture(t);
  const builds = join(f.base, "builds");
  const external = ownedWorkspacePath(builds, f.commonDir, "external");
  await mkdir(dirname(external), { recursive: true });
  await mkdir(external);
  let admissions = 0;
  const stash = join(f.base, "stash");
  const placement = { dataDir: stash, retainedDataDirs: [builds], admit: (path: string) => { assert.equal(path, external); admissions++; } };
  assert.equal(await canonicalLinkRoot(f.data, f.primary, external, placement), dirname(external));
  assert.equal(admissions, 1);
  const legacy = await f.checkout("legacy");
  assert.equal(await canonicalLinkRoot(f.data, f.primary, legacy, placement), f.root);
  const foreign = join(f.base, "foreign", "ns-external");
  await mkdir(foreign, { recursive: true });
  await assert.rejects(canonicalLinkRoot(f.data, f.primary, foreign, placement), /canonical Queue allocation root/);
});

test("parser reads literal prepare arguments and stops at shell operators", () => {
  assert.deepEqual(worktreeSiblingTokens(`${PREPARE} ../a ../b=bee && effigy setup ../not-a-source`), ["../a", "../b=bee"]);
  assert.deepEqual(worktreeSiblingTokens(`${PREPARE} ../a; echo ../z`), ["../a"]);
  assert.deepEqual(worktreeSiblingTokens(`${PREPARE} ../a | tee ../log`), ["../a"]);
  assert.deepEqual(worktreeSiblingTokens(`${PREPARE} && effigy setup`), []);
  assert.deepEqual(worktreeSiblingSpecs(`${PREPARE} "../a" '../b=bee' && echo "../q" '../r'`),
    [{ source: "../a", linkName: null }, { source: "../b", linkName: "bee" }]);
  assert.deepEqual(worktreeSiblingTokens(`x ${PREPARE} ../a && y ${PREPARE} ../c`), ["../a", "../c"]);
  assert.deepEqual(worktreeSiblingTokens("paseo:worktree -- prepare ../a"), []);
  assert.deepEqual(worktreeSiblingTokens("nucleus worktree prepare ../a ../b=bee && effigy setup"), ["../a", "../b=bee"]);
  assert.deepEqual(worktreeSiblingTokens(null), []);
});

test("legacy helper declarations are refused visibly on retained task branches", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t, "effigy skill run paseo:worktree -- prepare ../project-j");
  const directory = await f.checkout(randomUUID());
  const declared = await declaredWorktreeLinks({ directory, primaryRoot: f.primary, configured: f.configured });
  assert.deepEqual(declared.candidates, []);
  assert.deepEqual(declared.findings.map(finding => finding.kind), ["argument_unsupported"]);
  assert.match(declared.findings[0]!.detail, /retired; use nucleus worktree prepare/);
});

test("parser refusals keep Project QA's messages and take the task prefix", () => {
  assert.throws(() => worktreeSiblingSpecs(`${PREPARE} /abs`), { message: "Project QA cannot prepare a dynamic or absolute declared worktree sibling source: /abs" });
  assert.throws(() => worktreeSiblingSpecs(`${PREPARE} $HOME/x`), { message: "Project QA cannot prepare a dynamic or absolute declared worktree sibling source: $HOME/x" });
  assert.throws(() => worktreeSiblingSpecs(`${PREPARE} ../a=../evil`), { message: "Project QA worktree sibling link name is not a safe path component: ../evil" });
  assert.throws(() => worktreeSiblingSpecs(`${PREPARE} ../a=.hidden`, "Task worktree link"), { message: "Task worktree link worktree sibling link name is not a safe path component: .hidden" });
});

test("worktree.setup is a string or an array of strings; absent is no declaration", () => {
  assert.deepEqual(worktreeSetupScripts(manifest("one")), ["one"]);
  assert.deepEqual(worktreeSetupScripts(manifest(["one", "two"])), ["one", "two"]);
  assert.deepEqual(worktreeSetupScripts("{}"), []);
  assert.deepEqual(worktreeSetupScripts(JSON.stringify({ worktree: {} })), []);
  assert.throws(() => worktreeSetupScripts(manifest(3)), /string or an array of strings/);
  assert.throws(() => worktreeSetupScripts(manifest(["one", 2])), /string or an array of strings/);
  assert.throws(() => worktreeSetupScripts("not json"));
});

test("declaration at the checkout HEAD: array form, absent manifest, invalid JSON, payload caps", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t, [`${PREPARE} ../project-j=jet`, "effigy setup"]);
  const directory = await f.checkout(randomUUID());
  const jet = await realpath(f.projectJ);
  assert.deepEqual((await declaredWorktreeLinks({ directory, primaryRoot: f.primary, configured: f.configured })).candidates, [{ name: "jet", target: jet }]);
  // The checkout's exact HEAD is read, not the primary's working tree.
  await writeFile(join(f.primary, "paseo.json"), manifest(`${PREPARE} ../other`));
  assert.deepEqual((await declaredWorktreeLinks({ directory, primaryRoot: f.primary, configured: f.configured })).candidates, [{ name: "jet", target: jet }]);

  await git(directory, "rm", "-q", "paseo.json");
  await commitFiles(directory, "no manifest", {});
  const absent = await declaredWorktreeLinks({ directory, primaryRoot: f.primary, configured: f.configured });
  assert.deepEqual([absent.candidates, absent.findings], [[], []]);

  await commitFiles(directory, "broken", { "paseo.json": "{ not json" });
  const invalid = await declaredWorktreeLinks({ directory, primaryRoot: f.primary, configured: f.configured });
  assert.equal(invalid.findings[0]?.kind, "manifest_invalid");
  assert.equal(invalid.commit, await git(directory, "rev-parse", "HEAD"));

  await commitFiles(directory, "large", { "paseo.json": manifest(`${PREPARE} ../project-j`) + " ".repeat(WORKTREE_LINKS_MANIFEST_MAX_BYTES) });
  const large = await declaredWorktreeLinks({ directory, primaryRoot: f.primary, configured: f.configured });
  assert.deepEqual(large.candidates, []);
  assert.match(large.findings[0]?.detail ?? "", /exceeds/);

  await mkdir(join(f.primary, ".effigy/local"), { recursive: true });
  await writeFile(join(f.primary, ".effigy/local/dependency-links.json"), ledger(["../project-j"]) + " ".repeat(WORKTREE_LINKS_LEDGER_MAX_BYTES));
  const bigLedger = await declaredWorktreeLinks({ directory, primaryRoot: f.primary, configured: f.configured });
  assert.equal(bigLedger.findings.find(finding => finding.kind === "ledger_invalid")?.detail.includes("exceeds"), true);
  await writeFile(join(f.primary, ".effigy/local/dependency-links.json"), "nope");
  assert.ok((await declaredWorktreeLinks({ directory, primaryRoot: f.primary, configured: f.configured })).findings.some(finding => finding.kind === "ledger_invalid"));
});

test("unsupported arguments and unresolved sources are per-item findings; valid items still resolve", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t, `${PREPARE} /abs $HOME/x ../project-j ../missing ../project-j=../bad`);
  const directory = await f.checkout(randomUUID());
  const declared = await declaredWorktreeLinks({ directory, primaryRoot: f.primary, configured: f.configured });
  assert.deepEqual(declared.candidates, [{ name: "project-j", target: await realpath(f.projectJ) }]);
  assert.deepEqual(declared.findings.map(finding => finding.kind), ["argument_unsupported", "argument_unsupported", "source_unresolved", "argument_unsupported"]);
  assert.match(declared.findings[2]!.detail, /^Task worktree link worktree sibling source is unavailable: \.\.\/missing$/);
});

test("resolution accepts configured primaries only", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const stranger = join(f.base, "repos", "stranger");
  await repo(stranger, { "README.md": "x\n" });
  await assert.rejects(resolveSiblingSource(f.primary, "../stranger", f.configured), /Project QA worktree sibling source is not a configured Queue repository/);
  // A configured linked worktree is never a source.
  const linked = join(f.base, "repos", "jet-wt");
  await git(f.projectJ, "worktree", "add", "--detach", linked, "HEAD");
  await assert.rejects(resolveSiblingSource(f.primary, "../jet-wt", [{ origin: null, path: linked }], "Task worktree link"), /Task worktree link will not use a linked worktree as a sibling source/);
  // A clone of a configured origin resolves to that primary, and is outside it.
  const clone = join(f.base, "elsewhere", "jet-clone");
  await command("git", ["clone", "-q", f.projectJ, clone], f.base);
  await git(f.projectJ, "remote", "add", "origin", "https://github.com/example/project-j.git");
  await git(clone, "remote", "set-url", "origin", "https://github.com/example/project-j.git");
  await assert.rejects(resolveSiblingSource(f.primary, "../../elsewhere/jet-clone", f.configured), /Project QA worktree sibling source is outside its configured checkout/);
  assert.equal(await resolveSiblingSource(f.primary, "../project-j", f.configured), await realpath(f.projectJ));
});

test("prepare and ledger duplicates dedupe by target; conflicting targets are a finding for that name", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t, `${PREPARE} ../project-j ../other=lib`);
  await repo(join(f.base, "repos", "other"), { "README.md": "o\n" });
  await repo(join(f.base, "repos", "lib"), { "README.md": "l\n" });
  const configured = [...f.configured, { origin: null, path: join(f.base, "repos", "other") }, { origin: null, path: join(f.base, "repos", "lib") }];
  await mkdir(join(f.primary, ".effigy/local"), { recursive: true });
  await writeFile(join(f.primary, ".effigy/local/dependency-links.json"), ledger(["../project-j", "../lib"]));
  const directory = await f.checkout(randomUUID());
  const declared = await declaredWorktreeLinks({ directory, primaryRoot: f.primary, configured });
  assert.deepEqual(declared.candidates, [{ name: "project-j", target: await realpath(f.projectJ) }]);
  assert.deepEqual(declared.findings.map(finding => [finding.kind, finding.name]), [["name_conflict", "lib"]]);
  const placed = await provisionWorktreeLinks({ dataDir: f.data, task: task(f, directory), configured });
  assert.deepEqual(placed.links.map(link => [link.name, link.outcome]), [["project-j", "created"]]);
  assert.equal(existsSync(join(f.root, "lib")), false, "a conflicting name places nothing");
});

test("placement: absent creates, a match is reused, anything else is a conflict left untouched", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  await mkdir(f.root, { recursive: true });
  const jet = await realpath(f.projectJ);
  assert.equal((await placeWorktreeLink(f.root, "a", jet)).outcome, "created");
  assert.equal(await readlink(join(f.root, "a")), jet);
  assert.equal((await placeWorktreeLink(f.root, "a", jet)).outcome, "reused");
  await symlink(f.primary, join(f.root, "mismatch"));
  await symlink(join(f.base, "gone"), join(f.root, "dangling"));
  await mkdir(join(f.root, "dir"));
  await writeFile(join(f.root, "file"), "x");
  for (const name of ["mismatch", "dangling", "dir", "file"]) {
    const placed = await placeWorktreeLink(f.root, name, jet);
    assert.equal(placed.outcome, "conflict", name);
    assert.match(placed.reason!, /left untouched/);
  }
  assert.equal(await readlink(join(f.root, "mismatch")), f.primary);
  assert.equal(await readlink(join(f.root, "dangling")), join(f.base, "gone"));
  assert.equal((await lstat(join(f.root, "dir"))).isDirectory(), true);
  // EEXIST race: the path appears between the absence observation and the create.
  assert.equal((await placeWorktreeLink(f.root, "race-match", jet, () => symlink(jet, join(f.root, "race-match")))).outcome, "reused");
  const raced = await placeWorktreeLink(f.root, "race-other", jet, () => symlink(f.primary, join(f.root, "race-other")));
  assert.equal(raced.outcome, "conflict");
  assert.equal(await readlink(join(f.root, "race-other")), f.primary);
  // Spec 028 discovery never takes a placed link for a checkout sibling.
  assert.deepEqual(await discoverCheckoutSiblings(f.root, null), []);
});

test("placement refuses a root that is not the canonical allocation parent or is a symlink", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  await mkdir(f.root, { recursive: true });
  const stray = join(f.base, "stray", "ns-x");
  await mkdir(dirname(stray), { recursive: true });
  await git(f.primary, "worktree", "add", "-b", "stray", stray, "HEAD");
  await assert.rejects(canonicalLinkRoot(f.data, f.primary, stray), /not the canonical Queue allocation root/);
  const result = await provisionWorktreeLinks({ dataDir: f.data, task: task(f, stray), configured: f.configured });
  assert.deepEqual(result.links.map(link => link.outcome), ["failed"]);
  assert.equal(existsSync(join(dirname(stray), "project-j")), false);

  const real = join(f.base, "real-root");
  await mkdir(real);
  await rm(f.root, { recursive: true });
  await symlink(real, f.root);
  const taskId = randomUUID();
  const directory = ownedWorkspacePath(f.data, f.commonDir, taskId);
  await git(f.primary, "worktree", "add", "-b", `ns-${taskId}`, directory, "HEAD");
  await assert.rejects(canonicalLinkRoot(f.data, f.primary, directory), /redirected or is not a real directory/);
  const redirected = await provisionWorktreeLinks({ dataDir: f.data, task: task(f, directory), configured: f.configured });
  assert.equal(redirected.links[0]?.outcome, "failed");
  assert.equal(existsSync(join(real, "project-j")), false, "nothing is written through a redirected root");
});

test("a pass re-run after a crash between create and record observes reused", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const directory = await f.checkout(randomUUID());
  assert.deepEqual((await provisionWorktreeLinks({ dataDir: f.data, task: task(f, directory), configured: f.configured })).links.map(link => link.outcome), ["created"]);
  assert.deepEqual((await provisionWorktreeLinks({ dataDir: f.data, task: task(f, directory), configured: f.configured })).links.map(link => link.outcome), ["reused"]);
});

test("eligibility comes only from a new dispatch intent; binding arms only an eligible attempt and never resets a final record", () => {
  const final: WorktreeLinks = { state: "prepared", workspaceId: "ws", directory: "/d", commit: null, links: [], findings: [], at: "t" };
  const binding = { workspaceId: "ws", directory: "/d" };
  // A new intent: no workspace, no recorded intent.
  assert.deepEqual(worktreeLinksForIntent({ workspaceId: null, workspaceIntent: false }), { worktreeLinks: { state: "eligible" } });
  assert.deepEqual(worktreeLinksForIntent({ workspaceId: null, workspaceIntent: false, worktreeLinks: final }), { worktreeLinks: { state: "eligible", previous: final } });
  // Re-entry of an intent already recorded (legacy or new), a retained workspace, or an existing eligibility: nothing.
  assert.deepEqual(worktreeLinksForIntent({ workspaceId: null, workspaceIntent: true }), {});
  assert.deepEqual(worktreeLinksForIntent({ workspaceId: null, workspaceIntent: true, worktreeLinks: final }), {});
  assert.deepEqual(worktreeLinksForIntent({ workspaceId: "ws", workspaceIntent: false }), {});
  assert.deepEqual(worktreeLinksForIntent({ workspaceId: null, workspaceIntent: false, worktreeLinks: { state: "eligible" } }), {});
  // Binding: only eligible arms; a carried final for the same binding is restored; everything else is untouched.
  assert.deepEqual(worktreeLinksForBinding({ worktreeLinks: { state: "eligible" } }, binding), { worktreeLinks: { state: "pending", ...binding } });
  assert.deepEqual(worktreeLinksForBinding({ worktreeLinks: { state: "eligible", previous: final } }, binding), { worktreeLinks: final });
  assert.deepEqual(worktreeLinksForBinding({ worktreeLinks: { state: "eligible", previous: final } }, { workspaceId: "ws2", directory: "/d" }), { worktreeLinks: { state: "pending", workspaceId: "ws2", directory: "/d" } });
  assert.deepEqual(worktreeLinksForBinding({}, binding), {}, "a legacy attempt stays absent");
  assert.deepEqual(worktreeLinksForBinding({ worktreeLinks: final }, binding), {});
  assert.deepEqual(worktreeLinksForBinding({ worktreeLinks: final }, { workspaceId: "ws2", directory: "/d" }), {}, "a final record for another binding is not re-armed without a new intent");
  assert.deepEqual(worktreeLinksForBinding({ worktreeLinks: { state: "pending", ...binding } }, binding), {});
  const first = { worktreeLinks: { state: "pending" as const, ...binding }, ...binding, agentIntent: false, agentId: null, runId: null, retiredWorkers: [], continuesWorkspace: false };
  assert.equal(worktreeLinksDue(first), true);
  assert.equal(worktreeLinksDue({ ...first, worktreeLinks: final }), false);
  assert.equal(worktreeLinksDue({ ...first, worktreeLinks: { state: "eligible" } }), false);
  assert.equal(worktreeLinksDue({ ...first, worktreeLinks: undefined }), false);
  assert.equal(worktreeLinksDue({ ...first, workspaceId: "other" }), false);
  assert.equal(worktreeLinksDue({ ...first, runId: "run" }), false);
  assert.equal(worktreeLinksDue({ ...first, continuesWorkspace: true }), false);
  assert.equal(worktreeLinksDue({ ...first, retiredWorkers: [{ agentId: "a", runId: "r", profile, reason: "x" }] }), false);
});

test("prompt discloses links-only provisioning, live targets and refused links", () => {
  const record: WorktreeLinks = { state: "prepared", workspaceId: "ws", directory: "/d", commit: "c".repeat(40), at: "t",
    links: [{ name: "project-j", target: "/repos/project-j", outcome: "created" }, { name: "lib", target: "/repos/lib", outcome: "reused" },
      { name: "core", target: "/repos/core", outcome: "conflict", reason: "/workspace/core links to /x, not /repos/core; left untouched" }],
    findings: [{ kind: "source_unresolved", name: "missing", detail: "Task worktree link worktree sibling source is unavailable: ../missing" }] };
  const block = queueWorktreeLinkBlock({ worktreeLinks: record });
  assert.match(block, /links-only partial provisioning/);
  assert.match(block, /Installs, builds and container attach were NOT run/);
  assert.match(block, /live configured checkout on any branch, possibly dirty, not a pinned dependency/);
  assert.match(block, /- \.\.\/project-j -> \/repos\/project-j \(created\)/);
  assert.match(block, /- \.\.\/lib -> \/repos\/lib \(reused\)/);
  assert.match(block, /- \.\.\/core -> \/repos\/core: conflict, \/workspace\/core links to \/x/);
  assert.match(block, /source_unresolved missing: .*unavailable: \.\.\/missing/);
  assert.match(block, /no authority to replace, repair, build or install their sources, or to substitute another checkout/);
  assert.equal(queueWorktreeLinkBlock({ worktreeLinks: { state: "pending", workspaceId: "ws", directory: "/d" } }), "");
  assert.equal(queueWorktreeLinkBlock({ worktreeLinks: { ...record, links: [], findings: [] } }), "");
  assert.equal(queueWorktreeLinkBlock({}), "");
});

/** An engine whose workspaces are real Queue-allocated checkouts of the fixture primary. */
function engineFor(t: TestContext, store: Store, f: Awaited<ReturnType<typeof fixture>>) {
  const prompts: string[] = [];
  const adapter: Adapter = fakeAdapter({
    profiles: async () => [profile],
    validate: async task => task.planningCommit,
    createWorkspace: async task => ({ id: `ws-${task.id}`, directory: existsSync(ownedWorkspacePath(f.data, f.commonDir, task.id)) ? ownedWorkspacePath(f.data, f.commonDir, task.id) : await f.checkout(task.id, task.branch) }),
    verifyWorkspace: async task => task.branch,
    createAgent: async (task, _token, prompt) => { prompts.push(prompt); return { id: `agent-${task.id}`, workspaceId: task.workspaceId }; },
    observe: async id => ({ id, workspaceId: store.tasks().find(task => task.agentId === id)?.workspaceId ?? null, status: "running", active: true, permissions: false, error: "" }),
    archiveTaskWorkspace: async () => true,
    verifyPr: async () => ({ url: "https://github.com/example/repo/pull/1", head: "b".repeat(40) }),
    findOpenBranchPr: async () => [],
  });
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [profile];
  engine.siblingDataDir = f.data;
  t.after(() => engine.stop());
  store.setMeta("pool", [{ profileId: profile.id, enabled: true, group: "test", weight: 1, scopes: ["general"] }]);
  store.setMeta("paused", false);
  for (const checkout of f.configured) store.putRepository({ origin: null, path: checkout.path }, null, "");
  return { engine, adapter, prompts };
}

async function engineFixture(t: TestContext) {
  const f = await fixture(t);
  const store = new Store(join(f.base, "queue.sqlite"));
  t.after(() => store.close());
  return { f, store, ...engineFor(t, store, f) };
}

const submit = (store: Store, repoPath: string, title = "Task") => {
  const head = gitSync(repoPath, "rev-parse", "HEAD");
  return store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title, repoPath, planningCommit: head, handoffPath: "handoff.md", originAgentId: "origin",
  }), "host", "handoff", head);
};
const launch = (engine: Engine, task: Task) => (engine as unknown as { launchAgent(task: Task): Promise<void> }).launchAgent(task);
const prepare = (engine: Engine, task: Task) => (engine as unknown as { prepareWorktreeLinks(task: Task): Promise<{ task: Task }> }).prepareWorktreeLinks(task).then(result => result.task);
const preparedEvents = (store: Store, id: string) => store.events(id).filter(event => event.kind === "worktree_links_prepared");

test("workspace_created arms a pending record that provisions once on the first worker launch", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const { f, store, engine, prompts } = await engineFixture(t);
  const queued = submit(store, f.primary);
  await engine.wake();
  const current = store.task(queued.id);
  assert.equal(current.phase, "working", `${current.reason} ${JSON.stringify(store.events(queued.id).map(e => [e.kind, e.detail]))}`);
  const created = store.events(queued.id).find(event => event.kind === "workspace_created");
  assert.ok(created);
  const record = current.worktreeLinks;
  assert.equal(record?.state, "prepared");
  if (record?.state !== "prepared") return;
  assert.equal(record.workspaceId, current.workspaceId);
  assert.equal(record.directory, current.directory);
  assert.equal(record.commit, await git(current.directory!, "rev-parse", "HEAD"));
  assert.deepEqual(record.links, [{ name: "project-j", target: await realpath(f.projectJ), outcome: "created" }]);
  assert.equal(await readlink(join(f.root, "project-j")), await realpath(f.projectJ));
  assert.equal(preparedEvents(store, queued.id).length, 1);
  assert.match(preparedEvents(store, queued.id)[0]!.detail, /project-j created/);
  assert.match(prompts[0]!, /Installs, builds and container attach were NOT run/);
  assert.match(prompts[0]!, /\.\.\/project-j -> .*project-j \(created\)/);
  assert.match(workerPrompt(store.task(queued.id)), /links-only partial provisioning/, "later prompts still disclose the final record");
  assert.deepEqual(ownerTaskNext(collectOwnerVerbFacts(store, store.task(queued.id))).worktreeLinks, record);
});

test("a final record never re-runs: not after a head change, a re-observed creation or a revision launch", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const { f, store, engine } = await engineFixture(t);
  const queued = submit(store, f.primary);
  await engine.wake();
  const first = store.task(queued.id);
  const record = first.worktreeLinks;
  assert.equal(record?.state, "prepared");
  // Head and declaration change; the link is removed out of band.
  await commitFiles(first.directory!, "declare more", { "paseo.json": manifest(`${PREPARE} ../project-j=other`) });
  await rm(join(f.root, "project-j"));
  // A first-launch-shaped state (no worker identities) still does nothing once final.
  const reset = store.update(first.id, { agentId: null, agentIntent: false, runId: null, phase: "dispatching" });
  assert.equal(worktreeLinksDue(reset), false);
  assert.deepEqual((await prepare(engine, reset)).worktreeLinks, record);
  // A re-observed creation of the same workspace and directory keeps the final record (requirement 3).
  const rebound = store.update(first.id, { ...worktreeLinksForBinding(store.task(first.id), { workspaceId: first.workspaceId!, directory: first.directory! }) });
  assert.deepEqual(rebound.worktreeLinks, record);
  // A continuation launch with a pending record does nothing either.
  store.update(first.id, { worktreeLinks: { state: "pending", workspaceId: first.workspaceId!, directory: first.directory! }, continuesWorkspace: true });
  assert.equal((await prepare(engine, store.task(first.id))).worktreeLinks?.state, "pending");
  assert.equal(preparedEvents(store, first.id).length, 1);
  assert.equal(existsSync(join(f.root, "project-j")), false);
  assert.equal(existsSync(join(f.root, "other")), false);
});

test("a creation replay for the same binding never overwrites a final record or replays placement", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const { f, store, engine } = await engineFixture(t);
  const queued = submit(store, f.primary);
  const directory = await f.checkout(queued.id, queued.branch);
  // A final record for exactly the binding the create will return, with no workspace recorded:
  // the shape a recovery or version race leaves.
  const final: WorktreeLinks = { state: "prepared", workspaceId: `ws-${queued.id}`, directory, commit: null,
    links: [{ name: "project-j", target: await realpath(f.projectJ), outcome: "failed", reason: "earlier failure" }], findings: [], at: "2026-10-23T00:00:00.000Z" };
  store.update(queued.id, { worktreeLinks: final });
  await engine.wake();
  const current = store.task(queued.id);
  assert.equal(current.phase, "working");
  assert.equal(current.workspaceId, `ws-${queued.id}`);
  assert.deepEqual(current.worktreeLinks, final, "the failed final record stays disclosed and is not retried");
  assert.equal(preparedEvents(store, queued.id).length, 0);
  assert.equal(existsSync(join(f.root, "project-j")), false);
});

test("concurrent first launches write one final record", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const { f, store, engine } = await engineFixture(t);
  const queued = submit(store, f.primary);
  const directory = await f.checkout(queued.id, queued.branch);
  const bound = store.update(queued.id, { workspaceId: "ws-x", directory, profile, phase: "dispatching",
    ...worktreeLinksForBinding({ worktreeLinks: { state: "eligible" } }, { workspaceId: "ws-x", directory }) }, "workspace_created", "ws-x");
  const [a, b] = await Promise.all([prepare(engine, bound), prepare(engine, bound)]);
  assert.equal(a.worktreeLinks?.state, "prepared");
  assert.equal(b.worktreeLinks?.state, "prepared");
  assert.equal(preparedEvents(store, queued.id).length, 1);
  assert.equal(await readlink(join(f.root, "project-j")), await realpath(f.projectJ));
});

test("a legacy task without a record and a rebind get no links", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const { f, store, engine } = await engineFixture(t);
  const legacy = submit(store, f.primary, "Legacy");
  const directory = await f.checkout(legacy.id, legacy.branch);
  const bound = store.update(legacy.id, { workspaceId: "ws-legacy", directory, profile, phase: "dispatching", workspaceIntent: true });
  await launch(engine, bound);
  assert.equal(store.task(legacy.id).phase, "working");
  assert.equal(store.task(legacy.id).worktreeLinks, undefined);
  assert.equal(existsSync(join(f.root, "project-j")), false);

  // Rebind: an existing checkout replaces the recorded one; no record is armed for it.
  const held = submit(store, f.primary, "Rebind");
  const original = await f.checkout(held.id, held.branch);
  const displacedDir = join(f.root, `ns-${held.id}-1`);
  await git(f.primary, "worktree", "add", "-b", `${held.branch}-1`, displacedDir, "HEAD");
  store.update(held.id, { workspaceId: "displaced", directory: displacedDir, workspaceIntent: true, phase: "needs_attention",
    worktreeLinks: { state: "pending", workspaceId: "displaced", directory: displacedDir } });
  const adapter = (engine as unknown as { adapter: Adapter }).adapter;
  adapter.findWorkspaces = async () => [{ id: "displaced", directory: displacedDir }, { id: "original", directory: original }];
  const current = store.task(held.id);
  await (engine as unknown as { retryValidation(input: unknown): Promise<Task> }).retryValidation({ taskId: held.id, version: current.version, rebindWorkspaceId: "original" });
  const rebound = store.task(held.id);
  assert.equal(rebound.workspaceId, "original");
  assert.ok(store.events(held.id).some(event => event.kind === "dispatch_workspace_rebound"));
  assert.deepEqual(rebound.worktreeLinks, { state: "pending", workspaceId: "displaced", directory: displacedDir }, "a rebind arms nothing");
  const launched = store.update(held.id, { profile, phase: "dispatching" });
  assert.equal(worktreeLinksDue(launched), false);
  assert.equal((await prepare(engine, launched)).worktreeLinks?.state, "pending");
  assert.equal(existsSync(join(f.root, "project-j")), false);
});

test("a validation retry that re-observes a completed creation keeps the final record; a new binding arms a fresh one", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const { f, store, engine, adapter } = await engineFixture(t);
  const queued = submit(store, f.primary);
  const directory = await f.checkout(queued.id, queued.branch);
  const final: WorktreeLinks = { state: "prepared", workspaceId: `ws-${queued.id}`, directory, commit: null,
    links: [{ name: "project-j", target: await realpath(f.projectJ), outcome: "created" }], findings: [], at: "2026-10-23T00:00:00.000Z" };
  store.update(queued.id, { worktreeLinks: final, workspaceIntent: true, phase: "needs_attention" });
  adapter.findWorkspaces = async () => [];
  adapter.inspectWorkspaceCreation = async () => ({ kind: "found_done", directory });
  const retry = (engine as unknown as { retryValidation(input: unknown): Promise<Task> });
  await retry.retryValidation({ taskId: queued.id, version: store.task(queued.id).version });
  assert.ok(store.events(queued.id).some(event => event.kind === "workspace_created"));
  assert.equal(store.task(queued.id).workspaceId, `ws-${queued.id}`);
  assert.deepEqual(store.task(queued.id).worktreeLinks, final);

  const other = submit(store, f.primary, "Other");
  const otherDir = await f.checkout(other.id, other.branch);
  const old = { ...final, workspaceId: "ws-old", directory: "/gone" };
  store.update(other.id, { worktreeLinks: old, workspaceIntent: true, phase: "needs_attention" });
  adapter.inspectWorkspaceCreation = async () => ({ kind: "found_done", directory: otherDir });
  await retry.retryValidation({ taskId: other.id, version: store.task(other.id).version });
  assert.deepEqual(store.task(other.id).worktreeLinks, old, "a retry continues recorded eligibility only; it cannot arm an intent that has none");

  const eligible = submit(store, f.primary, "Eligible");
  const eligibleDir = await f.checkout(eligible.id, eligible.branch);
  store.update(eligible.id, { worktreeLinks: { state: "eligible", previous: old }, workspaceIntent: true, phase: "needs_attention" });
  adapter.inspectWorkspaceCreation = async () => ({ kind: "found_done", directory: eligibleDir });
  await retry.retryValidation({ taskId: eligible.id, version: store.task(eligible.id).version });
  assert.deepEqual(store.task(eligible.id).worktreeLinks, { state: "pending", workspaceId: `ws-${eligible.id}`, directory: eligibleDir });
});

test("a declaration beyond the record bounds is one finding and places nothing", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t, null);
  const names = Array.from({ length: 201 }, (_, i) => `lib${i}`);
  for (const name of names) await mkdir(join(f.projectJ, "libs", name), { recursive: true });
  await mkdir(join(f.primary, ".effigy/local"), { recursive: true });
  await writeFile(join(f.primary, ".effigy/local/dependency-links.json"), ledger(names.map(name => `../project-j/libs/${name}`)));
  const directory = await f.checkout(randomUUID());
  const placed = await provisionWorktreeLinks({ dataDir: f.data, task: task(f, directory), configured: f.configured });
  assert.deepEqual(placed.links, []);
  assert.deepEqual(placed.findings.map(finding => finding.detail), ["201 links declared, more than 200; none placed"]);
  assert.equal(existsSync(join(f.root, "lib0")), false);
});

test("an unexpected provisioning failure is the record's finding and never blocks the first worker launch", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const { f, store, engine, prompts } = await engineFixture(t);
  const queued = submit(store, f.primary);
  const projects = store.projects.bind(store);
  let calls = 0;
  store.projects = () => { if (new Error().stack?.includes("prepareWorktreeLinks")) { calls++; throw Error("project registry unreadable"); } return projects(); };
  await engine.wake();
  const current = store.task(queued.id);
  assert.equal(calls, 1);
  assert.equal(current.phase, "working", "the worker still launches");
  assert.ok(current.agentId);
  const record = current.worktreeLinks;
  assert.equal(record?.state, "prepared");
  if (record?.state !== "prepared") return;
  assert.deepEqual(record.links, []);
  assert.match(record.findings[0]!.detail, /Links-only provisioning failed: project registry unreadable/);
  assert.match(prompts[0]!, /Links-only provisioning failed: project registry unreadable/, "the first worker is told");
  assert.equal(existsSync(join(f.root, "project-j")), false);
});

const recover = (engine: Engine, task: Task) => (engine as unknown as { recover(task: Task): Promise<void> }).recover(task);

test("a crash between a new intent and its binding keeps eligibility through recovery by find or by found_done, and provisions once", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  for (const route of ["find", "found_done"] as const) await t.test(route, async t => {
    const { f, store, engine, adapter } = await engineFixture(t);
    const queued = submit(store, f.primary);
    const directory = await f.checkout(queued.id, queued.branch);
    // The durable state a crash after dispatch_intent and before workspace_created leaves under this code.
    const crashed = store.update(queued.id, { phase: "dispatching", profile, workspaceIntent: true, worktreeLinks: { state: "eligible" } }, "dispatch_intent", profile.name);
    if (route === "find") adapter.findWorkspaces = async () => [{ id: "ws-found", directory }];
    else { adapter.findWorkspaces = async () => []; adapter.inspectWorkspaceCreation = async () => ({ kind: "found_done", directory }); }
    await recover(engine, crashed);
    const current = store.task(queued.id);
    const workspaceId = route === "find" ? "ws-found" : `ws-${queued.id}`;
    assert.equal(current.workspaceId, workspaceId);
    assert.ok(store.events(queued.id).some(event => event.kind === "workspace_recovered"));
    assert.equal(current.worktreeLinks?.state, "prepared");
    assert.equal(current.worktreeLinks?.state === "prepared" && current.worktreeLinks.workspaceId, workspaceId);
    assert.equal(await readlink(join(f.root, "project-j")), await realpath(f.projectJ));
    assert.equal(preparedEvents(store, queued.id).length, 1);
  });
});

test("an intent recorded before this code gets no links when it binds after the upgrade, by creation or recovery", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  await t.test("validation-retry replay, normal creation", async t => {
    // An intent with no workspace never re-enters dispatch_intent: its creation completes
    // through the validation-retry replay, which records workspace_created.
    const { f, store, engine, adapter } = await engineFixture(t);
    const legacy = submit(store, f.primary, "Legacy intent");
    const directory = await f.checkout(legacy.id, legacy.branch);
    store.update(legacy.id, { workspaceIntent: true, phase: "needs_attention" }, "dispatch_intent", "pre-upgrade");
    adapter.findWorkspaces = async () => [];
    adapter.inspectWorkspaceCreation = async () => ({ kind: "found_done", directory });
    await (engine as unknown as { retryValidation(input: unknown): Promise<Task> }).retryValidation({ taskId: legacy.id, version: store.task(legacy.id).version });
    assert.ok(store.events(legacy.id).some(event => event.kind === "workspace_created"));
    await engine.wake();
    assert.equal(store.task(legacy.id).worktreeLinks, undefined, "a recorded intent without eligibility is never armed");
    assert.equal(existsSync(join(f.root, "project-j")), false);
  });
  await t.test("recovered by find", async t => {
    const { f, store, engine, adapter } = await engineFixture(t);
    const legacy = submit(store, f.primary, "Legacy recovery");
    const directory = await f.checkout(legacy.id, legacy.branch);
    const crashed = store.update(legacy.id, { phase: "dispatching", profile, workspaceIntent: true }, "dispatch_intent", "pre-upgrade");
    adapter.findWorkspaces = async () => [{ id: "ws-legacy", directory }];
    await recover(engine, crashed);
    assert.equal(store.task(legacy.id).workspaceId, "ws-legacy");
    assert.equal(store.task(legacy.id).worktreeLinks, undefined);
    assert.equal(existsSync(join(f.root, "project-j")), false);
  });
});

test("a new attempt's eligibility survives its validation-retry replay and provisions once on the first launch", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const { f, store, engine, adapter } = await engineFixture(t);
  const queued = submit(store, f.primary);
  const directory = await f.checkout(queued.id, queued.branch);
  store.update(queued.id, { workspaceIntent: true, phase: "needs_attention", worktreeLinks: { state: "eligible" } }, "dispatch_intent", "earlier attempt");
  adapter.findWorkspaces = async () => [];
  adapter.inspectWorkspaceCreation = async () => ({ kind: "found_done", directory });
  await (engine as unknown as { retryValidation(input: unknown): Promise<Task> }).retryValidation({ taskId: queued.id, version: store.task(queued.id).version });
  assert.deepEqual(store.task(queued.id).worktreeLinks, { state: "pending", workspaceId: `ws-${queued.id}`, directory });
  await engine.wake();
  assert.equal(store.task(queued.id).worktreeLinks?.state, "prepared", JSON.stringify(store.events(queued.id).map(e => e.kind)));
  assert.equal(preparedEvents(store, queued.id).length, 1);
  assert.equal(await readlink(join(f.root, "project-j")), await realpath(f.projectJ));
});

test("a failed write of the final record leaves it pending, tells the first worker from this attempt's failure, and never claims the event", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  for (const eventFails of [false, true]) await t.test(eventFails ? "event write also fails" : "event recorded", async t => {
    const { f, store, engine, prompts } = await engineFixture(t);
    const queued = submit(store, f.primary);
    const update = store.update.bind(store), event = store.event.bind(store);
    store.update = ((id: string, patch: Partial<Task>, ...rest: unknown[]) => {
      if (patch.worktreeLinks?.state === "prepared") throw Error("disk I/O error");
      return (update as (...args: unknown[]) => Task)(id, patch, ...rest);
    }) as typeof store.update;
    store.event = ((id: string, kind: string, ...rest: unknown[]) => {
      if (eventFails && kind === "worktree_links_record_failed") throw Error("disk I/O error");
      return (event as (...args: unknown[]) => unknown)(id, kind, ...rest);
    }) as typeof store.event;
    await engine.wake();
    const current = store.task(queued.id);
    assert.equal(current.phase, "working", "the worker launches with its ordinary durable agent intent");
    assert.ok(current.agentIntent && current.agentId);
    assert.equal(current.worktreeLinks?.state, "pending", "placement unknown, not success");
    assert.match(prompts[0]!, /could not record its links-only provisioning result \(disk I\/O error\)/);
    assert.match(prompts[0]!, /Installs, builds and container attach were NOT run, and sibling links may be missing/);
    assert.equal(store.events(queued.id).some(e => e.kind === "worktree_links_record_failed"), !eventFails);
    assert.equal(preparedEvents(store, queued.id).length, 0);
  });
});

test("a validation retry that clears a recorded intent carries only the eligibility it recorded", () => {
  const final: WorktreeLinks = { state: "prepared", workspaceId: "ws", directory: "/d", commit: null, links: [], findings: [], at: "t" };
  assert.deepEqual(worktreeLinksForClearedIntent({ workspaceIntent: true }), { worktreeLinks: { state: "ineligible" } });
  assert.deepEqual(worktreeLinksForClearedIntent({ workspaceIntent: true, worktreeLinks: final }), { worktreeLinks: { state: "ineligible", previous: final } });
  assert.deepEqual(worktreeLinksForClearedIntent({ workspaceIntent: true, worktreeLinks: { state: "eligible" } }), {});
  assert.deepEqual(worktreeLinksForClearedIntent({ workspaceIntent: false }), {});
  assert.deepEqual(worktreeLinksForIntent({ workspaceId: null, workspaceIntent: false, worktreeLinks: { state: "ineligible" } }), {}, "an ineligible task's next intent stays ineligible");
  assert.deepEqual(worktreeLinksForBinding({ worktreeLinks: { state: "ineligible" } }, { workspaceId: "ws", directory: "/d" }), {});
});

test("a legacy intent whose creation is provably absent never becomes eligible through the retry's next dispatch (review #616)", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  for (const shape of ["legacy", "eligible"] as const) await t.test(shape, async t => {
    const { f, store, engine, adapter } = await engineFixture(t);
    const queued = submit(store, f.primary, shape);
    store.update(queued.id, { workspaceIntent: true, phase: "needs_attention", ...(shape === "eligible" ? { worktreeLinks: { state: "eligible" as const } } : {}) }, "dispatch_intent", "earlier");
    adapter.findWorkspaces = async () => [];
    adapter.inspectWorkspaceCreation = async () => ({ kind: "absent" });
    await (engine as unknown as { retryValidation(input: unknown): Promise<Task> }).retryValidation({ taskId: queued.id, version: store.task(queued.id).version });
    assert.equal(store.task(queued.id).workspaceIntent, false, "the retry cleared the intent");
    assert.equal(store.task(queued.id).worktreeLinks?.state, shape === "legacy" ? "ineligible" : "eligible");
    await engine.wake();
    const current = store.task(queued.id);
    assert.ok(store.events(queued.id).some(event => event.kind === "workspace_created"), JSON.stringify(store.events(queued.id).map(e => e.kind)));
    if (shape === "legacy") {
      assert.equal(current.worktreeLinks?.state, "ineligible");
      assert.equal(existsSync(join(f.root, "project-j")), false, "no backfill");
    } else {
      assert.equal(current.worktreeLinks?.state, "prepared");
      assert.equal(await readlink(join(f.root, "project-j")), await realpath(f.projectJ));
    }
  });
});

test("a finding name longer than the record bound is clamped, so the final record still writes (review #616)", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const alias = "a".repeat(300);
  const f = await fixture(t, `${PREPARE} ../missing=${alias}`);
  const directory = await f.checkout(randomUUID());
  const placed = await provisionWorktreeLinks({ dataDir: f.data, task: task(f, directory), configured: f.configured });
  assert.deepEqual(placed.findings.map(finding => [finding.kind, finding.name?.length]), [["source_unresolved", 256]]);
  assert.ok(worktreeLinksSchema.safeParse({ ...placed, at: "t" }).success);
});

test("every worktreeLinks state survives a store reload unchanged", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t, null);
  const path = join(f.base, "reload.sqlite");
  const final: WorktreeLinks = { state: "prepared", workspaceId: "ws", directory: "/d", commit: "a".repeat(40),
    links: [{ name: "project-j", target: "/t", outcome: "conflict", reason: "left untouched" }], findings: [{ kind: "name_conflict", name: "lib", detail: "two targets" }], at: "t" };
  const states: WorktreeLinks[] = [{ state: "eligible" }, { state: "eligible", previous: final }, { state: "ineligible" }, { state: "ineligible", previous: final },
    { state: "pending", workspaceId: "ws", directory: "/d" }, final];
  const ids: string[] = [];
  let store = new Store(path);
  for (const state of states) { const task = submit(store, f.primary, state.state); store.update(task.id, { worktreeLinks: state }); ids.push(task.id); }
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  assert.deepEqual(ids.map(id => store.task(id).worktreeLinks), states);
});
