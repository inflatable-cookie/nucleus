import type { Run, Task } from "../../shared/contracts";
import { isSemanticIncidentCause, type ReviewerCalibration, type ReviewerCalibrationRow } from "../../shared/telemetry";
import type { QueueEvent } from "./task-facts";
import type { TelemetryBaseItem } from "./telemetry-item";
import { revisionKind } from "./task-facts";

const ms = (value: string | null | undefined, fallback: number) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};

export interface ReviewerVerdictFact {
  at: string; runId: string; head: string;
  verdict: "approved" | "changes_required"; exact: boolean;
  reviewer: { agentId: string | null; profileId: string | null; profileName: string | null; provider: string | null; model: string | null; profileGroup: string | null };
}
export interface ReviewerRoundFact { at: string; runId: string; head: string; kind: "review" | "pre_merge"; partial: boolean; verdictIndex: number | null }
export interface ReviewerIncidentFact { at: string; id: string; cause: string; semantic: boolean; verdictIndex: number | null }
/**
 * Per-task reviewer calibration facts derived once per base build. Attribution links only
 * Queue-proven ordering: each later fact (revision round, pre-merge refusal, post-merge
 * incident) belongs to the latest accepted or blocking verdict recorded at or before it.
 * No fact reads repository prose or titles.
 */
export interface ReviewerCalibrationFacts {
  verdicts: ReviewerVerdictFact[];
  rounds: ReviewerRoundFact[];
  refusals: { at: string; runId: string | null; verdictIndex: number | null }[];
  postMergeIncidents: ReviewerIncidentFact[];
}

function reviewerIdentity(run: Run): ReviewerVerdictFact["reviewer"] {
  return {
    agentId: run.agentId, profileId: run.profile?.id ?? null, profileName: run.profile?.name ?? null,
    provider: run.profile?.provider ?? null, model: run.profile?.model ?? null, profileGroup: run.profileGroup ?? null,
  };
}

/**
 * Durable exact-head reviewer attribution. A verdict is exact when the reviewer run carries
 * a proven reviewer profile (identity edge) and its completion records the verdict at the
 * run's exact head; everything older or incomplete stays partial and leaves the
 * identity-denominated rates alone. Revision rounds follow the same cause rule as the
 * intervention counters: rounds without a stored cause marker are reconstructed and marked
 * partial.
 */
export function reviewerCalibrationFacts(task: Task, events: QueueEvent[], runs: Run[]): ReviewerCalibrationFacts {
  const verdictRuns = runs.filter(run => run.role === "reviewer" && run.completion
    && (run.completion.status === "ready_to_merge" || run.completion.status === "changes_required"))
    .sort((a, b) => ms(a.createdAt, 0) - ms(b.createdAt, 0));
  const verdicts: ReviewerVerdictFact[] = verdictRuns.map(run => ({
    at: run.createdAt, runId: run.id, head: run.head,
    verdict: run.completion!.status === "ready_to_merge" ? "approved" : "changes_required",
    exact: Boolean(run.profile?.provider),
    reviewer: reviewerIdentity(run),
  }));
  const verdictIndexFor = (at: string) => {
    const time = ms(at, 0);
    let index: number | null = null;
    for (let index_ = 0; index_ < verdicts.length; index_++) {
      if (ms(verdicts[index_].at, 0) <= time) index = index_; else break;
    }
    return index;
  };
  const firstVerdictAt = verdicts.length ? ms(verdicts[0].at, 0) : null;
  const rounds = firstVerdictAt === null ? [] : runs
    .filter(run => run.role === "revision" && revisionKind(run) === "review" && ms(run.createdAt, 0) >= firstVerdictAt)
    .sort((a, b) => ms(a.createdAt, 0) - ms(b.createdAt, 0))
    .map(run => ({
      at: run.createdAt, runId: run.id, head: run.head,
      kind: run.revisionCause === "pre_merge" ? "pre_merge" as const : "review" as const,
      partial: !run.revisionCause, verdictIndex: verdictIndexFor(run.createdAt),
    }));
  const refusals = firstVerdictAt === null ? [] : events
    .filter(event => event.kind === "pre_merge_refused")
    .sort((a, b) => ms(a.at, 0) - ms(b.at, 0))
    .map(event => ({ at: event.at, runId: null, verdictIndex: verdictIndexFor(event.at) }));
  const mergeAt = Math.min(...events.filter(event => ["merge_verified", "external_merge_observed"].includes(event.kind)).map(event => ms(event.at, 0)), Infinity);
  const incidents = new Map<string, ReviewerIncidentFact>();
  if (Number.isFinite(mergeAt)) for (const event of events) {
    if (event.kind !== "incident" || ms(event.at, 0) < mergeAt) continue;
    try {
      const value = JSON.parse(event.detail) as { id?: unknown; cause?: unknown };
      if (typeof value.id !== "string" || typeof value.cause !== "string") continue;
      const prior = incidents.get(value.id);
      if (prior && ms(prior.at, 0) <= ms(event.at, 0)) continue;
      incidents.set(value.id, { at: event.at, id: value.id, cause: value.cause, semantic: isSemanticIncidentCause(value.cause), verdictIndex: verdictIndexFor(event.at) });
    } catch { /* Unparseable historical incidents stay out of the calibration cohort. */ }
  }
  return { verdicts, rounds, refusals, postMergeIncidents: [...incidents.values()] };
}

function reviewerRowKey(identity: ReviewerVerdictFact["reviewer"]) {
  return identity.profileId ?? identity.agentId ?? "unknown-reviewer";
}

function reviewerRowLabel(identity: ReviewerVerdictFact["reviewer"]) {
  return identity.profileName ?? identity.agentId ?? "Unattributed reviewer";
}

/**
 * Aggregate per-task calibration facts into one group section: counts everywhere, rates only
 * at group level. Rates count distinct verdicts (or exact-attributed rounds) so a rate can
 * never exceed one no matter how many facts share a verdict, and every rate excludes partial
 * verdicts and facts attributed to them, matching Contract 006's partial-evidence rule.
 */
export function mergeReviewerCalibration<Item extends Pick<TelemetryBaseItem, "reviewer">>(items: Item[]): ReviewerCalibration {
  const rows = new Map<string, ReviewerCalibrationRow>();
  const row = (identity: ReviewerVerdictFact["reviewer"]) => {
    const key = reviewerRowKey(identity);
    const existing = rows.get(key);
    if (existing) return existing;
    const created: ReviewerCalibrationRow = { key, label: reviewerRowLabel(identity),
      provider: identity.provider, model: identity.model, profileGroup: identity.profileGroup, agentId: identity.agentId,
      verdicts: 0, approved: 0, changesRequired: 0,
      revisionRounds: 0, resolvedRounds: 0, preMergeRefusals: 0, postMergeIncidents: 0 };
    rows.set(key, created);
    return created;
  };
  const totals = { verdicts: 0, approved: 0, changesRequired: 0, exactVerdicts: 0, partialVerdicts: 0, exactApproved: 0,
    revisionRounds: 0, partialRevisionRounds: 0, exactVerdictRounds: 0, resolvedRounds: 0,
    preMergeRefusals: 0,
    postMergeIncidents: 0, postMergeSemanticIncidents: 0, postMergeOperationalIncidents: 0 };
  // Distinct-verdict cohorts for the rates: verdict run IDs are globally unique, so a verdict
  // counts once no matter how many rounds or refusals it produced.
  const exactRoundVerdicts = new Set<string>(), exactRefusalVerdicts = new Set<string>();
  const evidence = new Set<ReviewerVerdictFact["exact"]>();
  for (const item of items) {
    const facts = item.reviewer;
    for (const verdict of facts.verdicts) {
      evidence.add(verdict.exact);
      totals.verdicts += 1;
      if (verdict.verdict === "approved") totals.approved += 1; else totals.changesRequired += 1;
      if (verdict.exact) { totals.exactVerdicts += 1; if (verdict.verdict === "approved") totals.exactApproved += 1; }
      else totals.partialVerdicts += 1;
      // A partial verdict keeps its group verdict count but never joins a per-reviewer row.
      if (!verdict.exact) continue;
      const aggregate = row(verdict.reviewer);
      aggregate.verdicts += 1;
      if (verdict.verdict === "approved") aggregate.approved += 1; else aggregate.changesRequired += 1;
    }
    // A round is resolved only by the next recorded verdict being an accepted re-review;
    // a round followed by another blocking verdict stays unresolved.
    const nextVerdict = (at: string) => facts.verdicts.find(verdict => ms(verdict.at, 0) > ms(at, 0)) ?? null;
    for (const round of facts.rounds) {
      const target = round.verdictIndex !== null ? facts.verdicts[round.verdictIndex] : null;
      totals.revisionRounds += 1;
      if (round.partial) totals.partialRevisionRounds += 1;
      if (!target?.exact) continue;
      totals.exactVerdictRounds += 1;
      exactRoundVerdicts.add(target.runId);
      const resolved = nextVerdict(round.at)?.verdict === "approved";
      if (resolved) totals.resolvedRounds += 1;
      const aggregate = row(target.reviewer);
      aggregate.revisionRounds += 1;
      if (resolved) aggregate.resolvedRounds += 1;
    }
    for (const refusal of facts.refusals) {
      const target = refusal.verdictIndex !== null ? facts.verdicts[refusal.verdictIndex] : null;
      // The reviewed-head gate only runs after an accepted ready_to_merge verdict.
      if (!target?.exact || target.verdict !== "approved") continue;
      totals.preMergeRefusals += 1;
      exactRefusalVerdicts.add(target.runId);
      row(target.reviewer).preMergeRefusals += 1;
    }
    for (const incident of facts.postMergeIncidents) {
      totals.postMergeIncidents += 1;
      if (incident.semantic) totals.postMergeSemanticIncidents += 1; else totals.postMergeOperationalIncidents += 1;
      const target = incident.verdictIndex !== null ? facts.verdicts[incident.verdictIndex] : null;
      if (target?.exact) row(target.reviewer).postMergeIncidents += 1;
    }
  }
  const rate = (numerator: number, denominator: number) => denominator > 0 ? numerator / denominator : null;
  return {
    verdicts: totals.verdicts, approved: totals.approved, changesRequired: totals.changesRequired,
    exactVerdicts: totals.exactVerdicts, partialVerdicts: totals.partialVerdicts, exactApproved: totals.exactApproved,
    revisionRounds: totals.revisionRounds, partialRevisionRounds: totals.partialRevisionRounds,
    resolvedRounds: totals.resolvedRounds, preMergeRefusals: totals.preMergeRefusals,
    postMergeIncidents: totals.postMergeIncidents, postMergeSemanticIncidents: totals.postMergeSemanticIncidents, postMergeOperationalIncidents: totals.postMergeOperationalIncidents,
    // Distinct-verdict shares stay within [0,1] even when several rounds share one verdict.
    revisionReturnRate: rate(exactRoundVerdicts.size, totals.exactVerdicts),
    resolutionRate: rate(totals.resolvedRounds, totals.exactVerdictRounds),
    refusalRate: rate(exactRefusalVerdicts.size, totals.exactApproved),
    reviewers: [...rows.values()].sort((a, b) => a.label.localeCompare(b.label)).slice(0, 100),
    omittedReviewers: Math.max(0, rows.size - 100),
    // Without verdicts nothing is proven, so the calibration evidence stays partial.
    evidence: totals.verdicts === 0 ? "partial" : evidence.size > 1 ? "mixed" : evidence.has(true) ? "exact" : "partial",
  };
}

