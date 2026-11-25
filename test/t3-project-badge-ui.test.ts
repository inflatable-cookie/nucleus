import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { mount, useNativeStubs, type HostNode } from "./support/render";
import { EngineFeaturesContext, RUST_ENGINE_FEATURES } from "../client/engine-features";
import { generatedProjectBadge, projectBadgeWebForeground } from "../shared/t3/project-badge";
import { taskSummarySchema } from "../shared/contracts";

/**
 * nucleus#1450: a board task card shows the generated T3 project badge in the colours of
 * the surface's mode, and keeps the folder icon when no badge applies. The card is mounted
 * with a schema-checked task summary, as the board renders it.
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
const light = {
  ...dark,
  surface0: "#f6f7f9",
  surface1: "#ffffff",
  foreground: "#15181d",
  foregroundMuted: "#5b6472",
} as const;

function seededSummary(repoPath: string) {
  return taskSummarySchema.parse({
    id: "badge-card",
    title: "Badge card",
    repoPath,
    version: 2,
    hostId: "t3code:env-a",
    number: null,
    reference: null,
    entrypoint: "worker",
    phase: "queued",
    reason: "",
    held: false,
    dependsOn: [],
    queuePriority: 0,
    resolution: {},
  });
}

/** The monogram's text node, and the colour its style resolves to. */
function monogramNode(
  ui: ReturnType<typeof mount>,
  monogram: string,
): HostNode | undefined {
  return ui.ofType("Text").find((node) => node.children.join("") === monogram);
}

test("a matched T3 project shows its monogram in the dark surface's colour", async () => {
  await load();
  const summary = seededSummary("/synthetic/repos/biock-aase");
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
    assert.equal(
      node.props.style.color,
      "rgb(237, 106, 255)",
      "dark surfaces use the converted 400 text value",
    );
    assert.equal(node.props.style.fontFamily, "monospace");
    assert.equal(
      node.props.style.backgroundColor,
      "rgba(237, 106, 255, 0.14)",
      "the tint is the same entry at 14% alpha",
    );
    assert.match(ui.text(), /biock-aase/, "the project name stays the label");
  } finally {
    ui.update(h("View", null));
  }
});

test("a light surface uses the 600 text value for the same badge", async () => {
  await load();
  const summary = seededSummary("/synthetic/repos/biock-aase");
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
    assert.equal(
      node?.props.style.color,
      "rgb(200, 0, 222)",
      "light surfaces use the converted 600 text value",
    );
    assert.equal(
      node?.props.style.backgroundColor,
      "rgba(200, 0, 222, 0.14)",
    );
  } finally {
    ui.update(h("View", null));
  }
});

test("without a badge the card keeps the folder icon and draws no monogram", async () => {
  await load();
  const summary = seededSummary("/synthetic/repos/biock-aase");
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
    assert.equal(
      ui
        .ofType("Text")
        .some(
          (node) =>
            typeof node.props.style?.backgroundColor === "string" &&
            node.props.style.backgroundColor.endsWith(", 0.14)"),
        ),
      false,
      "no badge draws no tint",
    );
    assert.match(ui.text(), /biock-aase/);
  } finally {
    ui.update(h("View", null));
  }
});

const leadCard = (
  id: string,
  title: string,
  tags: string[],
  repositories: Array<{ origin: string; path: string }>,
) => ({
  id,
  title,
  preview: "",
  repositories,
  lanes: [],
  tags,
  papercutArea: tags.includes("papercut") ? "board" : null,
  state: "open" as const,
  version: 1,
  check: null,
  approved: false,
  targets: [],
});

test("lead and papercut cards share TaskCard's badge rendering in dark and light surfaces and keep opening actions", async () => {
  await load();
  const repoPath = "/synthetic/repos/biock-aase";
  const summary = seededSummary(repoPath);
  const repositoryBadges = {
    [repoPath]: { monogram: "BA", color: "fuchsia" },
  } as const;
  const projectForRepository = (path: string) =>
    path === repoPath ? { name: "Biock Aase" } : undefined;

  for (const [surface, expectedColor, expectedBg] of [
    [dark, "rgb(237, 106, 255)", "rgba(237, 106, 255, 0.14)"],
    [light, "rgb(200, 0, 222)", "rgba(200, 0, 222, 0.14)"],
  ] as const) {
    const taskUi = mount(
      h(queue.TaskCard as never, {
        task: summary,
        selected: false,
        onPress: () => {},
        c: surface as never,
        board: true,
        projectBadge: repositoryBadges[repoPath],
      }),
    );
    const taskNode = monogramNode(taskUi, "BA");
    const opened: string[] = [];
    const leadUi = mount(
      h(queue.TriageLeadCard as never, {
        lead: leadCard(
          "lead-1",
          "Lead card",
          [],
          [{ origin: "owner/biock-aase", path: repoPath }],
        ),
        projectForRepository,
        repositoryBadges,
        selected: false,
        c: surface as never,
        onSelectLead: (id: string) => opened.push(`lead:${id}`),
        onSelectPapercut: (id: string) => opened.push(`papercut:${id}`),
      }),
    );
    const cutUi = mount(
      h(queue.TriageLeadCard as never, {
        lead: leadCard(
          "cut-1",
          "Papercut card",
          ["papercut"],
          [{ origin: "owner/biock-aase", path: repoPath }],
        ),
        projectForRepository,
        repositoryBadges,
        selected: false,
        c: surface as never,
        onSelectLead: (id: string) => opened.push(`lead:${id}`),
        onSelectPapercut: (id: string) => opened.push(`papercut:${id}`),
      }),
    );
    try {
      for (const cardUi of [leadUi, cutUi]) {
        const node = monogramNode(cardUi, "BA");
        assert.ok(node, "the monogram is drawn");
        assert.deepEqual(
          node.props.style,
          taskNode?.props.style,
          "lead and papercut share TaskCard's badge style",
        );
        assert.equal(node.props.style.color, expectedColor);
        assert.equal(node.props.style.backgroundColor, expectedBg);
        assert.match(
          cardUi.text(),
          /Biock Aase/,
          "the project name stays visible",
        );
      }
      assert.match(leadUi.text(), /Lead/);
      assert.match(cutUi.text(), /Papercut/);
      leadUi.press(/^Lead: Lead card, Status: Unchecked · awaiting a check$/);
      cutUi.press(/^Papercut: Papercut card, Status: Open · board$/);
      assert.deepEqual(opened, ["lead:lead-1", "papercut:cut-1"]);
    } finally {
      taskUi.update(h("View", null));
      leadUi.update(h("View", null));
      cutUi.update(h("View", null));
    }
  }
});

test("multi-project cards badge only unambiguous projects and never choose a badge by repository order", async () => {
  await load();
  const repoA = { origin: "owner/alpha", path: "/repos/alpha" };
  const repoB = { origin: "owner/beta", path: "/repos/beta" };
  const repoC = { origin: "owner/gamma", path: "/repos/gamma" };
  const projectForRepository = (path: string) =>
    path === repoA.path
      ? { name: "Alpha" }
      : path === repoB.path
        ? { name: "Beta" }
        : { name: "Alpha" };
  const repositoryBadges = {
    [repoA.path]: { monogram: "AL", color: "amber" },
  } as const;

  const forward = mount(
    h(queue.TriageLeadCard as never, {
      lead: leadCard("lead-fwd", "Cross project", [], [repoA, repoB]),
      projectForRepository,
      repositoryBadges,
      selected: false,
      c: dark as never,
      onSelectLead: () => {},
      onSelectPapercut: () => {},
    }),
  );
  const reverse = mount(
    h(queue.TriageLeadCard as never, {
      lead: leadCard("lead-rev", "Cross project", [], [repoB, repoA]),
      projectForRepository,
      repositoryBadges,
      selected: false,
      c: dark as never,
      onSelectLead: () => {},
      onSelectPapercut: () => {},
    }),
  );
  const conflictedSameProject = mount(
    h(queue.TriageLeadCard as never, {
      lead: leadCard("lead-same", "Same project split", [], [repoA, repoC]),
      projectForRepository,
      repositoryBadges,
      selected: false,
      c: dark as never,
      onSelectLead: () => {},
      onSelectPapercut: () => {},
    }),
  );
  try {
    assert.ok(monogramNode(forward, "AL"));
    assert.ok(monogramNode(reverse, "AL"));
    assert.equal(
      forward.ofType("Icon").filter((node) => node.props.name === "Folder")
        .length,
      1,
      "unmatched project keeps folder",
    );
    assert.equal(
      reverse.ofType("Icon").filter((node) => node.props.name === "Folder")
        .length,
      1,
      "repository order never changes badge assignment",
    );
    assert.match(forward.text(), /Alpha,\s*.*Beta/);
    assert.match(reverse.text(), /Beta,\s*.*Alpha/);
    assert.equal(
      monogramNode(conflictedSameProject, "AL"),
      undefined,
      "same project with unmatched sibling repo keeps folder instead of picking by order",
    );
    assert.equal(
      conflictedSameProject
        .ofType("Icon")
        .filter((node) => node.props.name === "Folder").length,
      1,
    );
  } finally {
    forward.update(h("View", null));
    reverse.update(h("View", null));
    conflictedSameProject.update(h("View", null));
  }
});

test("Rust rows use the known project badge when its repository refinements disagree", async () => {
  const { CardProject } = await import("../client/board/cards");
  const { LeadProjectEyebrow } = await import("../client/board/triage-lead-card");
  const repoA = { origin: "owner/alpha", path: "/repos/alpha" };
  const repoB = { origin: "owner/beta", path: "/repos/beta" };
  const project = { key: "build-lab", name: "Build Lab" };
  const expected = generatedProjectBadge(project.name);
  const refined = { monogram: "RT", color: "amber" } as const;
  for (const repositories of [[repoA, repoB], [repoB, repoA], [repoA]]) {
    const ui = mount(h(EngineFeaturesContext.Provider, {
      value: RUST_ENGINE_FEATURES,
      children: h(LeadProjectEyebrow, {
        repositories, c: dark, projectForRepository: () => project,
        repositoryBadges: { [repoA.path]: refined, [repoB.path]: expected },
      }),
    }));
    try {
      const badge = repositories.length === 1 ? refined : expected;
      assert.equal(monogramNode(ui, badge.monogram)?.props.style.color, projectBadgeWebForeground(badge, true));
      assert.ok(!ui.ofType("Icon").some((node) => node.props.name === "Folder"));
    } finally {
      ui.update(h("View", null));
    }
  }
  const ui = mount(h(EngineFeaturesContext.Provider, {
    value: RUST_ENGINE_FEATURES,
    children: h(CardProject, { name: project.name, projectKey: project.key, c: dark }),
  }));
  try {
    assert.equal(monogramNode(ui, expected.monogram)?.props.style.color, projectBadgeWebForeground(expected, true));
  } finally {
    ui.update(h("View", null));
  }
});
