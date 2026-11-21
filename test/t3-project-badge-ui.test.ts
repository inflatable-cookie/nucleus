import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { mount, useNativeStubs, type HostNode } from "./support/render";
import { Store } from "../core/store/store";
import { submissionSchema, summarizeTask, type Task } from "../shared/contracts";

/**
 * nucleus#1450: a board task card shows the generated T3 project badge in the colours of
 * the surface's mode, and keeps the folder icon when no badge applies. The card is mounted
 * from a real stored task summary, as the board renders it.
 * nucleus#1487: the stub style is the browser-safe conversion (sRGB foreground plus the
 * same entry at 14% alpha), because react-native-web drops the pinned `oklch()` and
 * `color-mix()` declarations. The real RN Web emission is covered by
 * `test/t3-project-badge-web.test.ts`.
 */
useNativeStubs();
type QueueModule = typeof import("../client/queue");
let queue: QueueModule;
const load = async () => {
  queue = await import("../client/queue");
  return queue;
};

const h = React.createElement;
const head = "a".repeat(40);
const dark = {
  accent: "#8caaff",
  accentForeground: "#101521",
  surface0: "#111318",
  surface1: "#1a1d24",
  surface2: "#252932",
  border: "#39404b",
  foreground: "#f1f3f5",
  foregroundMuted: "#a5acb8",
  statusSuccess: "#71c99a",
  statusWarning: "#e9bc68",
  statusDanger: "#ef8282",
} as const;
const light = { ...dark, surface0: "#f6f7f9", surface1: "#ffffff", foreground: "#15181d", foregroundMuted: "#5b6472" } as const;

function seededSummary(store: Store, repoPath: string) {
  const inserted = store.insert(
    submissionSchema.parse({
      submissionId: "badge-card",
      title: "Badge card",
      repoPath,
      planningCommit: head,
      handoffPath: "badge-card.md",
      originAgentId: "0b355fd4",
    }),
    "host",
    "handoff",
    head,
  );
  const task: Task = store.update(inserted.id, {
    notificationAgentId: "56e9c969",
    originError: "",
    originLookupError: "",
    phase: "queued",
  });
  // The host is the summary's own field: a T3 task's identity, as the board reads it.
  return { ...summarizeTask(task), hostId: "t3code:env-a" };
}

/** The monogram's text node, and the colour its style resolves to. */
function monogramNode(ui: ReturnType<typeof mount>, monogram: string): HostNode | undefined {
  return ui.ofType("Text").find((node) => node.children.join("") === monogram);
}

test("a matched T3 project shows its monogram in the dark surface's colour", async () => {
  await load();
  const store = new Store(":memory:");
  try {
    const summary = seededSummary(store, "/synthetic/repos/biock-aase");
    const ui = mount(
      h(queue.TaskCard as never, {
        task: summary,
        selected: false,
        onPress: () => {},
        c: dark as never,
        board: true,
        projectBadge: { monogram: "BA", color: "fuchsia" },
      }),
    );
    try {
      const node = monogramNode(ui, "BA");
      assert.ok(node, "the monogram is drawn");
      assert.equal(node.props.style.color, "rgb(237, 106, 255)", "dark surfaces use the converted 400 text value");
      assert.equal(node.props.style.fontFamily, "monospace");
      assert.equal(node.props.style.backgroundColor, "rgba(237, 106, 255, 0.14)", "the tint is the same entry at 14% alpha");
      assert.match(ui.text(), /biock-aase/, "the project name stays the label");
    } finally {
      ui.update(h("View", null));
    }
  } finally {
    store.close();
  }
});

test("a light surface uses the 600 text value for the same badge", async () => {
  await load();
  const store = new Store(":memory:");
  try {
    const summary = seededSummary(store, "/synthetic/repos/biock-aase");
    const ui = mount(
      h(queue.TaskCard as never, {
        task: summary,
        selected: false,
        onPress: () => {},
        c: light as never,
        board: true,
        projectBadge: { monogram: "BA", color: "fuchsia" },
      }),
    );
    try {
      const node = monogramNode(ui, "BA");
      assert.equal(node?.props.style.color, "rgb(200, 0, 222)", "light surfaces use the converted 600 text value");
      assert.equal(node?.props.style.backgroundColor, "rgba(200, 0, 222, 0.14)");
    } finally {
      ui.update(h("View", null));
    }
  } finally {
    store.close();
  }
});

test("without a badge the card keeps the folder icon and draws no monogram", async () => {
  await load();
  const store = new Store(":memory:");
  try {
    const summary = seededSummary(store, "/synthetic/repos/biock-aase");
    const ui = mount(
      h(queue.TaskCard as never, {
        task: summary,
        selected: false,
        onPress: () => {},
        c: dark as never,
        board: true,
      }),
    );
    try {
      assert.equal(monogramNode(ui, "BA"), undefined);
      assert.equal(ui.ofType("Text").some((node) => typeof node.props.style?.backgroundColor === "string" && node.props.style.backgroundColor.endsWith(", 0.14)")), false, "no badge draws no tint");
      assert.match(ui.text(), /biock-aase/);
    } finally {
      ui.update(h("View", null));
    }
  } finally {
    store.close();
  }
});
