import type { Task } from "../../shared/contracts";
import type { HostAgentSpec } from "../../shared/host";
import { removeMcpBinding, workerAgentSpec, type CreationOwner } from "./agent-creation";
import { ProvenPreSendRefusalError } from "../recovery/task-reasons";

export interface AgentPolicyHost {
  creationOwner(): CreationOwner;
  nativeAgentCreate(spec: HostAgentSpec, mcp: boolean, retry: boolean): Promise<{id:string;workspaceId:string | null}>;
  unsupportedMcp(error:unknown): boolean;
}
export class AgentPolicy {
  constructor(private readonly host: AgentPolicyHost) {}
  async createAgent(task: Task, token: string, prompt: string, legacyPrompt = prompt) {
    if (!task.workspaceId || !task.profile || !task.runId) throw new Error("Dispatch identity is incomplete");
    const spec = workerAgentSpec(() => this.host.creationOwner(), task, token, prompt, legacyPrompt);
    const mcp = spec.mcpBindingPath !== null;
    let agent;
    try { agent = await this.host.nativeAgentCreate(spec, mcp, false); }
    catch(error) {
      if(!mcp||!this.host.unsupportedMcp(error))throw error;
      removeMcpBinding(spec.mcpBindingPath!);
      agent = await this.host.nativeAgentCreate(spec, false, true);
    }
    return { id: agent.id, workspaceId: agent.workspaceId };
  }
  async guardedNativeAgentCreate(spec: HostAgentSpec, mcp: boolean, retry: boolean) {
    const guard = spec.guard;
    if(guard){
      try{
        if(!await guard.allowed()||!guard.stillAllowed())throw new ProvenPreSendRefusalError('Review-entry source or writer state changed before creation');
      }catch(error){
        if(error instanceof ProvenPreSendRefusalError)throw error;
        throw new ProvenPreSendRefusalError(error instanceof Error?error.message:String(error));
      }
    }
    return this.host.nativeAgentCreate(spec, mcp, retry);
  }
}
