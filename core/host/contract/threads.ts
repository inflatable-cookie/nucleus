import type { Task } from '../../../shared/contracts';

/** The threads themselves: creating one for a task, finding the ones that exist, stopping a turn, and archiving or deleting a finished thread. */
export interface HostThreads {
  createAgent(task: Task, token: string, prompt: string, legacyPrompt?: string): Promise<{ id: string; workspaceId: string | null }>;
  findAgents(task: Task): Promise<{ id: string; workspaceId: string | null }[]>;
  /** Stop the assigned agent's current turn without delivering a follow-up message. */
  stopAgentTurn?(agentId: string): Promise<void>;
  archiveAgent(agentId: string): Promise<void>;
  /**
   * Permanently remove one thread at closeout (nucleus#1155). Present exactly
   * when the host can remove a thread: on such a host a task's support threads
   * stay settled while it is open and are removed when it ends, and a host
   * without this method keeps today's archive behaviour (Paseo).
   */
  deleteAgent?(agentId: string): Promise<void>;
}
