import type { Adapter } from '../../core/host';
import { ProvenPreSendRefusalError } from '../../core/host';
import { T3CodeHost, type T3CodeConfig } from './adapter';

export { T3CodeHost, type T3CodeConfig } from './adapter';
export { T3CompatibilityError } from './contracts';
export { T3RpcError } from './rpc';
export function createHost(config: T3CodeConfig): T3CodeHost { return new T3CodeHost(config); }

/** Register native operations without claiming the workflow capabilities of step 2. */
export function createAdapter(host: T3CodeHost): Adapter & { readonly hostId: string } {
  const workflowUnavailable = async (): Promise<never> => { throw new ProvenPreSendRefusalError('T3Code lifecycle dispatch requires CLI reporting and board decision routing (trial step 2)'); };
  return {
    get hostId() { return host.hostId; },
    capabilities: () => host.capabilities(), reportingViaMcp: false, supportsCoordinatorRecovery: false,
    validate: workflowUnavailable, createWorkspace: workflowUnavailable, createAgent: workflowUnavailable,
    verifyWorkspace: workflowUnavailable, verifyPr: workflowUnavailable,
    findWorkspaces: task => host.findWorkspaces(task), findAgents: task => host.findAgents({ 'nucleus.task': task.id }),
    observe: id => host.observe(id), observationInventory: ids => host.observationInventory(ids),
    originAgent: id => host.originAgent(id), listLiveAgents: () => host.listLiveAgents(),
    workspaceAvailable: id => host.workspaceAvailable(id), workspaceIdAccepted: id => host.workspaceIdAccepted(id),
    profiles: () => host.profiles(), catalog: () => host.catalog(),
    notify: (id, messageId, text) => host.sendMessage(id, { messageId, text }),
    stopAgentTurn: id => host.stopAgentTurn(id), archiveAgent: id => host.archiveAgent(id),
    agentTimelinePage: (id, limit) => host.agentTimelinePage(id, limit), agentTimeline: (id, limit) => host.agentTimeline(id, limit),
    pendingQuestions: id => host.pendingQuestions(id), answeredQuestions: id => host.answeredQuestions(id),
    answerNativeQuestion: (agent, workspace, request, answers) => host.answerNativeQuestion(agent, workspace, request, answers),
    answerNativePermission: (agent, workspace, request, decision, intentId) => host.respondRuntimeRequest(agent, workspace, request, { decision }, intentId),
    dismissNativeQuestion: (agent, workspace, request) => host.dismissNativeQuestion(agent, workspace, request),
  };
}
