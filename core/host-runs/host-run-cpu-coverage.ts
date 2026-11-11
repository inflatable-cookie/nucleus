/**
 * Queue-internal transport for a host run's CPU reason (Tom, 2026-10-23,
 * "Honest + cheaper"; approver ruling: sidecar). A supervisor writes one
 * private sidecar beside its run's records, before its result; settlement binds
 * it to the run and stores it in the store's internal meta. Neither is a
 * Contract 010 shape, a private record or a table row, so older Queue code
 * never reads them. Anything stale, missing, unreadable or inconsistent is
 * absent: never a measurement, never 0, never a failed settlement.
 */
import { z } from "zod";
import { boundCpuCoverage, hostRunCpuCoverageSchema, projectQaStepNameSchema, type HostRunCpuCoverage } from "../../shared/contracts";

export const HOST_RUN_CPU_COVERAGE_FORMAT = "queue.host-run.cpu-coverage";
/** The sidecar's file name beside a run's records. */
export const HOST_RUN_CPU_COVERAGE_FILE = "cpu-coverage.json";

export const hostRunCpuCoverageSidecarSchema = z.object({
  format: z.literal(HOST_RUN_CPU_COVERAGE_FORMAT),
  version: z.literal(1),
  runId: z.string().min(1).max(160),
  epoch: z.number().int().positive(),
  /** Milestone QA: the step whose process group the result names. */
  step: projectQaStepNameSchema.optional(),
  cpuMs: z.number().int().nonnegative().nullable(),
  cpuCoverage: hostRunCpuCoverageSchema,
}).strict();
export type HostRunCpuCoverageSidecar = z.infer<typeof hostRunCpuCoverageSidecarSchema>;

export function hostRunCpuCoverageSidecar(identity: { runId: string; epoch: number; step?: string }, cpuMs: number | null,
  cpuCoverage: HostRunCpuCoverage): HostRunCpuCoverageSidecar {
  return { format: HOST_RUN_CPU_COVERAGE_FORMAT, version: 1, runId: identity.runId, epoch: identity.epoch,
    ...(identity.step ? { step: identity.step } : {}), cpuMs, cpuCoverage };
}

/**
 * The reason a sidecar gives for exactly this settling result: same run, epoch,
 * step (or none on both sides) and cpuMs, and consistent with that cpuMs.
 */
export function boundSidecarCoverage(raw: unknown, expected: { runId: string; epoch: number; step?: string; cpuMs: number | null }): HostRunCpuCoverage | undefined {
  const parsed = hostRunCpuCoverageSidecarSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const sidecar = parsed.data;
  if (sidecar.runId !== expected.runId || sidecar.epoch !== expected.epoch || sidecar.step !== expected.step || sidecar.cpuMs !== expected.cpuMs) return undefined;
  return boundCpuCoverage(expected.cpuMs, sidecar.cpuCoverage);
}

/** Parse a sidecar's bytes; anything unreadable is null. */
export function parseCpuCoverageSidecar(bytes: Buffer | string | null | undefined): unknown {
  if (bytes === null || bytes === undefined) return null;
  try { return JSON.parse(bytes.toString()); } catch { return null; }
}

/** The store meta key for a settled run's bound reason; no older Queue scan matches it. */
export const hostRunCpuCoverageMetaKey = (runId: string) => `hostRunCpuCoverage:${runId}`;
export const hostRunCpuCoverageMetaSchema = z.object({
  epoch: z.number().int().positive(),
  cpuMs: z.number().int().nonnegative().nullable(),
  cpuCoverage: hostRunCpuCoverageSchema,
}).strict();
