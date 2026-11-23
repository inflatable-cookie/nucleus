import type { AnsweredQuestionRead, HostPermissionDecision, NativeDecisionInput } from '../../../shared/host';
import type { Profile, Task } from '../../../shared/contracts';

/** The host native question surface: the answered and pending question reads, the answer, permission and dismissal sends, the task decision, the planner and reviewer asks, the consult reviewer and the decider. */
export interface HostNativeQuestions {
  /**
   * Spec 058 (task 542): recently answered native questions on one agent, oldest
   * first. The existing permission-resolution surface owns the read. A read
   * that fails is an explicit `{ok: false}` rather than an empty list, so the
   * caller records a lost observation as unknown and never resends.
   */
  answeredQuestions?(agentId: string): Promise<AnsweredQuestionRead>;
  pendingQuestions?(agentId: string): Promise<Array<{ requestId: string; questions: Array<{ header: string; question: string; options: string[] }> }>>;
  answerNativeQuestion?(agentId: string, workspaceId: string, requestId: string, answers: Record<string, string>): Promise<void>;
  /** One explicitly addressed native approval, retaining its stable durable send identity. */
  answerNativePermission?(agentId: string, workspaceId: string, requestId: string, decision: HostPermissionDecision, intentId: string, message?: string): Promise<void>;
  /** Dismiss one pending native question through the host; never used for tool or bash permissions. */
  dismissNativeQuestion?(agentId: string, workspaceId: string, requestId: string): Promise<void>;
  /**
   * Spec 058: ask a decision through the task's own native Paseo question. The
   * caller owns the durable send intent; an interrupted observation resolves as
   * unknown and is never permission to resend.
   */
  raiseTaskDecision?(task: Task, input: NativeDecisionInput): Promise<string>;
  /**
   * Send one question only when idle. Chat is never an answer; resolution waits for the command receipt.
   */
  askPlanner?(planner: string, input: { prompt: string; signal: AbortSignal; timeoutMs: number; messageId: string; sourceAgentId?: string }): Promise<string | null>;
  /**
   * Spec 058 slice 17 (task 584): ask the task's retained reviewer one consult turn — a second
   * opinion on a blocked report, never a review round. Answers arrive through the command receipt.
   */
  createConsultReviewer?(task: Task, input: { profile: Profile; id: string }): Promise<{ id: string; workspaceId: string | null }>;
  askReviewer?(reviewer: string, input: { prompt: string; signal: AbortSignal; timeoutMs: number; messageId: string; sourceAgentId?: string }): Promise<string | null>;
  /**
   * Spec 058 (task 540): start one short-lived decider agent in the task's workspace with the
   * given profile. Return its idle identity before delivery so the caller can register answer authority.
   */
  runDecider?(task: Task, input: { profile: Profile; signal: AbortSignal; timeoutMs: number; decisionId: string }): Promise<{ agentId: string; text: string | null }>;
  /** Spec 058 (task 540): answer the task thread's own native question through its permission id. */
  answerTaskDecision?(task: Task, input: { requestId: string; header: string; answer: string }): Promise<void>;
}
