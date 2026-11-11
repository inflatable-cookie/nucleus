import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {readFileSync} from 'node:fs';
import {callbackRequest, callbackTransportPhase} from '../shared/service/callback-client.mjs';
import {createHash} from 'node:crypto';
import {dataHome} from '../shared/data-home.mjs';
import {pathIsUnderDataHome, runIdMismatchRefusal} from '../shared/service/report-binding.mjs';
import {dedupeReviewedInputs, reviewedInputListRefusals} from '../shared/service/reviewed-inputs.mjs';
const bindingPath=process.argv[2];if(!bindingPath)throw Error('Missing MCP session binding');
function bindingUnderCurrentDataHome() {
  try { return pathIsUnderDataHome(bindingPath, dataHome()); }
  catch { return false; }
}
function mismatchRefusal(toolName, boundRunId, namedRunId, kind) {
  return runIdMismatchRefusal({ toolName, boundRunId, namedRunId, kind, bindingUnderDataHome: bindingUnderCurrentDataHome() });
}
const server=new McpServer({name:'nucleus',version:'1.0.0'});
// Run tools expose only the Nucleus names. The legacy catalog (dependencies, dispositions,
// promotion, trusted runners) was deleted on 2026-10-15; owners steer through the CLI. A scope
// argument from an older launch is accepted and ignored.
// Papercut 8647384e: the list rule is shared with shared/schema/review.ts, so a refusal
// names the exact entry, field and expected shape and harmless duplicates are de-duplicated.
const reviewedInputList=z.array(z.unknown()).transform(rows=>dedupeReviewedInputs(rows)).superRefine((rows,context)=>{
 for(const issue of reviewedInputListRefusals(rows))context.addIssue({code:'custom',path:issue.path,message:issue.message});
});
// Mirrors shared coordinatorActionSchema; test/mcp.test.ts keeps the report catalog equal to the canonical report fields.
const reason=z.string().trim().min(1).max(4000),instruction=z.string().trim().min(1).max(12000),role=z.enum(['worker','reviewer','coordinator']);
// Spec 058 (task 533): each named awaiting proof carries the route that can produce it; untagged is external.
const awaitingProof=z.union([z.string().trim().min(1).max(2000),z.object({proof:z.string().trim().min(1).max(2000),route:z.enum(['author','environment','external'])}).strict()]);
// Mirrors shared completionBaseSchema's structured cause (task 624); test/mcp.test.ts keeps the report catalog equal to the canonical report fields.
const cause=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('external'),name:z.string().trim().min(1).max(160)}).strict(),
 z.object({kind:z.enum(['internal','unfinished'])}).strict(),
]);
const coordinatorAction=z.discriminatedUnion('verb',[
 z.object({verb:z.literal('restart'),role:role.optional(),instruction:instruction.optional(),fresh:z.boolean().optional(),reason}).strict(),
 z.object({verb:z.literal('route'),role,profileId:z.string().trim().min(1).max(240),thinkingOptionId:z.string().optional(),now:z.boolean().optional(),reason}).strict(),
 z.object({verb:z.literal('move'),to:z.enum(['work','review','merge','closeout']),instruction:instruction.optional(),reason}).strict(),
 z.object({verb:z.literal('retry_effect'),effect:z.string().trim().min(1).max(240).optional(),reason}).strict(),
 z.object({verb:z.literal('cannot'),reason}).strict(),
]);
server.registerTool('nucleus_report',{
 description:'Report the result of your current Nucleus run. The bridge supplies the run this session is bound to; omit runId, or repeat that exact runId. A report naming any other run is refused and nothing is recorded, so a mistyped runId can never read as accepted. The bridge supplies private credentials and task identity. Every report carries a short headline — at most about 200 characters of plain language saying what happened and what is next; Nucleus derives it from the first sentence of the summary when it is omitted. A task whose brief opts into queue.reportOnly may report report_ready with artifact {key, version, digest} after writing its report to that exact Nucleus lane document; Nucleus releases the worker and waits for its planner to accept or return it. For reviewer verdicts, supply complete findings as reviewText; the plugin publishes the PR comment. Original substantive reviewers must include reviewedInputs for repository files read to support approval. Up to 512 entries use {path, sha256}; above 512, summarise with {directory} or {glob} entries and/or {digest, count}, where digest is the SHA-256 of the UTF-8 JSON array of {path, sha256} entries sorted by path. A harmless duplicate entry is de-duplicated; a malformed entry is refused with the exact entry, field and expected shape, and you must correct that field and resend the same report — a refused report of your own is never a reason to report blocked or error. The authenticated callback preserves this bounded receipt. A reviewer may also supply a bounded verdicts array (id, subject, verdict, evidence, optional note) with one entry per judgment; when the brief opted into queue.reviewVerdicts, ready_to_merge is refused while a requested subject has no verdict. When source review is complete but a proof you cannot produce yourself prevents completion, report blocked with sourceApproved true and awaitingProofs naming each missing proof with the route that can produce it: {proof, route} where route is author (the author can produce this evidence at the head), environment (a check that faulted before any assertion in your own run; Nucleus gives exactly one clean retry) or external (native hardware, another project verification, a post-merge proof). An untagged proof is treated as external and Nucleus routes each proof to whoever can produce it; the tag never grants approval. A deliberate bounded pre-PR checkpoint reports status progress_checkpoint with the exact local head; the queue continues the same retained worker without a coordinator. A reviewer that cannot finish its reading in one turn reports status review_in_progress with checkpoint {covered, remaining, notes}; the queue records it durably and continues the same reviewer run at the same head. It is never a verdict. On a new reviewer run, changes_required names reviewResponsibility author for a concrete author defect; blocked/error names environment for a real impediment. Unfinished reading is reviewer-owned and uses review_in_progress, not an author verdict. A proof-only executor reports status proof_executed with proofResult {status, selector, exitCode, evidence} for the one brief-named selector it actually ran; it never reports a review verdict. A coordinator reports its one owner action as coordinatorAction (restart, route, move, retry_effect or cannot) with status recovered, or blocked/error for cannot. A blocked or error report names its structured cause: {kind: external, name: a short named cause} for a concrete external impediment (any admission, guard or budget refusal, or a proof or native step in this run, is external), {kind: internal} for an observed execution failure of this run, or {kind: unfinished} when the run must continue elsewhere; reports without it keep the summary-phrase fallback. A blocked or error report that hit a concrete failure names it in impediment (the command or provider message); a blocked or error report with no impediment and no new commit continues in this same thread, up to twice, before the planner ladder. Retry identical arguments after a transport failure.',
 inputSchema:{sourceApproved:z.literal(true).optional(),awaitingProofs:z.array(awaitingProof).min(1).max(40).optional(),reviewResponsibility:z.enum(['author','reviewer','environment']).optional(),runId:z.string().min(1).optional(),status:z.enum(['ready_for_review','report_ready','progress_checkpoint','review_in_progress','ready_to_merge','changes_required','proof_executed','closed','blocked','error','recovered','escalate']),artifact:z.object({key:z.string().min(1),version:z.number().int().positive(),digest:z.string().regex(/^sha256:[a-f0-9]{64}$/)}).strict().optional(),proofResult:z.object({status:z.enum(['passed','failed']),selector:z.string().min(1).max(2000),exitCode:z.number().int().nullable().optional(),evidence:z.string().max(4000).optional()}).strict().optional(),headline:z.string().trim().min(1).max(240),summary:z.string().min(1).max(12000),cause:cause.optional(),impediment:z.string().trim().min(1).max(4000).optional(),head:z.string().regex(/^[a-f0-9]{40}$/).optional(),closeoutCommit:z.string().regex(/^[a-f0-9]{40}$/).optional(),coordinatorAction:coordinatorAction.optional(),prNumber:z.number().int().positive().optional(),reviewText:z.string().min(1).max(48000).optional(),reviewedInputs:reviewedInputList.optional(),checkpoint:z.object({covered:z.array(z.string().min(1).max(600)).max(200).optional(),remaining:z.array(z.string().min(1).max(600)).min(1).max(200),notes:z.string().max(4000).optional()}).strict().optional(),verdicts:z.array(z.object({id:z.string().min(1).max(120),subject:z.string().min(1).max(600),verdict:z.enum(['pass','fail','insufficient','not_applicable']),evidence:z.string().min(1).max(4000),note:z.string().max(4000).optional()})).max(500).optional(),providerUnavailable:z.boolean().optional(),providerRetryAt:z.string().datetime({offset:true}).optional()}
},async input=>{
 try{
  const binding=JSON.parse(readFileSync(bindingPath,'utf8'));
  const {runId,...report}=input;
  // This session reports for exactly one run. A model-typed runId is a transcription, not identity:
  // a mismatch is refused here, with the bound run named, instead of being forwarded as if accepted
  // (queue #535, papercut 5ac8ffb0). Nothing is recorded, so the same report can be resent.
  if(runId!==undefined&&runId!==binding.runId)return{isError:true,content:[{type:'text',text:mismatchRefusal('nucleus_report',binding.runId,runId,'report')}]};
  const payload={taskId:binding.taskId,runId:binding.runId,...report};
  const eventId=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const result=await callbackRequest(binding,'/report',{eventId,...payload},{timeoutMessage:'Report timed out; retry identical tool arguments'});
  return {content:[{type:'text',text:JSON.stringify(result)}]};
 }catch(error){return {isError:true,content:[{type:'text',text:error instanceof Error?error.message:'Report failed'}]};}
});
// Spec 058 (task 550; task 562 pending+resume): the same per-run binding carries
// nucleus_ask, so a worker or reviewer can ask on every provider. The call waits
// in-turn, bounded (~120s), and returns the answer with who answered it, or pending
// with the question id when the answer is still coming; Queue owns routing, dedupe,
// the durable records and the resume. A transport failure is classified by phase,
// never left as unknown delivery: a connect failure (the request never reached
// Queue, e.g. ENOENT when a roll takes the socket away) is a definite not-recorded
// retry, a response lost after Queue processed the ask is collectable by the
// identical re-ask, a call lost in flight names the same identical re-ask, and a
// call silent past the client's in-turn budget states no delivery verdict at all:
// whether Queue recorded the ask is unobserved, and the identical re-ask joins it
// if recorded or records it if not. The budget rides the binding as askTimeoutMs.
server.registerTool('nucleus_ask',{
 description:'Ask Nucleus one question in-turn and wait for the answer, on any provider. For a board decision, provide a plain-language headline, two or three choices with one-line consequences, the recommended choice label, and longer context in details. Nucleus records the question durably and sends operator-only kinds to the board; other questions go to the project planner, or a short-lived decider after about ten minutes. target "reviewer" instead consults this task\'s retained reviewer for a second opinion mid-turn (a missing or silent reviewer falls through to the planner). A planner answer may include Overtakes with exact decision IDs it settles; Nucleus never infers matches from wording. The tool result is the answer with who answered it. When no answer arrives within about 120 seconds the result is Recorded as question <id>; pending with <planner|decider|Tom>. You will be resumed with the answer; retry the same arguments to collect the answer. The bridge supplies the run this session is bound to; omit runId, or repeat that exact runId. Never use nucleus_ask to ask for authority this run already holds, and never send test or probe questions.',
 inputSchema:{question:z.string().trim().min(1).max(4000),headline:z.string().trim().min(1).max(140).regex(/^[^\r\n]*$/).optional(),choices:z.array(z.union([z.string().trim().min(1).max(400),z.object({label:z.string().trim().min(1).max(120),consequence:z.string().trim().max(240).regex(/^[^\r\n]*$/)}).strict()])).max(10).optional(),recommended:z.string().trim().min(1).max(120).optional(),details:z.string().max(48000).nullable().optional(),kind:z.enum(['proof_acceptance','budget','review','scope','release','process']).optional(),target:z.enum(['planner','reviewer']).optional(),runId:z.string().min(1).optional()}
},async input=>{
 let binding;
 // The session binding is not the Queue transport: a binding-read failure says
 // so and never runs through the transport classification below.
 try{binding=JSON.parse(readFileSync(bindingPath,'utf8'));}
 catch(error){return {isError:true,content:[{type:'text',text:`Nucleus session binding unreadable (${error instanceof Error?error.message:String(error)}); this session cannot ask, and nothing was sent.`}]};}
 const {runId,...ask}=input;
 if(runId!==undefined&&runId!==binding.runId)return{isError:true,content:[{type:'text',text:mismatchRefusal('nucleus_ask',binding.runId,runId,'ask')}]};
 const payload={taskId:binding.taskId,runId:binding.runId,...ask};
 const eventId=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
 // The client's in-turn budget only bounds the silent wait; Queue answers pending
 // well inside it. A budget expiry proves nothing about delivery — the text below
 // claims no recorded state, and stays free of transport words so the phase
 // classification never mistakes the budget for a fault.
 const askBudgetMs=typeof binding.askTimeoutMs==='number'&&binding.askTimeoutMs>0?binding.askTimeoutMs:150_000;
 let result;
 try{result=await callbackRequest(binding,'/ask',{eventId,...payload},{timeoutMs:askBudgetMs,timeoutMessage:'Nucleus gave no answer within the in-turn budget. Whether the question reached Nucleus and was recorded is unobserved. Call nucleus_ask again with exactly the same arguments — the identical re-ask joins the same question when Nucleus holds it and records it when not. Never re-ask as a new question.'});}
 catch(error){
  const message=error instanceof Error?error.message:String(error);
  const phase=callbackTransportPhase(error);
  if(phase==='connect')return {isError:true,content:[{type:'text',text:`Question not recorded: Nucleus could not be reached to store it (${message}). Retry the same nucleus_ask arguments — an identical retry is the same question, and never re-ask as a new question.`}]};
  if(phase==='response')return {isError:true,content:[{type:'text',text:`Nucleus processed the question but its response was lost (${message}). The receipt is recorded: call nucleus_ask again with exactly the same arguments to collect it — never re-ask as a new question.`}]};
  if(phase)return {isError:true,content:[{type:'text',text:`The call to Nucleus was lost in flight (${message}). The question is content-addressed, so Nucleus may already hold it: call nucleus_ask again with exactly the same arguments to join or collect it — never re-ask as a new question.`}]};
  return {isError:true,content:[{type:'text',text:message||'Ask failed'}]};
 }
 return {content:[{type:'text',text:JSON.stringify(result)}]};
});
// Spec 058 rollout step 3 (task 621): the same per-run binding carries
// nucleus_message, so a worker or reviewer can share information directly with
// the current worker or reviewer of another task on every provider. The sender's
// identity comes from the binding and cannot be forged; Queue resolves the
// recipient, delivers into a live recipient's thread labelled with the sender
// task and role (or queues it for that role's next turn), records it on both
// tasks and returns the delivery result. Messages carry information only; the
// size, rate and duplicate bounds live server-side.
server.registerTool('nucleus_message',{
 description:'Send one short worker-to-worker message through Nucleus to the current worker or reviewer of another task. to names the recipient task (a reference like effigy#590, a bare number on your own repository, or a task id); role picks worker (default) or reviewer; text carries the message (at most 4000 characters). Nucleus delivers it, queues it, or reports an uncertain delivery; never resend an uncertain message. Terminal recipients refuse. Messages carry information only: they grant no authority and change no brief, hold, verdict or budget — decisions and rulings still go through nucleus_ask and the planner ladder. Repeated identical messages are dropped. The bridge supplies the run this session is bound to; omit runId, or repeat that exact runId. Never send test or probe messages.',
 inputSchema:{to:z.string().trim().min(1).max(240),role:z.enum(['worker','reviewer']).optional(),text:z.string().trim().min(1).max(4000),runId:z.string().min(1).optional()}
},async input=>{
 try{
  const binding=JSON.parse(readFileSync(bindingPath,'utf8'));
  const {runId,...message}=input;
  if(runId!==undefined&&runId!==binding.runId)return{isError:true,content:[{type:'text',text:mismatchRefusal('nucleus_message',binding.runId,runId,'message')}]};
  const payload={taskId:binding.taskId,runId:binding.runId,...message};
  const eventId=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const result=await callbackRequest(binding,'/message',{eventId,...payload},{timeoutMessage:'Message timed out; retry identical tool arguments'});
  return {content:[{type:'text',text:JSON.stringify(result)}]};
 }catch(error){return {isError:true,content:[{type:'text',text:error instanceof Error?error.message:'Message failed'}]};}
});
await server.connect(new StdioServerTransport());
