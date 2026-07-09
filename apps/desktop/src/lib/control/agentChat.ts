import { invoke } from "@tauri-apps/api/core";

export type AgentChatRequest = {
  conversation_id: string;
  project_id: string;
  message: string;
};

export type AgentChatReply = {
  session_id: string;
  thread_id: string;
  turn_id: string;
  model: string;
  assistant_message: string;
};

export function sendAgentChatMessage(request: AgentChatRequest): Promise<AgentChatReply> {
  return invoke<AgentChatReply>("send_agent_chat_message", { request });
}
