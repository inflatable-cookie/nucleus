/**
 * The task-context blocks every role prompt may carry: lane context and lane
 * documents, the Nucleus-held brief, siblings, worktree links, build output,
 * and the handoff/brief source line. Each block returns '' when the task does
 * not carry that context, so a task without it keeps its exact prompt.
 */
import type { Task } from '../../../shared/contracts';
import { currentBrief } from '../../planning/brief';
import { laneDocumentScratchPath } from '../../planning/brief-lane-documents';
import { buildOutputDisclosure } from '../../../shared/build-output-disclosure';

/**
 * Spec 019: a laned task carries the current title and aim as context, not
 * authority. Tasks without a lane get an empty block and keep their exact prompts.
 */
export function queueLaneBlock(task: Pick<Task, 'lanes' | 'laneContext'>) {
  const lanes = task.lanes ?? [];
  if (!lanes.length) return '';
  const contexts = lanes.map(key => (task.laneContext ?? []).find(context => context.key === key)).filter((context): context is NonNullable<typeof context> => Boolean(context));
  if (!contexts.length) return '';
  return `${contexts.map(context => `Lane context — not scope authority: ${context.title}\n${context.aim}\n`).join('')}The handoff or brief still governs this task's scope. The lane aim grants no additional authority.\n`;
}

/**
 * Spec 026: linked or cited lane documents are pinned and materialized in each
 * run's scratch. Tasks without a document get an empty block and keep their prompts.
 */
export function queueLaneDocumentBlock(task: Pick<Task, 'laneDocumentPins' | 'laneDocumentIssues'>, directory?: string | null) {
  const pins = task.laneDocumentPins ?? [];
  const pathBlock = directory && pins.length
    ? `Read-only lane document copies for this run:\n${pins.map(pin => `- ${pin.key}: ${laneDocumentScratchPath(directory, pin.key)}`).join('\n')}\n`
    : '';
  const issueBlock = task.laneDocumentIssues?.length
    ? `Lane document references not found in the current plan (resolve and read as needed before relying on them): ${task.laneDocumentIssues.join(', ')}\n`
    : '';
  if (!pins.length) return `${pathBlock}${issueBlock}`;
  return `${pathBlock}${issueBlock}${pins.map(pin => `Lane document — context, not scope authority: ${pin.key} version ${pin.version}, ${pin.digest}
----- BEGIN LANE DOCUMENT ${pin.key} -----
${pin.text}
----- END LANE DOCUMENT ${pin.key} -----
`).join('')}`;
}

/**
 * Spec 020: a brief-mode task carries its pinned brief inline, labelled as held
 * by Nucleus. Handoff-mode tasks get an empty block and keep their exact prompts.
 */
export function queueBriefBlock(task: Pick<Task, 'briefVersions' | 'planningCommit'>) {
  const current = currentBrief(task);
  if (!current) return '';
  const amended = current.version > 1 ? `This brief was amended to version ${current.version}. Amendment reason: ${current.reason}\nEarlier versions are superseded; follow this version.\n` : '';
  return `Nucleus-held brief: version ${current.version}, ${current.digest}, written against planning ${task.planningCommit}.
Nucleus holds this brief. It is not a repository file: do not commit it, copy it into the repository, or look for it under docs/handoffs.
${amended}----- BEGIN QUEUE-HELD BRIEF -----
${current.text}
----- END QUEUE-HELD BRIEF -----
`;
}

/**
 * Spec 027: sibling context. The worker, revision and reviewer prompts name the
 * Nucleus-owned sibling worktrees and say they are read-only by rule. Tasks with
 * `queue.siblings: false` or no sibling pins get an empty block and keep their
 * exact prompts.
 */
export function queueSiblingBlock(task: Pick<Task, 'siblingPins' | 'siblingFindings' | 'hostId'>) {
  const pins = task.siblingPins ?? [];
  if (!pins.length) return '';
  const lines = pins.map(pin => `- ${pin.repository} at ${pin.path} (pinned at ${pin.commit})`).join('\n');
  const findings = (task.siblingFindings ?? []).map(finding =>
    `- ${finding.repository} at ${finding.path}: expected ${finding.expected}, observed ${finding.actual ?? 'missing'}${finding.dirty ? ', dirty' : ''}`).join('\n');
  // BB registers the task worktree as an external directory and its provider runs
  // inside an OS sandbox that may create nothing beside the checkout, so Nucleus
  // places one link per pinned sibling there before the worker launches
  // (nucleus#1315). Paseo worktree roots carry the repository's own link-task
  // clones already, so no such line is added there.
  const linked = typeof task.hostId === 'string' && task.hostId.startsWith('bb:')
    ? `\nNucleus links each of these pinned checkouts beside this checkout (${pins.map(pin => `../${pin.path.split('/').pop() || pin.repository}`).join(', ')}), so a relative sibling path resolves without any other preparation. A missing link is a blocker to report, never permission to create one from the sandbox.`
    : '';
  return `Sibling repositories (read-only by rule; never edit, commit, merge or push them — the fix for a real change is a linked task):\n${lines}${linked}\n${findings ? `Recorded sibling changes under review:\n${findings}\n` : ''}`;
}

/**
 * Spec 028: worktree-root sibling checkouts Nucleus did not fast-forward. Empty
 * when every sibling was clean, detached and current (or none exist).
 */
export function queueCheckoutSiblingBlock(task: Pick<Task, 'checkoutSiblingFindings'>) {
  const findings = task.checkoutSiblingFindings ?? [];
  if (!findings.length) return '';
  return `Worktree-root sibling checkouts Nucleus did not fast-forward (dirty, branched or diverged checkouts are left untouched):\n${findings.map(finding => `- ${finding.detail}`).join('\n')}\n`;
}

/**
 * Links-only provisioning (Tom, 2026-10-23): what Nucleus placed beside a new
 * checkout, and what it did not run. Empty when nothing was declared.
 */
export function queueWorktreeLinkBlock(task: Pick<Task, 'worktreeLinks'>, recordFailure?: string | null) {
  // This launch's own attempt could not record its result: say so, claim nothing.
  if (recordFailure) return `Worktree links: Nucleus could not record its links-only provisioning result (${recordFailure}). Installs, builds and container attach were NOT run, and sibling links may be missing. These links grant no authority to replace, repair, build or install sources, or to substitute another checkout. A missing link or step your work depends on is a blocker to report.\n`;
  const record = task.worktreeLinks;
  if (record?.state !== 'prepared' || (!record.links.length && !record.findings.length)) return '';
  const placed = record.links.filter(link => link.outcome === 'created' || link.outcome === 'reused');
  const refused = record.links.filter(link => link.outcome === 'conflict' || link.outcome === 'failed');
  return `Worktree links: this checkout skipped the repository's paseo.json worktree.setup. Nucleus did links-only partial provisioning: it placed only the sibling links declared by nucleus worktree prepare and the primary's Effigy dependency ledger. Installs, builds and container attach were NOT run.
${placed.length ? `Links beside this checkout. Each target is a live configured checkout on any branch, possibly dirty, not a pinned dependency:\n${placed.map(link => `- ../${link.name} -> ${link.target} (${link.outcome})`).join('\n')}\n` : ''}${refused.length ? `Links Nucleus did not place:\n${refused.map(link => `- ../${link.name} -> ${link.target}: ${link.outcome}${link.reason ? `, ${link.reason}` : ''}`).join('\n')}\n` : ''}${record.findings.length ? `Link declaration findings:\n${record.findings.map(finding => `- ${finding.kind}${finding.name ? ` ${finding.name}` : ''}: ${finding.detail}`).join('\n')}\n` : ''}These links grant no authority to replace, repair, build or install their sources, or to substitute another checkout. A missing link or step your work depends on is a blocker to report.
`;
}

/**
 * Queue #395: a continuation may reuse the artifacts an earlier run left.
 * Run-bound cleanup is recorded only for a run that reported a result, and a
 * `complete` record names Nucleus's own obligation rather than what is present
 * now, so the block quotes the stored records before any reuse instruction.
 */
export function queueBuildOutputBlock(task: Pick<Task, 'resolution' | 'workspaceId'>, subjectRunId?: string | null) {
  const disclosure = buildOutputDisclosure(task.resolution?.buildOutputCleanups, { workspaceId: task.workspaceId, runId: subjectRunId ?? null });
  return disclosure ? `${disclosure.text}\n` : '';
}

/** The line naming the instruction source: the committed handoff, or the Nucleus-held brief. */
export const sourceLine = (task: Task) => currentBrief(task) ? '' : `Committed handoff: ${task.handoffPath} at ${task.planningCommit}\n`;
