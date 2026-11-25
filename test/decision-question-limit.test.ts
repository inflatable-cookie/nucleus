import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { DECISION_QUESTION_CLIP_MARKER, clipDecisionQuestion } from "../shared/contracts";
import { errorText, readErrorText, storedBoardErrorText } from "../client/error-text";

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
