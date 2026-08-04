import { describe, expect, test } from "bun:test";
import { mergePreparedReworkDraft, REVIEW_REWORK_PROMPT } from "./reviewRework";

describe("review rework composer handoff", () => {
  test("prepares the bounded prompt in an empty composer", () => {
    expect(mergePreparedReworkDraft("", REVIEW_REWORK_PROMPT)).toBe(REVIEW_REWORK_PROMPT);
  });

  test("preserves an existing draft", () => {
    expect(mergePreparedReworkDraft("Keep this context", REVIEW_REWORK_PROMPT)).toBe(
      `Keep this context\n\n${REVIEW_REWORK_PROMPT}`,
    );
  });

  test("does not rewrite existing draft whitespace", () => {
    expect(mergePreparedReworkDraft("Keep this context  ", REVIEW_REWORK_PROMPT)).toBe(
      `Keep this context  \n\n${REVIEW_REWORK_PROMPT}`,
    );
  });

  test("does not append the same request twice", () => {
    const draft = `Existing context\n\n${REVIEW_REWORK_PROMPT}`;
    expect(mergePreparedReworkDraft(draft, REVIEW_REWORK_PROMPT)).toBe(draft);
  });
});
