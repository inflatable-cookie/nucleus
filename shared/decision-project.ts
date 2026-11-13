import type { DecisionView } from './contracts';

/** A machine identity Nucleus could not place; the board shows this instead of the raw ID. */
export const UNKNOWN_ASKER_LABEL = 'an earlier thread';

/** The asking project shown on a decision; an omitted project is its own General surface. */
export function decisionProjectLabel(decision: Pick<DecisionView, 'askedBy'>): string {
  const project = decision.askedBy.project;
  if (!project) return 'General';
  return project.origin?.split('/').at(-1) || project.path.split(/[\\/]/).filter(Boolean).at(-1) || project.path;
}

export function isGeneralDecision(decision: Pick<DecisionView, 'askedBy'>): boolean {
  return decision.askedBy.project === null;
}
