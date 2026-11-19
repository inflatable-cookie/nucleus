import type { PromptSection } from './measure';

/** Standing guidance shared with the Nucleus skill and the per-run context store. */
export const WORKER_RULES = `Own decisions within the brief and record material decisions and reasons in the PR's Decisions list. Approve binary choices by default, including budget extensions. Bring product or scope changes, releases, outward actions and profiles that require board approval to the planner. For a board discussion, include the headline, two or three choices and consequences, your recommended choice and the details.

Work around blockers within the approved scope first. If a second opinion is needed, ask the retained reviewer. Ask the planner once in the current turn when a ruling is needed. If the answer is pending, collect it later with the identical question. After one reviewer consult, report a remaining blocker with what you tried. Nucleus escalates once per cause to the project planner and joins repeats to the open escalation.

Use the ask and tell tools or feed the same JSON on stdin to \`nucleus ask -\` ({to, question, …}) and \`nucleus tell -\` ({to, text, role?}) with your current run binding. On BB, use the report command with the continuation variables from your prompt, adding \`ask\` or \`message\` to pass the same JSON. Address task roles or planners by role. Messages communicate information. Never resend a message or re-ask a question whose delivery is unknown.

Continue until you deliver or hit a concrete impediment. Push finished work before reporting blocked. For blocked or error include \`cause\` ({kind: 'external', name: '<short cause>'}, {kind: 'internal'} or {kind: 'unfinished'}) and \`impediment\` with the failed command or observed provider message. Classify admission, guard or budget refusals and proof or native-step failures as external. Unfinished work and context pressure call for continued work or a checkpoint where allowed. A blocked or error report without an impediment or new commit can continue the same thread at most twice before the planner ladder.

For a push or PR creation, observe the branch or PR before each retry and back off from 5 to 60 seconds for about 15 minutes on transient forge failures. Report the observed failure and elapsed wait if the retries are exhausted. For an obvious stuck thread or bookkeeping stop, request move or retry_effect with \`nucleus task -\`, force:true and observed evidence. For a failed forge check include the check, job URL and evidence that this diff could not have caused it. Force requires known causality.`;

export const REVIEWER_RULES = `Own the review judgment within the brief. Ask the planner once in the current turn when a ruling is needed. If the answer is pending, collect it later with the identical question. Use the ask and tell tools or feed the same JSON on stdin to \`nucleus ask -\` ({to, question, …}) and \`nucleus tell -\` ({to, text, role?}) with your current run binding. On BB, use the report command with the continuation variables from your prompt, adding \`ask\` or \`message\` to pass the same JSON. Address task roles or planners by role. Messages communicate information. Never resend a message or re-ask a question whose delivery is unknown.

For blocked or error include \`cause\` ({kind: 'external', name: '<short cause>'}, {kind: 'internal'} or {kind: 'unfinished'}) and \`impediment\` with the failed command or observed provider message. Classify admission, guard or budget refusals and proof or native-step failures as external. Use a review checkpoint for unfinished reading within the checkpoint allowance.

For an obvious stuck thread or bookkeeping stop, request move or retry_effect with \`nucleus task -\`, force:true and observed evidence. For a failed forge check include the check, job URL and evidence that this diff could not have caused it. Force requires known causality.`;

export const RECOVERY_RULES = `Own the recovery judgment and choose one available owner verb from current evidence. If a ruling or authority is missing, report coordinatorAction {verb: 'cannot', reason: '…'} and name what is missing. Recovery rulings go through the coordinator report. Never resend an unknown delivery.

For blocked or error include \`cause\` ({kind: 'external', name: '<short cause>'}, {kind: 'internal'} or {kind: 'unfinished'}) and \`impediment\` with the failed command, observed provider message or missing authority. Classify admission, guard or budget refusals and proof or native-step failures as external.

Use \`nucleus task -\` with force:true only for an obvious stuck thread or bookkeeping stop with observed evidence. For a failed forge check include the check, job URL and evidence that this diff could not have caused it. Force requires known causality.`;

const rulesByRole = {
  worker: ['Worker rules', WORKER_RULES],
  revision: ['Worker rules', WORKER_RULES],
  reviewer: ['Reviewer rules', REVIEWER_RULES],
  recovery: ['Recovery rules', RECOVERY_RULES],
} as const;
type RulesRole = keyof typeof rulesByRole;
type PromptRole = RulesRole | 'executor' | 'closeout' | 'verification';

function rulesFor(role: PromptRole) {
  return role === 'executor' || role === 'closeout' || role === 'verification' ? undefined : rulesByRole[role];
}

export function roleRules(role: PromptRole): string {
  return rulesFor(role)?.[1] ?? '';
}

export function contextPointer(role: PromptRole, section: PromptSection, command: string): string {
  const heading = rulesFor(role)?.[0];
  return section('standingRules', heading ? `Follow '${heading}' in the nucleus skill or read it with \`${command} context rules\`. ` : '')
    + section('contextIndex', `Extended context: \`${command} context [rules|validation|proofs|history]\`. Never resend an unknown delivery or use another thread's ticket.\n`);
}
