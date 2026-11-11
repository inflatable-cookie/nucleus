import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HostRunEndpoint, HOST_RUN_FACT_CACHE_BYTES, hostRunProcessStartIdentity, writeVerifiedOwnedFile } from "../service/callbacks/host-run-endpoint";
import { HostRunScheduler } from "../core/host-runs/host-run-scheduler";
import { Store } from "../core/store/store";

type Internals = {
  ensureState(): void; loadFacts(): void; reconcileFacts(): void; compactFacts(): void;
  onReport(id: string, body: unknown): { ok: boolean; error?: { code: string } };
  storeFact(fact: unknown): void; facts: Map<string, unknown>;
  maintenance(): void; syncTokenKeys(): void;
  servingOwner: { serving(): boolean; writeAuthority(): void };
  cancelRun(id: string, reason: string): unknown;
};
function fixture(t: { after(fn: () => void): void }) {
  const stateDir = mkdtempSync(join(tmpdir(), "hr-primitives-"));
  const store = new Store(":memory:");
  t.after(() => store.close());
  const scheduler = new HostRunScheduler(store);
  const endpoint = new HostRunEndpoint(scheduler, { stateDir });
  const internal = endpoint as unknown as Internals;
  internal.ensureState();
  return { stateDir, endpoint, internal, scheduler };
}
const fact = (selector = "qa") => ({ kind: "override", factId: randomUUID(), observedAt: new Date().toISOString(), reason: "fixture", selector });

test("fact cache compaction preserves journal dedup and conflicts for evicted facts", t => {
  const { stateDir, internal } = fixture(t);
  const original = fact();
  assert.equal(internal.onReport("first", { facts: [original] }).ok, true);
  for (let i = 0; i < 3; i++) {
    const facts = Array.from({ length: 350 }, () => ({ ...fact("x".repeat(500)), reason: "x".repeat(4000) }));
    assert.equal(internal.onReport(`large-${i}`, { facts }).ok, true);
  }
  assert.equal(internal.facts.has(original.factId), false);
  assert.ok(statSync(join(stateDir, "facts.jsonl")).size <= HOST_RUN_FACT_CACHE_BYTES);
  assert.equal(internal.onReport("conflict", { facts: [{ ...original, selector: "changed" }] }).error?.code, "conflict");
  assert.equal(internal.onReport("replay", { facts: [original] }).ok, true);
});

test("startup loads a bounded complete tail from a legacy fact log", t => {
  const { stateDir, internal } = fixture(t);
  writeVerifiedOwnedFile(stateDir, ["facts.jsonl"], "", 0o600);
  const path = join(stateDir, "facts.jsonl");
  appendFileSync(path, "x".repeat(HOST_RUN_FACT_CACHE_BYTES + 200));
  const last = fact();
  appendFileSync(path, `\n${JSON.stringify(last)}\n`);
  internal.loadFacts();
  internal.reconcileFacts();
  internal.compactFacts();
  assert.equal(internal.facts.size, 1);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).factId, last.factId);
});

test("authority publication failures surface and clear only after successful retry", t => {
  const { endpoint, internal } = fixture(t);
  internal.servingOwner.serving = () => true;
  Object.assign(internal, { ensureServing: async () => true, sweepRetainedOutput: () => {}, syncTokenKeys: () => {} });
  internal.servingOwner.writeAuthority = () => { throw new Error("fixture denied write"); };
  internal.maintenance();
  assert.match(endpoint.error()!, /authority publication failed.*fixture denied write/);
  internal.servingOwner.writeAuthority = () => {};
  internal.maintenance();
  assert.equal(endpoint.error(), null);
});

test("legacy running cancellation refuses a stale leader identity", t => {
  const { internal, scheduler } = fixture(t);
  Object.assign(scheduler, {
    get: () => ({ id: "stale", state: "running", pid: process.pid, processGroupId: process.pid, startIdentity: `${process.pid}@unknown` }),
    note: () => {},
  });
  assert.equal(internal.cancelRun("stale", "fixture"), null);
});


test("legacy running cancellation signals a proven leader group", t => {
  const { internal, scheduler } = fixture(t);
  const startIdentity = hostRunProcessStartIdentity(process.pid);
  assert.ok(!startIdentity.endsWith("@unknown"));
  const run = { id: "proven", state: "running", pid: process.pid, processGroupId: process.pid, startIdentity };
  Object.assign(scheduler, { get: () => run, note: () => {} });
  const signals: Array<{ pid: number; signal: string | number | undefined }> = [];
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    signals.push({ pid, signal });
    return true;
  });
  assert.equal(internal.cancelRun("proven", "fixture"), run);
  assert.ok(signals.some(entry => entry.pid === -process.pid && entry.signal === "SIGTERM"));
});
