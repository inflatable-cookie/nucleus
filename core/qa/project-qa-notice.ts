import type { ProjectQaRun } from "../../shared/contracts";
import { parseAgentId } from "../../shared/agent-identity";
import { hostKindOf } from "../../shared/host-kind";

/** Bare historical thread IDs are Paseo IDs; qualified identities retain their host boundary. */
export function projectQaRecipientKey(agentId: string): string {
  const qualified = parseAgentId(agentId);
  if (!qualified) return `paseo:${agentId}`;
  if (hostKindOf(qualified.hostId) === "paseo") return `paseo:${qualified.nativeAgentId}`;
  return `${qualified.hostId}:${qualified.nativeAgentId}`;
}

/** Preserve the first spelling while collapsing qualified and bare forms of one thread. */
export function uniqueProjectQaRecipients(agentIds: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const agentId of agentIds) {
    if (!agentId) continue;
    const key = projectQaRecipientKey(agentId);
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(agentId);
  }
  return recipients;
}

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
