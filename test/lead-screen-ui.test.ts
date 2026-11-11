import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { mount, useNativeStubs } from "./support/render";
import type { LeadDetail, LeadVersion } from "../shared/contracts";
import type { LeadActions, LeadRead } from "../client/lead-screen";

useNativeStubs();
const h = React.createElement;
const c = new Proxy({}, { get: () => "#000" }) as never;
const settle = () => new Promise(resolve => setImmediate(resolve));

const repo = { origin: "owner/alpha", path: "/alpha" };
const digest = (n: number) => `sha256:${String(n).repeat(64)}`;
const check = (ok: boolean, message = "") => ({ ok, message, checkedAt: "2026-11-06T09:00:00Z", planningCommit: null as string | null, baseBranch: "main" });
const version = (number: number, over: Partial<LeadVersion> = {}): LeadVersion => ({
  version: number, title: "Ledger reads", body: "", author: "nucleus#864", createdAt: "2026-11-06T08:00:00Z", digest: digest(number % 10), check: null, approval: null, ...over,
} as unknown as LeadVersion);

function lead(over: Partial<LeadDetail> = {}): LeadDetail {
  const base = {
    id: "6a84e627-0000-0000-0000-000000000000", title: "Ledger reads", body: "---\ntitle: Ledger reads\n---\n\n# Ledger reads\n\nThe brief, in full.\n", repositories: [repo], lanes: ["alpha-lane"],
    tags: [], papercut: null, closure: null, author: "nucleus#864", state: "open", version: 2, digest: digest(2), check: null, checkOperationId: null,
    approval: null, baseBranch: "main", dropReason: null, reopens: [], targets: [], source: null,
    createdAt: "2026-11-06T08:00:00Z", updatedAt: "2026-11-06T09:00:00Z", closedAt: null, promotedTaskId: null,
    versions: [version(2), version(1)],
    ...over,
  } as unknown as LeadDetail;
  return base;
}
const approved = (forVersion = 2) => ({ version: forVersion, digest: digest(forVersion % 10), approver: "operator (board)", approvedAt: "2026-11-06T10:00:00Z", note: "", relayed: false, baseBranch: "main" });

async function mountScreen(over: {
  read?: LeadRead; compact?: boolean; busy?: boolean; lane?: { key: string; title: string };
  actions?: Partial<LeadActions>; readVersion?: (version: number) => Promise<LeadVersion | null>;
} = {}) {
  const { LeadScreen } = await import("../client/lead-screen");
  const log = { calls: [] as string[], retries: 0, versions: [] as number[] };
  const actions: LeadActions = {
    onCheck: async () => { log.calls.push("check"); return "Checks passed"; },
    onApprove: async () => { log.calls.push("approve"); return "Approved."; },
    onPromote: async origin => { log.calls.push(`promote:${origin}`); return "Promoted as nucleus#900"; },
    onDrop: async reason => { log.calls.push(`drop:${reason}`); return "Dropped."; },
    onReopen: async reason => { log.calls.push(`reopen:${reason}`); return "Reopened."; },
    onPromoteTo: async (kind, reference) => { log.calls.push(`${kind}:${reference}`); return kind === "question" ? "Recorded as a question." : "Recorded as a knowledge change."; },
    ...over.actions,
  };
  const ui = mount(h(LeadScreen, {
    read: over.read ?? { data: lead() },
    actions: actions,
    readVersion: over.readVersion ?? (async (number: number) => {
      log.versions.push(number);
      return { ...version(number), body: `# Earlier\n\nChecked brief of version ${number}.` } as LeadVersion;
    }),
    compact: over.compact ?? false,
    busy: over.busy ?? false,
    lane: over.lane,
    c,
    onRetry: () => { log.retries += 1; },
  }));
  return { ui, log };
}

test("loading, failed and stale reads are distinct from an empty record", async () => {
  const loading = await mountScreen({ read: {} });
  assert.match(loading.ui.text(), /Loading lead…/);
  assert.doesNotMatch(loading.ui.text(), /No brief written yet/);

  const failed = await mountScreen({ read: { error: "socket closed" } });
  assert.match(failed.ui.text(), /Couldn’t load this lead: socket closed/);
  assert.match(failed.ui.text(), /No check, approval or action is shown until it loads\./);
  assert.equal(failed.ui.get("Retry loading the lead").props.accessibilityLabel, "Retry loading the lead");
  assert.doesNotMatch(failed.ui.text(), /Not approved\./);
  failed.ui.press("Retry loading the lead");
  assert.equal(failed.log.retries, 1);

  const stale = await mountScreen({ read: { data: lead(), error: "timeout" } });
  assert.match(stale.ui.text(), /Showing the last read of this lead\. It may be out of date: timeout/);
  assert.ok(stale.ui.get("Retry refreshing the lead"));
  assert.match(stale.ui.text(), /The brief, in full\./, "the last read stays on screen");
});

test("an empty record says what is absent and refuses every action with the reason", async () => {
  const { ui } = await mountScreen({ read: { data: lead({ body: "", digest: undefined, versions: [version(2)] }) } });
  assert.match(ui.text(), /No brief written yet\./);
  assert.match(ui.text(), /Not checked yet\./);
  assert.match(ui.text(), /Not approved\./);
  assert.equal(ui.get("Check the brief").props.disabled, true);
  assert.match(ui.text(), /Lead has no brief to check/);
  assert.equal(ui.get("Approve the checked version").props.disabled, true);
  assert.equal(ui.get("Promote to a task").props.disabled, true);
  assert.match(ui.text(), /Approve the checked version first/);
});

test("the checked version sits beside its result and the approver is named", async () => {
  const { ui } = await mountScreen({ read: { data: lead({ check: check(true), digest: digest(2), approval: approved(2) }) } });
  assert.match(ui.text(), /Checks passed/);
  assert.match(ui.text(), /Version 2 · checked /);
  assert.match(ui.text(), /Approved by operator \(board\)/);
  assert.match(ui.text(), /Version 2 · approved /);
  assert.equal(ui.get("Approve the checked version").props.disabled, true, "already approved");
  assert.equal(ui.get("Promote to a task").props.disabled, false, "an approved, checked version promotes");
  assert.equal(ui.query("Check out of date"), undefined);
});

test("a relayed approval says so instead of implying the operator pressed it", async () => {
  const { ui } = await mountScreen({ read: { data: lead({ check: check(true), approval: { ...approved(2), approver: "nucleus#864", relayed: true, note: "Tom's 2026-10-20 authorization" } }) } });
  assert.match(ui.text(), /Approved by nucleus#864, relayed with the operator's authority · Tom's 2026-10-20 authorization/);
  assert.match(ui.text(), /not the operator's own action/);
});

test("a changed version shows the check as stale and asks for the existing recheck", async () => {
  const { ui, log } = await mountScreen({ read: { data: lead({ version: 3, digest: digest(3), check: null, approval: null, versions: [version(3), version(2, { check: check(true) }), version(1)] }) } });
  const alert = ui.get("Check out of date");
  assert.equal(alert.props.accessibilityRole, "alert");
  assert.match(ui.text(), /Version 2 was checked; this is version 3\./);
  assert.match(ui.text(), /The check is out of date\. Check the brief again before approving it\./);
  assert.match(ui.text(), /Check stale · version 2 · Not approved/);
  assert.equal(ui.get("Check the brief").props.disabled, false, "the existing recheck is the next step");
  assert.equal(ui.get("Approve the checked version").props.disabled, true);
  assert.match(ui.text(), /The check is for version 2; check version 3 first/);
  assert.equal(ui.get("Promote to a task").props.disabled, true);
  ui.press("Check the brief");
  await settle();
  assert.deepEqual(log.calls, ["check"]);
  assert.equal(ui.get("Check result").props.accessibilityLabel, "Check result");
  assert.match(ui.text(), /Checks passed/);
});

test("an out-of-date check can show the brief that was actually checked", async () => {
  const stale = () => lead({ version: 3, digest: digest(3), check: null, approval: null, versions: [version(3), version(2, { check: check(true) }), version(1)] });
  const { ui, log } = await mountScreen({ read: { data: stale() } });
  assert.equal(ui.query("Brief of version 2"), undefined, "the checked brief is not loaded until asked for");
  ui.press("Show the brief of version 2");
  assert.match(ui.text(), /Loading version 2…/);
  await settle();
  assert.deepEqual(log.versions, [2]);
  assert.ok(ui.get("Brief of version 2"));
  assert.match(ui.text(), /Version 2, as it was checked:/);
  assert.match(ui.text(), /Checked brief of version 2\./, "the operator reads what the check covered");

  const failed = await mountScreen({ read: { data: stale() }, readVersion: async () => { throw new Error("socket closed"); } });
  failed.ui.press("Show the brief of version 2");
  await settle();
  assert.match(failed.ui.text(), /Couldn’t load version 2: socket closed/);

  const missing = await mountScreen({ read: { data: stale() }, readVersion: async () => null });
  missing.ui.press("Show the brief of version 2");
  await settle();
  assert.match(missing.ui.text(), /Couldn’t load version 2: Version 2 is not stored/);
});

test("a normal edit keeps the earlier approval visible as out of date", async () => {
  const { leadApprovalView } = await import("../client/lead-screen");
  const edited = lead({ version: 3, digest: digest(3), check: null, approval: null, versions: [version(3), version(2, { check: check(true), approval: approved(2) })] });
  assert.deepEqual(leadApprovalView(edited), { kind: "stale", approval: approved(2) }, "clearing the approval on a new version does not erase the history");

  const { ui } = await mountScreen({ read: { data: edited } });
  const alert = ui.get("Approval out of date");
  assert.equal(alert.props.accessibilityRole, "alert");
  assert.match(ui.text(), /Version 2 was approved; this is version 3\./);
  assert.equal(ui.get("Approve the checked version").props.disabled, true);
  assert.equal(ui.get("Promote to a task").props.disabled, true, "the stale approval never promotes");
});

test("an approval for another version is named stale, never shown as this version's", async () => {
  const { ui } = await mountScreen({ read: { data: lead({ version: 3, digest: digest(3), check: check(true), approval: approved(2) }) } });
  const alert = ui.get("Approval out of date");
  assert.equal(alert.props.accessibilityRole, "alert");
  assert.match(ui.text(), /Version 2 was approved; this is version 3\./);
  assert.equal(ui.get("Promote to a task").props.disabled, true);
  assert.match(ui.text(), /The approval is for version 2; approve version 3 first/);
});

test("every lead action reports its own result or refusal beside its own control", async () => {
  const refused = await mountScreen({ actions: { onCheck: async () => { throw new Error("checkout is dirty"); } } });
  refused.ui.press("Check the brief");
  await settle();
  assert.equal(refused.ui.get("Check refusal").props.accessibilityRole, "alert");
  assert.match(refused.ui.text(), /checkout is dirty/);
  assert.equal(refused.ui.query("Approve refusal"), undefined, "one action's failure never reads as another's outcome");

  const ok = await mountScreen({ read: { data: lead({ check: check(true) }) } });
  ok.ui.press("Approve the checked version");
  await settle();
  assert.deepEqual(ok.log.calls, ["approve"]);
  assert.equal(ok.ui.get("Approve result").props.accessibilityLabel, "Approve result");
  assert.match(ok.ui.text(), /Approved\./);
});

test("promotion names the repository when a lead lists more than one", async () => {
  const multiple = await mountScreen({ read: { data: lead({ repositories: [repo, { origin: "owner/beta", path: "/beta" }] }) } });
  assert.ok(multiple.ui.get("Promote to a task in owner/alpha"));
  assert.ok(multiple.ui.get("Promote to a task in owner/beta"));
  multiple.ui.press("Promote to a task in owner/beta");
  await settle();
  assert.deepEqual(multiple.log.calls, ["promote:owner/beta"]);

  const promoted = await mountScreen({ read: { data: lead({ targets: [{ kind: "task", repository: "owner/alpha", reference: "nucleus#900", at: "2026-11-06T11:00:00Z" }] }) } });
  assert.equal(promoted.ui.get("Promote to a task").props.disabled, true);
  assert.match(promoted.ui.text(), /Already promoted to a task in owner\/alpha/);
});

test("drop, reopen and the question or knowledge promotion sit in a secondary menu with their reasons", async () => {
  const open = await mountScreen({ read: { data: lead({ check: check(true), approval: approved(2) }) } });
  assert.equal(open.ui.query("Drop the lead"), undefined, "the secondary actions stay closed");
  open.ui.press("More actions");
  assert.equal(open.ui.get("Drop the lead").props.disabled, true, "a drop needs its reason");
  open.ui.type("Drop reason", "Superseded by the split");
  open.ui.press("Drop the lead");
  await settle();
  assert.deepEqual(open.log.calls, ["drop:Superseded by the split"]);
  assert.match(open.ui.text(), /Dropped\./);
  assert.equal(open.ui.get("Reopen the lead").props.disabled, true);
  assert.match(open.ui.text(), /Only a dropped lead can be reopened/);

  open.ui.type("Question or knowledge reference", "questions.md Q17");
  open.ui.press("Record promotion to a question");
  await settle();
  assert.deepEqual(open.log.calls, ["drop:Superseded by the split", "question:questions.md Q17"]);
  assert.match(open.ui.text(), /Recorded as a question\./);
  assert.equal(open.ui.get("Question promotion result").props.accessibilityLabel, "Question promotion result");

  // The second promotion keeps its own line instead of replacing or being hidden by the first.
  open.ui.press("Record promotion to a knowledge change");
  await settle();
  assert.equal(open.ui.get("Knowledge promotion result").props.accessibilityLabel, "Knowledge promotion result");
  assert.match(open.ui.text(), /Recorded as a question\./);
  assert.match(open.ui.text(), /Recorded as a knowledge change\./);

  const dropped = await mountScreen({ read: { data: lead({ state: "dropped", dropReason: "Mistake" }) } });
  dropped.ui.press("More actions");
  assert.equal(dropped.ui.get("Drop the lead").props.disabled, true);
  assert.match(dropped.ui.text(), /Only open leads can be dropped; this lead is dropped/);
  dropped.ui.type("Reopen reason", "Dropped by mistake");
  dropped.ui.press("Reopen the lead");
  await settle();
  assert.deepEqual(dropped.log.calls, ["reopen:Dropped by mistake"]);
  assert.equal(dropped.ui.get("Record promotion to a question").props.disabled, true, "a dropped lead promotes to nothing");
});

test("the brief sits beside the check and approval at wide sizes and stacks at narrow ones", async () => {
  const wide = await mountScreen({ compact: false, lane: { key: "alpha-lane", title: "Alpha lane" } });
  assert.equal(wide.ui.get("Lead brief and decision").props.style.flexDirection, "row");
  assert.ok(wide.ui.get("Lead brief"));
  assert.ok(wide.ui.get("Check result and approval"));
  assert.match(wide.ui.text(), /Alpha lane · lead/);

  const narrow = await mountScreen({ compact: true });
  assert.equal(narrow.ui.get("Lead brief and decision").props.style.flexDirection, "column");
  assert.match(narrow.ui.text(), /Planning lead/);
});

test("every control carries an accessible label and the record keeps its raw facts behind Details", async () => {
  const { ui } = await mountScreen();
  assert.ok(ui.get("Lead Ledger reads"));
  assert.ok(ui.get("Check the brief"));
  assert.ok(ui.get("Approve the checked version"));
  assert.doesNotMatch(ui.text(), /6a84e627-0000-0000-0000-000000000000/, "the raw id stays behind Details");
  assert.doesNotMatch(ui.text(), /title: Ledger reads/, "brief frontmatter stays behind Details");
  assert.match(ui.text(), /The brief, in full\./, "the brief shows its text");
  assert.ok(ui.ofType("Text").some(node => node.props.accessibilityRole === "header" && node.children.join("") === "Ledger reads"), "a Markdown heading is set as a heading");
  assert.doesNotMatch(ui.text(), /# Ledger reads/, "Markdown markers are not shown as markers");
  ui.press("Details");
  assert.match(ui.text(), /Lead id · 6a84e627-0000-0000-0000-000000000000/);
  assert.ok(ui.get("Brief frontmatter"));
  assert.match(ui.text(), /title: Ledger reads/);
  assert.ok(ui.get("Lead repositories"));
  assert.match(ui.text(), /owner\/alpha \(\/alpha\)/);
});

test("wrapped prose reads as one paragraph while headings, lists and code keep their shape", async () => {
  const { readableBlocks } = await import("../client/readable-text");
  assert.deepEqual(readableBlocks("# Title\n\nOne wrapped\nline here.\n\n- item one\n- item two\n\n```\nraw();\n```"), [
    { kind: "heading", text: "Title" },
    { kind: "gap", text: "" },
    { kind: "paragraph", text: "One wrapped line here." },
    { kind: "gap", text: "" },
    { kind: "line", text: "- item one" },
    { kind: "line", text: "- item two" },
    { kind: "gap", text: "" },
    { kind: "line", text: "```" },
    { kind: "line", text: "raw();" },
    { kind: "line", text: "```" },
  ]);
});

test("brief frontmatter is routing mechanics, so the operator reads the brief without it", async () => {
  const { briefParts } = await import("../client/lead-screen");
  const brief = "---\ntitle: Ledger\nlanes: [ui]\n---\n\n# Ledger\n\nBody text.";
  assert.deepEqual(briefParts(brief), { frontmatter: "---\ntitle: Ledger\nlanes: [ui]\n---", text: "# Ledger\n\nBody text." });
  assert.deepEqual(briefParts("Just prose, no frontmatter."), { frontmatter: null, text: "Just prose, no frontmatter." });
  assert.deepEqual(briefParts("---\ntitle: Ledger\n---\n"), { frontmatter: "---\ntitle: Ledger\n---", text: "" }, "frontmatter alone is no brief text");
});

test("a long version list pages honestly instead of rendering every version", async () => {
  const versions = Array.from({ length: 12 }, (_, index) => version(12 - index));
  const { ui } = await mountScreen({ read: { data: lead({ version: 12, versions }) } });
  ui.press("Details");
  assert.match(ui.text(), /Showing the latest 8 of 12 versions\./);
  assert.match(ui.text(), /v12 · nucleus#864/);
  assert.doesNotMatch(ui.text(), /v4 · nucleus#864/, "the next page is offered, not rendered");
  ui.press("Show 4 more versions of Ledger reads");
  assert.match(ui.text(), /v4 · nucleus#864/);
  assert.equal(ui.query("Show 4 more versions of Ledger reads"), undefined, "the last page is the whole list");
  assert.doesNotMatch(ui.text(), /Showing the latest 8 of 12 versions\./);
});

test("a busy board disables the actions so one record cannot take two writes at once", async () => {
  const { ui } = await mountScreen({ busy: true, read: { data: lead({ check: check(true) }) } });
  assert.equal(ui.get("Check the brief").props.disabled, true);
  assert.equal(ui.get("Approve the checked version").props.disabled, true);
  assert.equal(ui.get("Promote to a task").props.disabled, true);
});
