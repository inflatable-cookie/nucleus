import { test } from "node:test";
import assert from "node:assert/strict";
import type { PipelineBoard, PipelineCard } from "../shared/pipeline-board";
import {
  inboxCounts,
  inboxSections,
  inboxViews,
  leadsCards,
  needsCards,
  papercutCards,
} from "../shared/inbox-board";

// Only the columns the inbox reads are filled; the rest stay empty.
const board = (
  cards: Partial<Record<keyof PipelineBoard["cards"], PipelineCard[]>>,
) =>
  ({
    counts: {},
    cards: {
      Triage: [],
      Decisions: [],
      Attention: [],
      Queued: [],
      Working: [],
      Review: [],
      Closing: [],
      ...cards,
    },
  }) as unknown as PipelineBoard;

const lead = (id: string, tags: string[] = []): PipelineCard =>
  ({
    kind: "lead",
    id,
    lanes: [],
    value: { id, title: id, tags },
  }) as unknown as PipelineCard;
const decision = (id: string, createdAt: string): PipelineCard =>
  ({
    kind: "decision",
    id,
    lanes: [],
    value: { id, createdAt },
  }) as unknown as PipelineCard;
const raised = (id: string, since: string | null): PipelineCard =>
  ({
    kind: "raised",
    id,
    lanes: [],
    value: { id, hold: { since } },
  }) as unknown as PipelineCard;
const drained = (
  key: string,
  escalatedAt: string | null,
  since: string,
): PipelineCard =>
  ({
    kind: "lane_drain",
    id: `lane-drain:${key}`,
    lanes: [key],
    value: { key, drain: { escalatedAt, since } },
  }) as unknown as PipelineCard;
const task = (id: string, since: string | null): PipelineCard =>
  ({
    kind: "task",
    id,
    lanes: [],
    value: { id, hold: since === null ? undefined : { since } },
  }) as unknown as PipelineCard;

test("the menu lists Needs you, Planning, Leads, Papercuts, Queue, Working, In review and Closing, with no Active entry", () => {
  assert.deepEqual(
    inboxViews.map((view) => view.id),
    [
      "needs",
      "planning",
      "leads",
      "papercuts",
      "queue",
      "working",
      "review",
      "closing",
    ],
  );
  assert.deepEqual(
    inboxViews.map((view) => view.label),
    [
      "Needs you",
      "Planning",
      "Leads",
      "Papercuts",
      "Queue",
      "Working",
      "In review",
      "Closing",
    ],
  );
  for (const view of inboxViews)
    assert.ok(view.icon, `${view.id} carries its own icon`);
});

test("Working, In review and Closing each list their own column, with their own counts", () => {
  const cards = board({
    Working: [task("working", null)],
    Review: [task("review", null)],
    Closing: [task("closing", null)],
  });
  assert.deepEqual(
    inboxSections(cards, "working").map((section) => section.id),
    ["working"],
  );
  assert.deepEqual(
    inboxSections(cards, "review")[0]!.cards.map((card) => card.id),
    ["review"],
  );
  assert.deepEqual(
    inboxSections(cards, "closing")[0]!.cards.map((card) => card.id),
    ["closing"],
  );
  const counts = inboxCounts(cards);
  assert.equal(counts.working, 1);
  assert.equal(counts.review, 1);
  assert.equal(counts.closing, 1);
  assert.ok(!("active" in counts), "no Active aggregate remains");
});

test("Leads and Papercuts split the Triage column by tag, each with its own total", () => {
  const triage = board({
    Triage: [lead("idea", ["idea"]), lead("cut", ["papercut"]), lead("plain")],
  });
  assert.deepEqual(
    leadsCards(triage).map((card) => card.id),
    ["idea", "plain"],
  );
  assert.deepEqual(
    papercutCards(triage).map((card) => card.id),
    ["cut"],
  );
  const counts = inboxCounts(triage);
  assert.equal(counts.leads, 2);
  assert.equal(counts.papercuts, 1);
  assert.equal(inboxSections(triage, "papercuts")[0]!.label, "Papercuts");
  assert.deepEqual(
    inboxSections(triage, "papercuts")[0]!.cards.map((card) => card.id),
    ["cut"],
  );
});

test("Needs you is one list, newest needing action first, across decisions, holds, lanes and tasks", () => {
  const cards = board({
    Decisions: [
      decision("old-decision", "2026-11-01T00:00:00.000Z"),
      raised("hold", "2026-11-15T00:00:00.000Z"),
      drained("lane", "2026-11-20T00:00:00.000Z", "2026-11-18T00:00:00.000Z"),
    ],
    Attention: [
      task("undated", null),
      task("attention", "2026-11-10T00:00:00.000Z"),
    ],
  });
  assert.deepEqual(
    needsCards(cards).map((card) => card.id),
    ["lane-drain:lane", "hold", "attention", "old-decision", "undated"],
  );
  const [needs] = inboxSections(cards, "needs");
  assert.equal(
    inboxSections(cards, "needs").length,
    1,
    "one section, so no section headers",
  );
  assert.equal(needs!.label, "Needs you");
  assert.equal(inboxCounts(cards).needs, 5);
});

test("a drained lane sorts by its escalation, falling back to when the drain began", () => {
  const cards = board({
    Decisions: [
      drained(
        "escalated",
        "2026-11-21T00:00:00.000Z",
        "2026-11-01T00:00:00.000Z",
      ),
      drained("waiting", null, "2026-11-19T00:00:00.000Z"),
    ],
  });
  assert.deepEqual(
    needsCards(cards).map((card) => card.id),
    ["lane-drain:escalated", "lane-drain:waiting"],
  );
});
