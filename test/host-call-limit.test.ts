import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HOST_CALL_LIMIT,
  MAX_HOST_CALL_LIMIT,
  capacitySchema,
} from "../shared/contracts";
import {
  CAPACITY_CHANGE_LOG_META_KEY,
  CapacityChangeJournal,
  LEGACY_HOST_CALL_LIMIT_META_KEY,
  capacityAuthorityEffective,
} from "../core/dispatch/capacity-changes";
import { Store } from "../core/store/store";
import {
  Admission,
  BACKPRESSURE_DEFERRAL,
  LEGACY_PASEO_BACKPRESSURE_DEFERRAL,
  isBackpressureDeferral,
} from "../core/host/admission";
import { archiveRetryWaiting } from "../core/closeout/terminal-archive";

/**
 * The per-host call limit (service-boundary contract, "Host-call limit"). The
 * canonical name is `hostCallLimit`; `paseoCallLimit` is the Paseo-era name that
 * an older build still writes and reads. These proofs cover a store saved under
 * the old name, the canonical round trip, the one authority when both names are
 * present, every host sharing the one ceiling per host, and recovery from a
 * breaker deferral stored under the old wait prefix.
 */
const AT = "2026-11-21T09:00:00.000Z";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function storeFixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "nsq-host-call-limit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "queue.sqlite"));
  t.after(() => store.close());
  return {
    store,
    journal: new CapacityChangeJournal(store, { clock: () => AT }),
  };
}

test("a store saved under the Paseo-era name keeps its limit, and the first Settings write carries it into the canonical name", (t) => {
  const { store, journal } = storeFixture(t);
  store.setMeta(LEGACY_HOST_CALL_LIMIT_META_KEY, 9);
  assert.equal(store.configuredHostCallLimit(), 9);
  assert.equal(capacityAuthorityEffective(store).hostCallLimit, 9);
  assert.equal(journal.state().effective.hostCallLimit, 9);

  const result = journal.apply({ globalLimit: 21 });
  assert.deepEqual(
    result.fields,
    ["globalLimit"],
    "the limit itself did not move",
  );
  const [change] = journal.state().changes;
  assert.equal(
    change!.before.hostCallLimit,
    9,
    "the record keeps the value in force, not the default",
  );
  assert.equal(change!.after.hostCallLimit, 9);
  assert.equal(
    store.getMeta("hostCallLimit"),
    9,
    "the canonical key is saved with the first write",
  );
});

test("the canonical limit round-trips through the store, the record and the legacy mirror, and a repeat save is a no-op", (t) => {
  const { store, journal } = storeFixture(t);
  assert.deepEqual(journal.apply({ hostCallLimit: 12 }).fields, [
    "hostCallLimit",
  ]);
  assert.equal(store.configuredHostCallLimit(), 12);
  assert.equal(store.getMeta("hostCallLimit"), 12);
  assert.equal(
    store.getMeta(LEGACY_HOST_CALL_LIMIT_META_KEY),
    12,
    "the mirror keeps an older reader on the same bound",
  );
  const state = journal.state();
  assert.equal(state.effective.hostCallLimit, 12);
  assert.equal(state.changes.at(-1)!.after.hostCallLimit, 12);

  assert.equal(
    journal.apply({ hostCallLimit: 12 }).changed,
    false,
    "saving the value in force changes nothing",
  );
  assert.equal(journal.state().changes.length, 1, "and records nothing");
});

test("a Paseo-era write lands on the canonical limit, and two different values in one write are refused whole", (t) => {
  const { store, journal } = storeFixture(t);
  assert.deepEqual(journal.apply({ paseoCallLimit: 7 }).fields, [
    "hostCallLimit",
  ]);
  assert.equal(store.configuredHostCallLimit(), 7);

  assert.throws(
    () => journal.apply({ hostCallLimit: 5, paseoCallLimit: 8 }),
    /disagree; send one value/,
  );
  assert.equal(
    store.configuredHostCallLimit(),
    7,
    "a refused write changes nothing",
  );
  assert.equal(journal.state().changes.length, 1, "and records nothing");
  assert.equal(
    journal.apply({ hostCallLimit: 8, paseoCallLimit: 8 }).changed,
    true,
    "two names for one value agree",
  );
});

test("once the canonical limit is saved, a stale legacy value never overrides it", (t) => {
  const { store, journal } = storeFixture(t);
  journal.apply({ hostCallLimit: 12 });
  store.setMeta(LEGACY_HOST_CALL_LIMIT_META_KEY, 3);
  assert.equal(store.configuredHostCallLimit(), 12);
});

test("applied changes recorded under the Paseo-era names still read, under the canonical name, and keep their order", (t) => {
  const { store, journal } = storeFixture(t);
  const { hostCallLimit, ...rest } = capacityAuthorityEffective(store);
  const legacy = { ...rest, paseoCallLimit: hostCallLimit };
  store.setMeta(CAPACITY_CHANGE_LOG_META_KEY, [
    {
      version: 1,
      at: AT,
      surface: "paseo",
      before: legacy,
      after: { ...legacy, globalLimit: 21 },
    },
  ]);

  const [change] = journal.state().changes;
  assert.equal(
    journal.state().changes.length,
    1,
    "the history is kept, not dropped",
  );
  assert.equal(change!.version, 1);
  assert.equal(change!.before.hostCallLimit, DEFAULT_HOST_CALL_LIMIT);
  assert.equal(change!.after.globalLimit, 21);
  assert.equal("paseoCallLimit" in change!.before, false);

  journal.apply({ globalLimit: 22 });
  assert.equal(
    journal.state().changes.at(-1)!.version,
    2,
    "the next version continues the record",
  );
});

test("the host-call bound keeps its range under both names", () => {
  const base = { globalLimit: 1, projectLimit: 1 };
  assert.equal(
    capacitySchema.parse({ ...base, hostCallLimit: MAX_HOST_CALL_LIMIT })
      .hostCallLimit,
    MAX_HOST_CALL_LIMIT,
  );
  assert.equal(
    capacitySchema.parse({ ...base, paseoCallLimit: 4 }).paseoCallLimit,
    4,
  );
  assert.throws(() =>
    capacitySchema.parse({ ...base, hostCallLimit: MAX_HOST_CALL_LIMIT + 1 }),
  );
  assert.throws(() => capacitySchema.parse({ ...base, paseoCallLimit: 0 }));
  assert.throws(
    () => capacitySchema.parse({ ...base, hostCallLimitt: 3 }),
    "an unknown name is refused, not ignored",
  );
});

test("every host reads the one ceiling and holds its own share of it, so hosts never share a single pool", async (t) => {
  const { store, journal } = storeFixture(t);
  journal.apply({ hostCallLimit: 2 });
  const hosts = ["paseo", "t3code", "bb"].map(
    () =>
      new Admission({
        totalLimit: () => store.configuredHostCallLimit(),
        startIntervalMs: 0,
        limits: { observation: 32 },
      }),
  );
  for (const host of hosts)
    assert.equal(host.totalLimit, 2, "each host reads the same ceiling");

  // Six calls per host, all admitted through the host's own gate; the counter is shared
  // so the peak shows what the hosts hold together.
  let running = 0;
  let peak = 0;
  const work = async () => {
    running++;
    peak = Math.max(peak, running);
    await sleep(25);
    running--;
  };
  const callsFor = (host: Admission, name: string) =>
    Array.from({ length: 6 }, (_, index) =>
      host.run("observation", work, `${name}-${index}`),
    );

  await Promise.all(callsFor(hosts[0]!, "solo"));
  assert.equal(peak, 2, "one host alone is capped at the ceiling");

  peak = 0;
  await Promise.all(
    hosts.flatMap((host, index) => callsFor(host, `together-${index}`)),
  );
  assert.equal(
    peak,
    2 * hosts.length,
    "each host holds its own share at once, so the hosts add up rather than sharing one pool of two",
  );
});

test("a breaker deferral stored under the Paseo-era wait prefix is still a deferral that is due at once", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const retry = (error: string) => ({
    workspaceId: "ws",
    attempts: 1,
    error,
    nextAttemptAt: future,
  });
  const legacy = `${LEGACY_PASEO_BACKPRESSURE_DEFERRAL}3 slow critical Paseo calls in 60s: inventory 19540 ms (threshold 10000 ms)`;
  const current = `${BACKPRESSURE_DEFERRAL}3 slow critical host calls in 60s: inventory 19540 ms (threshold 10000 ms)`;

  assert.equal(
    isBackpressureDeferral(legacy),
    true,
    "a roll keeps recognising the stored wait",
  );
  assert.equal(isBackpressureDeferral(current), true);
  assert.equal(isBackpressureDeferral("teardown refused"), false);
  assert.equal(
    archiveRetryWaiting(retry(legacy) as never),
    false,
    "no call reached the host, so it is due on the first admitted pass",
  );
  assert.equal(archiveRetryWaiting(retry(current) as never), false);
  assert.equal(
    archiveRetryWaiting(retry("teardown refused") as never),
    true,
    "a failed attempt still waits for its backoff",
  );
});
