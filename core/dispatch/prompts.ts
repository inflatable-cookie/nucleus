/**
 * The prompts Nucleus dispatches with, one module per mechanism: the fixed
 * rules, the task-context blocks, the per-role prompt text, the run's shared
 * scope and callback, and the role dispatch. This module is the public surface;
 * callers import it, never a prompt module directly.
 */
export * from './prompt-text/validation';
export * from './prompt-text/report-rules';
export * from './prompt-text/proof-rules';
export * from './prompt-text/review-rules';
export * from './prompt-text/workspace-text';
export * from './prompt-text/task-blocks';
export * from './prompt-text/revision-text';
export * from './prompt-text/revision-prompt';
export * from './prompt-text/worker-prompt';
export * from './prompt-text/reviewer-prompt';
export * from './prompt-text/recovery-prompt';
export * from './prompt-text/executor-prompt';
export * from './prompt-text/prompt-context';
export * from './prompt-text/run-prompt';
