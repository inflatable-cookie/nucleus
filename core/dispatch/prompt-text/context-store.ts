import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Run, Task } from '../../../shared/contracts';
import { writeOwnedJson } from '../../machine/owned-file.mjs';
import { proofFilesBlock } from './proof-rules';
import { operatorValidationBlock, VALIDATION_RUN_RULE } from './validation';
import { roleRules } from './standing-rules';

export const CONTEXT_SECTIONS = ['rules', 'validation', 'proofs', 'history'] as const;
export type ContextSection = typeof CONTEXT_SECTIONS[number];
export type RunContext = Record<ContextSection, string>;

/** Extended text is advisory data. Safety and authority remain in the prompt and gates. */
export function buildRunContext(task: Task, run: { id: string; role: Run['role'] | 'worker'; head: string }, mcp: boolean, affectedTestsCommand?: string): RunContext {
  return {
    rules: roleRules(run.role),
    validation: `${operatorValidationBlock(affectedTestsCommand, run.role === 'reviewer')}\n${VALIDATION_RUN_RULE}`,
    proofs: proofFilesBlock(task, run.head),
    history: JSON.stringify({ checkpoints: task.checkpoints ?? null, reviews: task.resolution?.reviews ?? [], review: task.resolution?.review ?? null, buildOutputCleanups: task.resolution?.buildOutputCleanups ?? [] }, null, 2),
  };
}

const contextPath = (directory: string) => join(directory, 'nucleus-context', 'sections.json');

/** Publish only into the already-proved run scratch leaf. */
export function materializeRunContext(directory: string, runId: string, sections: RunContext): void {
  const root = realpathSync(directory);
  const contextDirectory = join(directory, 'nucleus-context');
  mkdirSync(contextDirectory, { recursive: true, mode: 0o700 });
  if (lstatSync(contextDirectory).isSymbolicLink() || realpathSync(contextDirectory) !== join(root, 'nucleus-context')) throw new Error('Run context directory is redirected');
  writeOwnedJson(contextPath(directory), { runId, sections });
}

/** Caller identity is authenticated by the callback before this function is called. */
export function readRunContext(directory: string, runId: string, section?: ContextSection): RunContext | string {
  const value = JSON.parse(readFileSync(contextPath(directory), 'utf8')) as { runId: string; sections: RunContext };
  if (value.runId !== runId) throw new Error('Context belongs to a different run');
  return section ? value.sections[section] : value.sections;
}
