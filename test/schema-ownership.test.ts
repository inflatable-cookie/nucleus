import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authorDeclarationSchema,
  availabilitySchema,
  capacityAuthorityValuesSchema,
  capacityBounds,
  capacitySchema,
  capacityStateFields,
  capabilityLevelSchema,
  costSchema,
  eventSchema,
  legacyHoldProjectionFields,
  reviewEntryInputSchema,
  submissionSchema,
  taskSchema,
  DEFAULT_HOST_CALL_LIMIT,
  MAX_HOST_CALL_LIMIT,
  RETAINED_WORKER_PROFILE_REASON,
  isRetainedProfileReason,
  retainedProfileReason,
  retiredSubmissionRefusals,
  syncHoldProjection,
  type Task,
} from "../shared/contracts";
import { RETAINED_WORKER_PROFILE_REASON as OWNED_REASON } from "../shared/retained-profile";

/**
 * Boundaries of the floor-7 `shared/schema` owners: the retired-submission
 * refusal rule, the derived cost scale, the one capacity-limit catalogue, the
 * legacy hold projection and the typed retained-profile fact. Each assertion is
 * about the owner's answer, not about its source text.
 */

const submission = (extra: Record<string, unknown> = {}) =>
  submissionSchema.parse({
    submissionId: "synthetic-boundary",
    title: "Boundary task",
    repoPath: "/repo",
    planningCommit: "a".repeat(40),
    originAgentId: "origin",
    ...extra,
  });

test("one retired-submission rule answers every surface with its own wording", () => {
  // A stored row still parses: no retirement deletes history.
  const historical = submission({
    responsible: false,
    manualVerification: true,
    reviewVerdicts: true,
    reviewContinuationIds: ["scope"],
  });
  assert.equal(historical.responsible, false);
  assert.equal(historical.manualVerification, true);

  assert.deepEqual(retiredSubmissionRefusals({}, "submission"), []);
  assert.deepEqual(retiredSubmissionRefusals({}, "frontmatter"), []);

  const surface = retiredSubmissionRefusals(
    {
      responsible: false,
      manualVerification: true,
      reviewVerdicts: ["a"],
      reviewPassGate: ["a"],
    },
    "submission",
  );
  assert.deepEqual(
    surface.map((refusal) => refusal.field),
    ["responsible", "manualVerification", "reviewVerdicts"],
    "a submission reports one combined verdicts refusal, in submission field order",
  );
  assert.match(
    surface[0]!.message,
    /^responsible: false is no longer supported/,
  );
  assert.match(
    surface[2]!.message,
    /^reviewVerdicts and reviewPassGate are no longer available/,
  );

  const frontmatter = retiredSubmissionRefusals(
    {
      responsible: false,
      manualVerification: true,
      reviewVerdicts: ["a"],
      reviewPassGate: ["a"],
    },
    "frontmatter",
  );
  assert.deepEqual(
    frontmatter.map((refusal) => refusal.field),
    ["responsible", "manualVerification", "reviewVerdicts", "reviewPassGate"],
    "frontmatter names each retired queue key separately",
  );
  assert.match(
    frontmatter[0]!.message,
    /^queue\.responsible: false is no longer supported/,
  );
  assert.match(
    frontmatter[3]!.message,
    /^queue\.reviewPassGate is no longer available/,
  );

  // Review entry applies the same rule to the submission it carries, under the submission path.
  const entry = reviewEntryInputSchema.safeParse({
    submission: submission({ responsible: false }),
    workspaceId: "workspace",
    prNumber: 7,
    expectedBranch: "ns-synthetic",
    expectedHead: "b".repeat(40),
    expectedBaseCommit: "c".repeat(40),
    authority: "Synthetic review entry",
    authorDeclaration: authorDeclarationSchema.parse({
      models: ["synthetic/model"],
      githubAuthor: "synthetic",
      authoringSystem: "synthetic",
      attestedBy: "synthetic",
      provenance: "Synthetic boundary proof",
    }),
  });
  assert.equal(entry.success, false);
  assert.deepEqual(
    entry.error!.issues.map((issue) => [issue.path.join("."), issue.message]),
    [
      [
        "submission.responsible",
        "responsible: false is no longer supported; every task runs the responsible lifecycle",
      ],
    ],
  );
});

test("the cost scale is the capability scale, listed most expensive first", () => {
  assert.deepEqual(
    costSchema.options,
    [...capabilityLevelSchema.options].reverse(),
  );
});

test("the capacity catalogue is the only place a limit is bounded and defaulted", () => {
  assert.deepEqual(Object.keys(capacitySchema.shape), [
    "globalLimit",
    "projectLimit",
    "papercutProjectLimit",
    "hostCallLimit",
    "paseoCallLimit",
    "stallThresholdMinutes",
    "holdReminderMinutes",
    "holdEscalationMinutes",
    "laneDrainMinutes",
    "laneDrainEscalationMinutes",
    "hostOutageNoticeMinutes",
    "threadRetentionDays",
    "operatorDefaultHostKind",
  ]);
  // An absent field keeps the catalogue's default, and the bound is the catalogue's.
  assert.equal(
    capacityStateFields.hostCallLimit.parse(undefined),
    DEFAULT_HOST_CALL_LIMIT,
  );
  assert.equal(
    capacityStateFields.hostCallLimit.parse(MAX_HOST_CALL_LIMIT),
    MAX_HOST_CALL_LIMIT,
  );
  assert.throws(() =>
    capacitySchema.parse({
      globalLimit: 1,
      projectLimit: 1,
      hostCallLimit: capacityBounds.hostCallLimit.max + 1,
    }),
  );
  // A settings write is the whole state: every bounded limit is required, not patched.
  assert.throws(() =>
    capacityAuthorityValuesSchema.parse({ globalLimit: 1, projectLimit: 1 }),
  );
  const whole = capacityAuthorityValuesSchema.parse(
    Object.fromEntries([
      ["globalLimit", 1],
      ["projectLimit", 1],
      ...Object.entries(capacityBounds).map(([field, bound]) => [
        field,
        bound.fallback,
      ]),
      ["operatorDefaultHostKind", "paseo"],
    ]),
  );
  assert.equal(
    whole.hostOutageNoticeMinutes,
    capacityBounds.hostOutageNoticeMinutes.fallback,
  );
});

test("the task row carries the legacy hold projection from one owner", () => {
  // The schema's fields are the shared group's own schemas, not copies.
  for (const field of Object.keys(legacyHoldProjectionFields) as Array<
    keyof typeof legacyHoldProjectionFields
  >)
    assert.equal(
      taskSchema.shape[field],
      legacyHoldProjectionFields[field],
      `${field} has one owner`,
    );
  // A row written through the projection parses with both the fences and the legacy fields.
  const projected = taskSchema.parse({
    ...submission(),
    id: "task",
    hostId: "host",
    createdAt: "now",
    updatedAt: "now",
    version: 1,
    phase: "queued",
    reason: "",
    ...syncHoldProjection({
      dispatch: {
        owner: "operator",
        reason: "Waiting",
        at: "now",
        generation: 2,
        until: null,
      },
    }),
    handoffText: "",
    planningBase: "",
    workspaceId: null,
    directory: null,
    branch: "ns-synthetic",
    agentId: null,
    runId: null,
    profile: null,
    workspaceIntent: false,
    agentIntent: false,
    lastAgentStatus: null,
    idleSince: null,
    completion: null,
    agentActive: null,
    lastObservedAt: null,
    prUrl: null,
    prHead: null,
    coordinatorGeneration: 0,
  } as never);
  assert.equal(projected.holdOwner, "operator");
  assert.equal(projected.holdGeneration, 2);
  assert.equal((projected as Task).holds.dispatch?.reason, "Waiting");
});

test("the retained-profile fact is one text with one reader", () => {
  assert.equal(RETAINED_WORKER_PROFILE_REASON, OWNED_REASON);
  assert.equal(isRetainedProfileReason(RETAINED_WORKER_PROFILE_REASON), true);
  assert.equal(
    isRetainedProfileReason(retainedProfileReason("profile is gone")),
    true,
  );
  assert.equal(
    isRetainedProfileReason("Retained worker profile was replaced"),
    false,
  );
  assert.equal(isRetainedProfileReason(null), false);
  assert.equal(isRetainedProfileReason(undefined), false);
});

test("the board event record refuses a field the contract does not declare, and availability keeps its set-payload tolerance", () => {
  assert.deepEqual(
    eventSchema.parse({
      id: 1,
      taskId: "task",
      at: "now",
      kind: "note",
      detail: "text",
    }),
    { id: 1, taskId: "task", at: "now", kind: "note", detail: "text" },
  );
  assert.throws(() =>
    eventSchema.parse({
      id: 1,
      taskId: "task",
      at: "now",
      kind: "note",
      detail: "text",
      extra: true,
    }),
  );
  // Availability's own contract is the opposite: an older caller's extra key is ignored.
  assert.deepEqual(
    availabilitySchema.parse({
      group: "g",
      unavailable: false,
      reason: "",
      retryAt: null,
      extra: true,
    }),
    { group: "g", unavailable: false, reason: "", retryAt: null },
  );
});
