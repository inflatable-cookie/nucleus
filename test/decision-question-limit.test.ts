import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Store } from "../core/store/store";
import { Decisions } from "../core/planning/decisions";
import { decisionList, DECISION_QUESTION_CLIP_MARKER, clipDecisionQuestion } from "../shared/contracts";
import { errorText, readErrorText, storedBoardErrorText } from "../client/error-text";
import { fixture } from "./support/responsible-lifecycle-fixture";

/**
 * Nucleus#1141: an over-long question never breaks a board read, and every
 * question producer stays within the limit. The three-round non-convergence
 * question is built from the reviewer's full findings plus the worker's latest
 * return, which exceeds the 4,000-character view limit; on the board route that
 * broke the read with a raw too_big refusal under the board header.
 */

test("1141-1 the joint-review producer keeps a long finding inside the limit with the material in details", async () => {
  const f = fixture({ responsible: true });
  // Board route: the joint question becomes a Spec 032 decision instead of a
  // native prompt. Only the route changes; the adapter keeps every other fake.
  Object.assign(f.adapter, { capabilities: () => ({ nativeDecisions: false }) });
  try {
    await f.reviews(2);
    await f.engine.wake();
    assert.equal(f.run().role, "revision", "a returned revision runs before the third review");
    await f.report("ready_for_review");
    await f.engine.wake();
    assert.equal(f.run().role, "reviewer", "the third review runs before the joint question");
    const longFinding = `Authenticated findings: ${"Finding detail. ".repeat(400).trim()}`;
    assert.ok(longFinding.length > 4000, "the fixture finding exceeds the view limit");
    await f.report("changes_required", { reviewText: longFinding });
    await f.settle(2);
    // The producer recorded its question instead of refusing it.
    assert.equal(f.events("responsible_question").length, 1, "exactly one joint question");
    assert.equal(f.events("responsible_question_unknown").length, 0, "no producer refusal");
    assert.equal(f.asks.length, 0, "no native prompt on the board route");
    // The board decision carries a short readable ask; the long material is in
    // the details, never in the clipped question.
    const open = new Decisions(f.store).list({ status: "open" });
    assert.equal(open.length, 1, "the joint question is one open board decision");
    const view = open[0]!;
    assert.deepEqual(view.links.tasks, [f.current().id]);
    assert.ok(view.question.length <= 4000, "the recorded question stays within the view limit");
    assert.match(view.question, /Three review rounds have not converged/);
    assert.doesNotMatch(view.question, /Finding detail\./, "the full finding is not inlined in the question");
    assert.ok((view.details ?? "").includes(longFinding), "the full finding travels in the details");
    assert.match(view.details ?? "", /revision reported ready_for_review/, "the worker return travels in the details");
    // The board read validates: the decision list output contract parses.
    decisionList.output.parse(open);
  } finally { await f.close(); }
});

test("1141-2 an already-stored over-long record clips in the view without failing the read", () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-decision-limit-"));
  const store = new Store(join(dir, "queue.sqlite"));
  try {
    const decisions = new Decisions(store);
    // Task 1183 places every new decision; this file owns clipping, not placing.
    const created = decisions.add({ question: "Short question?", askedBy: "agent",
      project: { origin: "owner/repo", path: "/repo" } });
    const over = `Over-long stored question: ${"word ".repeat(1500)}`;
    assert.ok(over.length > 4000, "the stored record exceeds the view limit");
    const raw = JSON.parse(String((store.db.prepare("SELECT data FROM decisions WHERE id=?").get(created.id) as { data: string }).data));
    raw.question = over;
    store.db.prepare("UPDATE decisions SET data=? WHERE id=?").run(JSON.stringify(raw), created.id);
    // The whole read still returns everything; the view clips with a marker.
    const listed = decisions.list({ status: "open" });
    assert.equal(listed.length, 1);
    assert.ok(listed[0]!.question.length <= 4000);
    assert.ok(listed[0]!.question.endsWith(DECISION_QUESTION_CLIP_MARKER), "the clipped view names the marker");
    assert.equal(decisions.get({ id: created.id }).question, listed[0]!.question);
    // The board read validates: the decision list output contract parses.
    decisionList.output.parse(listed);
    // The stored row is never rewritten by the read.
    const reread = JSON.parse(String((store.db.prepare("SELECT data FROM decisions WHERE id=?").get(created.id) as { data: string }).data));
    assert.equal(reread.question, over, "the stored record keeps its full text");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("1141-3 the header's read error renders as plain text naming the read", () => {
  const field = z.object({ question: z.string().trim().min(1).max(4000) });
  let refusal: unknown;
  try { field.parse({ question: "x".repeat(5000) }); assert.fail("the over-long question must refuse"); }
  catch (error) { refusal = error; }
  const oneLine = errorText(refusal);
  assert.match(oneLine, /^question: /);
  assert.doesNotMatch(oneLine, /"origin"/, "never a raw schema dump");
  assert.equal(readErrorText("Decisions", refusal), `Decisions failed to load: ${oneLine}`);
  assert.equal(readErrorText("Board state", new Error("no connection")), "Board state failed to load: no connection");
  // A stored board error may itself be a serialised refusal from before the
  // header formatted refusals; it renders as the same one line.
  const raw = JSON.stringify((refusal as z.ZodError).issues);
  assert.ok(raw.startsWith("["), "the stored shape is the raw issues dump");
  assert.equal(storedBoardErrorText(raw), `Board state needs attention: ${oneLine}`);
  assert.equal(storedBoardErrorText("no connection"), "Board state needs attention: no connection");
});

test("1141-4 the shared helper clips at a word boundary with a marker", () => {
  assert.equal(clipDecisionQuestion("Short?"), "Short?");
  assert.equal(clipDecisionQuestion("x".repeat(4000)).length, 4000, "a question at the limit passes through");
  const words = "word ".repeat(1500);
  const clipped = clipDecisionQuestion(words);
  assert.ok(clipped.length <= 4000);
  assert.ok(clipped.endsWith(`word${DECISION_QUESTION_CLIP_MARKER}`), "the cut lands on a word boundary with a marker");
  const solid = clipDecisionQuestion("x".repeat(5000));
  assert.ok(solid.length <= 4000);
  assert.ok(solid.endsWith(DECISION_QUESTION_CLIP_MARKER), "a wordless run is hard-cut with a marker");
});
