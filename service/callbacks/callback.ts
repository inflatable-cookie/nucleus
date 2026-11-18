import { resolveTicketCaller } from "../../core/dispatch/participant-tickets";
import { createServer, type IncomingMessage } from "node:http";
import { chmodSync, readFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { bulkDispositionRequestSchema, completionSchema, dependencyIdsSchema, taskControlRequestSchema } from "../../shared/contracts";
import {Reports,reportSchema} from "../../core/intake/report";
import {UnauthorizedCallbackError} from "../../core/store/store-auth";
import {agentAskSchema, AGENT_ASK_WAIT_MS} from "../../core/questions/agent-ask";
import {agentMessageSchema} from "../../core/questions/agent-messages";
import { AGENT_MESSAGE_MAX_CHARS } from "../../core/questions/agent-messages";
import { ACP_TURN_WAIT_MAX_MS } from "../../core/acp/sessions";
import type { Engine } from "../../core/engine";
import { z } from "zod";

const callerTicketSchema = z.union([z.object({ taskId: z.string().min(1), runId: z.string().min(1) }).strict(), z.object({ participantId: z.string().uuid() }).strict()]);
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
const helperAnswerSchema = z.object({
  eventId: z.string().regex(/^[a-f0-9]{64}$/),
  taskId: z.string().min(1),
  runId: z.string().min(1),
  questionId: z.string().trim().min(1).max(300),
  answer: z.string().trim().min(1).max(4000).optional(),
  choice: z.string().trim().min(1).max(400).optional(),
  reason: z.string().trim().min(1).max(500).regex(/^[^\r\n]*$/),
  overtakes: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
  decision: z.literal("operator").optional(),
}).strict().refine(value => Number(Boolean(value.answer)) + Number(Boolean(value.choice)) + Number(Boolean(value.decision)) === 1, { message: "Provide exactly one of answer, choice or decision" });

// Spec 065: an ACP session names the task and session its minted binding carries.
// Nothing here is a claimed identity: both are checked against the session record.
const acpCallerSchema = z.object({ taskId: z.string().min(1).max(160), sessionId: z.string().min(1).max(160) }).strict();
const acpTurnSchema = acpCallerSchema.extend({
  waitMs: z.number().int().min(0).max(ACP_TURN_WAIT_MAX_MS).optional(),
  /** An attach always answers with the current lifecycle line; a held poll only sends changes. */
  attach: z.boolean().optional(),
}).strict();
const acpMessageSchema = acpCallerSchema.extend({
  eventId: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().trim().min(1).max(AGENT_MESSAGE_MAX_CHARS),
}).strict();

/** The ACP surface this process attached, or the refusal that it serves none. */
function acpSessions(engine: Engine) {
  if (!engine.acp) throw new Error("This process does not serve ACP sessions");
  return engine.acp;
}

// The compiled build rewrites the literal module-URL expression in source text, so the helper spells it
// in two parts: rewritten, it never matches the helper's own path and the helper exits 0 without reporting.
// The shared client is self-contained for exactly this reason: these bytes are the helper's only other
// source text, so nothing here edits or re-exports it and no import has to be resolved from the data home.
const helperCallbackClient = readFileSync(new URL('../../shared/service/callback-client.mjs', import.meta.url), 'utf8');
export const workerHelper = helperCallbackClient + String.raw`

import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {request as httpRequest} from 'node:http';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
// Importing this file has no side effects: it reports only when run as a script, so
// a caller that imports callbackRequest from it never sends a stray request.
const invokedAsScript=(()=>{try{return Boolean(process.argv[1])&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(${'import.meta'}.url));}catch{return false;}})();
if(invokedAsScript)await reportFromStdin();
async function reportFromStdin(){
const continuationTicket=process.env.NUCLEUS_CONTINUATION_TICKET;
const ticketPath=process.argv[2]??continuationTicket??callbackEnvValue('TICKET');
const ticket=ticketPath?JSON.parse(readFileSync(ticketPath,'utf8')):null;
const currentRun=process.env.NUCLEUS_CONTINUATION_RUN_ID;
if(currentRun&&ticket?.runId!==currentRun) throw new Error('Continuation ticket does not match the current run; use the ticket path supplied in the continuation prompt');
const socketPath=ticket?ticket.socketPath:callbackEnvValue('SOCKET'),token=ticket?ticket.token:callbackEnvValue('RUN_TOKEN'),taskId=ticket?ticket.taskId:callbackEnvValue('TASK_ID'),runId=ticket?ticket.runId:callbackEnvValue('RUN_ID');
if(!socketPath||!token||!taskId||!runId) throw new Error('Missing Nucleus callback environment');
// A BB role thread runs inside its provider's OS sandbox, which refuses every Unix
// socket. The run ticket records that host, and the payload then goes to the BB
// backend over loopback; the backend forwards it to this same socket from outside
// the sandbox with this ticket's own credential.
const viaBbRelay=typeof ticket?.host==='string'&&ticket.host.startsWith('bb:');
const BB_RELAY_ROUTE='/api/v1/plugins/nucleus/http/report';
function bbRelayUrls(){
  const urls=[];
  const named=process.env.BB_SERVER_URL;
  if(named)urls.push(String(named));
  try{
    const home=process.env.BB_DATA_DIR||join(homedir(),'.bb');
    const runtime=JSON.parse(readFileSync(join(home,'bb-app-runtime.json'),'utf8'));
    if(runtime&&typeof runtime.serverUrl==='string'&&runtime.serverUrl)urls.push(runtime.serverUrl);
  }catch{}
  return [...new Set(urls.map(url=>String(url).replace(/\/+$/,'')).filter(Boolean))];
}
function postBbRelay(base,body,timeoutMs){
  const payload=JSON.stringify(body);
  const url=new URL(base+'/'+BB_RELAY_ROUTE.replace(/^\//,''),base);
  return new Promise((resolve,reject)=>{
    const pending=httpRequest({hostname:url.hostname,port:url.port||80,path:url.pathname,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(payload)}},res=>{
      let response='';res.setEncoding('utf8');res.on('data',chunk=>{response+=chunk;});
      res.on('end',()=>{
        if(res.statusCode!==200){const failure=new Error(response);failure.callbackStatus=res.statusCode;reject(failure);return;}
        try{resolve(JSON.parse(response));}catch{reject(new Error('Invalid Queue response; inspect current state before retrying'));}
      });
      res.on('error',reject);
    });
    pending.setTimeout(timeoutMs,()=>pending.destroy(new Error('Queue request timed out; inspect current state before retrying')));
    pending.on('error',reject);
    pending.end(payload);
  });
}
async function relayThroughBb(route,payload,options){
  const urls=bbRelayUrls();
  if(!urls.length) throw new Error('BB report relay: no BB server URL (BB_SERVER_URL or bb-app-runtime.json)');
  let last=null;
  for(const base of urls){
    try{return await postBbRelay(base,{route,taskId,runId,token,payload},options&&options.timeoutMs?options.timeoutMs:60000);}
    catch(error){last=error;if(error&&error.callbackStatus)throw error;}
  }
  throw last||new Error('BB report relay: no BB server answered');
}
async function deliver(route,payload,options){
  if(!viaBbRelay)return await callbackRequest({socketPath,token},route,payload,options);
  // The relay is the route a provider sandbox can reach. A relay that is not
  // there (an older BB server, a fixture, a host whose plugin is not loaded) never
  // strands the report: the callback socket is still tried, and the event id is
  // deterministic, so a relay that forwarded before its answer was lost is
  // answered from the receipt rather than applied twice.
  let relayError=null;
  try{return await relayThroughBb(route,payload,options);}catch(error){relayError=error;}
  try{return await callbackRequest({socketPath,token},route,payload,options);}
  catch(socketError){
    const detail=(error)=>error&&error.message?error.message:String(error);
    throw new Error('BB report relay failed (' + detail(relayError) + ') and the callback socket failed (' + detail(socketError) + ')');
  }
}
// The next argument reads the task-scoped plan the recovery coordinator launched with; it sends no report and takes no stdin.
const command=process.argv[3];
if(command==='next'){const plan=await deliver('/task-next',{callerTaskId:taskId,callerRunId:runId},{timeoutMs:45000,timeoutMessage:'Callback timed out; retry next'});console.log(JSON.stringify(plan));return;}
const route=command==='ask'?'/ask':command==='message'?'/message':command==='answer'?'/answer':'/complete';
let text='',bytes=0;
for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>5*1024*1024)throw new Error('Callback too large');text+=chunk;}
const input=JSON.parse(text);
// An explicit identity belongs to the report, not to the selected ticket.
for(const [key,bound] of [['taskId',taskId],['runId',runId]])
  if(input[key]!==undefined&&input[key]!==bound)throw new Error('Report '+key+' does not match the callback ticket');
if(route!=='/complete'){
  const payload={...input,taskId,runId};
  payload.eventId=input.eventId||createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const result=await deliver(route,payload,{timeoutMs:route==='/ask'?` + CALLBACK_ASK_TIMEOUT_MS + `:` + CALLBACK_SOCKET_TIMEOUT_MS + String.raw`,timeoutMessage:'Callback timed out; retry the same JSON'});
  console.log(JSON.stringify(result));
  return;
}
// The ticket binds this run's coordinator generation, so a coordinative report that omits it still carries the authenticated run's generation. An explicit payload value always wins; a run that was genuinely superseded is still refused server-side.
const fields={...input,coordinatorGeneration:input.coordinatorGeneration??ticket?.coordinatorGeneration};
// Every result field is forwarded: the authenticated completion schema owns acceptance, so a field it
// accepts is never dropped here and an unknown one is refused there. Fields keep their historical order
// so an identical retry keeps its event ID; the ticket owns task and run identity.
const order=['status','summary','closeoutCommit','replacementAgentId','recoveryAction','prNumber','head','reviewCommentId','coordinatorGeneration','providerUnavailable','providerRetryAt','reviewText','reviewedInputs','verdicts','checkpoint','proofFiles'];
const payload={taskId,runId};
for(const key of order)if(fields[key]!==undefined)payload[key]=fields[key];
for(const [key,value] of Object.entries(fields))if(!order.includes(key)&&!['taskId','runId','eventId'].includes(key)&&value!==undefined)payload[key]=value;
const eventId=input.eventId||createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const result=await deliver('/complete',{eventId,...payload},{timeoutMs:45000,timeoutMessage:'Callback timed out; retry the same JSON'});
console.log(JSON.stringify(result));
}
`;

/** The caller a route authenticates: the bearer token plus the task and run it was issued for. */
interface CallbackCaller { taskId: string; runId: string; token: string }

/** The caller fields every caller-addressed request carries beside its own payload. */
interface CallerFacts { callerTaskId: string; callerRunId: string }

/** One callback route: its own body bound, and its own decode-and-apply step. */
interface CallbackRoute {
  /** Largest request body this route accepts. */
  bodyBytes: number;
  /** Decode one request body and apply it. A throw is this route's refusal: `callbackStatus` answers it. */
  handle(input: unknown, token: string): unknown;
}

/** Completion and report bodies carry receipts, so they get the large bound; every other route is small. */
const LARGE_CALLBACK_BODY_BYTES = 5 * 1024 * 1024;
const SMALL_CALLBACK_BODY_BYTES = 64 * 1024;

const asCaller = (request: CallerFacts, token: string): CallbackCaller =>
  ({ taskId: request.callerTaskId, runId: request.callerRunId, token });

/** A body past its route's bound: refused before any of it is decoded. */
class CallbackBodyTooLarge extends Error {
  constructor() { super("Callback too large"); }
}

/**
 * The status one refused callback becomes, and the one place it is chosen: the
 * oversized body answers the 413 it always has, a credential this service does
 * not accept is a 401 the store's own refusal class names, and every other
 * refusal keeps the socket's existing 409 — a malformed body, a schema-invalid
 * request, and the engine's refusal of a well-formed call alike. Nothing here
 * matches an error message. Answering a malformed body with a 400 of its own is
 * a behaviour change this structural task does not make (follow-up: see PR).
 */
function callbackStatus(error: unknown): number {
  if (error instanceof CallbackBodyTooLarge) return 413;
  if (error instanceof UnauthorizedCallbackError) return 401;
  return 409;
}

/** One bounded body read, so a route never buffers more than its own bound. */
async function readCallbackBody(req: IncomingMessage, limit: number): Promise<string> {
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new CallbackBodyTooLarge();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString();
}

export async function startCallbacks(socketPath: string, helperPath: string, engine: Engine) {
  if (existsSync(socketPath)) unlinkSync(socketPath); // Caller holds the live-process ownership lock.
  writeFileSync(helperPath, workerHelper, { mode: 0o600 });
  const reports=new Reports(engine);
  // The one route list: the allowlist and the dispatch are this table, so a route
  // can never be listed and then handled by another branch, or listed twice.
  const routes: Record<string, CallbackRoute> = {
    "/caller": { bodyBytes: SMALL_CALLBACK_BODY_BYTES,
      handle: (input, token) => resolveTicketCaller(engine.store, callerTicketSchema.parse(input), token) },
    "/report": { bodyBytes: LARGE_CALLBACK_BODY_BYTES,
      handle: (input, token) => reports.report(reportSchema.parse(input), token) },
    "/ask": { bodyBytes: SMALL_CALLBACK_BODY_BYTES,
      handle: (input, token) => engine.resolution.agentAsk(agentAskSchema.parse(input), token) },
    "/message": { bodyBytes: SMALL_CALLBACK_BODY_BYTES,
      handle: (input, token) => engine.resolution.agentMessage(agentMessageSchema.parse(input), token) },
    "/answer": { bodyBytes: SMALL_CALLBACK_BODY_BYTES,
      handle: (input, token) => engine.resolution.answerDelegatedQuestionFromTicket(helperAnswerSchema.parse(input), token) },
    "/complete": { bodyBytes: LARGE_CALLBACK_BODY_BYTES,
      handle: (input, token) => engine.complete(completionSchema.parse(input), token) },
    "/task-control": { bodyBytes: SMALL_CALLBACK_BODY_BYTES,
      handle: (input, token) => {
        const request = selfControlSchema.parse(input);
        return engine.taskControlFromAgent(asCaller(request, token), request.input);
      } },
    "/task-dependencies": { bodyBytes: SMALL_CALLBACK_BODY_BYTES,
      handle: (input, token) => {
        const request = dependencyDetailSchema.parse(input);
        return engine.dependencyDetail(asCaller(request, token), request.taskId);
      } },
    "/set-dependencies": { bodyBytes: SMALL_CALLBACK_BODY_BYTES,
      handle: (input, token) => {
        const request = dependencyUpdateSchema.parse(input);
        const receipt = engine.updateDependenciesFromAgent(asCaller(request, token), request);
        void engine.wakeTask(request.callerTaskId);
        return receipt;
      } },
    "/project-queue": { bodyBytes: SMALL_CALLBACK_BODY_BYTES,
      handle: (input, token) => {
        const request = dependencyDetailSchema.parse(input);
        return engine.projectQueueDetail(asCaller(request, token), request.taskId);
      } },
    "/task-disposition": { bodyBytes: SMALL_CALLBACK_BODY_BYTES,
      handle: (input, token) => {
        const request = dispositionDetailSchema.parse(input);
        return engine.authenticatedDispositionDetail(asCaller(request, token), request.taskId);
      } },
    "/task-next": { bodyBytes: SMALL_CALLBACK_BODY_BYTES,
      handle: (input, token) => {
        const request = recoveryTaskNextSchema.parse(input);
        return engine.recoveryTaskNextFromAgent(asCaller(request, token));
      } },
    "/dispose-task": { bodyBytes: SMALL_CALLBACK_BODY_BYTES,
      handle: async (input, token) => {
        const request = disposeTaskSchema.parse(input);
        const caller = asCaller(request, token);
        const receipt = request.action === "withdraw_cancel"
          ? await engine.withdrawCancellationFromAgent(caller, request)
          : await engine.disposeTaskFromAgent(caller, {
            taskId: request.taskId, version: request.version, action: request.action, reason: request.reason,
            replacementTaskId: request.replacementTaskId, workDisposition: request.workDisposition,
          });
        void engine.wakeTask(request.taskId);
        void engine.wakeRepository(engine.store.task(request.taskId).repoPath);
        return receipt;
      } },
    "/bulk-task-disposition": { bodyBytes: SMALL_CALLBACK_BODY_BYTES,
      handle: async (input, token) => {
        const request = bulkDispositionSchema.parse(input);
        const { callerTaskId, callerRunId, ...operation } = request;
        return engine.startBulkDispositionFromAgent(asCaller({ callerTaskId, callerRunId }, token), operation);
      } },
    "/bulk-task-disposition-detail": { bodyBytes: SMALL_CALLBACK_BODY_BYTES,
      handle: (input, token) => {
        const request = bulkDispositionDetailSchema.parse(input);
        return engine.bulkDispositionDetailFromAgent(asCaller(request, token), request.operationId);
      } },
    "/bulk-task-disposition-retry": { bodyBytes: SMALL_CALLBACK_BODY_BYTES,
      handle: (input, token) => {
        const request = bulkDispositionDetailSchema.parse(input);
        return engine.retryBulkDispositionFromAgent(asCaller(request, token), request.operationId);
      } },
    "/acp-turn": { bodyBytes: SMALL_CALLBACK_BODY_BYTES,
      handle: (input, token) => acpSessions(engine).turn(acpTurnSchema.parse(input), token) },
    "/acp-message": { bodyBytes: SMALL_CALLBACK_BODY_BYTES,
      handle: (input, token) => acpSessions(engine).message(acpMessageSchema.parse(input), token) },
    "/promote-task": { bodyBytes: SMALL_CALLBACK_BODY_BYTES,
      handle: (input, token) => {
        const request = taskPromotionSchema.parse(input);
        const receipt = engine.promoteTaskFromAgent(asCaller(request, token), request);
        void engine.wakeTask(request.callerTaskId);
        return receipt;
      } },
  };
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const route = req.method === "POST" && req.url ? routes[req.url] : undefined;
    if (!route) { res.writeHead(404).end('{"error":"Not found"}'); return; }
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) { res.writeHead(401).end('{"error":"Unauthorized callback"}'); return; }
    try {
      const input = JSON.parse(await readCallbackBody(req, route.bodyBytes));
      res.end(JSON.stringify(await route.handle(input, auth.slice(7))));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid callback";
      res.writeHead(callbackStatus(error)).end(JSON.stringify({ error: message }));
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
