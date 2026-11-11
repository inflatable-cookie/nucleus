import { createServer } from "node:http";
import { chmodSync, readFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { bulkDispositionRequestSchema, completionSchema, dependencyIdsSchema, taskControlRequestSchema } from "../../shared/contracts";
import {Reports,reportSchema} from "../../core/intake/report";
import {agentAskSchema, AGENT_ASK_WAIT_MS} from "../../core/questions/agent-ask";
import {agentMessageSchema} from "../../core/questions/agent-messages";
import type { Engine } from "../../core/engine";
import { z } from "zod";

const dependencyCallerSchema=z.object({callerTaskId:z.string().min(1),callerRunId:z.string().min(1)});
const dependencyDetailSchema=dependencyCallerSchema.extend({taskId:z.string().min(1)}).strict();
const dependencyUpdateSchema=dependencyDetailSchema.extend({version:z.number().int().positive(),dependsOn:dependencyIdsSchema}).strict();
const taskPromotionSchema=dependencyDetailSchema.extend({version:z.number().int().positive()}).strict();
const dispositionDetailSchema = dependencyCallerSchema.extend({ taskId: z.string().min(1) }).strict();
const disposeTaskSchema = dependencyCallerSchema.extend({
  taskId: z.string().min(1), version: z.number().int().positive(),
  action: z.enum(["cancel", "supersede", "withdraw_cancel"]), reason: z.string().trim().min(1).max(4000),
  replacementTaskId: z.string().min(1).max(160).optional(),
  workDisposition: z.enum(["preserve", "archive_if_empty", "retained_by_replacement"]).optional(),
}).strict().superRefine((request, context) => {
  if (request.action === "withdraw_cancel" && (request.replacementTaskId || request.workDisposition))
    context.addIssue({ code: "custom", path: ["action"], message: "Cancellation withdrawal does not take a replacement or work disposition" });
});
export const CALLBACK_SOCKET_TIMEOUT_MS = 45_000;
/** Helper ask waits longer than the server's bounded in-turn wait so a delayed answer is not a socket timeout. */
export const CALLBACK_ASK_TIMEOUT_MS = AGENT_ASK_WAIT_MS + 30_000;
const selfControlSchema = dependencyCallerSchema.extend({input: taskControlRequestSchema}).strict();
const bulkDispositionSchema = dependencyCallerSchema.and(bulkDispositionRequestSchema);
const bulkDispositionDetailSchema = dependencyCallerSchema.extend({ operationId: z.string().min(1).max(160) }).strict();
// The recovery coordinator reads its own task's plan; the caller identity binds the task.
const recoveryTaskNextSchema = dependencyCallerSchema.strict();

// The compiled build rewrites the literal module-URL expression in source text, so the helper spells it
// in two parts: rewritten, it never matches the helper's own path and the helper exits 0 without reporting.
export const workerHelper = readFileSync(new URL('../../shared/service/callback-client.mjs', import.meta.url), 'utf8') + String.raw`

import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
// Importing this file has no side effects: it reports only when run as a script, so
// a caller that imports callbackRequest from it never sends a stray request.
const invokedAsScript=(()=>{try{return Boolean(process.argv[1])&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(${'import.meta'}.url));}catch{return false;}})();
if(invokedAsScript)await reportFromStdin();
async function reportFromStdin(){
const ticketPath=process.argv[2]??callbackEnvValue('TICKET');
const ticket=ticketPath?JSON.parse(readFileSync(ticketPath,'utf8')):null;
const socketPath=ticket?ticket.socketPath:callbackEnvValue('SOCKET'),token=ticket?ticket.token:callbackEnvValue('RUN_TOKEN'),taskId=ticket?ticket.taskId:callbackEnvValue('TASK_ID'),runId=ticket?ticket.runId:callbackEnvValue('RUN_ID');
if(!socketPath||!token||!taskId||!runId) throw new Error('Missing Nucleus callback environment');
// The next argument reads the task-scoped plan the recovery coordinator launched with; it sends no report and takes no stdin.
const command=process.argv[3];
if(command==='next'){const plan=await callbackRequest({socketPath,token},'/task-next',{callerTaskId:taskId,callerRunId:runId},{timeoutMs:45000,timeoutMessage:'Callback timed out; retry next'});console.log(JSON.stringify(plan));return;}
const route=command==='ask'?'/ask':command==='message'?'/message':'/complete';
let text='',bytes=0;
for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>5*1024*1024)throw new Error('Callback too large');text+=chunk;}
const input=JSON.parse(text);
// An explicit identity belongs to the report, not to the selected ticket.
for(const [key,bound] of [['taskId',taskId],['runId',runId]])
  if(input[key]!==undefined&&input[key]!==bound)throw new Error('Report '+key+' does not match the callback ticket');
if(route!=='/complete'){
  const payload={...input,taskId,runId};
  payload.eventId=input.eventId||createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const result=await callbackRequest({socketPath,token},route,payload,{timeoutMs:route==='/ask'?` + CALLBACK_ASK_TIMEOUT_MS + `:` + CALLBACK_SOCKET_TIMEOUT_MS + String.raw`,timeoutMessage:'Callback timed out; retry the same JSON'});
  console.log(JSON.stringify(result));
  return;
}
// The ticket binds this run's coordinator generation, so a coordinative report that omits it still carries the authenticated run's generation. An explicit payload value always wins; a run that was genuinely superseded is still refused server-side.
const fields={...input,coordinatorGeneration:input.coordinatorGeneration??ticket?.coordinatorGeneration};
// Every result field is forwarded: the authenticated completion schema owns acceptance, so a field it
// accepts is never dropped here and an unknown one is refused there. Fields keep their historical order
// so an identical retry keeps its event ID; the ticket owns task and run identity.
const order=['status','summary','closeoutCommit','replacementAgentId','recoveryAction','prNumber','head','reviewCommentId','coordinatorGeneration','providerUnavailable','providerRetryAt','reviewText','reviewedInputs','verdicts','checkpoint'];
const payload={taskId,runId};
for(const key of order)if(fields[key]!==undefined)payload[key]=fields[key];
for(const [key,value] of Object.entries(fields))if(!order.includes(key)&&!['taskId','runId','eventId'].includes(key)&&value!==undefined)payload[key]=value;
const eventId=input.eventId||createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const result=await callbackRequest({socketPath,token},'/complete',{eventId,...payload},{timeoutMs:45000,timeoutMessage:'Callback timed out; retry the same JSON'});
console.log(JSON.stringify(result));
}
`;

export async function startCallbacks(socketPath: string, helperPath: string, engine: Engine) {
  if (existsSync(socketPath)) unlinkSync(socketPath); // Caller holds the live-process ownership lock.
  writeFileSync(helperPath, workerHelper, { mode: 0o600 });
  const reports=new Reports(engine);
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method !== "POST" || !["/complete","/report","/ask","/message","/task-dependencies","/set-dependencies","/project-queue","/promote-task","/task-disposition","/task-next","/dispose-task","/bulk-task-disposition","/bulk-task-disposition-detail","/bulk-task-disposition-retry","/task-control"].includes(req.url ?? "")) { res.writeHead(404).end('{"error":"Not found"}'); return; }
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) { res.writeHead(401).end('{"error":"Unauthorized callback"}'); return; }
    const maxRequestBytes = req.url === "/complete" || req.url === "/report" ? 5 * 1024 * 1024 : 65536;
    try {
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxRequestBytes) { res.writeHead(413).end('{"error":"Callback too large"}'); return; }
        chunks.push(Buffer.from(chunk));
      }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      let receipt:unknown;
      if(req.url==="/report")receipt=await reports.report(reportSchema.parse(input),auth.slice(7));
      else if(req.url==="/ask")receipt=await engine.resolution.agentAsk(agentAskSchema.parse(input),auth.slice(7));
      else if(req.url==="/message")receipt=await engine.resolution.agentMessage(agentMessageSchema.parse(input),auth.slice(7));
      else if(req.url==="/task-control"){
        const request=selfControlSchema.parse(input);
        receipt=await engine.taskControlFromAgent({taskId:request.callerTaskId,runId:request.callerRunId,token:auth.slice(7)},request.input);
      }else if(req.url==="/complete")receipt=await engine.complete(completionSchema.parse(input),auth.slice(7));
      else if(req.url==="/task-dependencies"){
        const request=dependencyDetailSchema.parse(input);
        receipt=engine.dependencyDetail({taskId:request.callerTaskId,runId:request.callerRunId,token:auth.slice(7)},request.taskId);
      }else if(req.url==="/set-dependencies"){
        const request=dependencyUpdateSchema.parse(input);
        receipt=engine.updateDependenciesFromAgent({taskId:request.callerTaskId,runId:request.callerRunId,token:auth.slice(7)},request);
        void engine.wakeTask(request.callerTaskId);
      }else if(req.url==="/project-queue"){
        const request=dependencyDetailSchema.parse(input);
        receipt=engine.projectQueueDetail({taskId:request.callerTaskId,runId:request.callerRunId,token:auth.slice(7)},request.taskId);
      }else if(req.url==="/task-disposition"){
        const request=dispositionDetailSchema.parse(input);
        receipt=engine.authenticatedDispositionDetail({taskId:request.callerTaskId,runId:request.callerRunId,token:auth.slice(7)},request.taskId);
      }else if(req.url==="/task-next"){
        const request=recoveryTaskNextSchema.parse(input);
        receipt=engine.recoveryTaskNextFromAgent({taskId:request.callerTaskId,runId:request.callerRunId,token:auth.slice(7)});
      }else if(req.url==="/dispose-task"){
        const request=disposeTaskSchema.parse(input);
        const caller={taskId:request.callerTaskId,runId:request.callerRunId,token:auth.slice(7)};
        if(request.action==="withdraw_cancel") receipt=await engine.withdrawCancellationFromAgent(caller,request);
        else if(request.action==="cancel"||request.action==="supersede") receipt=await engine.disposeTaskFromAgent(caller,{
          taskId:request.taskId,version:request.version,action:request.action,reason:request.reason,
          replacementTaskId:request.replacementTaskId,workDisposition:request.workDisposition,
        });
        void engine.wakeTask(request.taskId);
        void engine.wakeRepository(engine.store.task(request.taskId).repoPath);
      }else if(req.url==="/bulk-task-disposition"){
        const request=bulkDispositionSchema.parse(input);
        const {callerTaskId,callerRunId,...operation}=request;
        receipt=await engine.startBulkDispositionFromAgent({taskId:callerTaskId,runId:callerRunId,token:auth.slice(7)},operation);
      }else if(req.url==="/bulk-task-disposition-detail"){
        const request=bulkDispositionDetailSchema.parse(input);
        receipt=engine.bulkDispositionDetailFromAgent({taskId:request.callerTaskId,runId:request.callerRunId,token:auth.slice(7)},request.operationId);
      }else if(req.url==="/bulk-task-disposition-retry"){
        const request=bulkDispositionDetailSchema.parse(input);
        receipt=await engine.retryBulkDispositionFromAgent({taskId:request.callerTaskId,runId:request.callerRunId,token:auth.slice(7)},request.operationId);
      }else{
        const request=taskPromotionSchema.parse(input);
        receipt=engine.promoteTaskFromAgent({taskId:request.callerTaskId,runId:request.callerRunId,token:auth.slice(7)},request);
        void engine.wakeTask(request.callerTaskId);
      }
      res.end(JSON.stringify(receipt));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid callback";
      res.writeHead(message === "Unauthorized callback" ? 401 : 409).end(JSON.stringify({ error: message }));
    }
  });
  server.requestTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);
  return async () => {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
    if (existsSync(socketPath)) unlinkSync(socketPath);
  };
}
