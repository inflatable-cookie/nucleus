/**
 * The fixed numbers one milestone QA run is admitted and supervised with. They
 * live here so the admission, launch, settlement and retention owners share one
 * copy instead of importing the runner facade.
 */
import { VALIDATION_TIMEOUT_MAX_MS, PROJECT_QA_DEFAULT_MAX_OUTPUT_BYTES } from "../../shared/contracts";

/** Default milestone QA command when the repository sets no `qa` command. Per-task validation stays null by default. */
export const DEFAULT_PROJECT_QA_ARGV = ["effigy", "qa"];
export const DEFAULT_PROJECT_QA_TIMEOUT_MS = VALIDATION_TIMEOUT_MAX_MS;
export const DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES = PROJECT_QA_DEFAULT_MAX_OUTPUT_BYTES;
/**
 * #121: the host-run envelope for one milestone run. Setup and teardown each get
 * the hook timeout bound, so the envelope covers both around every stage's own
 * window; no step can consume another's launch-relative timeout budget.
 * #1286: the run timeout is at least the stage total plus the setup and
 * teardown allowance, and never below the default, so a staged setting can
 * never be killed by the run timeout before its last stage's own limit.
 */
export const projectQaEnvelopeMs = (stages: ReadonlyArray<{ timeoutMs: number }>): number =>
  Math.max(
    stages.reduce((sum, stage) => sum + stage.timeoutMs, 0) + 2 * DEFAULT_PROJECT_QA_TIMEOUT_MS,
    DEFAULT_PROJECT_QA_TIMEOUT_MS,
  );
/** Bounded tail kept on the run record. */
export const PROJECT_QA_TAIL_BYTES = 2000;
/** Every interrupted-preparation settlement starts with this; the scheduler reads its typed code. */
export const QA_INTERRUPTED_PREPARATION_PREFIX = "QA request preparation was interrupted";
