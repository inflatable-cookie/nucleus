import type { Resolution } from '../resolution';
import type { DelegatedAnswer } from './question-delegation';

/**
 * The question service's shared in-flight state.
 *
 * A question raise, the answer that settles it and the recovery sweep that resumes
 * it are separate owners (`question-raises.ts`, `question-raise-routes.ts`,
 * `question-answers.ts`, `question-recovery.ts`); this class holds the one set of
 * maps they share, so the in-flight guard a raise holds and the answer that
 * releases it are never two copies. `Resolution` reads the same maps through its
 * getters.
 */
export class Questions {
  constructor(readonly resolution: Resolution) {}
  readonly queueAskRaiseAnsweredBy = new Map<string, string>();
  readonly queueAskRaises = new Map<string, { resolve: (answer: string) => void; reject: (error: Error) => void }>();
  readonly recoveringQueueAsks = new Set<string>();
  readonly delegatedAnswers = new Map<string, DelegatedAnswer>();
  readonly responsibleQuestions = new Map<string, AbortController>();
  supersedeBudgetQuestions(taskId: string, reason: string): string[] {
    return this.resolution.questionSupersession.supersedeBudgetQuestions(taskId, reason);
  }
}
