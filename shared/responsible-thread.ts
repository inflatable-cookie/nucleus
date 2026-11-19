/**
 * Why one live thread is a candidate for a project's cross-project messages,
 * strongest first. `project.get` reports the same list so a routing choice can
 * be checked without reading the queue's internals (nucleus#1379).
 *
 * - `registered-planner`: the project's `project.set-planner` thread.
 * - `dispatcher`: a thread that dispatched or owns tasks in the project.
 * - `registered-agent`: a thread named with `agent.register`.
 * - `repository-worker`: a thread that only works in a project checkout.
 */
export const RESPONSIBLE_THREAD_REASONS = [
  "registered-planner",
  "dispatcher",
  "registered-agent",
  "repository-worker",
] as const;

export type ResponsibleThreadReason = (typeof RESPONSIBLE_THREAD_REASONS)[number];
