/**
 * The refusal vocabulary of one milestone QA admission claim. Every refusal that
 * can end a request before it claims a run carries its own code, so a scheduler
 * decides whether a batch may resume from the code alone and never from the
 * diagnostic text it happens to read.
 */
import type { QaAdmissionRefusalCode } from '../../shared/contracts';

/**
 * A QA admission refused at a named boundary, with the diagnostic the request
 * keeps. It keeps the plain `Error` rendering the refusal text had before the
 * code existed, so a recorded diagnostic reads the same.
 */
export class QaAdmissionRefusal extends Error {
  constructor(readonly code: QaAdmissionRefusalCode, message: string) {
    super(message);
  }
}

export function refuseQaAdmission(code: QaAdmissionRefusalCode, message: string): never {
  throw new QaAdmissionRefusal(code, message);
}

const RESUMABLE = new Set<QaAdmissionRefusalCode>([
  // A pause, roll, configuration change or ownership handover: no run was
  // claimed, so the same batch resumes under a new request generation.
  'schedule_paused', 'schedule_owner_closing', 'schedule_no_planner',
  'release_line_acquired', 'concurrent_head_moved',
  'fence', 'interrupted_preparation',
]);

/** True when the refusal proves no run was claimed and the batch may resume under a new request identity. */
export const qaAdmissionRefusalResumesBatch = (code: QaAdmissionRefusalCode | null | undefined): boolean =>
  code != null && RESUMABLE.has(code);

/** The code one failed admission records; anything outside this vocabulary is unclassified, never guessed. */
export const qaAdmissionRefusalCode = (error: unknown): QaAdmissionRefusalCode =>
  error instanceof QaAdmissionRefusal ? error.code : 'unclassified';
