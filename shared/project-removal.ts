import type { Decision, Lane, Lead, PendingSubmission, Project, ProjectRemovalBlocker, ProjectRemovalBlockerKind } from './contracts';
import { normalizeRepositoryOrigin } from './lanes';

/**
 * Spec 027: what blocks deleting a project record. One owner for the rule, so the
 * store's refusal and the board's confirmation name the same blockers. A project
 * is delete-able only when nothing still uses it: no non-terminal task, no open
 * lead or papercut, no open decision, no active lane and no pending submission.
 */
export type { ProjectRemovalBlocker, ProjectRemovalBlockerKind };

/** A task as either the store or the board sees it: full tasks and summaries both fit. */
type BlockerTask = { id: string; title: string; repoPath: string; repository?: string | null; phase: string; number?: number | null; reference?: string | null };
/** An outcome resolves a purged task's repository for a decision's link. */
type BlockerOutcome = { taskId: string; repository: { origin: string | null; path: string } };
/** A numbering row survives a task's purge, so it resolves a link with no outcome. */
type BlockerTaskNumber = { taskId: string; repository: string };

/**
 * The records a blocker scan resolves against. `tasks`, `leads`, `outcomes` and
 * `taskRepositories` should be the caller's fullest history, whatever each
 * record's state: direct blockers are filtered here, but an open decision's
 * links must resolve through removed tasks and terminal records too, or a
 * decision linked only to purged history is missed.
 */
export interface ProjectRemovalState {
  tasks: BlockerTask[];
  leads: Lead[];
  outcomes?: BlockerOutcome[];
  taskRepositories?: BlockerTaskNumber[];
  lanes: Array<Pick<Lane, 'key' | 'title' | 'status' | 'repositories'>>;
  submissions: PendingSubmission[];
  decisions: Decision[];
}

/**
 * A project member matches a record's remote identity or its checkout path.
 * `identity` is an origin slug when it normalises to one; otherwise it is a
 * checkout path (a task's stored repository identity is the checkout path when
 * no origin is known), so it is compared against the member's path as well.
 */
export function projectRepositoryMatches(project: Project, repoPath?: string | null, identity?: string | null): boolean {
  const origin = identity ? normalizeRepositoryOrigin(identity) : null;
  return project.repositories.some(repo => origin && repo.origin
    ? repo.origin === origin
    : Boolean(repo.path && ((repoPath && repo.path === repoPath) || (identity && repo.path === identity))));
}

export function projectRemovalBlockers(project: Project, state: ProjectRemovalState): ProjectRemovalBlocker[] {
  const blockers: ProjectRemovalBlocker[] = [];
  const matches = (repoPath?: string | null, origin?: string | null) => projectRepositoryMatches(project, repoPath, origin);

  const tasks = state.tasks.filter(task => task.phase !== 'done' && task.phase !== 'cancelled' && matches(task.repoPath, task.repository));
  if (tasks.length) blockers.push({ kind: 'task', label: 'task', names: tasks.map(task => task.reference ?? task.id) });

  const leads = state.leads.filter(lead => lead.state === 'open' && lead.repositories.some(repo => matches(repo.path, repo.origin)));
  const papercuts = leads.filter(lead => lead.tags.includes('papercut'));
  const openLeads = leads.filter(lead => !lead.tags.includes('papercut'));
  if (openLeads.length) blockers.push({ kind: 'lead', label: 'open lead', names: openLeads.map(lead => lead.title) });
  if (papercuts.length) blockers.push({ kind: 'papercut', label: 'open papercut', names: papercuts.map(lead => lead.title) });

  const lanes = state.lanes.filter(lane => (lane.status === 'active' || lane.status === 'paused') && lane.repositories.some(repo => matches(repo.path, repo.origin)));
  if (lanes.length) blockers.push({ kind: 'lane', label: 'active lane', names: lanes.map(lane => lane.title || lane.key) });

  const submissions = state.submissions.filter(submission => matches(submission.repoPath, submission.repository));
  if (submissions.length) blockers.push({ kind: 'submission', label: 'pending submission', names: submissions.map(submission => submission.title || submission.id) });

  const decisions = state.decisions.filter(decision => decision.status === 'open' && (
    Boolean(decision.askedBy.project && matches(decision.askedBy.project.path, decision.askedBy.project.origin))
    || decision.links.tasks.some(id =>
      state.tasks.some(task => task.id === id && matches(task.repoPath, task.repository))
      || (state.outcomes ?? []).some(outcome => outcome.taskId === id && matches(outcome.repository.path, outcome.repository.origin))
      || (state.taskRepositories ?? []).some(entry => entry.taskId === id && matches(entry.repository, entry.repository)))
    || decision.links.leads.some(id => state.leads.some(lead => lead.id === id && lead.repositories.some(repo => matches(repo.path, repo.origin))))
    || decision.links.papercuts.some(id => state.leads.some(lead => lead.id === id && lead.repositories.some(repo => matches(repo.path, repo.origin))))));
  if (decisions.length) blockers.push({ kind: 'decision', label: 'open decision', names: decisions.map(decision => decision.question) });

  return blockers;
}

/** Every blocker type and a few of each, as the refusal and the board both word them. */
export function projectRemovalBlockerText(blockers: ProjectRemovalBlocker[]): string {
  return blockers.map(blocker => {
    const shown = blocker.names.slice(0, 3).join(', ');
    const more = blocker.names.length > 3 ? `, +${blocker.names.length - 3} more` : '';
    return `${blocker.names.length} ${blocker.label}${blocker.names.length === 1 ? '' : 's'} (${shown}${more})`;
  }).join('; ');
}

/** The refusal an operator sees, naming every blocker type and a few of each. */
export function projectRemovalRefusal(project: Project, blockers: ProjectRemovalBlocker[]): string {
  return `Project ${project.key} cannot be removed: ${projectRemovalBlockerText(blockers)}`;
}

const CARRIED_NOUNS: Record<ProjectRemovalBlockerKind, [string, string]> = {
  task: ['task', 'tasks'], lead: ['lead', 'leads'], papercut: ['papercut', 'papercuts'], lane: ['lane', 'lanes'],
  submission: ['submission', 'submissions'], decision: ['decision', 'decisions'], operation: ['operation', 'operations'], qa: ['QA run', 'QA runs'],
};

/** nucleus#984: what a move carries along, counted ("2 leads, 1 papercut"); empty when nothing comes. */
export function projectCarriedText(carried: ProjectRemovalBlocker[]): string {
  return carried.filter(item => item.names.length).map(item => {
    const [one, many] = CARRIED_NOUNS[item.kind];
    return `${item.names.length} ${item.names.length === 1 ? one : many}`;
  }).join(', ');
}
