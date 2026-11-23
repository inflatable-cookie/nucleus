import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { command, git } from "../../core/git/index";
import { Store } from "../../core/store/store";
import { Engine } from "../../core/engine";
import type { Adapter, AgentObservation } from "../../core/host";
import type { ResolutionAdapter } from "../../core/resolution";
import type { TimelineEntry } from "../../core/recovery/stall";
import type { HostProcessFact } from "../../core/host/types";
import { profileSchema, submissionSchema, type Profile, type Task } from "../../shared/contracts";
import { fakeAdapter, createTaskAgent } from "./fakes";
import { toolTimelinePage } from "./tool-timeline";

/**
 * Spec 068 batch 5b: one real repository, task worktree, Store and Engine with a
 * synthetic host whose observations, timeline, process table and native
 * permission answers the test sets. The task starts as a running initial worker.
 */
export const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const profile = (id: string): Profile =>
  profileSchema.parse({ id, name: id, provider: "test", model: id, notes: "", available: true, problem: "", supportedThinking: [] });

export const running = (overrides: Partial<AgentObservation> = {}): AgentObservation => ({
  id: "worker",
  workspaceId: "task-ws",
  status: "running",
  active: true,
  permissions: false,
  error: "",
  updatedAt: minutesAgo(1),
  turnStartedAt: minutesAgo(2),
  activeTurnId: "worker-turn-1",
  ...overrides,
});

export interface SelfHealingFixture {
  root: string;
  directory: string;
  head: string;
  store: Store;
  task: Task;
  engine: Engine;
  adapter: Adapter & Partial<ResolutionAdapter>;
  createdRuns: string[];
  permissionAnswers: unknown[][];
  messages: Array<{ agentId: string; messageId: string; text: string }>;
  setObservation(state: AgentObservation): void;
  /** The worker pushes a revision commit to the task branch and PR; returns the new head. */
  pushRevision(): Promise<string>;
  setTimeline(entries: TimelineEntry[]): void;
  setProcesses(read: (() => Promise<HostProcessFact[] | null>) | null): void;
}

export async function selfHealingFixture(t: { after: (cb: () => Promise<void> | void) => void }): Promise<SelfHealingFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nsq-heal-")));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await command("git", ["init", "--bare", "--initial-branch=main", join(root, "origin.git")], root);
  await command("git", ["clone", join(root, "origin.git"), join(root, "repo")], root);
  const repo = join(root, "repo");
  await git(repo, "config", "user.name", "Queue test");
  await git(repo, "config", "user.email", "queue@example.invalid");
  await mkdir(join(repo, "docs"), { recursive: true });
  await writeFile(join(repo, "docs/plan.json"), "{}\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "initial");
  await git(repo, "push", "origin", "main");
  const base = await git(repo, "rev-parse", "HEAD");
  const directory = join(root, "task-worktree");
  await git(repo, "worktree", "add", "-b", "ns-task", directory, base);
  await writeFile(join(directory, "lane.txt"), "lane change\n");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "lane change");
  await git(directory, "push", "origin", "ns-task");
  const head = await git(directory, "rev-parse", "HEAD");
  let prHead = head;
  const store = new Store(join(root, "queue.sqlite"));
  t.after(() => store.close());
  store.setMeta("paused", false);
  const worker = profile("worker"), coordinator = profile("coordinator"), reviewer = profile("reviewer");
  store.setMeta("pool", [worker, coordinator, reviewer].map((p) => ({
    profileId: p.id, enabled: true, group: p.id, roles: [p.id], weight: "default", scopes: ["general"],
  })));
  const submitted = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(), title: "Self-healing", repoPath: repo, baseBranch: "main",
      planningCommit: base, handoffPath: "docs/plan.json", originAgentId: "origin",
    }),
    "host", "handoff", base,
  );
  const task = store.update(submitted.id, {
    phase: "working", directory, branch: "ns-task", workspaceId: "task-ws", agentId: "worker", runId: "initial",
    profile: worker, workerModel: worker.model, agentActive: true, lastAgentStatus: "running",
    lastObservedAt: new Date().toISOString(),
  });
  const createdRuns: string[] = [];
  const permissionAnswers: unknown[][] = [];
  const messages: SelfHealingFixture["messages"] = [];
  let observation = running();
  let timeline: TimelineEntry[] = [];
  const adapter: Adapter & Partial<ResolutionAdapter> = fakeAdapter({
    supportsCoordinatorRecovery: true,
    profiles: async () => [worker, coordinator, reviewer],
    validate: async (candidate: Task) => candidate.planningCommit,
    createWorkspace: async (candidate: Task) => ({ id: `ws-${candidate.id}`, directory }),
    verifyWorkspace: async (candidate: Task) => candidate.branch,
    verifyResume: async () => {},
    createAgent: createTaskAgent,
    createRun: async (_candidate, run) => {
      createdRuns.push(run.role);
      return { id: `agent-${run.id}`, workspaceId: run.workspaceId };
    },
    observe: async (id: string) => (id === observation.id ? observation : { ...observation, id, status: "idle", active: false, permissions: false, activeTurnId: null, pendingRequest: undefined }),
    agentTimeline: async () => timeline,
    agentTimelinePage: async () => toolTimelinePage(timeline),
    verifyPr: async () => ({ url: "https://github.com/example/repo/pull/11", head: prHead }),
    verifyPrIdentity: async () => ({ url: "https://github.com/example/repo/pull/11", head: prHead }),
    findOpenBranchPr: async () => [],
    notify: async () => {},
    answerNativePermission: async (...args: unknown[]) => { permissionAnswers.push(args); },
    steerOrNotify: async (agentId: string, messageId: string, text: string) => {
      messages.push({ agentId, messageId, text });
      return "delivered" as const;
    },
  });
  const engine = new Engine(store, adapter, 0);
  engine.profiles.push(worker, coordinator, reviewer);
  return {
    root, directory, head, store, task, engine, adapter, createdRuns, permissionAnswers, messages,
    setObservation: (state) => { observation = state; },
    pushRevision: async () => {
      await writeFile(join(directory, "lane.txt"), "lane change, revised\n");
      await git(directory, "commit", "-am", "address review");
      await git(directory, "push", "origin", "ns-task");
      prHead = await git(directory, "rev-parse", "HEAD");
      return prHead;
    },
    setTimeline: (entries) => { timeline = entries; },
    setProcesses: (read) => {
      if (read) adapter.hostProcessListing = read;
      else delete adapter.hostProcessListing;
    },
  };
}
