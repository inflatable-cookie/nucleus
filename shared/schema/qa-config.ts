import { z } from "zod";
import { DEFAULT_PROCESS_TERMINATION_GRACE_MS, PROCESS_TERMINATION_GRACE_MAX_MS } from "./validation";

/** Spec 022: permanent settings for one repository. */
/**
 * Spec 033: the separate GitHub reviewer identity a repository opts into for
 * formal PR reviews. The login is the review author Queue verifies; the token
 * itself lives only in the macOS login keychain and is never stored here.
 */
/**
 * Spec 022 / #104: the milestone QA command `project.qa.run` uses. It is separate from
 * `validation`, which also runs on every task's prospective merge, so a repository can
 * set its own milestone command without bringing back per-task full QA (Tom, 2026-09-30).
 */
export const PROJECT_QA_TIMEOUT_MAX_MS = 7_200_000;

/** Bound on one stream's retained bytes when the setting names no cap. */
export const PROJECT_QA_DEFAULT_MAX_OUTPUT_BYTES = 65_536;

/** A staged milestone QA accepts at most this many ordered stages. */
export const PROJECT_QA_STAGE_MAX = 8;

/** Stage names are slug-shaped so they can name a step and a log file safely. */
export const PROJECT_QA_STAGE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * #121: one ordered stage of a milestone QA run. When a repository sets `stages`
 * each stage is its own recorded step — its own argv, timeout, output cap and
 * step record — inside the one scheduler admission of the whole run.
 */
export const projectQaStageSchema = z.object({
  name: z.string().trim().min(1).max(80).regex(PROJECT_QA_STAGE_NAME_PATTERN, "QA stage name must be slug-shaped"),
  argv: z.array(z.string().max(4096)).min(1).max(32).refine(argv => argv[0].length > 0, "QA stage executable must not be empty"),
  timeoutMs: z.number().int().min(1).max(PROJECT_QA_TIMEOUT_MAX_MS),
  maxOutputBytes: z.number().int().min(1).max(1048576).optional(),
}).strict();

export type ProjectQaStage = z.infer<typeof projectQaStageSchema>;

/** Stage names the run's own setup and teardown steps own; a stage may not reuse them. */
export const PROJECT_QA_RESERVED_STAGE_NAMES = ["setup", "teardown"] as const;

export const projectQaScheduleSchema = z.object({
  afterMerges: z.number().int().min(1).max(1000),
  maxIntervalHours: z.number().int().min(1).max(24).default(24),
}).strict();

export const projectQaSchema = z.object({
  /** Explicit opt-in; omission or null disables automatic milestone admission. */
  schedule: projectQaScheduleSchema.nullable().optional(),
  argv: z.array(z.string().max(4096)).min(1).max(32).refine(argv => argv[0].length > 0, "QA executable must not be empty").optional(),
  timeoutMs: z.number().int().min(1).max(PROJECT_QA_TIMEOUT_MAX_MS).optional(),
  maxOutputBytes: z.number().int().min(1).max(1048576).default(PROJECT_QA_DEFAULT_MAX_OUTPUT_BYTES),
  terminationGraceMs: z.number().int().min(0).max(PROCESS_TERMINATION_GRACE_MAX_MS).default(DEFAULT_PROCESS_TERMINATION_GRACE_MS),
  /** When present this replaces the single argv/timeoutMs; the run records each stage as its own step. */
  stages: z.array(projectQaStageSchema).min(1).max(PROJECT_QA_STAGE_MAX).optional(),
}).strict().superRefine((qa, context) => {
  if (qa.stages) {
    if (qa.argv || qa.timeoutMs)
      context.addIssue({ code: "custom", message: "A staged QA setting replaces argv and timeoutMs; it cannot set both" });
    const names = new Set<string>();
    for (const stage of qa.stages) {
      if (names.has(stage.name)) context.addIssue({ code: "custom", message: `QA stage names must be unique: ${stage.name}` });
      names.add(stage.name);
      if ((PROJECT_QA_RESERVED_STAGE_NAMES as readonly string[]).includes(stage.name))
        context.addIssue({ code: "custom", message: `QA stage name is reserved for the run's own step: ${stage.name}` });
    }
    const total = qa.stages.reduce((sum, stage) => sum + stage.timeoutMs, 0);
    if (total > PROJECT_QA_TIMEOUT_MAX_MS)
      context.addIssue({ code: "custom", message: `QA stage timeouts total ${total}ms, above the ${PROJECT_QA_TIMEOUT_MAX_MS}ms maximum` });
  } else if (!qa.argv || !qa.timeoutMs) {
    context.addIssue({ code: "custom", message: "A QA setting needs argv and timeoutMs, or 1 to 8 stages" });
  }
});

export type ProjectQa = z.input<typeof projectQaSchema>;
