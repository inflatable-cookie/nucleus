/**
 * The Rust task view (Spec 071) mounted on the board's own Rust transport, once per
 * state in the approved mockup. Each fixture is the engine's serialized task detail,
 * next view and history, so the schema, the timeline reading and the actions are
 * exercised together. Each state asserts the attention panel, the timeline segments
 * and the available actions.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mount, useNativeStubs } from "./support/render";
import { waitFor } from "./support/budgets";

import {
  HOUR, MINUTE, card, engineTask, head, mergeCommit, now, prUrl, pushed, review, steps, work,
  type Fixture, type Step,
} from "./support/rust-task-detail-fixtures";

const responses = new Map<string, unknown>();
const posts: Array<{ path: string; command: unknown }> = [];
// The board's module transport reads the global fetch when it loads.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input).replace(/^\/api\/engine/, "");
  if (init?.method === "POST") {
    posts.push({ path, command: JSON.parse(String(init.body)) });
    return Response.json({ status: "pending", version: 7 }, { status: 202 });
  }
  const key = path.replace(/\?.*$/, "");
  if (!responses.has(key)) return Response.json({ error: "missing" }, { status: 404 });
  return Response.json(responses.get(key));
}) as typeof fetch;

let dialog: Promise<typeof import("../client/task/rust-task")> | undefined;
const load = () => {
  if (!dialog) {
    useNativeStubs();
    dialog = import("../client/task/rust-task");
  }
  return dialog;
};
const colors = {
  accent: "#346cf1", accentForeground: "#ffffff", surface0: "#000000", surface1: "#111111", surface2: "#1c1c1c",
  border: "#333333", foreground: "#f5f5f5", foregroundMuted: "#818181", foregroundLabel: "#8f8f8f",
  statusSuccess: "#19bc7d", statusWarning: "#e8a33d", statusDanger: "#ef5b5b",
} as never;

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

async function open(id: string, fixture: Fixture) {
  const { RustTaskDialog } = await load();
  const { detail, next, history } = engineTask(id, fixture);
  responses.set(`/tasks/${id}`, detail);
  responses.set(`/tasks/${id}/next`, next);
  responses.set(`/tasks/${id}/history`, history);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const h = React.createElement;
  const ui = mount(
    h(QueryClientProvider, {
      client,
      children: h(RustTaskDialog, {
        id,
        summary: undefined,
        project: () => ({ name: "Board Fixture", key: "board-fixture", badge: null }),
        inline: true,
        c: colors,
        onClose: () => {},
        invalidate: () => {},
      }),
    }),
  );
  mounted.push(() => {
    ui.update(h(React.Fragment));
    client.clear();
  });
  await waitFor(() => Boolean(ui.query("Progress")) && !ui.text().includes("Loading task"), 5000, `${id} loads`);
  await waitFor(() => Boolean(ui.query(/^Step /)) && (fixture.commands.length === 0 || Boolean(ui.query("Brief, collapsed") || ui.query("Brief, expanded"))), 5000, `${id} settles`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { ui, client, detail };
}

const segments = (ui: ReturnType<typeof mount>) =>
  ui.all(/^(Queued|Working|Review|Merge|Close)( round \d+)? · /).map((node) => node.props.accessibilityLabel as string);
const panel = (ui: ReturnType<typeof mount>) =>
  ["Planner question", "Your decision", "Needs attention", "Held", "Report ready"].filter((name) => ui.query(name));
const actions = (ui: ReturnType<typeof mount>) =>
  ["Promoted", "Hold", "Move, Move", "Cancel", "Recheck", "Release", "Amend", "Open answer"].filter((name) => ui.query(name));

const done = (key: string, entered: number, left: number): Step => ({ key, state: "done", visits: [{ enteredAtMs: entered, leftAtMs: left }] });
const baseCommands = [
  { name: "cancel", preflight: "ready" },
  { name: "amend", preflight: "ready" },
  { name: "hold", preflight: "ready" },
  { name: "move", phase: "reviewing", preflight: "pending" },
  { name: "set_dependencies", preflight: "unavailable" },
  { name: "set_prerequisite_wait", preflight: "unavailable" },
];

test("working: no panel, a live round, the worker's activity and routine actions", async () => {
  const { ui } = await open("working", {
    phase: "working", stateLabel: "Working", attention: "active",
    steps: steps(
      done("queued", now - 18 * HOUR, now - 51 * MINUTE),
      { key: "working", state: "current", activeSinceMs: now - 51 * MINUTE, visits: [{ enteredAtMs: now - 51 * MINUTE, leftAtMs: null }] },
      { key: "review", state: "todo" }, { key: "merge", state: "todo" }, { key: "close", state: "todo" },
    ),
    cards: [card("worker", 1, { startedAtMs: now - 51 * MINUTE, ended: false, activity: "Running engine tests" })],
    run: {
      role: "worker", thread: "worker-thread", instance: "task-fixture-run-worker-1", purpose: "Move lesson exports",
      reservedAt: now - 51 * MINUTE, lastSendAt: now - 51 * MINUTE, reviewHead: null, reported: false, revoked: false,
      activity: { label: "Running engine tests", startedAt: now - 2 * MINUTE },
    },
    commands: baseCommands,
  });
  assert.deepEqual(panel(ui), []);
  assert.deepEqual(segments(ui), [
    "Queued · complete",
    "Working round 1 · in progress",
    "Review · not started", "Merge · not started", "Close · not started",
  ]);
  assert.match(ui.get(/^Step Queued:/).props.accessibilityLabel, /^Step Queued: done · 17h 9m$/);
  assert.match(ui.get(/^Step Working:/).props.accessibilityLabel, /^Step Working: current · 5[01]m \d+s$/);
  assert.match(ui.text(), /Running engine tests/);
  assert.match(ui.text(), /fixture-worker-model/);
  assert.match(ui.text(), /51m \/ 3h/);
  assert.ok(ui.query("Open worker thread"), "the role links its thread");
  assert.doesNotMatch(ui.text(), /worker-thread|codex-fixture/, "no raw thread IDs or host internals");
  assert.deepEqual(actions(ui), ["Hold", "Move, Move", "Cancel", "Amend"]);
  assert.match(ui.text(), /board-fixture#233/);
  assert.match(ui.text(), /Fixture task working/);
  assert.ok(ui.query("State: Working"), "status sits under the title");
});

test("planner question: a warning panel with the Answer form collapsed, then answered", async () => {
  const question = { work: { prompt: "Delete the v1 importer now, or keep it behind a flag?", options: ["Delete it now", "Keep it behind the flag"] } };
  const { ui } = await open("question", {
    phase: "working", stateLabel: "Working · planner", attention: "attention", wait: "question",
    stateSinceMs: now - 14 * MINUTE, question,
    steps: steps(
      done("queued", now - 3 * HOUR, now - 2 * HOUR - 4 * MINUTE),
      { key: "working", state: "current", tone: "warning", elapsedMs: 110 * MINUTE },
      { key: "review", state: "todo" }, { key: "merge", state: "todo" }, { key: "close", state: "todo" },
    ),
    cards: [card("worker", 1, {
      startedAtMs: now - 124 * MINUTE, endedAtMs: now - 14 * MINUTE, elapsedMs: 110 * MINUTE,
      outcome: { kind: "question", question },
    })],
    commands: [...baseCommands, { name: "answer", preflight: "ready" }],
    history: [{ sequence: 4, content: { at: now - 14 * MINUTE }, presentation: [{ kind: "question", question }] }],
  });
  assert.deepEqual(panel(ui), ["Planner question"]);
  assert.match(ui.text(), /Delete the v1 importer now/);
  assert.deepEqual(segments(ui).slice(1, 2), ["Working round 1 · asked a question"]);
  assert.match(ui.get(/^Step Working:/).props.accessibilityLabel, /^Step Working: current · waiting 14m \d+s · 1h 50m$/);
  assert.deepEqual(actions(ui), ["Hold", "Move, Move", "Cancel", "Amend", "Open answer"]);
  assert.equal(ui.query("Option, Option"), undefined, "the form starts collapsed");
  assert.ok(ui.query("Activity, collapsed"), "activity collapses while someone must act");

  ui.press("Open answer");
  ui.press("Option, Option");
  ui.press("Option: Keep it behind the flag");
  ui.press("Answer");
  await waitFor(() => posts.some(({ path }) => path === "/tasks/question/commands"), 5000, "answer posted");
  assert.deepEqual(posts.find(({ path }) => path === "/tasks/question/commands")?.command, {
    answer: { work: "Keep it behind the flag" },
  });
});

test("changes on round 2: Review stays lit amber, the PR card shows the latest findings", async () => {
  const { ui } = await open("changes", {
    phase: "working", stateLabel: "Changes", attention: "active", reviewRound: 2,
    steps: steps(
      done("queued", now - 9 * HOUR, now - 9 * HOUR + 7 * MINUTE),
      {
        key: "working", state: "current", activeSinceMs: now - 12 * MINUTE,
        visits: [{ enteredAtMs: now - 9 * HOUR, leftAtMs: now - 6 * HOUR }, { enteredAtMs: now - 12 * MINUTE, leftAtMs: null }],
      },
      { key: "review", state: "todo" }, { key: "merge", state: "todo" }, { key: "close", state: "todo" },
    ),
    cards: [
      card("worker", 1, { startedAtMs: now - 9 * HOUR, endedAtMs: now - 7 * HOUR, elapsedMs: 132 * MINUTE, outcome: work(false) }),
      card("reviewer", 1, { startedAtMs: now - 7 * HOUR, endedAtMs: now - 6 * HOUR, elapsedMs: 41 * MINUTE,
        outcome: review("changes", "Stored export jobs have no migration.", ["No migration for stored export jobs"]) }),
      card("worker", 2, { startedAtMs: now - 3 * HOUR, endedAtMs: now - 2 * HOUR, elapsedMs: 48 * MINUTE, outcome: work(true) }),
      card("reviewer", 2, { startedAtMs: now - HOUR, endedAtMs: now - 20 * MINUTE, elapsedMs: 37 * MINUTE,
        outcome: review("changes", "The retry path still writes the legacy header.", [
          "Retry path still writes the legacy header", "Envelope size guard measures characters, not bytes",
        ]) }),
      card("worker", 3, { startedAtMs: now - 12 * MINUTE, ended: false }),
    ],
    pullRequest: { url: prUrl, head: pushed },
    verdict: { reviewed: { head: pushed, decision: "changes", summary: "The retry path still writes the legacy header." } },
    allowance: { usedMs: 182 * MINUTE, limitMs: 4 * HOUR, exhausted: false },
    commands: baseCommands,
  });
  assert.deepEqual(panel(ui), []);
  assert.deepEqual(segments(ui), [
    "Queued · complete",
    "Working round 1 · work submitted",
    "Working round 2 · revision pushed",
    "Working round 3 · in progress",
    "Review round 1 · changes requested",
    "Review round 2 · changes requested",
    "Merge · not started", "Close · not started",
  ]);
  assert.match(ui.get(/^Step Working:/).props.accessibilityLabel, /^Step Working: current · Round 3 · 1[12]m \d+s$/);
  assert.equal(ui.get(/^Step Review:/).props.accessibilityLabel, "Step Review: done · Round 2 · 1h 18m");
  assert.match(ui.text(), /PR #233/);
  assert.match(ui.text(), /Changes requested/);
  assert.match(ui.text(), /Envelope size guard measures characters, not bytes/);
  assert.ok(ui.query("Round 1 · changes requested"), "earlier rounds sit collapsed");
  assert.doesNotMatch(ui.text(), /No migration for stored export jobs/);
  assert.ok(ui.query("Open reviewer thread"));
  assert.deepEqual(actions(ui), ["Hold", "Move, Move", "Cancel", "Amend"]);
});

test("merging with checks pending: a drifting merge step and the wait line, no panel", async () => {
  const { ui } = await open("merging", {
    phase: "merging", stateLabel: "Merging · checks", attention: "waiting", wait: "checks",
    waitDetail: "Waiting for required checks.", nextCheckAt: now + 4 * MINUTE,
    steps: steps(
      done("queued", now - HOUR, now - 58 * MINUTE),
      { key: "working", state: "done", elapsedMs: 46 * MINUTE },
      { key: "review", state: "done", elapsedMs: 21 * MINUTE },
      { key: "merge", state: "current", visits: [{ enteredAtMs: now - 8 * MINUTE, leftAtMs: null }] },
      { key: "close", state: "todo" },
    ),
    cards: [
      card("worker", 1, { elapsedMs: 46 * MINUTE, outcome: work(false) }),
      card("reviewer", 1, { elapsedMs: 21 * MINUTE, outcome: review("approve", "Pins the wire and updates both call sites.") }),
    ],
    pullRequest: { url: prUrl, head },
    verdict: { reviewed: { head, decision: "approve", summary: "Pins the wire and updates both call sites." } },
    commands: baseCommands.filter(({ name }) => name !== "amend"),
  });
  assert.deepEqual(panel(ui), []);
  assert.deepEqual(segments(ui), [
    "Queued · complete", "Working round 1 · work submitted", "Review round 1 · approved",
    "Merge · in progress", "Close · not started",
  ]);
  assert.match(ui.get(/^Step Merge:/).props.accessibilityLabel, /^Step Merge: current · [78]m \d+s$/);
  assert.match(ui.text(), /Waiting for required checks\./);
  assert.match(ui.text(), /Next check/);
  assert.match(ui.text(), /Approved/);
  assert.deepEqual(actions(ui), ["Hold", "Move, Move", "Cancel"]);
});

test("done: the merged PR comes first, steps are complete and there is no footer", async () => {
  const finished = now - 2 * HOUR;
  const { ui } = await open("done", {
    phase: "done", stateLabel: "Done", attention: "finished", finishedAtMs: finished, stateSinceMs: finished,
    steps: steps(
      done("queued", now - 5 * HOUR, now - 5 * HOUR + 22 * MINUTE),
      { key: "working", state: "done", elapsedMs: 91 * MINUTE },
      { key: "review", state: "done", elapsedMs: 52 * MINUTE },
      done("merge", finished - 9 * MINUTE, finished - 6 * MINUTE),
      // A pre-1601 close: its entry time was never recorded.
      { key: "close", state: "done", visits: [{ enteredAtMs: null, leftAtMs: finished }] },
    ),
    cards: [
      card("worker", 1, { elapsedMs: 60 * MINUTE, outcome: work(false) }),
      card("reviewer", 1, { elapsedMs: 30 * MINUTE, outcome: review("changes", "", ["Settings migration leaves the old key readable"]) }),
      card("worker", 2, { elapsedMs: 31 * MINUTE, outcome: work(true) }),
      card("reviewer", 2, { elapsedMs: 22 * MINUTE, outcome: review("approve", "The command and its migrations are gone.") }),
    ],
    pullRequest: { url: prUrl, head },
    verdict: { reviewed: { head, decision: "approve", summary: "The command and its migrations are gone." } },
    commands: [],
    history: [
      { sequence: 9, content: { at: finished }, presentation: [{ kind: "finished", phase: "done" }] },
      { sequence: 8, content: { at: finished - 6 * MINUTE }, presentation: [{ kind: "merged", commit: mergeCommit }] },
    ],
  });
  await waitFor(() => ui.text().includes(mergeCommit.slice(0, 7)), 5000, "merge commit from history");
  assert.deepEqual(panel(ui), []);
  assert.deepEqual(segments(ui), [
    "Queued · complete",
    "Working round 1 · work submitted", "Working round 2 · revision pushed",
    "Review round 1 · changes requested", "Review round 2 · approved",
    "Merge · complete", "Close · complete",
  ]);
  assert.equal(ui.get(/^Step Close:/).props.accessibilityLabel, "Step Close: done", "an unrecorded time stays unknown");
  assert.equal(ui.get(/^Step Review:/).props.accessibilityLabel, "Step Review: done · Round 2 · 52m");
  assert.match(ui.text(), /Merged/);
  assert.match(ui.text(), /Approved · round 2/);
  assert.deepEqual(actions(ui), []);
  const order = ui.all(/^(Pull request|Progress)$/).map((node) => node.props.accessibilityLabel);
  assert.deepEqual(order, ["Pull request", "Progress"]);
});

test("blocked with Recheck: a danger panel leads with Recheck, which posts the version", async () => {
  const { ui } = await open("blocked", {
    phase: "merging", stateLabel: "Merging · planner", attention: "attention", wait: "question",
    waitDetail: "Required check “e2e” failed.", stateSinceMs: now - 47 * MINUTE,
    question: { repair: "merge_blocked" },
    steps: steps(
      done("queued", now - 5 * HOUR, now - 5 * HOUR + 3 * MINUTE),
      { key: "working", state: "done", elapsedMs: 160 * MINUTE },
      { key: "review", state: "done", elapsedMs: 29 * MINUTE },
      { key: "merge", state: "current", tone: "danger", visits: [{ enteredAtMs: now - HOUR, leftAtMs: null }] },
      { key: "close", state: "todo" },
    ),
    cards: [
      card("worker", 1, { elapsedMs: 160 * MINUTE, outcome: work(false) }),
      card("reviewer", 1, { elapsedMs: 29 * MINUTE, outcome: review("approve", "Drops the endpoint.") }),
    ],
    pullRequest: { url: prUrl, head },
    verdict: { reviewed: { head, decision: "approve", summary: "Drops the endpoint." } },
    commands: [...baseCommands, { name: "recheck", preflight: "ready" }, { name: "answer", preflight: "ready" }],
  });
  assert.deepEqual(panel(ui), ["Needs attention"]);
  assert.match(ui.text(), /GitHub is blocking the merge\./);
  assert.match(ui.text(), /Required check “e2e” failed\./);
  assert.deepEqual(segments(ui).slice(3, 4), ["Merge · in progress"]);
  assert.match(ui.get(/^Step Merge:/).props.accessibilityLabel, /^Step Merge: current · blocked · 4[78]m \d+s$/);
  assert.deepEqual(actions(ui), ["Hold", "Move, Move", "Cancel", "Recheck", "Amend", "Open answer"]);
  assert.ok(ui.query("Open pull request"));
  ui.press("Recheck");
  await waitFor(() => posts.some(({ path }) => path === "/tasks/blocked/commands"), 5000, "recheck posted");
  assert.deepEqual(posts.find(({ path }) => path === "/tasks/blocked/commands")?.command, { recheck: 7 });
});

test("queued on a prerequisite: the prerequisites, Promoted, and Cancel asks first", async () => {
  const { ui } = await open("queued", {
    phase: "queued", stateLabel: "Queued · prerequisite", attention: "waiting", wait: "prerequisite",
    steps: steps(
      { key: "queued", state: "current", visits: [{ enteredAtMs: now - 26 * HOUR, leftAtMs: null }] },
      { key: "working", state: "todo" }, { key: "review", state: "todo" }, { key: "merge", state: "todo" }, { key: "close", state: "todo" },
    ),
    dependencies: [
      { taskId: "t-pin", reference: "board-fixture#87", title: "Pin the publishing wire", phase: "merging", status: "pending" },
      { taskId: "t-cut", reference: "silo#41", title: "Cut the release", phase: "done", status: "satisfied" },
    ],
    commands: [
      { name: "cancel", preflight: "ready" }, { name: "amend", preflight: "ready" }, { name: "hold", preflight: "ready" },
      { name: "promote", preflight: "ready" },
      { name: "set_dependencies", preflight: "ready" }, { name: "set_prerequisite_wait", preflight: "unavailable" },
    ],
  });
  assert.deepEqual(panel(ui), []);
  assert.deepEqual(segments(ui), [
    "Queued · in progress", "Working · not started", "Review · not started", "Merge · not started", "Close · not started",
  ]);
  assert.match(ui.get(/^Step Queued:/).props.accessibilityLabel, /^Step Queued: current · 1d 2h$/);
  assert.match(ui.text(), /board-fixture#87.*Pin the publishing wire.*Merging/);
  assert.match(ui.text(), /silo#41.*Cut the release.*Done/);
  assert.ok(ui.query("Edit prerequisites"));
  assert.deepEqual(actions(ui), ["Promoted", "Hold", "Cancel", "Amend"]);
  ui.press("Cancel");
  assert.match(ui.text(), /Cancel this task\?/);
  assert.equal(posts.filter(({ path }) => path === "/tasks/queued/commands").length, 0, "Cancel asks first");
  ui.press("Cancel task");
  await waitFor(() => posts.some(({ path }) => path === "/tasks/queued/commands"), 5000, "cancel posted");
  assert.deepEqual(posts.find(({ path }) => path === "/tasks/queued/commands")?.command, "cancel");
});

test("every history record kind renders, and an unknown one is skipped", async () => {
  const at = (minutes: number) => ({ at: now - minutes * MINUTE });
  const { ui } = await open("history", {
    phase: "done", stateLabel: "Done", attention: "finished", finishedAtMs: now,
    steps: steps(
      { key: "queued", state: "done" }, { key: "working", state: "done" }, { key: "review", state: "done" },
      { key: "merge", state: "done" }, { key: "close", state: "done" },
    ),
    commands: [],
    history: [
      { sequence: 9, content: at(1), presentation: [{ kind: "finished", phase: "done" }, { kind: "future_board_record", instance: "x" }] },
      { sequence: 8, content: at(2), presentation: [{ kind: "merged", commit: mergeCommit }] },
      { sequence: 7, content: at(3), presentation: [{ kind: "verdict", verdict: { accepted: { head, acceptance: { reason: "Merged by hand" } } } }] },
      { sequence: 6, content: at(4), presentation: [
        { kind: "run_reported", instance: "r1", sentAtMs: now - 4 * MINUTE, outcome: review("approve", "Fine", []) },
        { kind: "verdict", verdict: { reviewed: { head, decision: "approve", summary: "Fine" } } },
        { kind: "run_ended", instance: "r1" },
      ] },
      { sequence: 5, content: at(5), presentation: [
        { kind: "run_reported", instance: "w1", sentAtMs: now - 5 * MINUTE, outcome: { kind: "blocked", reason: "Tests failed" } },
        { kind: "run_reported", instance: "w1", sentAtMs: now - 5 * MINUTE, outcome: { kind: "report", summary: "Done" } },
        { kind: "run_reported", instance: "w1", sentAtMs: now - 5 * MINUTE, outcome: { kind: "future_outcome" } },
      ] },
      { sequence: 4, content: at(6), presentation: [{ kind: "pull_request", url: prUrl }, { kind: "question", question: { retry: { role: "worker" } } }] },
      { sequence: 3, content: at(7), presentation: [
        { kind: "run_routing", instance: "w1", providerInstance: "codex-fixture", provider: "codex", model: "fixture-worker-model" },
        { kind: "run_started", instance: "w1", role: "worker", purpose: "Fixture", reviewHead: null, model: "fixture-worker-model", round: 2 },
      ] },
    ],
  });
  await waitFor(() => Boolean(ui.query("More activity")), 5000, "history renders");
  ui.press("More activity");
  for (const text of [
    "Done", "Merged", "External merge accepted", "Approved", "Run could not finish", "Tests failed",
    "Report delivered", "Pull request opened", "Question asked", "Worker started round 2",
  ]) assert.match(ui.text(), new RegExp(text));
  assert.equal(ui.text().match(/Approved/g)?.length, 1, "a review outcome and its verdict show once");
  assert.doesNotMatch(ui.text(), /invalid response|future_|codex-fixture/);
});
