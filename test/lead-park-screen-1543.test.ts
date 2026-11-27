import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { mount, useNativeStubs } from "./support/render";
import type { LeadDetail } from "../shared/contracts";
import { leadActionHints } from "./support/lead-actions";
import type { LeadActions } from "../client/lead-screen";

/** Nucleus#1543: the lead screen shows a park's reason and recheck day, and Park and Unpark call their actions. */
useNativeStubs();
const h = React.createElement;
const c = new Proxy({}, { get: () => "#000" }) as never;
const settle = () => new Promise((resolve) => setImmediate(resolve));
const repo = { origin: "owner/alpha", path: "/alpha" };

type LeadPatch = Omit<Partial<LeadDetail>, "actions"> & {
  actions?: Partial<LeadDetail["actions"]>;
};

function lead({ actions, ...over }: LeadPatch = {}): LeadDetail {
  const base = {
    id: "3d55a901-0000-0000-0000-000000000000",
    title: "Open the T3 Inbox board in the maximized right panel",
    body: "Open the board in the right panel.",
    repositories: [repo],
    lanes: [],
    tags: [],
    papercut: null,
    closure: null,
    author: "agent-1",
    state: "open",
    version: 4,
    digest: undefined,
    check: null,
    checkOperationId: null,
    approval: null,
    baseBranch: "main",
    dropReason: null,
    reopens: [],
    targets: [],
    source: null,
    parked: null,
    recheck: null,
    createdAt: "2026-11-06T08:00:00Z",
    updatedAt: "2026-11-06T09:00:00Z",
    closedAt: null,
    promotedTaskId: null,
    versions: [],
    ...over,
  } as unknown as LeadDetail;
  return {
    ...base,
    actions: leadActionHints(base.repositories, {
      check: "Lead has no brief to check",
      approve: "Lead has no brief to approve",
      ...actions,
    }),
  };
}

async function mountLead(detail: LeadDetail) {
  const { LeadScreen } = await import("../client/lead-screen");
  const calls: string[] = [];
  const actions: LeadActions = {
    onPromote: async () => "Promoted",
    onDrop: async () => "Dropped.",
    onReopen: async () => {
      calls.push("reopen");
      return "Reopened.";
    },
    onPark: async (reason, revisitAt) => {
      calls.push(`park:${reason}:${revisitAt === null ? "none" : "dated"}`);
      return "Parked.";
    },
    onPromoteTo: async () => "Recorded.",
  };
  const ui = mount(
    h(LeadScreen, {
      read: { data: detail },
      actions,
      readVersion: async () => null,
      compact: false,
      busy: false,
      c,
      onRetry: () => undefined,
    }),
  );
  return { ui, calls };
}

test("1543-9 a parked lead shows its reason and recheck day, and Reopen returns it", async () => {
  const revisitAt = new Date(Date.now() + 86_400_000).toISOString();
  const { ui, calls } = await mountLead(
    lead({
      actions: { reopen: null },
      parked: {
        reason: "Waits on a T3 capability",
        revisitAt,
        by: "planner",
        at: "2026-11-22T09:00:00Z",
      },
    }),
  );
  assert.match(ui.text(), /Parked · Waits on a T3 capability · check again /);
  ui.press("Return the lead to the to-do list");
  await settle();
  assert.deepEqual(calls, ["reopen"]);
});

test("1543-10 a due recheck names its reason; Park is refused for a day that is not after today", async () => {
  const { ui, calls } = await mountLead(
    lead({
      recheck: {
        reason: "Waits on a T3 capability",
        at: "2026-11-22T09:00:00Z",
      },
    }),
  );
  assert.match(ui.text(), /Due for a recheck · Waits on a T3 capability/);
  ui.press("More actions");
  ui.type("Park reason", "Still waiting");
  ui.type("Check again on", "2020-01-01");
  assert.equal(
    ui.get("Park the lead").props.disabled,
    true,
    "a past day is refused before anything is sent",
  );
  ui.type("Check again on", "");
  assert.equal(
    ui.get("Park the lead").props.disabled,
    false,
    "a blank day parks with no date",
  );
  ui.press("Park the lead");
  await settle();
  assert.deepEqual(calls, ["park:Still waiting:none"]);
});

test("a past revisit date shows as due while the item remains parked", async () => {
  const { ui } = await mountLead(
    lead({
      actions: { reopen: null },
      parked: {
        reason: "Waiting",
        revisitAt: "2020-01-01T09:00:00Z",
        by: "planner",
        at: "2019-01-01T09:00:00Z",
      },
    }),
  );
  assert.match(ui.text(), /Parked · Waiting · revisit due/);
  assert.ok(ui.query("Return the lead to the to-do list"));
});
