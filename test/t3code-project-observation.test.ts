import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { RuntimeBoard } from "../core/runtime/board";
import { Decisions } from "../core/planning/decisions";
import { Store } from "../core/store/store";
import { createTaskDetailCache } from "../core/telemetry/task-detail";
import { createUiSnapshotFactsCache } from "../core/telemetry/ui-snapshot";
import { submissionSchema } from "../shared/contracts";
import {
  matchProjectBadges,
  projectBadgeFor,
  type ProjectObservation,
} from "../shared/t3/project-badge";
import { t3Fake } from "./support/t3code-fake";

/**
 * nucleus#1450: the T3 host's project observation is its last synchronized shell read.
 * The board's generated badges read it without any host call of their own, so the
 * observation must keep the project fields the badge rules use (icon metadata, favicon,
 * the workspace root that identifies the repository), and be absent before any read.
 */
test("the host's observation is its last shell read, and carries the icon fields the badges need", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "t3code-observe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  const host = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(root, "state.json"),
    timeoutMs: 1_000,
    probeThreadId: "synthetic-probe",
    acp: () => null,
    reentryTimeoutMs: 300,
  });
  t.after(() => host.close());
  assert.equal(
    host.projectObservation(),
    null,
    "no read yet, so no observation",
  );
  await host.connect();

  const primaryRoot = join(directory, "biock-aase");
  server.projects.push(
    {
      id: "primary",
      title: "Biock Aase",
      workspaceRoot: primaryRoot,
      projectIcon: { kind: "monogram", text: "BX", color: "teal" },
      faviconPath: null,
    },
    {
      id: "favicon-only",
      title: "Icon Project",
      workspaceRoot: join(directory, "icon-project"),
      projectIcon: null,
      faviconPath: "assets/favicon.svg",
    },
  );
  await host.reads.shell();

  const observed = host.projectObservation();
  assert.ok(observed, "the shell read is the observation");
  const primary = observed.find((project) => project.id === "primary");
  assert.ok(primary);
  assert.equal(primary.workspaceRoot, primaryRoot);
  assert.deepEqual(primary.projectIcon, {
    kind: "monogram",
    text: "BX",
    color: "teal",
  });
  assert.equal(
    projectBadgeFor(primary)?.monogram,
    "BX",
    "T3's own monogram is reused",
  );
  const favicon = observed.find((project) => project.id === "favicon-only");
  assert.ok(favicon);
  assert.equal(
    projectBadgeFor(favicon),
    null,
    "a favicon keeps the normal label",
  );

  const badges = matchProjectBadges({
    tasks: [{ hostId: host.hostId, repoPath: primaryRoot }],
    observations: [{ hostId: host.hostId, projects: observed }],
  });
  assert.deepEqual(badges[host.hostId]?.[primaryRoot], {
    monogram: "BX",
    color: "teal",
  });
});

test("RuntimeBoard.uiSnapshot populates repositoryBadges for lead-only and papercut-only repos without dispatch default or other-host leaks", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "t3code-board-badges-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const realRoot = await realpath(root);
  const leadReal = join(realRoot, "lead-real");
  const leadLink = join(realRoot, "lead-link");
  const cutReal = join(realRoot, "cut-real");
  const paseoOnly = join(realRoot, "paseo-only");
  const ambiguousRepo = join(realRoot, "ambig-repo");
  for (const dir of [leadReal, cutReal, paseoOnly, ambiguousRepo])
    mkdirSync(dir);
  symlinkSync(leadReal, leadLink);

  const store = new Store(":memory:");
  t.after(() => store.close());
  store.setMeta("operatorDefaultHostKind", "paseo");
  const stamp = "2026-11-20T00:00:00.000Z";

  // Lead-only repository (symlinked path) and papercut-only repository (no tasks in either).
  store.addLead(
    {
      id: "lead-only",
      title: "Lead without tasks",
      body: "Details",
      repositories: [{ origin: "org/lead-only", path: leadLink }],
      lanes: [],
      tags: [],
      author: "operator",
      state: "open",
      version: 1,
      dropReason: null,
      targets: [],
      source: null,
      createdAt: stamp,
      updatedAt: stamp,
      closedAt: null,
    },
    "operator",
  );
  store.addPapercut({
    id: "cut-only",
    title: "Papercut without tasks",
    repository: { origin: "org/cut-only", path: cutReal },
    area: "board",
    happened: "Missing badge",
    impact: "Harder scan",
    fix: null,
    source: null,
    filedBy: "operator",
    filedAt: stamp,
    state: "open",
    taskId: null,
    closedReason: null,
    note: null,
    closedAt: null,
  });
  // A repository with a Paseo task AND a lead, where T3 does not observe it; plus an ambiguous T3 repo.
  const head = "a".repeat(40);
  store.insert(
    submissionSchema.parse({
      submissionId: "paseo-task",
      title: "Paseo task",
      repoPath: paseoOnly,
      planningCommit: head,
      handoffPath: "paseo.md",
      originAgentId: "0b355fd4",
    }),
    "paseo:primary",
    "handoff",
    head,
  );
  store.addLead(
    {
      id: "lead-ambig",
      title: "Ambiguous repo lead",
      body: "Details",
      repositories: [{ origin: "org/ambig", path: ambiguousRepo }],
      lanes: [],
      tags: [],
      author: "operator",
      state: "open",
      version: 1,
      dropReason: null,
      targets: [],
      source: null,
      createdAt: stamp,
      updatedAt: stamp,
      closedAt: null,
    },
    "operator",
  );

  let observations: ProjectObservation[] = [
    {
      hostId: "t3code:env-a",
      projects: [
        {
          id: "p1",
          title: "biock-aase",
          workspaceRoot: leadReal,
          archivedAt: null,
          deletedAt: null,
        },
        {
          id: "p2",
          title: "ncock-iase",
          workspaceRoot: cutReal,
          archivedAt: null,
          deletedAt: null,
        },
        {
          id: "p3a",
          title: "Ambig One",
          workspaceRoot: ambiguousRepo,
          archivedAt: null,
          deletedAt: null,
        },
        {
          id: "p3b",
          title: "Ambig Two",
          workspaceRoot: ambiguousRepo,
          archivedAt: null,
          deletedAt: null,
        },
      ],
    },
  ];
  const board = new RuntimeBoard({
    store,
    engine: {
      profiles: [],
      retiredObservationKey: (host) => `retired:${host}`,
      currentExternalWait: () => "",
      resolution: {
        slotAdmissionReason: () => "",
        slotAdmissionReader: () => () => "",
      },
    },
    decisions: new Decisions(store),
    cachedTaskDetail: createTaskDetailCache(store),
    cachedUiSnapshotFacts: createUiSnapshotFactsCache(store),
    markStoreAccess: () => {},
    anyHostConnected: () => true,
    backupHealthProjection: () => ({
      newestSnapshotAt: null,
      localError: null,
    }),
    boardError: () => "",
    prStates: {},
    hostId: "paseo:primary",
    projectObservations: () => observations,
  });

  const first = board.uiSnapshot({});
  assert.equal("unchanged" in first, false);
  if ("unchanged" in first) return;
  assert.deepEqual(first.projectBadges, {});
  assert.deepEqual(first.repositoryBadges, {
    [leadLink]: { monogram: "BA", color: "fuchsia" },
    [cutReal]: { monogram: "NI", color: "blue" },
  });
  assert.equal(first.repositoryBadges?.[paseoOnly], undefined);
  assert.equal(first.repositoryBadges?.[ambiguousRepo], undefined);

  // Observation change advances the revision and drops the badge when archived.
  observations = [
    {
      hostId: "t3code:env-a",
      projects: [
        {
          id: "p1",
          title: "biock-aase",
          workspaceRoot: leadReal,
          archivedAt: stamp,
          deletedAt: null,
        },
        {
          id: "p2",
          title: "ncock-iase",
          workspaceRoot: cutReal,
          archivedAt: null,
          deletedAt: null,
        },
      ],
    },
  ];
  const second = board.uiSnapshot({ revision: first.revision });
  assert.equal("unchanged" in second, false);
  if ("unchanged" in second) return;
  assert.ok(second.revision > first.revision);
  assert.deepEqual(second.repositoryBadges, {
    [cutReal]: { monogram: "NI", color: "blue" },
  });
});
