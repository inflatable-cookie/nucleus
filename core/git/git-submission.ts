/**
 * Submission validation: what may be submitted, and what the recorded planning
 * identity must prove before a task exists.
 *
 * Submission is a read-only check of one repository and one commit; it never
 * mutates the checkout it reads. A brief's pinned identity is proved here too,
 * because a later dispatch verifies the same facts.
 */
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Submission, Task } from "../../shared/contracts";
import type { InstructionArtifact } from "../../shared/hooks";
import { CONTROL_SCHEMA_V5, manifestSupportsCloseoutSelection } from "../../shared/hooks";
import { discoverManifest, instructionForCommit, pinInstruction } from "../hooks/hook-manifest";
import { assertOneInstructionSource, briefDigest, currentBrief, pinnedBriefDigest } from "../planning/brief";
import { git, gitAncestry, requireGitAncestry } from "./git-command";

export interface PlanningHeadProof { head: string; planningCommit: string; ancestor?: boolean }

export async function validateSubmission(input: Submission) {
  if (!isAbsolute(input.repoPath) || await realpath(input.repoPath) !== input.repoPath) throw new Error("Use the repository's absolute real path");
  if (await git(input.repoPath, "rev-parse", "--show-toplevel") !== input.repoPath) throw new Error("Repository path must name its Git root");
  await git(input.repoPath, "check-ref-format", "--branch", input.baseBranch);
  assertOneInstructionSource(input);
  if (input.brief) return validateBriefSubmission(input);
  if (input.handoffPath.startsWith("/") || input.handoffPath.split("/").some(p => !p || p === "." || p === "..") || input.handoffPath.includes("\\")) throw new Error("Handoff must be a repository-relative file path");
  const tree = await git(input.repoPath, "ls-tree", input.planningCommit, "--", input.handoffPath);
  if (!/^100(644|755) blob /.test(tree)) throw new Error("Handoff must be a regular tracked file at the planning commit");
  const instruction = await resolveInstruction(input);
  const handoffText = await git(input.repoPath, "show", `${input.planningCommit}:${input.handoffPath}`);
  if (!handoffText || handoffText.length > 128000) throw new Error("Handoff is empty or exceeds 128 KB");
  const planningBase = await git(input.repoPath, "rev-parse", `refs/heads/${input.baseBranch}`);
  await requireGitAncestry(input.repoPath, input.planningCommit, planningBase,
    "Planning commit is not on the base branch; submit a commit the base contains");
  return { handoffText, planningBase, instruction };
}
/**
 * Spec 020 brief submission: nothing is read from or written to the repository
 * except the manifest eligibility and planning ancestry at the planning commit.
 */
async function validateBriefSubmission(input: Submission) {
  pinnedBriefDigest(input);
  if (input.instruction) throw new Error("A Queue-held brief carries no committed instruction artifact");
  await assertBriefEligible(input.repoPath, input.planningCommit);
  // Spec 022: the planning base is the pushed integration head, fetched fresh.
  // A shared checkout that is merely behind origin still validates against what
  // is pushed, because capture pinned the pushed head as the planning commit.
  try { await git(input.repoPath, "fetch", "origin", input.baseBranch); }
  catch (error) { throw new SubmissionUnavailableError(`Submission awaits Git remote: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  const planningBase = await git(input.repoPath, "rev-parse", `refs/remotes/origin/${input.baseBranch}`);
  const relation = await gitAncestry(input.repoPath, input.planningCommit, planningBase);
  if (relation === 'unknown') throw new Error("Brief planning ancestry cannot be read; the submission is unchanged, so retry once the repository reads");
  if (relation !== 'ancestor') throw new Error("Brief planning commit is not on the integration branch");
  return { handoffText: input.brief!.text, planningBase, instruction: null };
}
/**
 * Brief mode runs only where no lifecycle hook reads a committed handoff: a v5,
 * v6 or v7 manifest at the planning commit, or no manifest. v1–v4 are refused.
 */
export async function assertBriefEligible(repoPath: string, planningCommit: string) {
  const discovery = await discoverManifest(repoPath, planningCommit);
  if (discovery && !manifestSupportsCloseoutSelection(discovery.manifest.schema))
    throw new Error(`Brief mode requires a ${CONTROL_SCHEMA_V5} control manifest or none; this repository's manifest at ${planningCommit.slice(0, 12)} is ${discovery.manifest.schema}, whose lifecycle hooks read committed handoffs. Submit a committed handoff instead.`);
}
/** A brief task's pinned text must be exactly its current recorded version. */
export function assertPinnedBrief(task: Task) {
  const current = currentBrief(task);
  if (!current || current.text !== task.handoffText || current.digest !== briefDigest(task.handoffText)) throw new Error("Queue-held brief does not match its pinned version");
}
/** Prove a brief worker's source identity, accounting for an external PR intake. */
export async function verifyBriefWorkerIdentity(task: Task, directory: string, head: string, ordinaryFailure = "Brief planning commit is not an ancestor of the worker worktree"): Promise<void> {
  assertPinnedBrief(task);
  if (task.reviewEntry) {
    const { planningCommit, verifiedBase, verifiedHead } = task.reviewEntry;
    if (planningCommit !== task.planningCommit)
      throw new Error("Brief review-entry base does not descend from the planning commit");
    await requireGitAncestry(directory, planningCommit, verifiedBase,
      "Brief review-entry base does not descend from the planning commit");
    await requireGitAncestry(directory, verifiedHead, head,
      "Brief review-entry worker head does not descend from the recorded intake head");
    return;
  }
  await requireGitAncestry(directory, task.planningCommit, head, ordinaryFailure);
}
/** A read-only submission check can wait safely for its Git remote without losing intent. */
export class SubmissionUnavailableError extends Error {}

/** Verify pushed planning after acceptance; fetch before ancestry checks and never mutate the checkout. */
export async function verifyPublishedPlanning(input: Submission): Promise<void> {
  try { await git(input.repoPath, "fetch", "origin", input.baseBranch); }
  catch (error) { throw new SubmissionUnavailableError(`Submission awaits Git remote: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  const local = await git(input.repoPath, "rev-parse", `refs/heads/${input.baseBranch}`);
  const remote = await git(input.repoPath, "rev-parse", `refs/remotes/origin/${input.baseBranch}`);
  const pushed = await gitAncestry(input.repoPath, local, remote);
  if (pushed === 'unknown') throw new Error("Cannot prove the integration commit is pushed: Git ancestry is unreadable");
  if (pushed !== 'ancestor') throw new Error("Push the integration commit before queue submission");
  await requireGitAncestry(input.repoPath, input.planningCommit, remote,
    "Submitted planning commit is not contained in the pushed integration branch");
}

/** Resolve the immutable generic instruction identity, validating any supplied artifact. */
async function resolveInstruction(input: Submission): Promise<InstructionArtifact> {
  if (!input.instruction) return instructionForCommit(input.repoPath, input.planningCommit, input.handoffPath, "text/markdown");
  if (input.instruction.commit !== input.planningCommit || input.instruction.path !== input.handoffPath) throw new Error("Instruction identity must match the committed planning base");
  return pinInstruction(input.repoPath, input.instruction);
}
/** Use a private linked base checkout without switching the registered main checkout. */
