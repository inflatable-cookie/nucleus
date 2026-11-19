/** A prompt measurement contains counts only, never prompt text or credentials. */
export interface PromptSize {
  total: number;
  sections: Record<string, number>;
}

/**
 * Count named, rendered fragments without double-counting overlapping text.
 * Callers give fragments in priority order. Every remaining character belongs to
 * `other`, so section counts always sum to the exact transmitted size.
 */
export function measurePrompt(prompt: string, fragments: ReadonlyArray<readonly [string, string]>): PromptSize {
  const occupied = new Uint8Array(prompt.length);
  const sections: Record<string, number> = {};
  for (const [name, fragment] of fragments) {
    if (!fragment) continue;
    let from = 0;
    while (from <= prompt.length - fragment.length) {
      const start = prompt.indexOf(fragment, from);
      if (start < 0) break;
      let count = 0;
      for (let i = start; i < start + fragment.length; i++) {
        if (!occupied[i]) { occupied[i] = 1; count++; }
      }
      sections[name] = (sections[name] ?? 0) + count;
      from = start + fragment.length;
    }
  }
  sections.other = prompt.length - Object.values(sections).reduce((sum, size) => sum + size, 0);
  return { total: prompt.length, sections };
}

import type { Run, Task } from '../../../shared/contracts';
import { queueBriefBlock, queueLaneBlock, queueLaneDocumentBlock } from './task-blocks';
import { proofFilesBlock } from './proof-rules';
import { operatorValidationBlock, affectedRunReviewerNote } from './validation';
import { AUTHOR_BLOCKER_RULE, RESPONSIBLE_FORCE_RULE, RESPONSIBLE_OWNERSHIP_RULE, responsibleAskInTurnRule, responsibleBlockerLadderRule, responsibleMessageRule } from './report-rules';

/** Classify the variable and standing fragments used by the current renderers. */
export function measureRunPrompt(prompt: string, task: Task, run: Pick<Run, 'head' | 'temporaryDirectory'>, mcp: boolean, affectedTestsCommand?: string): PromptSize {
  return measurePrompt(prompt, [
    ['brief', queueBriefBlock(task)],
    ['proofFiles', proofFilesBlock(task, run.head)],
    ['lane', queueLaneBlock(task)],
    ['laneDocuments', queueLaneDocumentBlock(task, run.temporaryDirectory ?? task.temporaryDirectory)],
    ['validation', operatorValidationBlock(affectedTestsCommand)],
    ['validation', affectedTestsCommand ? affectedRunReviewerNote(affectedTestsCommand) : ''],
    ['standingRules', AUTHOR_BLOCKER_RULE],
    ['standingRules', RESPONSIBLE_FORCE_RULE],
    ['standingRules', RESPONSIBLE_OWNERSHIP_RULE],
    ['standingRules', responsibleAskInTurnRule(mcp)],
    ['standingRules', responsibleBlockerLadderRule(mcp)],
    ['standingRules', responsibleMessageRule(mcp)],
  ]);
}
