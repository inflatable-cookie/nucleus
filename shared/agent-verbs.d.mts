import type { z } from 'zod';

export declare const ASK_ROUTE_KEYWORDS: readonly ['reviewer', 'planner'];
export declare const TELL_ROLE_KEYWORDS: readonly ['reviewer', 'worker', 'planner', 'executor'];
export declare const TASK_ROLES: readonly ['worker', 'reviewer', 'planner', 'executor'];
export declare const VERB_TEXT_MAX_CHARS: number;
export declare const verbTargetSchema: z.ZodType<VerbTarget>;
export declare const askFieldShape: Record<string, z.ZodType>;
export declare const askInputShape: Record<string, z.ZodType>;
export declare const tellInputShape: Record<string, z.ZodType>;

/** A recipient as a caller names it: a keyword, a task reference, or an object. */
export type VerbTarget = 'reviewer' | 'worker' | 'planner' | 'executor' | string | { project: string; agent?: string } | { task: string; role?: TaskRole } | { reply: string };
export type TaskRole = 'worker' | 'reviewer' | 'planner' | 'executor';

export type AskTarget =
  | { kind: 'default' }
  | { kind: 'reviewer' }
  | { kind: 'planner' }
  | { kind: 'project'; project: string; agent: string | null }
  | { kind: 'task'; task: string; role: 'planner' }
  | { kind: 'reply'; reply: string };

export type TellTarget =
  | { kind: 'counterpart'; role: 'reviewer' | 'worker' | 'executor' }
  | { kind: 'planner' }
  | { kind: 'task'; task: string; role: TaskRole }
  | { kind: 'project'; project: string; agent: string | null }
  | { kind: 'reply'; reply: string };

export declare function normalizeAskTarget(to: VerbTarget | undefined, legacyTarget?: 'reviewer' | 'planner'): AskTarget;
export declare function normalizeTellTarget(to: VerbTarget | undefined, role?: TaskRole): TellTarget;
