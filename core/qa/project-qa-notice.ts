import type { ProjectQaRun } from "../../shared/contracts";

/** A successful timing stage may retain inconclusive performance failures. */
export function projectQaNotice(run: Pick<ProjectQaRun, "id" | "state" | "failureIndexes">): string {
  const indexes = run.failureIndexes ?? [];
  const advisory = (stage: string) => run.state === "passed" && /^(?:test:|test-)timing$/.test(stage);
  const stages = indexes.map(index => advisory(index.stage)
    ? `timing inconclusive under load: ${index.failed ?? 0} performance oracles failed`
    : `${index.stage}: ${index.failed ?? 0} failed, ${index.cancelled ?? 0} cancelled`);
  const failed = indexes.filter(index => !advisory(index.stage)).reduce((sum, index) => sum + (index.failed ?? 0), 0);
  const cancelled = indexes.filter(index => !advisory(index.stage)).reduce((sum, index) => sum + (index.cancelled ?? 0), 0);
  const blockingRunFailure = run.state === "failed" || run.state === "timed_out" || run.state === "hold" || run.state === "lost";
  const fallback = (!indexes.some(index => !advisory(index.stage)) && blockingRunFailure) ? 1 : 0;
  const identities = indexes.flatMap(index => index.identities.map(identity => `${identity.title}${identity.location ? ` (${identity.location})` : ""}`));
  const shown = identities.slice(0, 20);
  const remaining = identities.length - shown.length + indexes.reduce((sum, index) => sum + index.omittedIdentities, 0);
  const identityDetail = shown.length ? ` Failed tests and performance oracles: ${shown.join("; ")}${remaining ? `; and ${remaining} more not listed` : ""}.` : "";
  return `Milestone QA ${run.state}: ${failed + fallback} failed, ${cancelled} cancelled${stages.length ? `; stages: ${stages.join("; ")}` : ""}. Run ${run.id}.${identityDetail}`;
}
