import type { DecisionView } from './contracts';

/** The asking project shown on a decision; an omitted project is its own General surface. */
export function decisionProjectLabel(decision: Pick<DecisionView, 'askedBy'>): string {
  const project = decision.askedBy.project;
  if (!project) return 'General';
  return project.origin?.split('/').at(-1) || project.path.split(/[\\/]/).filter(Boolean).at(-1) || project.path;
}

export function isGeneralDecision(decision: Pick<DecisionView, 'askedBy'>): boolean {
  return decision.askedBy.project === null;
}
