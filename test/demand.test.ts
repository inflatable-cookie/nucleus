import { test } from "node:test";
import assert from "node:assert/strict";
import {
  complexityBracket,
  demandPick,
  requestedTier,
  reviewerDemand,
  runDemand,
  taskDemandPreview,
  workerClimbTarget,
  workerStartTier,
  workerStepUp,
  type DemandCandidate,
} from "../shared/demand";
import {
  poolRecordFromLegacy,
  poolSchema,
  profileCapabilityLevels,
  profileWeightLevels,
  weightShare,
  type ProfileWeight,
  submissionSchema,
  usageLevelSchema,
  usageLevels,
  type CapabilityLevel,
  type DemandLevel,
  type PoolEntry,
  type Profile,
  type ProfileCapability,
  type Task,
  type UsageLevel,
} from "../shared/contracts";
import {
  chooseProfile,
  workerSelectionExplanation,
} from "../core/dispatch/routing";
import { requestOnly } from "../shared/pool";
import { poolShapes } from "./support/pool-shapes";

/** Spec 053 rows against the live pool's ratings, in brackets (Tom, 2026-11-19). */
const entry = (
  profileId: string,
  capability: ProfileCapability,
  weight: ProfileWeight = "default",
) =>
  poolSchema.parse({
    profileId,
    enabled: true,
    group: profileId,
    roles: ["worker"],
    weight,
    scopes: ["general"],
    capability,
  });
const pool = [
  entry("opus", "frontier"),
  entry("sol", "heavyweight"),
  entry("deepseek", "worker"),
  entry("haiku", "worker"),
  entry("grok", "worker"),
  entry("glm", "mechanical"),
  entry("muse", "mechanical"),
];
const profiles = pool.map((item) => ({
  id: item.profileId,
  model: `vendor/${item.profileId}-model`,
  available: true,
}));
const candidates: DemandCandidate[] = pool.map((item) => ({
  ...item,
  model: `vendor/${item.profileId}-model`,
  available: true,
}));
const pick = (
  demand: DemandLevel,
  usage: UsageLevel = "normal",
  exclude: string[] = [],
  requested?: DemandLevel | null,
  climb?: DemandLevel | null,
) =>
  demandPick(
    demand,
    usage,
    candidates,
    new Set(),
    new Set(exclude.map((id) => `${id}-model`)),
    requested,
    climb,
  );

const COMPLEXITIES = [
  "very_low",
  "low",
  "medium",
  "high",
  "very_high",
] as const;
/** The start bracket of every level for every complexity (Tom, 2026-11-19). */
const START: Record<
  UsageLevel,
  Record<CapabilityLevel | "unset", DemandLevel>
> = {
  low: {
    very_low: "mechanical",
    low: "mechanical",
    medium: "mechanical",
    high: "worker",
    very_high: "heavyweight",
    unset: "mechanical",
  },
  normal: {
    very_low: "mechanical",
    low: "mechanical",
    medium: "worker",
    high: "worker",
    very_high: "heavyweight",
    unset: "worker",
  },
  high: {
    very_low: "mechanical",
    low: "mechanical",
    medium: "worker",
    high: "heavyweight",
    very_high: "heavyweight",
    unset: "worker",
  },
  extra_high: {
    very_low: "mechanical",
    low: "mechanical",
    medium: "worker",
    high: "heavyweight",
    very_high: "heavyweight",
    unset: "worker",
  },
  maximum: {
    very_low: "heavyweight",
    low: "heavyweight",
    medium: "heavyweight",
    high: "heavyweight",
    very_high: "heavyweight",
    unset: "heavyweight",
  },
};

test("052: usage levels are low, normal, high, extra high and maximum; a stored minimal reads as low", () => {
  assert.deepEqual(
    [...usageLevels],
    ["low", "normal", "high", "extra_high", "maximum"],
  );
  assert.equal(
    usageLevelSchema.parse("minimal"),
    "low",
    "a stale writer maps to low at the wire boundary",
  );
  for (const level of usageLevels)
    assert.equal(usageLevelSchema.parse(level), level, `${level} is unchanged`);
});

test("052 brackets: four capability brackets; every five-point rating reads as its bracket at the wire boundary", () => {
  assert.deepEqual(
    [...profileCapabilityLevels],
    ["mechanical", "worker", "heavyweight", "frontier"],
  );
  const legacy = {
    very_low: "mechanical",
    low: "mechanical",
    medium: "worker",
    high: "worker",
    very_high: "heavyweight",
    frontier: "frontier",
  } as const;
  for (const [from, to] of Object.entries(legacy))
    assert.equal(
      entry("p", from as ProfileCapability).capability,
      to,
      `${from} → ${to}`,
    );
  assert.throws(
    () => entry("p", "ultra" as ProfileCapability),
    "an unknown rating is not guessed",
  );
});

test("052: a task's own bracket and the bracket it may climb to; medium and high share Worker and differ in the climb", () => {
  assert.deepEqual(COMPLEXITIES.map(complexityBracket), [
    "mechanical",
    "mechanical",
    "worker",
    "worker",
    "heavyweight",
  ]);
  assert.deepEqual(COMPLEXITIES.map(requestedTier), [
    "mechanical",
    "mechanical",
    "worker",
    "heavyweight",
    "frontier",
  ]);
  assert.equal(
    complexityBracket(null),
    "worker",
    "unset complexity counts as medium",
  );
  assert.equal(requestedTier(null), "worker");
});

test("052 table: every level starts a task at its bracket, with maximum on Heavyweight whatever the complexity", () => {
  for (const level of usageLevels)
    for (const complexity of COMPLEXITIES)
      assert.equal(
        workerStartTier(level, complexity),
        START[level][complexity],
        `${level}/${complexity}`,
      );
  for (const level of usageLevels)
    assert.equal(
      workerStartTier(level, null),
      START[level].unset,
      `${level}/unset complexity is medium`,
    );
});

test("052: the reviewer runs one bracket below the worker at Low, Normal and High and on it above; the coordinator always asks for Mechanical", () => {
  for (const level of usageLevels)
    for (const complexity of COMPLEXITIES) {
      const worker = profileCapabilityLevels.indexOf(
        runDemand(complexity, "worker", level),
      );
      const reviewer = profileCapabilityLevels.indexOf(
        runDemand(complexity, "reviewer", level),
      );
      const below = level === "low" || level === "normal" || level === "high";
      assert.equal(
        reviewer,
        below ? Math.max(0, worker - 1) : worker,
        `${level}/${complexity}: reviewer`,
      );
      assert.equal(
        runDemand(complexity, "coordinator", level),
        "mechanical",
        `${level}/${complexity}: coordinator`,
      );
    }
});

test("052: the reviewer reads the worker's actual profile; a critical task floors it at the worker", () => {
  const rated = [
    entry("w", "worker"),
    entry("h", "heavyweight"),
    entry("m", "mechanical"),
    entry("f", "frontier"),
  ];
  const on = (id: string, critical = false) => ({
    complexity: "medium" as const,
    critical,
    profile: { id },
  });
  assert.equal(
    reviewerDemand(on("h"), rated, "normal"),
    "worker",
    "Heavyweight author → Worker reviewer at Normal",
  );
  assert.equal(
    reviewerDemand(on("w"), rated, "normal"),
    "mechanical",
    "Worker author → Mechanical reviewer at Normal",
  );
  assert.equal(
    reviewerDemand(on("m"), rated, "low"),
    "mechanical",
    "a Mechanical author gets a Mechanical reviewer",
  );
  assert.equal(
    reviewerDemand(on("f"), rated, "normal"),
    "heavyweight",
    "Frontier author → Heavyweight reviewer",
  );
  assert.equal(
    reviewerDemand(on("w"), rated, "high"),
    "mechanical",
    "at High the reviewer is one bracket below the author",
  );
  assert.equal(
    reviewerDemand(on("h"), rated, "high"),
    "worker",
    "a Heavyweight author gets a Worker reviewer at High",
  );
  assert.equal(
    reviewerDemand(on("w", true), rated, "high"),
    "worker",
    "critical: at High the reviewer is floored at the worker",
  );
  assert.equal(reviewerDemand(on("h"), rated, "extra_high"), "heavyweight");
  assert.equal(
    reviewerDemand(on("w"), rated, "extra_high"),
    "worker",
    "Extra high keeps the same-bracket reviewer",
  );
  assert.equal(
    reviewerDemand(on("w"), rated, "maximum"),
    "worker",
    "Maximum keeps the same-bracket reviewer",
  );
  assert.equal(
    reviewerDemand(on("w", true), rated, "normal"),
    "worker",
    "critical: at least the worker",
  );
});

test("052: the climb is one bracket from the worker's actual profile, capped at the bracket the task may climb to", () => {
  const rated = [
    entry("m", "mechanical"),
    entry("w", "worker"),
    entry("h", "heavyweight"),
  ];
  const climb = (
    complexity: CapabilityLevel,
    profileId: string | null,
    usage: UsageLevel = "normal",
  ) =>
    workerClimbTarget(
      {
        complexity,
        profile: profileId ? { id: profileId } : null,
        resolution: {
          review: { status: "changes_required", runId: "review-1" },
          workerClimb: null,
        },
      },
      rated,
      usage,
    );
  assert.deepEqual(climb("high", "w"), {
    from: "worker",
    to: "heavyweight",
    reviewRunId: "review-1",
  });
  assert.equal(climb("very_high", "h"), null);
  assert.deepEqual(climb("very_high", "h", "extra_high"), {
    from: "heavyweight",
    to: "frontier",
    reviewRunId: "review-1",
  });
  assert.equal(
    climb("medium", "w"),
    null,
    "a medium task never climbs past Worker",
  );
  assert.equal(climb("low", "m"), null, "low stays on Mechanical");
  assert.equal(
    climb("high", "w", "high"),
    null,
    "at High a high task already starts on Heavyweight",
  );
  assert.deepEqual(
    climb("medium", "m", "low"),
    { from: "mechanical", to: "worker", reviewRunId: "review-1" },
    "Low starts medium on Mechanical and climbs back to Worker",
  );
  assert.equal(workerStepUp("worker", "heavyweight"), "heavyweight");
  assert.equal(
    workerStepUp("heavyweight", "heavyweight"),
    "heavyweight",
    "never past the climb bracket",
  );
  assert.equal(
    workerStepUp("frontier", "heavyweight"),
    "frontier",
    "an explicit route above it is not pulled back",
  );
});

test("052 permission: Frontier is request-only below Extra high; Heavyweight at Low and Normal only when the task neither starts nor climbs there", () => {
  const cases = [
    ["low", "frontier", "frontier", null, true],
    ["normal", "frontier", "frontier", "frontier", true],
    ["normal", "heavyweight", "worker", null, true],
    ["normal", "heavyweight", "heavyweight", null, true],
    ["normal", "heavyweight", "heavyweight", "heavyweight", false],
    ["normal", "heavyweight", "frontier", null, false],
    ["low", "heavyweight", "frontier", null, false],
    ["high", "frontier", "frontier", "frontier", true],
    ["high", "heavyweight", "worker", null, false],
    ["extra_high", "frontier", "worker", null, false],
    ["maximum", "frontier", "worker", null, false],
  ] as const;
  for (const [level, capability, requested, climb, gated] of cases)
    assert.equal(
      requestOnly({ capability }, level, requested, climb),
      gated,
      `${level}/${capability}/${requested}/${climb}`,
    );
  for (const capability of ["mechanical", "worker"] as const)
    for (const level of usageLevels)
      assert.equal(
        requestOnly({ capability }, level, "mechanical"),
        false,
        `${level}/${capability}`,
      );
});

test("053 rows: only profiles the level covers form the automatic set; gated ones meet the demand only on request, and weight never excludes", () => {
  assert.deepEqual(
    pick("worker", "normal", [], "worker"),
    { profileIds: ["deepseek", "haiku", "grok"], shortfall: false },
    "a medium task selects the Worker pool; Heavyweight is above it and held",
  );
  assert.deepEqual(
    pick("worker", "normal", ["haiku"], "worker").profileIds,
    ["deepseek", "grok"],
    "an excluded author model leaves the set",
  );
  assert.deepEqual(
    pick("worker", "normal", [], "heavyweight"),
    { profileIds: ["deepseek", "haiku", "grok"], shortfall: false },
    "a high task's first run is on Worker; Heavyweight is held before the climb",
  );
  assert.deepEqual(
    pick("heavyweight", "normal", [], "heavyweight", "heavyweight"),
    { profileIds: ["sol"], shortfall: false },
    "the recorded climb to Heavyweight needs no request at Normal",
  );
  assert.deepEqual(
    pick("heavyweight", "normal", [], "frontier"),
    { profileIds: ["sol"], shortfall: false },
    "a very-high task starts on Heavyweight at Normal without a request",
  );
  assert.deepEqual(
    pick("frontier", "normal", [], "frontier", "frontier"),
    { profileIds: ["sol"], shortfall: true },
    "its climb to Frontier is request-only: the best covered profile serves",
  );
  assert.deepEqual(
    pick("frontier", "high", [], "frontier", "frontier"),
    { profileIds: ["sol"], shortfall: true },
    "at High too",
  );
  assert.deepEqual(
    pick("frontier", "extra_high", [], "frontier", "frontier"),
    { profileIds: ["opus"], shortfall: false },
    "at Extra high Frontier is automatic",
  );
  assert.deepEqual(
    pick("heavyweight", "maximum", [], "worker"),
    { profileIds: ["opus", "sol"], shortfall: false },
    "at Maximum workers use Heavyweight and Frontier",
  );
  assert.deepEqual(
    pick("mechanical", "extra_high", [], "mechanical").profileIds,
    ["glm", "muse"],
    "Mechanical demand selects its own bracket whatever the cost",
  );
  const short = pick("heavyweight", "normal", ["sol"], "frontier");
  assert.deepEqual(
    short.profileIds,
    ["deepseek", "haiku", "grok"],
    "the nearest covered bracket below on a shortfall",
  );
  assert.equal(short.shortfall, true);
});

test("053: unavailable groups, disabled and catalog-missing profiles are never picked", () => {
  const offline = demandPick(
    "worker",
    "normal",
    candidates,
    new Set(["deepseek"]),
    new Set(),
    "worker",
  );
  assert.ok(!offline.profileIds.includes("deepseek"));
  const disabled = demandPick(
    "worker",
    "normal",
    candidates.map((item) =>
      item.profileId === "deepseek" ? { ...item, enabled: false } : item,
    ),
    new Set(),
    new Set(),
    "worker",
  );
  assert.ok(!disabled.profileIds.includes("deepseek"));
  assert.deepEqual(
    demandPick("worker", "normal", [], new Set(), new Set(), "worker")
      .profileIds,
    [],
  );
});

test("053 preview: per-role rows from the level start bracket, the reviewer excludes every author model, and requests show their reach", () => {
  const rows = taskDemandPreview(
    {
      complexity: "high",
      workerModel: "vendor/deepseek-model",
      workerModels: ["vendor/deepseek-model"],
    },
    pool,
    profiles,
    "normal",
    new Set(),
  );
  assert.deepEqual(
    rows.map((row) => [row.role, row.demand]),
    [
      ["worker", "worker"],
      ["reviewer", "mechanical"],
      ["coordinator", "mechanical"],
    ],
  );
  assert.deepEqual(
    rows[2]!.pick.profileIds,
    ["glm", "muse"],
    "the coordinator runs on Mechanical",
  );
  const requested = taskDemandPreview(
    {
      complexity: "medium",
      profileRequests: {
        worker: { profileId: "sol", reason: "needs it" },
        reviewer: { profileId: "sol", reason: "needs it" },
        coordinator: { profileId: "glm", reason: "cheap" },
      },
    },
    pool,
    profiles,
    "normal",
    new Set(),
  );
  assert.deepEqual(
    requested.map((row) => row.request),
    [
      { profileId: "sol", replaces: true },
      { profileId: "sol", replaces: true },
      { profileId: "glm", replaces: true },
    ],
    "each explicit request is shown with its role",
  );
});

test("053 preview: an opaque author blocks review, and a review-entry author is excluded from its own review", () => {
  const opaque = taskDemandPreview(
    { complexity: "high", workerModel: "default" },
    pool,
    profiles,
    "normal",
    new Set(),
  );
  assert.equal(
    opaque[1]!.blocked,
    "an opaque author model cannot prove review independence",
  );
  assert.deepEqual(opaque[1]!.pick.profileIds, []);
  const reviewEntry = taskDemandPreview(
    {
      complexity: "high",
      reviewEntry: { authorDeclaration: { models: ["vendor/glm-model"] } },
    },
    pool,
    profiles,
    "normal",
    new Set(),
  );
  assert.ok(!reviewEntry[1]!.pick.profileIds.includes("glm"));
});

/** The share of `selections` picks each profile gets when every pick is recorded (recent and lifetime counts both). */
function simulate(
  task: Task,
  selectionProfiles: Profile[],
  selectionPool: PoolEntry[],
  selections: number,
  usage: UsageLevel = "normal",
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < selections; i++) {
    const chosen = chooseProfile(
      task,
      selectionProfiles,
      selectionPool,
      counts,
      new Set(),
      "worker",
      counts,
      usage,
    );
    if (!chosen) break;
    counts[`profile:${chosen.profile.id}`] =
      (counts[`profile:${chosen.profile.id}`] ?? 0) + 1;
    counts[chosen.entry.group] = (counts[chosen.entry.group] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts)
      .filter(([key]) => key.startsWith("profile:"))
      .map(([key, n]) => [key.slice("profile:".length), n]),
  );
}

test("053 rotation weight: equal weights rotate equally whatever the legacy rating, and a Heavyweight sits above a medium task", () => {
  // Legacy saved profiles carried differently rated Cost; reading them drops it, so the shares are equal.
  const legacy = [
    ["glm", "very_low"],
    ["grok", "medium"],
    ["haiku", "very_high"],
  ] as const;
  const leanProfiles: Profile[] = legacy.map(([id]) => ({
    id,
    name: id,
    provider: "test",
    model: `vendor/${id}-model`,
    available: true,
    problem: "",
    notes: "",
    supportedThinking: [],
  }));
  const leanPool = [
    ...legacy.map(([id, cost]) =>
      poolSchema.parse(
        poolRecordFromLegacy({
          profileId: id,
          enabled: true,
          group: id,
          roles: ["worker"],
          weight: 1,
          scopes: ["general"],
          cost,
          capability: "worker",
        }),
      ),
    ),
    entry("sol", "heavyweight"),
  ];
  const shares = simulate(
    { complexity: "medium" } as Task,
    leanProfiles.concat({
      ...leanProfiles[0]!,
      id: "sol",
      name: "sol",
      model: "vendor/sol-model",
    }),
    leanPool,
    99,
  );
  assert.deepEqual(
    shares,
    { glm: 33, grok: 33, haiku: 33 },
    "prior cost gives no profile more of the rotation",
  );
});

test('053 rotation weight: each notch moves the share one fixed step from Default, and the diagnostic names the same pick', () => {
  assert.deepEqual(profileWeightLevels.map(weightShare), [0.5, 0.75, 1, 1.5, 2], 'steeper stops: 50, 75, 100, 150 and 200% of Default (nucleus#1558)');
  const stops = ['fewest', 'fewer', 'default', 'more', 'most'] as const;
  const stepProfiles: Profile[] = stops.map(id => ({ id, name: id, provider: 'test', model: `vendor/${id}-model`, available: true, problem: '', notes: '', supportedThinking: [] }));
  const stepPool = stops.map(id => entry(id, 'worker', id));
  const shares = simulate({ complexity: 'medium' } as Task, stepProfiles, stepPool, 1000);
  const total = Object.values(shares).reduce((sum, n) => sum + n, 0);
  assert.equal(total, 1000);
  // 0.5 : 0.75 : 1.0 : 1.5 : 2.0 of 5.75 → 87, 130, 174, 261, 348.
  for (const [id, expected] of Object.entries({ fewest: 87, fewer: 130, default: 174, more: 261, most: 348 }))
    assert.ok(Math.abs((shares[id] ?? 0) - expected) <= 2, `${id} took ${shares[id]} of 1000, expected about ${expected}`);
  // Diagnostics read the same rotation: the set lists shares, never a cost, and its leader is the dispatched pick.
  const task = { ...submissionSchema.parse({ submissionId: 's-diag', title: 'T', repoPath: '/r', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'o', complexity: 'medium' }) } as Task;
  const recent: Record<string, number> = { 'profile:fewest': 1, 'profile:fewer': 1, 'profile:default': 1, 'profile:more': 1, 'profile:most': 1 };
  const explained = workerSelectionExplanation(task, stepPool, stepProfiles, 'normal', new Set(), { counts: recent, recent });
  assert.deepEqual(explained.met.map(row => [row.profileId, row.weight, row.share]), [['most', 'most', 2], ['more', 'more', 1.5], ['default', 'default', 1], ['fewer', 'fewer', 0.75], ['fewest', 'fewest', 0.5]]);
  assert.equal(explained.met.some(row => 'cost' in row || 'effectiveWeight' in row), false);
  assert.equal(explained.choice?.profileId, chooseProfile(task, stepProfiles, stepPool, {}, new Set(), 'worker', recent, 'normal')?.profile.id);
});

/** The real pool shape (synthetic IDs), with its live ratings migrated to brackets. */
const realPool = poolShapes.map((shape, index) =>
  poolSchema.parse({ profileId: `shape-${index}`, ...shape.entry }),
);
const realProfiles: Profile[] = realPool.map((item, index) => ({
  id: item.profileId,
  name: poolShapes[index]!.profile.label,
  provider: poolShapes[index]!.profile.provider,
  model: poolShapes[index]!.profile.model,
  available: true,
  problem: "",
  notes: "",
  supportedThinking: [],
}));
const idAt = (capability: ProfileCapability) =>
  realPool.find((item) => item.enabled && item.capability === capability)!
    .profileId;
const profileOf = (id: string) => ({
  ...realProfiles.find((item) => item.id === id)!,
  thinkingOptionId: "",
});
const realTask = (complexity: CapabilityLevel, extra: Partial<Task> = {}) =>
  ({
    ...submissionSchema.parse({
      submissionId: `s-${complexity}`,
      title: "T",
      repoPath: "/r",
      planningCommit: "a".repeat(40),
      handoffPath: "h",
      originAgentId: "o",
      complexity,
    }),
    ...extra,
  }) as Task;
const changes = (task: Task, from: ProfileCapability): Task =>
  ({
    ...task,
    profile: profileOf(idAt(from)),
    resolution: {
      ...task.resolution,
      review: {
        eventId: "review-1",
        taskId: task.id,
        runId: "review-1",
        status: "changes_required",
        summary: "Fix it",
        head: "a".repeat(40),
      },
    },
  }) as Task;
const select = (
  task: Task,
  role: "worker" | "reviewer" | "coordinator" = "worker",
  usage: UsageLevel = "normal",
  poolFor: PoolEntry[] = realPool,
) =>
  chooseProfile(task, realProfiles, poolFor, {}, new Set(), role, {}, usage)
    ?.entry.capability ?? null;

test("1385 real pool: the live ratings migrate to brackets", () => {
  assert.deepEqual(
    realPool.map((item) => item.capability),
    [
      "mechanical",
      "heavyweight",
      "worker",
      "worker",
      "frontier",
      "heavyweight",
      "worker",
      "mechanical",
      "worker",
      "worker",
      "worker",
      "worker",
    ],
  );
});

test("1385 real pool: a medium task runs on Worker and never climbs past it", () => {
  const task = realTask("medium");
  assert.equal(select(task), "worker");
  const reviewed = changes(task, "worker");
  assert.equal(workerClimbTarget(reviewed, realPool, "normal"), null);
  assert.equal(select(reviewed), "worker");
});

test("1385 real pool: a high task starts on Worker and climbs once to Heavyweight after an applied changes-required review", () => {
  const task = realTask("high");
  assert.equal(select(task), "worker");
  assert.equal(
    select({ ...task, phase: "changes_requested" } as Task),
    "worker",
    "the phase alone does not climb",
  );
  const reviewed = changes(task, "worker");
  assert.equal(select(reviewed), "heavyweight");
  const recorded = {
    ...reviewed,
    resolution: {
      ...reviewed.resolution,
      workerClimb: {
        reviewRunId: "review-1",
        from: "worker",
        to: "heavyweight",
        profileId: idAt("heavyweight"),
        at: "now",
      },
    },
  } as Task;
  assert.equal(
    workerClimbTarget(
      { ...recorded, profile: profileOf(idAt("heavyweight")) },
      realPool,
      "normal",
    ),
    null,
    "one climb per review run",
  );
});

test("1385 real pool: a very-high task starts on Heavyweight and uses Frontier on request below Extra high", () => {
  const task = realTask("very_high");
  assert.equal(select(task), "heavyweight");
  const reviewed = changes(task, "heavyweight");
  assert.equal(workerClimbTarget(reviewed, realPool, "normal"), null);
  assert.equal(
    select(reviewed),
    "heavyweight",
    "Normal holds Frontier without a request",
  );
  assert.equal(
    select(reviewed, "worker", "high"),
    "heavyweight",
    "High holds it too",
  );
  assert.equal(
    select(reviewed, "worker", "extra_high"),
    "frontier",
    "Extra high does not",
  );
  const requested = {
    ...reviewed,
    profileRequests: {
      worker: {
        profileId: idAt("frontier"),
        reason: "needs it",
        required: false,
      },
    },
  } as Task;
  assert.equal(
    select(requested),
    "frontier",
    "an explicit request reaches Frontier at Normal",
  );
});

test("1385 real pool: usage levels shift the worker by whole brackets", () => {
  assert.equal(select(realTask("medium"), "worker", "low"), "mechanical");
  assert.equal(select(realTask("high"), "worker", "low"), "worker");
  assert.equal(select(realTask("high"), "worker", "high"), "heavyweight");
  assert.equal(
    select(realTask("very_low"), "worker", "extra_high"),
    "mechanical",
  );
  for (const complexity of COMPLEXITIES)
    for (const role of ["worker", "reviewer"] as const)
      assert.ok(
        ["heavyweight", "frontier"].includes(
          select(realTask(complexity), role, "maximum")!,
        ),
        `maximum ${complexity} ${role}`,
      );
});

test("1385 real pool: the reviewer is one bracket below the author at Low, Normal and High and on its bracket above; critical prefers at least the worker", () => {
  const on = (
    complexity: CapabilityLevel,
    bracket: ProfileCapability,
    critical = false,
  ) =>
    realTask(complexity, {
      profile: profileOf(idAt(bracket)),
      critical,
    } as Partial<Task>);
  assert.equal(select(on("medium", "worker"), "reviewer"), "mechanical");
  assert.equal(select(on("very_high", "heavyweight"), "reviewer"), "worker");
  assert.equal(select(on("low", "mechanical"), "reviewer"), "mechanical");
  assert.equal(
    select(on("medium", "worker"), "reviewer", "low"),
    "mechanical",
    "Low is unchanged",
  );
  assert.equal(
    select(on("high", "heavyweight"), "reviewer", "high"),
    "worker",
    "a Heavyweight worker gets a Worker-bracket reviewer at High",
  );
  assert.equal(
    select(on("medium", "worker"), "reviewer", "high"),
    "mechanical",
    "a Worker author gets a Mechanical reviewer at High",
  );
  assert.equal(
    select(on("high", "heavyweight", true), "reviewer", "high"),
    "heavyweight",
    "a critical task at High floors its reviewer at the worker",
  );
  assert.equal(
    select(on("medium", "worker"), "reviewer", "extra_high"),
    "worker",
    "Extra high keeps the same-bracket reviewer",
  );
  assert.equal(
    select(on("high", "heavyweight"), "reviewer", "extra_high"),
    "heavyweight",
  );
  const critical = select(on("medium", "worker", true), "reviewer");
  assert.ok(
    profileCapabilityLevels.indexOf(critical!) >=
      profileCapabilityLevels.indexOf("worker"),
    `critical reviewer on ${critical}`,
  );
});

test("1385 real pool: the coordinator runs on Mechanical when available, else the lowest permitted bracket", () => {
  for (const level of usageLevels)
    for (const complexity of COMPLEXITIES)
      assert.equal(
        select(realTask(complexity), "coordinator", level),
        "mechanical",
        `${level}/${complexity}`,
      );
  const noMechanical = realPool.filter(
    (item) => item.capability !== "mechanical",
  );
  assert.equal(
    select(realTask("very_high"), "coordinator", "normal", noMechanical),
    "worker",
  );
  const topOnly = realPool.filter(
    (item) =>
      item.capability === "heavyweight" || item.capability === "frontier",
  );
  assert.equal(
    select(realTask("medium"), "coordinator", "normal", topOnly),
    null,
    "Normal holds both top brackets for a medium task",
  );
  assert.equal(
    select(realTask("medium"), "coordinator", "high", topOnly),
    "heavyweight",
    "High permits Heavyweight",
  );
});
