/**
 * The one entrance to a dispatched run's prompt: which role's prompt a run
 * gets, and nothing about how that prompt reads. Each role's text has its own
 * owner, and the scope and callback a run shares are built once in
 * `prompt-context.ts`.
 */
import type { Run, Task } from '../../../shared/contracts';
import type { RecoveryDispatchSnapshot } from '../../recovery/recovery-context';
import type { OwnerReviewContext } from '../../review/owner-review-context';
import { executorRunPrompt } from './executor-prompt';
import { runPromptContext } from './prompt-context';
import { closeoutRunPrompt, recoveryRunPrompt } from './recovery-prompt';
import { reviewerRunPrompt } from './reviewer-prompt';
import { revisionRunPrompt } from './revision-prompt';
import { unmeasuredSection, type PromptSection } from './measure';

/**
 * One dispatched run's prompt for its role. Verification runs are retired, so
 * they refuse here rather than rendering a prompt nothing can deliver.
 */
export function runPrompt(task: Task, run: Run, helper: string, ticket: string, mcp = false, context: RecoveryDispatchSnapshot | null = null, ownerContext: OwnerReviewContext | null = null, affectedTestsCommand?: string, section: PromptSection = unmeasuredSection): string {
  if (run.role === 'verification') throw new Error('Verification coordinator runs are retired');
  const prompt = runPromptContext(task, run, helper, ticket, mcp, affectedTestsCommand, section);
  if (run.role === 'recovery') return recoveryRunPrompt(prompt, context);
  if (run.role === 'revision') return revisionRunPrompt(prompt);
  if (run.role === 'executor') return executorRunPrompt(prompt);
  if (run.role === 'reviewer') return reviewerRunPrompt(prompt, ownerContext);
  return closeoutRunPrompt(prompt);
}
