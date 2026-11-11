import { fakeAdapter, createTaskAgent } from './support/fakes';
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { submissionSchema, type Profile } from "../shared/contracts";
import type { Adapter } from "../core/host";

const profile: Profile = {
  id: "worker",
  name: "Worker",
  provider: "test",
  model: "test",
  notes: "",
  available: true,
  problem: "",
  supportedThinking: ["low"],
};

test("settling many dependents coalesces dispatch by repository", async () => {
  async function measure(size: number) {
    const store = new Store(":memory:");
    const adapter = fakeAdapter({
      profiles: async () => [profile],
      validate: async (task: { planningCommit: string }) => task.planningCommit,
      createWorkspace: async (task: { id: string }) => ({
        id: `ws-${task.id}`,
        directory: "/fixture",
      }),
      verifyWorkspace: async (task: { branch: string }) => task.branch,
      createAgent: createTaskAgent,
      observe: async (id: string) => ({
        id,
        workspaceId: null,
        status: "running",
        active: true,
        permissions: false,
        error: "",
      }),
      archiveTaskWorkspace: async () => true,
      verifyPr: async () => ({
        url: "https://github.com/example/repo/pull/1",
        head: "a".repeat(40),
      }),
      findOpenBranchPr: async () => [],
    } as unknown as Adapter);
    const engine = new Engine(store, adapter, 0);
    engine.profiles = [profile];
    store.setMeta("pool", [
      {
        profileId: profile.id,
        enabled: true,
        group: "test",
        weight: 1,
        scopes: ["general"],
      },
    ]);
    store.setMeta("paused", false);
    store.setMeta("globalLimit", 2);
    store.setMeta("projectLimit", 2);
    const add = (repoPath: string, dependsOn: string[] = []) =>
      store.insert(
        submissionSchema.parse({
          submissionId: randomUUID(),
          title: "Task",
          repoPath,
          dependsOn,
          planningCommit: "a".repeat(40),
          handoffPath: "handoff.md",
          originAgentId: "origin",
        }),
        "host",
        "handoff",
        "a".repeat(40),
      );
    const parent = add("/parent");
    for (let i = 0; i < size; i++) add("/project-a", [parent.id]);
    let passes = 0,
      visits = 0,
      reads = 0;
    const dispatch = engine as unknown as {
      dispatchTask(id: string, held: boolean): Promise<void>;
    };
    const originalDispatch = dispatch.dispatchTask.bind(engine);
    dispatch.dispatchTask = (id, held) => {
      visits++;
      return originalDispatch(id, held);
    };
    const originalWake = engine.wakeRepository.bind(engine);
    let resolve!: (work: Promise<void>) => void;
    const awakened = new Promise<Promise<void>>((done) => {
      resolve = done;
    });
    engine.wakeRepository = (repo) => {
      passes++;
      const work = originalWake(repo);
      resolve(work);
      return work;
    };
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = ((sql: string) => {
      const stmt = prepare(sql);
      return new Proxy(stmt, {
        get(target, name) {
          const member = Reflect.get(target, name, target);
          if (typeof member !== "function") return member;
          if (name === "get" || name === "all" || name === "iterate")
            return (...args: unknown[]) => {
              reads++;
              return member.apply(target, args);
            };
          return member.bind(target);
        },
      });
    }) as typeof store.db.prepare;
    try {
      store.update(parent.id, { phase: "done" });
      await awakened;
      return { passes, visits, reads };
    } finally {
      store.db.prepare = prepare;
      await engine.stop();
      store.close();
    }
  }
  const small = await measure(10),
    large = await measure(1000);
  assert.equal(small.passes, 1);
  assert.equal(large.passes, 1);
  assert.equal(small.visits, 2);
  assert.equal(large.visits, 2);
  assert.ok(
    large.reads < small.reads * 120,
    `affected-dependent reads should grow at most linearly: ${small.reads} vs ${large.reads}`,
  );
  console.log(
    `settlement fan-out: 10: ${small.passes} pass, ${small.visits} visits, ${small.reads} reads; 1000: ${large.passes} pass, ${large.visits} visits, ${large.reads} reads`,
  );
});
