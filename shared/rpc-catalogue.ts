/**
 * Shared strict RPC catalogue (Contract 007).
 *
 * Every served method is listed here once. The service generates its
 * registration from this list, the bridge generates its forwarding handlers
 * from it, and the parity fixture proves the list covers every RPC contract
 * exported from `shared/contracts`, so interaction coverage cannot drift.
 * This module must stay free of runtime, Store and transport imports.
 */
import * as contracts from "./contracts";

export interface RpcCatalogueEntry {
  name: string;
  contract: { name: string; input: unknown; output: unknown };
  /** Owner method served inside the standalone service. */
  method: string;
  /**
   * `true` when the method changes Queue state. The client retries only a call
   * whose outcome is unknown when it is read-only, so every method is classified
   * here and the classification test fails when an entry is unclassified or a
   * read-only entry changes.
   */
  mutating: boolean;
}

export const RPC_CATALOGUE: RpcCatalogueEntry[] = [
  { name: "caller.resolve", contract: contracts.callerResolve, method: "resolveHostCaller", mutating: false },
  { name: "queue.snapshot", contract: contracts.snapshot, method: "snapshot", mutating: false },
  { name: "backup.now", contract: contracts.backupNow, method: "backupNow", mutating: true },
  { name: "backup.list", contract: contracts.backupList, method: "backupList", mutating: false },
  { name: "queue.queued-page", contract: contracts.queuePage, method: "queuedPage", mutating: false },
  { name: "lane.task-page", contract: contracts.laneTaskPage, method: "laneTaskPage", mutating: false },
  { name: "queue.ui-snapshot", contract: contracts.uiSnapshot, method: "uiSnapshot", mutating: false },
  { name: "queue.detail", contract: contracts.detail, method: "detail", mutating: false },
  { name: "queue.outcome", contract: contracts.outcome, method: "outcome", mutating: false },
  { name: "queue.outcome-search", contract: contracts.outcomeSearch, method: "outcomeSearch", mutating: false },
  { name: "papercut.add", contract: contracts.papercutAdd, method: "addPapercut", mutating: true },
  { name: "papercut.list", contract: contracts.papercutList, method: "listPapercuts", mutating: false },
  { name: "papercut.get", contract: contracts.papercutGet, method: "getPapercut", mutating: false },
  { name: "papercut.edit", contract: contracts.papercutEdit, method: "editPapercut", mutating: true },
  { name: "papercut.promote", contract: contracts.papercutPromote, method: "promotePapercut", mutating: true },
  { name: "papercut.promote-task", contract: contracts.papercutPromoteTask, method: "promotePapercutToTask", mutating: true },
  { name: "papercut.close", contract: contracts.papercutClose, method: "closePapercut", mutating: true },
  { name: "papercut.set-lanes", contract: contracts.papercutSetLanes, method: "setPapercutLanes", mutating: true },
  { name: "lead.add", contract: contracts.leadAdd, method: "addLead", mutating: true },
  { name: "lead.edit", contract: contracts.leadEdit, method: "editLead", mutating: true },
  { name: "lead.get", contract: contracts.leadGet, method: "getLeadSummary", mutating: false },
  { name: "lead.version", contract: contracts.leadVersion, method: "getLeadVersion", mutating: false },
  { name: "lead.list", contract: contracts.leadList, method: "listLeads", mutating: false },
  { name: "lead.board", contract: contracts.leadBoard, method: "leadBoard", mutating: false },
  { name: "lead.set-lanes", contract: contracts.leadSetLanes, method: "setLeadLanes", mutating: true },
  { name: "lead.set-tags", contract: contracts.leadSetTags, method: "setLeadTags", mutating: true },
  { name: "lead.drop", contract: contracts.leadDrop, method: "dropLead", mutating: true },
  { name: "lead.reopen", contract: contracts.leadReopen, method: "reopenLead", mutating: true },
  { name: "lead.promote", contract: contracts.leadPromote, method: "promoteLead", mutating: true },
  { name: "lead.check", contract: contracts.leadCheck, method: "checkLead", mutating: true },
  { name: "lead.approve", contract: contracts.leadApprove, method: "approveLead", mutating: true },
  { name: "lead.promote-task", contract: contracts.leadPromoteTask, method: "promoteLeadToTask", mutating: true },
  { name: "lead.submit", contract: contracts.leadSubmit, method: "submitLead", mutating: true },
  { name: "lead.import", contract: contracts.leadImport, method: "importLeads", mutating: true },
  { name: "decision.add", contract: contracts.decisionAdd, method: "addDecision", mutating: true },
  { name: "decision.get", contract: contracts.decisionGet, method: "getDecision", mutating: false },
  { name: "decision.list", contract: contracts.decisionList, method: "listDecisions", mutating: false },
  { name: "decision.agent-projects", contract: contracts.decisionAgentProjects, method: "decisionAgentProjects", mutating: false },
  { name: "question.native-list", contract: contracts.nativeQuestionList, method: "listNativeQuestions", mutating: false },
  { name: "question.native-answer", contract: contracts.nativeQuestionAnswer, method: "answerNativeQuestion", mutating: true },
  { name: 'host.permission-answer', contract: contracts.hostPermissionAnswer, method: 'answerHostPermission', mutating: true },
  { name: "question.answer", contract: contracts.questionAnswer, method: "answerDelegatedQuestion", mutating: true },
  { name: "decision.answer", contract: contracts.decisionAnswer, method: "answerDecision", mutating: true },
  { name: "decision.withdraw", contract: contracts.decisionWithdraw, method: "withdrawDecision", mutating: true },
  { name: "decision.link", contract: contracts.decisionLink, method: "linkDecision", mutating: true },
  { name: "decision.supersede", contract: contracts.decisionSupersede, method: "supersedeDecision", mutating: true },
  { name: "lane.document.get", contract: contracts.laneDocumentGet, method: "getLaneDocument", mutating: false },
  { name: "lane.document.edit", contract: contracts.laneDocumentEdit, method: "editLaneDocument", mutating: true },
  { name: "plan.get", contract: contracts.planGet, method: "getPlan", mutating: false },
  { name: "plans", contract: contracts.plans, method: "listPlans", mutating: false },
  { name: "plan.set", contract: contracts.planSet, method: "setPlan", mutating: true },
  { name: "lane.upsert", contract: contracts.laneUpsert, method: "upsertLane", mutating: true },
  { name: "lane.status", contract: contracts.laneStatus, method: "setLaneStatus", mutating: true },
  { name: "lane.keep", contract: contracts.laneKeep, method: "keepLane", mutating: true },
  { name: "lanes", contract: contracts.lanes, method: "listLanes", mutating: false },
  { name: "repository.set", contract: contracts.repositorySet, method: "setRepository", mutating: true },
  { name: "repository.rekey-preview", contract: contracts.repositoryRekeyPreview, method: "previewRepositoryRekey", mutating: false },
  { name: "repository.rekey", contract: contracts.repositoryRekey, method: "rekeyRepository", mutating: true },
  { name: "repository.rekey-receipt", contract: contracts.repositoryRekeyReceiptRead, method: "repositoryRekeyReceipt", mutating: false },
  { name: "repository.get", contract: contracts.repositoryGet, method: "getRepository", mutating: false },
  { name: "repositories", contract: contracts.repositories, method: "listRepositories", mutating: false },
  { name: "project.upsert", contract: contracts.projectUpsert, method: "upsertProject", mutating: true },
  { name: "project.park", contract: contracts.projectPark, method: "parkProject", mutating: true },
  { name: "project.unpark", contract: contracts.projectUnpark, method: "unparkProject", mutating: true },
  { name: "project.set-planner", contract: contracts.projectSetPlanner, method: "setProjectPlanner", mutating: true },
  // Task 1110: the project's named, non-task threads. Registering issues a
  // participant ticket; listing observes each entry's live state.
  { name: "project.agents", contract: contracts.projectAgents, method: "projectAgents", mutating: false },
  { name: "agent.register", contract: contracts.agentRegister, method: "registerProjectAgent", mutating: true },
  { name: "agent.unregister", contract: contracts.agentUnregister, method: "unregisterProjectAgent", mutating: true },
  { name: "project.owner-candidates", contract: contracts.projectOwnerCandidates, method: "projectOwnerCandidates", mutating: false },
  { name: "project.settings", contract: contracts.projectSettings, method: "projectSettings", mutating: false },
  { name: "project.reset-cancellation", contract: contracts.projectResetCancellation, method: "resetProjectCancellation", mutating: true },
  { name: "project.management-preview", contract: contracts.projectManagementPreview, method: "projectManagementPreview", mutating: false },
  { name: "project.manage-remove", contract: contracts.projectManage, method: "manageRemoveProject", mutating: true },
  { name: "project.remove", contract: contracts.projectRemove, method: "removeProject", mutating: true },
  { name: "project.removal-blockers", contract: contracts.projectRemovalBlockers, method: "removalBlockers", mutating: false },
  { name: "project.remove-repository", contract: contracts.projectRemoveRepository, method: "removeProjectRepository", mutating: true },
  { name: "project.merge", contract: contracts.projectMerge, method: "mergeProject", mutating: true },
  { name: "project.merge-check", contract: contracts.projectMergeCheck, method: "mergeCheck", mutating: false },
  { name: "project.get", contract: contracts.projectGet, method: "getProject", mutating: false },
  { name: "projects", contract: contracts.projects, method: "listProjects", mutating: false },
  { name: "project.qa.run", contract: contracts.projectQaRun, method: "runProjectQa", mutating: true },
  { name: "project.qa.cancel", contract: contracts.projectQaCancel, method: "cancelProjectQa", mutating: true },
  { name: "project.qa.retry-teardown", contract: contracts.projectQaRetryTeardown, method: "retryProjectQaTeardown", mutating: true },
  { name: "project.qa.dismiss", contract: contracts.projectQaDismiss, method: "dismissProjectQa", mutating: true },
  { name: "project.qa.get", contract: contracts.projectQaGet, method: "getProjectQa", mutating: false },
  { name: "project.qa.request-status", contract: contracts.projectQaRequestStatus, method: "projectQaRequestStatus", mutating: false },
  { name: "project.qa.list", contract: contracts.projectQaList, method: "listProjectQa", mutating: false },
  { name: "project.qa.fence", contract: contracts.projectQaFence, method: "configureQaFence", mutating: true },
  { name: "project.qa.fence-status", contract: contracts.projectQaFenceStatus, method: "qaFenceStatus", mutating: false },
  { name: "host.run.list", contract: contracts.hostRunList, method: "listHostRuns", mutating: false },
  { name: "host.run.capacity.release", contract: contracts.hostRunCapacityRelease, method: "releaseHostRunCapacity", mutating: true },
  { name: "host.run.accounting.status", contract: contracts.hostRunAccountingStatus, method: "hostRunAccountingStatus", mutating: false },
  { name: "host.run.accounting.list", contract: contracts.hostRunAccountingList, method: "hostRunAccountingList", mutating: false },
  { name: "host.run.board", contract: contracts.hostRunBoard, method: "hostRunBoard", mutating: false },
  { name: "host.run.accounting.dispose", contract: contracts.hostRunAccountingDispose, method: "disposeHostRunAccounting", mutating: true },
  { name: "queue.telemetry", contract: contracts.telemetry, method: "telemetry", mutating: false },
  { name: "queue.submit", contract: contracts.submit, method: "submit", mutating: true },
  { name: "queue.submit-instruction", contract: contracts.submitInstruction, method: "submitInstruction", mutating: true },
  { name: "queue.handoff", contract: contracts.submitHandoff, method: "submitHandoff", mutating: true },
  { name: "queue.pool", contract: contracts.configurePool, method: "configurePool", mutating: true },
  { name: "usage.state", contract: contracts.usageState, method: "usageState", mutating: false },
  { name: "profile.list", contract: contracts.listNucleusProfiles, method: "profileList", mutating: false },
  { name: "profile.create", contract: contracts.createNucleusProfile, method: "profileCreate", mutating: true },
  { name: "profile.update", contract: contracts.updateNucleusProfile, method: "profileUpdate", mutating: true },
  { name: "profile.remove", contract: contracts.removeNucleusProfile, method: "profileRemove", mutating: true },
  { name: "profile.providers", contract: contracts.readProviderMap, method: "profileProviders", mutating: false },
  { name: "profile.providers.set", contract: contracts.writeProviderMap, method: "profileSetProviders", mutating: true },
  { name: "profile.compatibility", contract: contracts.readProfileCompatibility, method: "profileCompatibility", mutating: false },
  { name: "host.catalog", contract: contracts.readHostCatalog, method: "hostCatalog", mutating: false },
  { name: "queue.profile", contract: contracts.configureProfile, method: "configureProfile", mutating: true },
  { name: "queue.control", contract: contracts.queueControl, method: "queueControl", mutating: true },
  { name: "queue.stop-threads", contract: contracts.stopThreads, method: "stopThreads", mutating: true },
  { name: "queue.task", contract: contracts.taskControl, method: "taskControl", mutating: true },
  { name: "task.next", contract: contracts.taskNext, method: "taskNext", mutating: false },
  { name: "task.register", contract: contracts.taskRegister, method: "registerTask", mutating: true },
  { name: "queue.operation-start", contract: contracts.operationStart, method: "operationStart", mutating: true },
  // Inspection can durably reconcile a proven pre-send refusal; journal the request.
  { name: "queue.operation-status", contract: contracts.operationStatus, method: "operationStatus", mutating: true },
  { name: "queue.review-entry-workspace", contract: contracts.reviewEntryWorkspace, method: "reviewEntryWorkspace", mutating: true },
  { name: "queue.review-entry-preview", contract: contracts.reviewEntryPreview, method: "reviewEntryPreview", mutating: false },
  { name: "queue.review-entry-reconcile", contract: contracts.reviewEntryReconcile, method: "reviewEntryReconcile", mutating: true },
  { name: "queue.bulk-disposition", contract: contracts.bulkDisposition, method: "bulkDisposition", mutating: true },
  { name: "queue.bulk-disposition-detail", contract: contracts.bulkDispositionDetail, method: "bulkDispositionDetail", mutating: false },
  { name: "queue.bulk-disposition-retry", contract: contracts.retryBulkDisposition, method: "retryBulkDisposition", mutating: true },
  { name: "queue.completion-subscription", contract: contracts.completionSubscription, method: "completionSubscription", mutating: true },
  { name: "queue.reparent", contract: contracts.reparent, method: "reparent", mutating: true },
  { name: "queue.remove", contract: contracts.removeTask, method: "removeTask", mutating: true },
  { name: "queue.availability", contract: contracts.availabilityControl, method: "availabilityControl", mutating: true },
  { name: "queue.refresh", contract: contracts.refreshCatalog, method: "refreshCatalog", mutating: true },
  // Settings-only capacity writes (service-boundary contract): the Settings screen
  // reaches this over the Paseo plugin bridge or the local web board with a token,
  // and dispatch refuses it for every other surface before the handler runs.
  { name: "queue.capacity", contract: contracts.configureCapacity, method: "configureCapacity", mutating: true },
  // The values in force and the record of applied changes; the only supported read
  // of the host's dispatch limits.
  { name: "queue.capacity-state", contract: contracts.capacityState, method: "capacityAuthorityState", mutating: false },
  { name: "queue.usage", contract: contracts.configureUsage, method: "configureUsage", mutating: true },
  { name: "queue.routing-grant", contract: contracts.routingGrant, method: "routingGrant", mutating: true },
  { name: "queue.demand-offsets", contract: contracts.configureDemandOffsets, method: "configureDemandOffsets", mutating: true },
  { name: "queue.project-dispatch-limit", contract: contracts.configureProjectDispatchLimit, method: "configureProjectDispatchLimit", mutating: true },
];

export const RPC_METHOD_NAMES = RPC_CATALOGUE.map(entry => entry.name);

/** Bridge-side contracts: answered by the thin bridge itself, not the service. */
export const BRIDGE_CATALOGUE: RpcCatalogueEntry[] = [
  { name: "queue.service-state", contract: contracts.serviceState, method: "serviceState", mutating: false },
];

export const ALL_METHOD_NAMES = [...RPC_METHOD_NAMES, ...BRIDGE_CATALOGUE.map(entry => entry.name)];
