/** This run's Nucleus ticket, read and checked once; see bin/run-ticket.mjs. */
export type RunTicket = {
  path: string;
  ticket: Record<string, unknown>;
  participantId: string | null;
  taskId: string | null;
  runId: string | null;
  credential: { socketPath: string; token: string } | null;
};
export function runTicketPath(env?: NodeJS.ProcessEnv): string | null;
export function continuationRunId(env?: NodeJS.ProcessEnv): string | null;
export function readRunTicket(env?: NodeJS.ProcessEnv): RunTicket | null;
export function credentialFor(ticket: RunTicket | null, purpose: string): { socketPath: string; token: string };
