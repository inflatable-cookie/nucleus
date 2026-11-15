import type { AgentObservation } from "../host/adapter";
import { hostFailureRefusalDetail } from "../host/errors";
import { unreportedExecutorRun } from "../qa/proof-execution";
import type { Task, TaskControlInput } from "../../shared/contracts";
import type { Engine } from "../engine";
import { RestartRefusal } from "./owner-verbs";

/**
 * nucleus#1195: one bounded re-report request to the live proof executor whose
 * result never arrived. The same run, agent and credential stay: nothing is
 * relaunched, the selector is never re-run and the one allowance stays spent. The
 * send is recorded once as a durable intent before the delivery and its outcome
 * after it, so a repeat never asks and an unknown delivery refuses.
 */
export async function resendExecutorReport(engine: Engine, input: TaskControlInput, task: Task, reason: string): Promise<Task> {
  const store = engine.store;
  if (input.fresh === true) throw new RestartRefusal("A proof executor's re-report request continues the same run; fresh is unsupported because it would spend another execution");
  const run = unreportedExecutorRun(store.runs(task.id), task.resolution.currentRunId);
  if (!run) throw new RestartRefusal("No unreleased proof executor is waiting on a report; nothing was asked");
  if (!engine.adapter.notify) throw new RestartRefusal("This host cannot deliver the re-report request; use tell role=executor from a host with a message channel");
  const events = store.eventsAll(task.id);
  if (events.some(event => event.kind === "executor_report_request_sent" && event.detail.startsWith(`${run.id}:`)))
    throw new RestartRefusal(`The re-report request for proof executor run ${run.id} was already sent; its result is still outstanding. Inspect the executor's thread, or use tell role=executor`);
  if (events.some(event => event.kind === "executor_report_request_intent" && event.detail.startsWith(`${run.id}:`)))
    throw new RestartRefusal(`The re-report request for proof executor run ${run.id} has an unknown delivery; inspect the executor's thread before deciding anything else`);
  let observed: AgentObservation;
  try { observed = await engine.onTaskHost(task, () => engine.host.observe(run.agentId!)); }
  catch (error) { throw new RestartRefusal(`The proof executor cannot be observed (${hostFailureRefusalDetail(error)}); no re-report was asked`); }
  engine.requireOwnerControlCurrent(store.task(task.id), input.version, "Task changed during restart verification; read next again before restarting");
  const latest = unreportedExecutorRun(store.runs(task.id), task.resolution.currentRunId);
  if (!latest || latest.id !== run.id) throw new RestartRefusal("The proof executor changed during verification; read next again before restarting");
  if (observed.id !== run.agentId || observed.workspaceId !== run.workspaceId)
    throw new RestartRefusal("The observed executor agent or workspace differs from the recorded run; no re-report was asked");
  if (observed.status === "closed")
    throw new RestartRefusal("The proof executor's thread is closed, so it cannot resend a report; inspect its evidence and decide the next owner action");
  if (observed.active || observed.activeTurnId || observed.permissions || !["idle", "error"].includes(observed.status))
    throw new RestartRefusal("The proof executor is not positively idle; its own turn owns the report until it ends");
  const messageId = `ns-executor-report-${run.id}`;
  const request = `Nucleus re-requests your report for proof executor run ${run.id} (task ${task.reference ?? task.id}). Your last turn ended without a recorded result, and the task's one proof allowance stays spent. Do not run the selector again and do not change source. Resend the authenticated report for this same run with its existing credential and the evidence you already produced: proof_executed with proofResult {selector, status, exitCode, evidence}, and the same proofFiles when you copied them. If you never produced a result, report blocked or error with the concrete condition. This is one bounded re-report request. Reason: ${reason}`.slice(0, 4000);
  const text = `${request}${engine.adapter.reportingFallback ? ` ${engine.adapter.reportingFallback(run)}` : ""}`.slice(0, 6000);
  store.event(task.id, "executor_report_request_intent", `${run.id}: ${JSON.stringify({ runId: run.id, agentId: run.agentId, messageId })}`);
  try {
    await engine.onTaskHost(task, () => engine.adapter.notify!(run.agentId!, messageId, text));
  } catch (error) {
    throw new RestartRefusal(`The re-report request to proof executor run ${run.id} could not be delivered (${error instanceof Error ? error.message : String(error)}); its delivery is unknown, so nothing was retried`);
  }
  store.event(task.id, "executor_report_request_sent", `${run.id}: ${JSON.stringify({ runId: run.id, agentId: run.agentId, messageId })}`);
  engine.resolution.waiting(store.task(task.id),
    `The proof executor ${run.id} was asked to resend its report; the selector is not re-run and no new run starts`, "lifecycle");
  return store.task(task.id);
}
