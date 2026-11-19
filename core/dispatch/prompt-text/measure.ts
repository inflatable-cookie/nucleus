import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeOwnedJson } from '../../machine/owned-file.mjs';
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

/** Write only character counts for the exact launch attempt, never prompt text. */
export function writePromptSize(directory: string, runId: string, role: string, size: PromptSize): void {
  writeOwnedJson(join(directory, 'nucleus-prompt-size.json'), { runId, role, ...size });
}

/** A failed or missing telemetry read must not turn a sent prompt into a retry. */
export function recordPromptSize(store: { event(taskId: string, kind: string, detail: string): unknown }, taskId: string, runId: string, directory?: string): void {
  if (!directory) return;
  try {
    const result = JSON.parse(readFileSync(join(directory, 'nucleus-prompt-size.json'), 'utf8'));
    const names = ['brief', 'proofFiles', 'lane', 'laneDocuments', 'validation', 'standingRules', 'other'];
    if (result.runId !== runId || !['worker', 'revision', 'reviewer', 'recovery', 'executor', 'closeout'].includes(result.role) || !Number.isSafeInteger(result.total) || result.total < 0 || result.total > 10_000_000 || !result.sections || typeof result.sections !== 'object') return;
    const sections: Record<string, number> = {};
    for (const name of names) {
      const value = result.sections[name];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 0 || value > result.total) return;
      sections[name] = value;
    }
    if (Object.values(sections).reduce((a, b) => a + b, 0) !== result.total) return;
    store.event(taskId, 'prompt_size', JSON.stringify({ runId, role: result.role, total: result.total, sections }));
  } catch { /* telemetry cannot change delivery state */ }
}
