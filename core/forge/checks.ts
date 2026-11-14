import { type Task, type RepositoryChecksPolicy } from '../../shared/contracts';
import { api, repo, commandErrorText, type CheckEvidenceTransport } from './github-client';
import { type Store } from '../store/store';
import { verifyPr, command } from '../git/index';
import { taskPrNumber } from './pr-identity';

export type PrCheck = {__typename:string;databaseId?:number;name?:string;context?:string;status?:string;conclusion?:string;state?:string;startedAt?:string;completedAt?:string;detailsUrl?:string;targetUrl?:string;title?:string;summary?:string;text?:string;checkSuite?:{app?:{databaseId?:number|null}|null}|null;steps?:{name?:string;conclusion?:string|null;status?:string|null}[];labels?:string[];annotations?:{message?:string;title?:string}[]};
/** Hosted-runner acquisition signature: the job never ran, so its cancellation proves infrastructure, never code.
 * Every alternative names a runner, so an unrelated annotation that merely contains
 * "acquisition" (or "acquired" without a runner) never matches. */
export const HOSTED_RUNNER_ACQUISITION_PATTERN = /not acquired by runner|was not acquired by runner|runner of type hosted|no (available )?runner|runner[^.]{0,60}(unavailable|timed? ?out|timeout|acquir)|acquir[^.]{0,60}runner/i;
function checkRunnerAcquisitionText(check: PrCheck): string {
  const annotations = (check.annotations ?? []).map(annotation => `${annotation.title ?? ''} ${annotation.message ?? ''}`.trim()).filter(Boolean);
  return [check.title ?? '', check.summary ?? '', check.text ?? '', ...annotations].filter(Boolean).join('\n');
}
/** A CANCELLED check run proves infrastructure only with fetched positive evidence: an
 * explicitly empty step list (the job never executed) or a runner-acquisition annotation.
 * A bare CANCELLED conclusion with no step or annotation evidence stays semantic, so a
 * job cancelled after executing steps, or cancelled for another reason, never takes the
 * infrastructure path. */
export function isInfrastructureCancellation(check: PrCheck): boolean {
  if (check.__typename !== 'CheckRun' || check.status !== 'COMPLETED' || check.conclusion !== 'CANCELLED') return false;
  if (check.steps !== undefined) return check.steps.length === 0 || HOSTED_RUNNER_ACQUISITION_PATTERN.test(checkRunnerAcquisitionText(check));
  return HOSTED_RUNNER_ACQUISITION_PATTERN.test(checkRunnerAcquisitionText(check));
}
/** The Actions workflow run and job behind a check-run details URL, with the owning repository. */
export function workflowJobRefFromJobUrl(detailsUrl?: string): {owner: string; repo: string; runId: string; jobId: string} | null {
  const match = (detailsUrl ?? '').match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)/);
  if (!match) return null;
  const [owner, repo] = match[1].split('/');
  return {owner, repo, runId: match[2], jobId: match[3]};
}
/** Distinct workflow run ids behind infrastructure-cancelled checks, for one same-head rerun each. */
function infraWorkflowRunIds(checks: PrCheck[]): string[] {
  const ids = new Set<string>();
  for (const check of checks) {
    if (!isInfrastructureCancellation(check)) continue;
    const ref = workflowJobRefFromJobUrl(check.detailsUrl);
    if (ref) ids.add(ref.runId);
  }
  return [...ids];
}
/** Fetch Actions job steps for queued checks too, so an overdue runnerless job can
 * take the same guarded infrastructure retry path as a proven pre-run cancellation. */
export async function enrichPendingCheckEvidence(t: Task, checks: PrCheck[], transport: CheckEvidenceTransport = api, repository?: string): Promise<{checks: PrCheck[]; uninferred: string[]}> {
  const out = checks.map(check => ({...check, annotations: check.annotations?.map(note => ({...note}))}));
  const uninferred: string[] = [];
  const name = repository ?? await repo(t);
  for (const check of out) {
    if (check.__typename !== 'CheckRun' || !(check.status === 'QUEUED' || check.status === 'COMPLETED' && check.conclusion === 'CANCELLED')) continue;
    if (check.steps !== undefined && (check.status === 'QUEUED' || check.steps.length === 0 || HOSTED_RUNNER_ACQUISITION_PATTERN.test(checkRunnerAcquisitionText(check)))) continue;
    let stepsKnown = check.steps !== undefined;
    if (!stepsKnown) {
      const ref = workflowJobRefFromJobUrl(check.detailsUrl);
      if (ref) {
        try {
          const record = await transport(t, `repos/${name}/actions/jobs/${ref.jobId}`) as {steps?: {name?: string; conclusion?: string | null; status?: string | null}[]; labels?: unknown};
          if (record && Array.isArray(record.steps)) { check.steps = record.steps; stepsKnown = true; }
          if (record && Array.isArray(record.labels)) check.labels = record.labels.filter((label): label is string => typeof label === 'string').slice(0, 20);
        } catch { /* annotations next for cancellations; queued checks remain ordinary pending */ }
      }
    }
    if (check.status === 'COMPLETED' && !HOSTED_RUNNER_ACQUISITION_PATTERN.test(checkRunnerAcquisitionText(check)) && typeof check.databaseId === 'number' && !(check.annotations?.length)) {
      try {
        const notes = await transport(t, `repos/${name}/check-runs/${check.databaseId}/annotations`) as {message?: unknown; title?: unknown}[];
        if (Array.isArray(notes)) check.annotations = notes.map(note => ({message: String(note.message ?? ''), title: String(note.title ?? '')}));
      } catch { /* uninferred below */ }
    }
    if (check.status === 'COMPLETED' && !stepsKnown && !(check.annotations?.length) && !HOSTED_RUNNER_ACQUISITION_PATTERN.test(checkRunnerAcquisitionText(check))) uninferred.push(checkName(check));
  }
  return {checks: out, uninferred};
}
const CHECK_DURATION_META_PREFIX = "checkDuration:";
const CHECK_PENDING_META_PREFIX = "checkPendingSince:";
const CHECK_COMPLETED_META_PREFIX = "checkCompleted:";
const REQUIRED_CHECK_POLL_META_PREFIX = "requiredCheckPoll:";
export const REQUIRED_CHECK_POLL_INTERVAL_MS = 60_000;
export const REQUIRED_CHECK_ESCALATION_MS = 60 * 60_000;
export const PENDING_CHECK_FALLBACK_MS = 30 * 60 * 1000;
function checkDurationMetaKey(repo: string, name: string) { return `${CHECK_DURATION_META_PREFIX}${repo}:${name}`; }
function checkPendingMetaKey(repo: string, head: string, name: string) { return `${CHECK_PENDING_META_PREFIX}${JSON.stringify([repo, head, name])}`; }
function checkCompletedMetaKey(repo: string, name: string) { return `${CHECK_COMPLETED_META_PREFIX}${repo}:${name}`; }
export function requiredCheckPollMetaKey(taskId: string, head: string) { return `${REQUIRED_CHECK_POLL_META_PREFIX}${taskId}:${head}`; }
export type CheckHistory = {
  now?: number;
  forHead?: (head: string) => CheckHistory;
  durations?: (name: string) => number[];
  record?: (name: string, durationMs: number, completedAt?: string) => void;
  pendingSince?: (name: string) => string | undefined;
  clearPending?: (name: string) => void;
};
export function pendingCheckDeadlineMs(recentDurationsMs: number[]): number {
  if (!recentDurationsMs.length) return PENDING_CHECK_FALLBACK_MS;
  return Math.max(...recentDurationsMs) * 3;
}
export function isPendingCheckDeadlineReason(reason: string): boolean {
  return reason.includes("has been pending past its deadline") && reason.includes("job URL:");
}
/**
 * The merge gate's failed-check refusal text. Queue records this exact string as
 * the author's revision instruction, so a later observation of the identical
 * text at the identical head is the same failed evidence, not a new finding.
 */
const FAILED_CHECKS_REASON_PREFIX = "PR checks failed: ";
export function isFailedChecksReason(text: string | null | undefined): boolean {
  return Boolean(text && text.startsWith(FAILED_CHECKS_REASON_PREFIX));
}
/**
 * A reviewer-named proof that is actually a forge CI check (papercut c0fb3df9).
 * Matched by name or URL: a GitHub Actions run/job URL, a job/run ID pair, or
 * explicit check language. The merge gate's required-check wait already covers
 * it, so it is never an awaiting proof and never raises a proof question.
 */
export function isForgeCheckProofText(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text.trim();
  if (!normalized) return false;
  if (/github\.com\/[^\s]+\/actions\/(runs|jobs)/i.test(normalized)) return true;
  if (/\bjob\b[^\n]{0,80}\b\d{5,}\b/i.test(normalized) && /\brun\b[^\n]{0,80}\b\d{5,}\b/i.test(normalized)) return true;
  if (/\b(required\s+checks?|forge\s+checks?|CI\s+checks?|GitHub\s+(checks?|jobs?|workflows?|runs?))\b/i.test(normalized)) return true;
  if (/\b(queued|pending|running)\s+GitHub\s+job\b/i.test(normalized)) return true;
  return false;
}
function checkName(check: PrCheck) { return check.name ?? check.context ?? "unnamed check"; }
function checkJobUrl(check: PrCheck) { return check.detailsUrl?.trim() || check.targetUrl?.trim() || "(no job URL)"; }
function formatCheckWait(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  const hours = Math.round(ms / 3_600_000 * 10) / 10;
  return `${hours}h`;
}
function startedAtMs(check: PrCheck, history: CheckHistory | undefined, now: number): number | null {
  if (check.startedAt) {
    const started = Date.parse(check.startedAt);
    return Number.isFinite(started) ? started : null;
  }
  const seen = history?.pendingSince?.(checkName(check));
  if (!seen) return now;
  const started = Date.parse(seen);
  return Number.isFinite(started) ? started : now;
}
export function classifyPrChecks(checks: PrCheck[], history?: CheckHistory) {
  const now = history?.now ?? Date.now();
  for (const check of checks) {
    if (check.__typename === "CheckRun" ? check.status === "COMPLETED" : !["PENDING", "EXPECTED"].includes(check.state ?? "")) history?.clearPending?.(checkName(check));
    if (check.__typename !== "CheckRun" || check.status !== "COMPLETED" || !check.startedAt || !check.completedAt) continue;
    if (!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion ?? "")) continue;
    const duration = Date.parse(check.completedAt) - Date.parse(check.startedAt);
    if (Number.isFinite(duration) && duration > 0) history?.record?.(checkName(check), duration, check.completedAt);
  }
  const failed = checks.filter(c => (c.__typename === "CheckRun" ? c.status === "COMPLETED" && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion ?? "") : !["SUCCESS", "PENDING", "EXPECTED"].includes(c.state ?? "")) && !isInfrastructureCancellation(c));
  if (failed.length) return { wait: `${FAILED_CHECKS_REASON_PREFIX}${failed.map(check => `${checkName(check)} (job URL: ${checkJobUrl(check)})`).join(", ")}`, checksFailed: true as const };
  const infrastructure = checks.filter(isInfrastructureCancellation);
  if (infrastructure.length) return { wait: `Required checks cancelled before running (hosted-runner acquisition): ${infrastructure.map(check => `${checkName(check)} (job URL: ${checkJobUrl(check)})`).join(", ")}`, checksFailed: false as const, infrastructure: true as const, pendingCheck: true as const, infraRunIds: infraWorkflowRunIds(infrastructure) };
  const pending = checks.filter(c => c.__typename === "CheckRun" ? c.status !== "COMPLETED" : c.state !== "SUCCESS");
  const overdueChecks: {check: PrCheck; waited: number; deadline: number}[] = [];
  for (const check of pending) {
    const name = checkName(check);
    const deadline = pendingCheckDeadlineMs(history?.durations?.(name) ?? []);
    const started = startedAtMs(check, history, now);
    if (started == null) continue;
    const waited = now - started;
    if (waited < deadline) continue;
    overdueChecks.push({check, waited, deadline});
  }
  if (overdueChecks.length) {
    const {check, waited, deadline} = overdueChecks[0];
    const name = checkName(check), url = checkJobUrl(check);
    return {
      wait: `Required check '${name}' (${check.status === 'QUEUED' ? 'queued, no runner yet' : check.status === 'IN_PROGRESS' ? `in_progress for ${formatCheckWait(waited)}` : String(check.status ?? 'pending').toLowerCase()}) has been pending past its deadline (${formatCheckWait(waited)} elapsed, bound ${formatCheckWait(deadline)});${check.labels?.length ? ` runner label: ${check.labels.join(', ')};` : ''} job URL: ${url}`,
      checksFailed: false as const,
      overdue: true as const,
      pendingCheck: true as const,
      overdueCheck: { key: `${name}\u0000${url}`, name, state: check.status ?? check.state ?? 'PENDING', elapsedMs: waited, jobUrl: url, runnerLabels: check.labels ?? [] },
    };
  }
  if (pending.length) return { wait: "PR checks are pending", checksFailed: false as const, pendingCheck: true as const };
  return { wait: "", checksFailed: false as const };
}

/**
 * Task 382: one hosted check GitHub requires for the exact PR base branch.
 * `appId` is the GitHub App the check must come from (`null` when the
 * requirement only names a context); `source` records which forge surface it
 * came from so a recorded observation stays inspectable.
 */
type RequiredCheckRequirement = {context: string; appId: number | null; source: "protection-context" | "protection-check" | "ruleset"};
/** `known` is the only admissible proof of an empty requirement set; anything unreadable, refused or malformed stays unknown and holds visibly. */
export type CheckRequirements = {known: true; requirements: RequiredCheckRequirement[]; sources: {classicProtection: boolean; rulesets: boolean}} | {known: false; reason: string};
/**
 * One hosted check as observed at the exact head, with the identity GitHub gave
 * it (GraphQL type, check-run id and app binding) and its effective
 * classification. A required entry records what gated the task; an advisory
 * entry records a result Queue deliberately did not gate on. Evidence only:
 * neither rewrites a check conclusion nor proves a targeted test ran.
 */
export type CheckObservation = {identity: string; name: string; state: string; conclusion: string; jobUrl: string; databaseId: number | null; appId: number | null; classification: "required" | "advisory"};
export type CheckClassification = {
  wait: string;
  checksFailed?: boolean;
  overdue?: boolean;
  pendingCheck?: boolean;
  infrastructure?: boolean;
  infraRunIds?: string[];
  overdueCheck?: {key: string; name: string; state: string; elapsedMs: number; jobUrl: string; runnerLabels: string[]};
  checksPolicy?: RepositoryChecksPolicy;
  requirements?: {known: boolean; required: number; reason?: string};
  /** Non-required results recorded as evidence under an advisory policy. */
  advisory?: CheckObservation[];
  /** The required results (including a required context nobody reported) the same observation gated on. */
  requiredEvidence?: CheckObservation[];
};
/** What a merge gate reports: its wait plus the policy and advisory evidence behind it. */
export type GateEvidence = CheckClassification & {head: string; base: string; needsRebase?: boolean; timings?: Record<string, number>};

const ADVISORY_EVIDENCE_MAX = 50;
function boundedCheckText(value: unknown, max = 500): string {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : String(value ?? "");
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}
/** The HTTP status gh reported for a failed API call, or null when the failure carries none. */
function githubHttpStatus(error: unknown): number | null {
  const extra = error && typeof error === "object" ? error as {stderr?: unknown; stdout?: unknown; message?: unknown} : {};
  const text = [extra.stderr, extra.stdout, extra.message].filter((part): part is string => typeof part === "string").join("\n");
  const match = text.match(/\(HTTP (\d{3})\)/) ?? text.match(/\bHTTP (\d{3})\b/);
  return match ? Number(match[1]) : null;
}
function optionalAppId(value: unknown): number | null | "malformed" {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0) return Number(value);
  return "malformed";
}
/** Flatten `gh api --paginate --slurp` output (array of pages) and a plain array page alike; anything else is malformed. */
function paginatedRuleList(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  if (value.every(item => !Array.isArray(item))) return value;
  if (value.every(item => Array.isArray(item))) return value.flat();
  return null;
}
export type CheckRequirementTransport = (t: Task, endpoint: string, args?: string[]) => Promise<unknown>;
/** The bounded per-task record of the last advisory-policy check observation (task 382). */
export function checkPolicyObservationKey(taskId: string) { return `checkPolicyObservation:${taskId}`; }
/**
 * A classic-protection read that positively proves this repository has no
 * classic required status checks: GitHub's own "Branch not protected" or
 * "Required status checks not enabled" 404, or the documented refusal for a
 * private repository that cannot configure branch protection at all. Any other
 * 404/403 is ambiguous — GitHub returns 404 for resources the caller may not
 * read — and stays unknown evidence.
 */
function isPlanRefusal(error: unknown): boolean {
  return githubHttpStatus(error) === 403 && /upgrade to github pro or make this repository public/i.test(commandErrorText(error));
}
function isAbsentClassicProtection(error: unknown): boolean {
  const status = githubHttpStatus(error), text = commandErrorText(error);
  if (/branch not protected|required status checks not enabled/i.test(text)) return status === 404;
  if (isPlanRefusal(error)) return true;
  return false;
}
/**
 * Discover what the exact PR base branch actually requires on GitHub: classic
 * branch protection required status checks and every applicable ruleset's
 * required status checks, including their app binding.
 *
 * A 404 from the classic endpoint is positive evidence that this branch has no
 * classic required status checks. Every other failure — authorization, missing
 * permission, transport, a malformed or paginated-incomplete response — is
 * unknown evidence and never an empty requirement set: the caller holds and
 * re-observes rather than letting a local advisory setting weaken GitHub.
 */
export async function requiredCheckRequirements(t: Task, owner: string, repository: string, branch: string, transport: CheckRequirementTransport = api): Promise<CheckRequirements> {
  const problems: string[] = [];
  const requirements: RequiredCheckRequirement[] = [];
  let classicProtection = false, rulesets = false;
  const protectionEndpoint = `repos/${owner}/${repository}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`;
  try {
    const protection = await transport(t, protectionEndpoint) as {contexts?: unknown; checks?: unknown} | null | undefined;
    classicProtection = true;
    if (!protection || typeof protection !== "object" || Array.isArray(protection)) problems.push("classic required status checks returned no record");
    else {
      // GitHub reports the same contexts twice: `checks` carries the app binding
      // and `contexts` repeats them as legacy names. The binding is the narrower
      // truth, so a context present in `checks` never also becomes an unbound
      // requirement; only contexts the bound list does not name stay unbound.
      const bound: {context: string; appId: number | null}[] = [];
      if (protection.checks !== undefined) {
        if (!Array.isArray(protection.checks)) problems.push("classic required status check app bindings are malformed");
        else for (const check of protection.checks) {
          const context = (check as {context?: unknown})?.context, appId = optionalAppId((check as {app_id?: unknown})?.app_id);
          if (typeof context !== "string" || !context.trim() || appId === "malformed") problems.push("classic required status check app binding is malformed");
          else bound.push({context: context.trim(), appId});
        }
      }
      for (const entry of bound) requirements.push({...entry, source: "protection-check"});
      if (protection.contexts === undefined) problems.push("classic required status check contexts are missing");
      else if (!Array.isArray(protection.contexts)) problems.push("classic required status check contexts are malformed");
      else for (const context of protection.contexts) {
        if (typeof context !== "string" || !context.trim()) { problems.push("classic required status check context is malformed"); continue; }
        const name = context.trim();
        if (bound.some(entry => entry.context === name)) continue;
        requirements.push({context: name, appId: null, source: "protection-context"});
      }
    }
  } catch (error) {
    if (isAbsentClassicProtection(error)) classicProtection = true;
    else problems.push(`classic required status checks are unavailable: ${boundedCheckText(commandErrorText(error))}`);
  }
  const rulesEndpoint = `repos/${owner}/${repository}/rules/branches/${encodeURIComponent(branch)}?per_page=100`;
  try {
    const pages = await transport(t, rulesEndpoint, ["--paginate", "--slurp"]);
    const rules = paginatedRuleList(pages);
    if (!rules) problems.push("branch rules are malformed or pagination is incomplete");
    else {
      rulesets = true;
      for (const rule of rules) {
        if (!rule || typeof rule !== "object" || Array.isArray(rule)) { problems.push("a branch rule is malformed"); continue; }
        const item = rule as {type?: unknown; parameters?: unknown};
        // The rule type is the discriminator: without it a record cannot be told
        // apart from a truncated required-check rule, so it stays unknown.
        if (typeof item.type !== "string" || !item.type.trim()) { problems.push("a branch rule is missing its type discriminator"); continue; }
        if (item.type !== "required_status_checks") continue;
        const parameters = item.parameters;
        if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) { problems.push("a ruleset required status checks rule is malformed"); continue; }
        const required = (parameters as {required_status_checks?: unknown}).required_status_checks;
        if (!Array.isArray(required)) { problems.push("a ruleset required status checks rule is malformed"); continue; }
        for (const entry of required) {
          const context = (entry as {context?: unknown})?.context, appId = optionalAppId((entry as {integration_id?: unknown})?.integration_id);
          if (typeof context !== "string" || !context.trim() || appId === "malformed") { problems.push("a ruleset required status check is malformed"); continue; }
          requirements.push({context: context.trim(), appId, source: "ruleset"});
        }
      }
    }
  } catch (error) {
    problems.push(`branch rules are unavailable: ${boundedCheckText(commandErrorText(error))}`);
  }
  if (problems.length) return {known: false, reason: problems.slice(0, 8).join("; ")};
  const seen = new Set<string>();
  const deduped = requirements.filter(requirement => {
    const key = `${requirement.context}\u0000${requirement.appId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {known: true, requirements: deduped, sources: {classicProtection, rulesets}};
}
/**
 * Task 393: GitHub's explicit refusal to offer required-check rules for a
 * repository's plan or visibility. Activating a `required` policy on such a
 * repository would accept a setting whose requirement surface Queue can never
 * read, so it is refused before the setting is written.
 */
function isUnsupportedRequiredCheckPlan(error: unknown): boolean {
  return githubHttpStatus(error) === 403
    && /upgrade to github pro or make this repository public/i.test(commandErrorText(error));
}
/**
 * Whether `repository.set` may accept `checksPolicy: "required"` for a
 * repository. The probe derives the canonical `owner/name` identity and the
 * repository's own default branch from GitHub (never a guessed branch, and
 * never a claim that one branch proves every future PR base), then reuses the
 * ordinary requirement observation to establish that classic branch protection
 * and the applicable rulesets are readable at all.
 *
 * A positive answer only permits the owner's setting: it is not cached and it
 * is not merge proof. Every unreadable, unauthorized, malformed, ambiguous or
 * plan-refused capability stays unsupported with a bounded reason, so no
 * activation can turn a failure into an empty requirement set.
 */
type RequiredCheckPolicyCapability =
  | {supported: true; branch: string; requirements: {known: true; required: number}}
  | {supported: false; branch: string | null; kind: "unsupported" | "unknown"; reason: string};
export async function requiredCheckPolicyCapability(t: Task, owner: string, repository: string, transport: CheckRequirementTransport = api): Promise<RequiredCheckPolicyCapability> {
  const slug = `${owner}/${repository}`;
  const refusal = (branch: string | null, kind: "unsupported" | "unknown", reason: string): RequiredCheckPolicyCapability => ({supported: false, branch, kind, reason});
  let record: unknown;
  try {
    record = await transport(t, `repos/${owner}/${repository}`);
  } catch (error) {
    if (isUnsupportedRequiredCheckPlan(error)) return refusal(null, "unsupported", `GitHub refuses required-check rules for ${slug} on this plan or visibility: ${boundedCheckText(commandErrorText(error))}`);
    return refusal(null, "unknown", `the repository record for ${slug} could not be read, so its default branch is unknown: ${boundedCheckText(commandErrorText(error))}`);
  }
  const details = record && typeof record === "object" && !Array.isArray(record)
    ? record as {default_branch?: unknown; full_name?: unknown} : null;
  const branch = details && typeof details.default_branch === "string" ? details.default_branch.trim() : "";
  if (!branch) return refusal(null, "unknown", `GitHub's record for ${slug} reported no default branch, so the requirement surface to observe is unknown`);
  // A renamed or redirected repository answers with another canonical name. The
  // setting names this origin, so activating against a different repository is
  // refused rather than written under an identity nobody asked for.
  const fullName = details && typeof details.full_name === "string" ? details.full_name.trim() : "";
  if (fullName && fullName.toLowerCase() !== slug.toLowerCase())
    return refusal(branch, "unknown", `GitHub resolves ${slug} to ${fullName}; the repository identity is not canonical`);
  // The wrapper records the plan refusal without changing what the ordinary
  // requirement observation returns: the merge gate keeps its own established
  // classification, and only activation is refused here.
  const planRefusals: string[] = [];
  const recording: CheckRequirementTransport = async (task, endpoint, args) => {
    try {
      return await transport(task, endpoint, args);
    } catch (error) {
      if (isUnsupportedRequiredCheckPlan(error)) planRefusals.push(boundedCheckText(commandErrorText(error)));
      throw error;
    }
  };
  const requirements = await requiredCheckRequirements(t, owner, repository, branch, recording);
  if (planRefusals.length) return refusal(branch, "unsupported", `GitHub refuses required-check rules for ${slug} on this plan or visibility, so a "required" policy could read no enforceable requirements: ${planRefusals[0]}. Make the repository public or upgrade its plan, or keep the default "all" policy`);
  if (!requirements.known) return refusal(branch, "unknown", `the required-check requirements for ${slug}'s default branch ${branch} could not be established: ${requirements.reason}`);
  return {supported: true, branch, requirements: {known: true, required: requirements.requirements.length}};
}
/** The GitHub App database id on a check run, when the observation carries one. */
function checkAppId(check: PrCheck): number | null {
  const app = check.checkSuite?.app?.databaseId;
  return typeof app === "number" && Number.isSafeInteger(app) ? app : null;
}
/** A check satisfies a requirement only when its context matches and, for an app-bound requirement, it is a check run from that exact app. An app-bound requirement is never satisfied by a legacy status context or by an observation whose app identity is missing. */
function checkSatisfiesRequirement(check: PrCheck, requirement: RequiredCheckRequirement): boolean {
  if (checkName(check) !== requirement.context) return false;
  if (requirement.appId === null) return true;
  return check.__typename === "CheckRun" && checkAppId(check) === requirement.appId;
}
function observedCheckState(check: PrCheck): {state: string; conclusion: string} {
  if (check.__typename === "CheckRun") return {state: check.status ?? "UNKNOWN", conclusion: check.conclusion ?? ""};
  return {state: check.state ?? "UNKNOWN", conclusion: ""};
}
function observedCheckEvidence(check: PrCheck, classification: "required" | "advisory"): CheckObservation {
  const {state, conclusion} = observedCheckState(check);
  return {
    identity: check.__typename, name: checkName(check).slice(0, 200), state, conclusion,
    jobUrl: checkJobUrl(check).slice(0, 500), databaseId: typeof check.databaseId === "number" ? check.databaseId : null,
    appId: checkAppId(check), classification,
  };
}
/** Evidence for a list of observed checks, bounded by the same cap as the recorded observation. */
function checkEvidence(checks: PrCheck[], classification: "required" | "advisory"): CheckObservation[] {
  return checks.slice(0, ADVISORY_EVIDENCE_MAX).map(check => observedCheckEvidence(check, classification));
}
/**
 * Split observed checks into the ones GitHub requires for this base branch and
 * the ones a `required` policy makes advisory. A required context with no
 * matching observation (or with only an app-mismatched, same-named check) is
 * added as an `EXPECTED` status context, so it takes the existing pending and
 * pending-deadline path instead of silently becoming absent.
 */
export function partitionPrChecks(checks: PrCheck[], requirements: RequiredCheckRequirement[]): {required: PrCheck[]; advisory: PrCheck[]} {
  const required: PrCheck[] = [], advisory: PrCheck[] = [], matched = new Set<number>(), pushed = new Set<number>();
  checks.forEach((check, index) => {
    if (!requirements.some(requirement => checkSatisfiesRequirement(check, requirement))) return;
    matched.add(index);
    if (pushed.has(index)) return;
    pushed.add(index);
    required.push(check);
  });
  for (const requirement of requirements) {
    if (checks.some(check => checkSatisfiesRequirement(check, requirement))) continue;
    required.push({__typename: "StatusContext", context: requirement.context, state: "EXPECTED"});
  }
  checks.forEach((check, index) => { if (!matched.has(index)) advisory.push(check); });
  return {required, advisory};
}
/** The requirement summary recorded beside an observation. */
function requirementSummary(requirements: CheckRequirements | undefined): {known: boolean; required: number; reason?: string} {
  if (!requirements) return {known: false, required: 0, reason: "required checks were not observed"};
  if (!requirements.known) return {known: false, required: 0, reason: requirements.reason};
  return {known: true, required: requirements.requirements.length};
}
/** The hold every advisory classification uses when GitHub's requirements are unreadable, refused or malformed. */
function unknownRequirementsHold(requirements: CheckRequirements | undefined, policy: RepositoryChecksPolicy): CheckClassification {
  const summary = requirementSummary(requirements);
  const reason = summary.reason ?? "required checks were not observed";
  return {wait: `GitHub required checks for this base branch could not be established: ${reason}`, checksFailed: false, pendingCheck: true, checksPolicy: policy, requirements: summary};
}
/** Classify already-partitioned checks: only required checks gate, advisory ones become bounded evidence. */
function classifyPartitionedChecks(required: PrCheck[], advisory: PrCheck[], history: CheckHistory | undefined, requirements: CheckRequirements, policy: RepositoryChecksPolicy): CheckClassification {
  const classified = classifyPrChecks(required, history);
  return {...classified, checksPolicy: policy, requirements: requirementSummary(requirements),
    requiredEvidence: checkEvidence(required, "required"), advisory: checkEvidence(advisory, "advisory")};
}
/**
 * Classify checks for the exact head and policy, fetching the runner evidence
 * the infrastructure path needs only for required checks. Advisory checks are
 * never enriched, so an advisory cancellation or queued job can neither hold
 * the task nor spend the one same-head rerun intent.
 */
export async function observeCheckClassification(t: Task, checks: PrCheck[], history: CheckHistory | undefined, policy: RepositoryChecksPolicy, requirements: CheckRequirements | undefined, owner: string, repository: string, transport: CheckEvidenceTransport = api): Promise<CheckClassification> {
  if (policy === "all") {
    const prepared = await enrichPendingCheckEvidence(t, checks, transport, `${owner}/${repository}`);
    if (prepared.uninferred.length) return {wait: `Cancelled checks lack step evidence; re-observing: ${prepared.uninferred.join(', ')}`, pendingCheck: true as const, checksPolicy: policy};
    return {...classifyPrChecks(prepared.checks, history), checksPolicy: policy};
  }
  if (!requirements || !requirements.known) return unknownRequirementsHold(requirements, policy);
  const partition = partitionPrChecks(checks, requirements.requirements);
  const prepared = await enrichPendingCheckEvidence(t, partition.required, transport, `${owner}/${repository}`);
  if (prepared.uninferred.length) return {
    wait: `Required checks lack step evidence; re-observing: ${prepared.uninferred.join(', ')}`, pendingCheck: true as const,
    checksPolicy: policy, requirements: requirementSummary(requirements),
    requiredEvidence: checkEvidence(partition.required, "required"), advisory: checkEvidence(partition.advisory, "advisory"),
  };
  return classifyPartitionedChecks(prepared.checks, partition.advisory, history, requirements, policy);
}

export function branchRequiresUpToDate(rules: unknown[], protection: {strict?: boolean} | null | undefined) {
  if (protection?.strict) return true;
  return (Array.isArray(rules) ? rules : []).some(rule => {
    if (!rule || typeof rule !== 'object') return false;
    const item = rule as {type?: unknown; parameters?: {strict_required_status_checks_policy?: unknown}};
    return item.type === 'required_status_checks' && item.parameters?.strict_required_status_checks_policy === true;
  });
}

export function checkHistoryFromStore(store: Store, repo: string, now = Date.now(), head = ""): CheckHistory {
  return {
    now,
    forHead: (observedHead) => checkHistoryFromStore(store, repo, now, observedHead),
    durations: (name) => store.getMeta<number[]>(checkDurationMetaKey(repo, name)) ?? [],
    record: (name, ms, completedAt) => {
      if (completedAt) {
        const seenKey = checkCompletedMetaKey(repo, name);
        if (store.getMeta<string>(seenKey) === completedAt) return;
        store.setMeta(seenKey, completedAt);
      }
      const key = checkDurationMetaKey(repo, name);
      const prev = store.getMeta<number[]>(key) ?? [];
      store.setMeta(key, [...prev, ms].slice(-20));
    },
    pendingSince: (name) => {
      const key = checkPendingMetaKey(repo, head, name);
      const existing = store.getMeta<string>(key);
      if (existing) return existing;
      const at = new Date(now).toISOString();
      store.setMeta(key, at);
      return at;
    },
    clearPending: (name) => store.deleteMeta(checkPendingMetaKey(repo, head, name)),
  };
}
/** Read only the exact PR's required checks. Queue uses this while yielding the
 * repository integration turn, then reacquires the turn and runs every merge gate
 * again before acting on a settled check result. */
export async function requiredChecks(t: Task, history?: CheckHistory, checksPolicy: RepositoryChecksPolicy = 'all'): Promise<CheckClassification & {head: string}> {
  const verify = verifyPr;
  const pr = await verify(t, taskPrNumber(t));
  const name = await repo(t), [owner, repository] = name.split('/');
  const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid baseRefName isDraft state statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{databaseId name status conclusion startedAt completedAt detailsUrl checkSuite{app{databaseId}}} ... on StatusContext{context state targetUrl}}pageInfo{hasNextPage}}}}}}`;
  const data = await api(t, 'graphql', ['-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `repo=${repository}`, '-F', `number=${taskPrNumber(t)}`]);
  if (data.errors?.length) throw new Error('Required check re-observation query failed');
  const p = data.data?.repository?.pullRequest;
  if (!p || p.headRefOid !== pr.head || p.headRefOid !== t.prHead || p.baseRefName !== t.baseBranch || p.isDraft || p.state !== 'OPEN') throw new Error('PR identity changed while required checks were pending');
  if (p.statusCheckRollup?.contexts.pageInfo.hasNextPage) throw new Error('Required check pagination is incomplete');
  const requirements = checksPolicy === 'required' ? await requiredCheckRequirements(t, owner, repository, t.baseBranch) : undefined;
  const checks = await observeCheckClassification(t, p.statusCheckRollup?.contexts.nodes ?? [], history?.forHead?.(pr.head) ?? history, checksPolicy, requirements, owner, repository);
  return { head: pr.head, ...checks };
}
export async function branchUpdateRequired(t: Task, owner: string, repo: string, branch: string, read: CheckRequirementTransport = api) {
  let result: unknown;
  try {
    result = await read(t, `repos/${owner}/${repo}/rules/branches/${encodeURIComponent(branch)}?per_page=100`, ["--paginate", "--slurp"]);
  } catch (error) {
    if (!isPlanRefusal(error)) throw error;
    result = [];
  }
  const rules = paginatedRuleList(result);
  if (!rules || rules.some(rule => !rule || typeof rule !== 'object' || Array.isArray(rule) || typeof (rule as {type?: unknown}).type !== 'string')) throw Error('Branch rules are malformed or incomplete');
  for (const rule of rules) {
    const item = rule as {type: string; parameters?: {strict_required_status_checks_policy?: unknown}};
    if (item.type === 'required_status_checks' && typeof item.parameters?.strict_required_status_checks_policy !== 'boolean') throw Error('Strict branch rule is malformed');
  }
  let protection: {strict: boolean} | null = null;
  try {
    const value = await read(t, `repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`);
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as {strict?: unknown}).strict !== 'boolean') throw Error('Classic strict branch rule is malformed');
    protection = value as {strict: boolean};
  } catch (error) { if (!isAbsentClassicProtection(error)) throw error; }
  return branchRequiresUpToDate(rules, protection);
}
/** Dispatch one same-head rerun of failed jobs for each workflow run behind an
 * infrastructure cancellation. Every run is head-guarded: a run whose head no longer
 * equals the recorded PR head is skipped, never rerun. Returns the rerun run ids. */
export async function rerunFailedWorkflowRuns(t: Task, runIds: string[]): Promise<string[]> {
  const name = await repo(t);
  const head = t.prHead;
  if (!head) throw new Error('Same-head workflow rerun requires the recorded PR head');
  const reran: string[] = [];
  for (const runId of runIds) {
    if (!/^\d+$/.test(runId)) continue;
    const run = await api(t, `repos/${name}/actions/runs/${runId}`) as {head_sha?: unknown};
    if (run.head_sha !== head) continue;
    reran.push(runId);
  }
  if (!reran.length) throw new Error('No workflow run at the reviewed head remains to rerun');
  for (const runId of reran) await command('gh', ['run', 'rerun', runId, '--failed', '--repo', name], t.repoPath);
  return reran;
}
