import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EscapedDescendantCustody, ESCAPED_DESCENDANT_PROOF_MS } from "../core/machine/escaped-descendants";
import { overrideIdentityListing, processStartIdentityLiveness } from "../core/machine/process-identity-search";
import { hostRunProcessStartIdentity } from "../core/machine/start-identity";

/**
 * Contract 010's escaped-descendant proof. The listing is injected, so these
 * cases decide the proof rule without reading the host's process table: what a
 * clean scan proves, when it proves it, and that unknown is never absence.
 */

test("a caller polling faster than the proof interval still proves absence", t => {
  overrideIdentityListing({ state: "absent" });
  t.after(() => overrideIdentityListing(null));
  const custody = new EscapedDescendantCustody("fixture-identity");
  // The process owner settles on a 20 ms tick and scans every 100 ms, so every
  // poll is shorter than the interval: the first clean instant must be kept.
  assert.equal(custody.absenceProven(null, 1_000), false, "one clean scan is not proof");
  assert.equal(custody.absenceProven(null, 1_050), false);
  assert.equal(custody.absenceProven(null, 1_100), false);
  assert.equal(custody.absenceProven(null, 1_150), true,
    "the first scan past the interval proves absence");
  assert.deepEqual(custody.recorded(), [], "nothing is recorded for a run with no escapes");
  assert.ok(ESCAPED_DESCENDANT_PROOF_MS === 150, "the interval the test polls against");
});

test("an unreadable listing is never proof of absence", t => {
  overrideIdentityListing({ state: "unknown" });
  t.after(() => overrideIdentityListing(null));
  const custody = new EscapedDescendantCustody("fixture-identity");
  assert.equal(custody.absenceProven(null, 0), false);
  assert.equal(custody.absenceProven(null, 10_000), false,
    "an unknown host state cannot prove there was never a descendant");
});

test("a known live descendant the identity listing no longer sees does not prove absence", t => {
  overrideIdentityListing({ state: "absent" });
  t.after(() => overrideIdentityListing(null));
  const custody = new EscapedDescendantCustody("fixture-identity");
  overrideIdentityListing({
    state: "found",
    processes: [{ pid: process.pid, processGroupId: 9_999_999, startIdentity: hostRunProcessStartIdentity(process.pid) }],
  });
  assert.equal(custody.absenceProven(null, 0), false);
  assert.deepEqual(custody.recorded().map(entry => entry.pid), [process.pid], "the escaped descendant is recorded");
  // An escapee that execs a clean environment keeps its pid and birth identity but
  // loses the inherited marker, so the listing alone would call it absent.
  overrideIdentityListing({ state: "absent" });
  assert.equal(custody.absenceProven(null, 200), false, "the listing no longer sees it");
  assert.equal(custody.absenceProven(null, 5_000), false, "but it is recorded and still alive");
});

test("a recorded descendant that is dead or whose pid was reused does not hold the run", t => {
  overrideIdentityListing({ state: "absent" });
  t.after(() => overrideIdentityListing(null));
  const custody = new EscapedDescendantCustody("fixture-identity");
  // A reused pid: the recorded birth identity is not the one the pid carries now.
  overrideIdentityListing({
    state: "found",
    processes: [{ pid: process.pid, processGroupId: 9_999_999, startIdentity: `${process.pid}@2020-01-01T00:00:00Z` }],
  });
  assert.equal(custody.absenceProven(null, 0), false);
  overrideIdentityListing({ state: "absent" });
  assert.equal(custody.absenceProven(null, 200), false, "one clean scan is never proof");
  assert.equal(custody.absenceProven(null, 400), true, "a proven dead recorded identity does not hold the run");
});

test("a recorded identity that cannot be observed never proves absence", t => {
  overrideIdentityListing({ state: "absent" });
  t.after(() => overrideIdentityListing(null));
  const custody = new EscapedDescendantCustody("fixture-identity");
  overrideIdentityListing({
    state: "found",
    processes: [{ pid: process.pid, processGroupId: 9_999_999, startIdentity: `${process.pid}@unknown` }],
  });
  assert.equal(custody.absenceProven(null, 0), false);
  overrideIdentityListing({ state: "absent" });
  assert.equal(custody.absenceProven(null, 200), false);
  assert.equal(custody.absenceProven(null, 5_000), false, "an unobservable identity is never proof of death");
});

test("a recorded pid whose identity changed is never signalled", async t => {
  // One real child stands in for an escapee whose pid was reused: the recorded
  // birth identity is not the one the pid carries now, so a stop must skip it.
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], { stdio: "ignore" });
  let exited = false;
  const exit = new Promise<void>(resolvePromise => { child.once("exit", () => { exited = true; resolvePromise(); }); });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  const pid = child.pid!;
  const stale = `${pid}@2020-01-01T00:00:00Z`;
  overrideIdentityListing({ state: "found", processes: [{ pid, processGroupId: 9_999_999, startIdentity: stale }] });
  t.after(() => overrideIdentityListing(null));
  const custody = new EscapedDescendantCustody("fixture-identity");
  assert.equal(custody.absenceProven(null, 0), false);
  custody.signal("SIGKILL");
  await new Promise(resolvePromise => setTimeout(resolvePromise, 150));
  assert.equal(exited, false, "a pid that no longer carries the recorded identity is not signalled");
  assert.equal(processStartIdentityLiveness(pid, stale), "dead", "the recorded identity no longer names this process");
  // The same recorded pid with its real current identity is the process we saw.
  overrideIdentityListing({
    state: "found",
    processes: [{ pid, processGroupId: 9_999_999, startIdentity: hostRunProcessStartIdentity(pid) }],
  });
  const fresh = new EscapedDescendantCustody("fixture-identity");
  assert.equal(fresh.absenceProven(null, 0), false);
  fresh.signal("SIGKILL");
  await Promise.race([exit, new Promise(resolvePromise => setTimeout(resolvePromise, 2_000))]);
  assert.equal(exited, true, "a proven live descendant is signalled");
});
