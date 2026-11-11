import { test, weighted } from "./support/sharded-test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PaseoAdapter } from "../service/paseo-composition";
import { Admission, admitAdapter } from "../core/host/admission";
import { timedDaemonRequests } from "../hosts/paseo/adapter/paseo-call-timing";
import { createPaseoApi } from "@getpaseo/client";
import { proveWorkspaceEmpty } from "../core/verbs/disposition";
import { execFileSync } from "node:child_process";
import { capPaseoTitle } from "../core/workspaces/workspace-title";
import { WorkspaceObservationUnavailableError, ownedWorkspacePath, repoCommonDir } from "../core/workspaces/workspace-allocation";
import { RuntimeRetirementService, type EffigyAttempt } from "../core/runtime/runtime-retirement";
import { digest, Store } from "../core/store/store";
import { command, git } from "../core/git/index";
import { materializeSeed, type GitSeed } from "./support/git-seed";
import { sharedCargoEnvironment } from "../core/machine/cargo-cache";
import { checkoutRunScratchPlacement, runScratchRoot, runTemporaryDirectory, runTemporaryEnvironment, type RunScratchPlacement } from "../core/workspaces/run-scratch";
import type { CheckoutVolumeInfo } from "../core/workspaces/checkout-volume";
import { submissionSchema, type Completion, type Profile, type Run, type Task } from "../shared/contracts";

/**
 * A private Builds volume for a fixture: the production placement and its real
 * mount admission (`uuid`, external-writable check and canonical components),
 * pointed at a directory this test owns. Queue #535 refuses to create a run's
 * temp directory without that proof, so the fixtures exercise the proof itself.
 */
function fixtureRunScratch(dir: string): { mount: string; scratch: RunScratchPlacement } {
  const mount = join(realpathSync(dir), "Builds");
  mkdirSync(mount, { recursive: true });
  const volume: CheckoutVolumeInfo = { MountPoint: mount, VolumeUUID: "fixture", Internal: false, Writable: true, WritableVolume: true };
  return { mount, scratch: checkoutRunScratchPlacement({ mount, uuid: "fixture", observe: () => volume }) };
}

/**
 * A real repository for creation tests. Task 634 (PR 881) proves the owned path
 * on every create by spawning git in the task's repository, so a fixture that
 * exercises creation binds a real repository, not a placeholder path.
 */
function fixtureRepository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nsq-paseo-repo-")));
  execFileSync("git", ["init", "-q", "--initial-branch=main", root], { stdio: ["ignore", "ignore", "ignore"] });
  return root;
}

weighted(4)("release-base task dispatch registers the Queue-populated checkout as an existing directory", async () => {
  const repo = fixtureRepository();
  try {
    const adapter = new PaseoAdapter("ws://127.0.0.1:1", "/unused/callback.sock", "/unused/worker-report.mjs");
    const requests: any[] = [];
    adapter.findWorkspaces = async () => [];
    adapter.inspectWorkspaceCreation = async () => ({ kind: "found_done", directory: "/workspace" });
    (adapter as any).api = { workspaces: { create: async (input: any) => {
      requests.push(input);
      return { id: "workspace", directory: "/workspace" };
    } } };
    const task = { id: "task", title: "Release fix", repoPath: repo, branch: "ns-task", baseBranch: "release/v0.5" } as Task;

    assert.deepEqual(await adapter.createWorkspace(task), { id: "workspace", directory: "/workspace" });
    assert.deepEqual(requests[0].source, { kind: "directory", path: "/workspace" });
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

weighted(4)("a task workspace joins the Paseo project rooted at its repository, else keeps the plain directory source", async () => {
  const repo = fixtureRepository();
  try {
    for (const kind of ["project", "other-project", "list-fails"] as const) {
      const adapter = new PaseoAdapter("ws://127.0.0.1:1", "/unused/callback.sock", "/unused/worker-report.mjs");
      const requests: any[] = [];
      adapter.findWorkspaces = async () => [];
      adapter.inspectWorkspaceCreation = async () => ({ kind: "found_done", directory: "/worktrees/ns-task" });
      (adapter as any).api = {
        projects: { list: async () => {
          if (kind === "list-fails") throw new Error("daemon unavailable");
          return { projects: [
            { projectId: "prj_other", projectRootPath: "/elsewhere" },
            ...(kind === "project" ? [{ projectId: "prj_repo", projectRootPath: repo }] : []),
          ] };
        } },
        workspaces: { create: async (input: any) => { requests.push(input); return { id: "workspace", directory: "/worktrees/ns-task" }; } },
      };
      const task = { id: "task", title: "Fix", repoPath: repo, branch: "ns-task", baseBranch: "main" } as Task;
      await adapter.createWorkspace(task);
      assert.deepEqual(requests[0].source, kind === "project"
        ? { kind: "directory", path: "/worktrees/ns-task", projectId: "prj_repo" }
        : { kind: "directory", path: "/worktrees/ns-task" }, kind);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

weighted(4)("Paseo observations retain the actionable pending-request and active-turn details", async () => {
  const adapter = new PaseoAdapter("ws://127.0.0.1:1", "/unused/callback.sock", "/unused/worker-report.mjs");
  const agent = {
    workspaceId: "workspace", status: "idle", activeTurn: { turnId: "turn-42", startedAt: "2026-10-06T09:00:00.000Z" },
    pendingPermissions: [{ id: "question-42", kind: "question", name: "request_user_input", description: "Which API contract should I follow?\nUse the approved spec." }],
    runtimeInfo: null, lastError: null, refresh: async () => true, current: () => ({ labels: {}, updatedAt: "" }),
  };
  (adapter as any).api = { agents: { ref: () => agent } };

  const observation = await adapter.observe("worker");
  assert.equal(observation.activeTurnId, "turn-42");
  assert.deepEqual(observation.pendingRequest, {
    id: "question-42", kind: "question", firstLine: "Which API contract should I follow?",
  });
  assert.equal(observation.permissions, true);
});

weighted(4)("review verification includes declared external authors and still enforces the forge gate", async () => {
  const adapter=new PaseoAdapter("ws://127.0.0.1:1","/unused/callback.sock","/unused/worker-report.mjs");
  let reviewerModel="codex/gpt-5.6-luna";
  const observed:string[]=[];
  adapter.observe=async(id:string)=>{observed.push(id);return {model:reviewerModel} as any;};
  // Omit the PR deliberately: passing independence must reach, not bypass, forge validation.
  const task={agentId:null,retiredWorkers:[],workerModels:[],workerModel:null,
    reviewEntry:{authorDeclaration:{models:["xai/grok-4.6"]}}} as unknown as Task;
  const run={agentId:"reviewer"} as Run;
  const result={} as Completion;
  await assert.rejects(adapter.verifyReview(task,run,result),/Task has no PR/);
  assert.deepEqual(observed,["reviewer"]);
  reviewerModel="other/GROK-4.6";
  await assert.rejects(adapter.verifyReview(task,run,result),/not independent/);
  reviewerModel="codex/gpt-5.6-luna";
  task.workerModels=["codex/gpt-5.6-luna"];
  await assert.rejects(adapter.verifyReview(task,run,result),/not independent/);
  task.workerModels=[];
  task.reviewEntry=null;
  await assert.rejects(adapter.verifyReview(task,run,result),/not independent/);
});

weighted(4)("Paseo agent, workspace and rename titles are capped at every outbound call", async () => {
  const dir=mkdtempSync(join(tmpdir(),"nsq-paseo-titles-"));
  try {
    const sent:string[]=[];
    const envs:Array<Record<string,string>|undefined>=[];
    const adapter=new PaseoAdapter("ws://127.0.0.1:1",join(dir,"callback.sock"),join(dir,"worker-report.mjs"));
    adapter.runScratch=fixtureRunScratch(dir).scratch;
    const workspace={refresh:async()=>true,name:"Existing title",setTitle:async(title:string)=>{sent.push(title);return{title};},agents:{create:async(input:any)=>{sent.push(input.title);envs.push(input.env);return{id:"agent",workspaceId:"workspace"};}}};
    (adapter as any).api={workspaces:{
      list:async()=>({entries:[],pageInfo:{hasMore:false}}),
      create:async(input:any)=>{sent.push(input.title);return{id:"workspace",directory:input.requestId.includes("recover")?"":"/work"};},
      ref:()=>workspace,
    }};
    const longTitle=`Task ${"word ".repeat(70)}`;
    // Task 634 (PR 881) proves the owned path on every create by spawning git in
    // the task's repository, so the fixture binds a real one under its own dir.
    const repo=join(dir,"repo");
    execFileSync("git",["init","-q","--initial-branch=main",repo],{stdio:["ignore","ignore","ignore"]});
    const task={id:"task",title:longTitle,phase:"queued",held:false,number:190,repoPath:repo,branch:"task",baseBranch:"main",
      workspaceId:"workspace",profile:{id:"worker",name:"Worker",provider:"test",model:"test",notes:"",available:true,problem:"",supportedThinking:[]},
      runId:"agent-run",prHead:"a".repeat(40),originAgentId:"origin",directory:repo,planningSource:null,prUrl:"",skipPRReview:false,
      handoffPath:"docs/handoffs/task.md",planningCommit:"a".repeat(40),briefVersions:[],resolution:{closeoutWorkspaceHead:"a".repeat(40),review:null},lanes:[],reason:""} as unknown as Task;
    const workspaceTask={...task,workspaceId:null};
    adapter.inspectWorkspaceCreation=async()=>({kind:"found_done",directory:join(dir,"ws")});
    await adapter.createWorkspace(workspaceTask);
    await assert.rejects(adapter.recoverTaskWorkspace(task),/Recovered task workspace returned no directory/);
    await adapter.setTaskWorkspaceTitle(task,`Rename ${"word ".repeat(70)}`,"rename",false);
    await adapter.createCloseoutWorkspace(task);
    await adapter.createAgent(task,"token","prompt");
    // Verification coordinator runs are retired (cutover 2, PR 847); the second
    // launch is a closeout coordinator, which caps its title the same way.
    const run={id:"run",taskId:task.id,role:"closeout",workspaceId:"workspace",profile:task.profile,head:"a".repeat(40),generation:1} as Run;
    await adapter.createRun(task,run,"non-worker-token");
    for (const [index, runId, token] of [[0,"agent-run","token"],[1,"run","non-worker-token"]] as const) {
      const values={SOCKET:join(dir,"callback.sock"),TASK_ID:task.id,RUN_ID:runId,HELPER:join(dir,"worker-report.mjs"),BRANCH:task.branch,BASE_BRANCH:task.baseBranch};
      for(const [key,value] of Object.entries(values)) {
        assert.equal(envs[index]?.[`NUCLEUS_${key}`],value);
        assert.equal(envs[index]?.[`NORTHSTAR_${key}`],undefined,`${key} carries only its Nucleus name`);
      }
      assert.equal(envs[index]?.NUCLEUS_TICKET,join(dir,"tickets",`${runId}.json`));
      assert.equal(Object.values(envs[index] ?? {}).includes(token),false,"the callback token stays in the ticket");
    }
    // Worker and run agents share the Cargo home and build without incremental state (Tom, 2026-10-15).
    assert.deepEqual(envs.map(env=>[env?.CARGO_HOME,env?.CARGO_INCREMENTAL]),[[sharedCargoEnvironment().CARGO_HOME,"0"],[sharedCargoEnvironment().CARGO_HOME,"0"]]);
    // Queue #535: each launch names its own temp directory for its own run identity.
    const scratchRoot=runScratchRoot(fixtureRunScratch(dir).mount);
    assert.deepEqual(envs.map(env=>[env?.TMPDIR,env?.TMP,env?.TEMP]),[
      Array(3).fill(runTemporaryDirectory("agent-run",scratchRoot)),
      Array(3).fill(runTemporaryDirectory("run",scratchRoot)),
    ]);

    assert.equal(sent.length,6);
    for(const title of sent){
      assert.ok(title.length<=200,`title length was ${title.length}`);
      assert.ok(title.endsWith("…"),`title was not marked as truncated: ${title}`);
      assert.match(title,/word…$/);
    }
    assert.equal(capPaseoTitle("Short title"),"Short title");
    assert.equal(capPaseoTitle("x".repeat(201)),`${"x".repeat(199)}…`);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

weighted(4)("two concurrent Queue launches get their own TMPDIR under the Builds scratch root", async () => {
  const dir=mkdtempSync(join(tmpdir(),"nsq-run-tmp-"));
  try {
    const envs:Array<Record<string,string>>=[];
    const adapter=new PaseoAdapter("ws://127.0.0.1:1",join(dir,"callback.sock"),join(dir,"worker-report.mjs"));
    const {scratch}=fixtureRunScratch(dir);
    adapter.runScratch=scratch;
    (adapter as any).api={workspaces:{ref:()=>({agents:{create:async(input:any)=>{envs.push(input.env);return{id:`agent-${input.requestId}`,workspaceId:"workspace"};}}})}};
    const profile:Profile={id:"reviewer",name:"Reviewer",provider:"test",model:"review",notes:"",available:true,problem:"",supportedThinking:[]};
    const task={id:"task",title:"Task",workspaceId:"workspace",profile,runId:"run-a"} as Task;
    const run=(id:string)=>({id,taskId:task.id,role:"reviewer",generation:1,head:"a".repeat(40),base:"b".repeat(40),agentId:null,workspaceId:"workspace",profile,status:"running",createdAt:new Date().toISOString(),lastObservedAt:null,active:null,idleSince:null,completion:null,released:false}) as Run;
    // Both launches are in flight together: one shared temp root would hand both runs the same tsx IPC
    // path, which is the EADDRINUSE the Queue #530 reviewer hit before any assertion (papercut 5ac8ffb0).
    await Promise.all([adapter.createAgent(task,"token","prompt"),adapter.createRun(task,run("run-b"),"token")]);
    const temporary=envs.map(env=>env.TMPDIR).sort();
    assert.deepEqual([...temporary].sort(),[runTemporaryDirectory("run-a",scratch.root),runTemporaryDirectory("run-b",scratch.root)].sort());
    for(const path of temporary){
      assert.equal(existsSync(path),true,`${path} exists before the run starts`);
      assert.equal(statSync(path).isDirectory(),true,path);
      assert.equal(statSync(path).mode&0o077,0,`${path} is owner-only`);
    }
    assert.deepEqual(envs.map(env=>[env.TMP,env.TEMP]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))),temporary.map(path=>[path,path]));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

weighted(4)("a run launch refuses rather than create its TMPDIR on the internal disk when its pinned work volume is unavailable", async () => {
  for(const absence of ["unmounted","wrong-volume"] as const){
    const dir=mkdtempSync(join(tmpdir(),"nsq-run-tmp-refusal-"));
    try {
      // The mount path is either absent (`mkdir -p` would create it on the boot disk) or is not the
      // expected external volume. Either way the launch must refuse before anything is created.
      const mount=join(realpathSync(dir),"Builds");
      if(absence==="wrong-volume") mkdirSync(mount,{recursive:true});
      const volume:CheckoutVolumeInfo={MountPoint:mount,VolumeUUID:absence==="wrong-volume"?"different-volume":"fixture",Internal:false,Writable:true,WritableVolume:true};
      let created=0;
      const adapter=new PaseoAdapter("ws://127.0.0.1:1",join(dir,"callback.sock"),join(dir,"worker-report.mjs"));
      adapter.runScratch=checkoutRunScratchPlacement({mount,uuid:"fixture",observe:()=>volume});
      (adapter as any).api={workspaces:{ref:()=>({agents:{create:async()=>{created++;return{id:"agent",workspaceId:"workspace"};}}})}};
      const profile:Profile={id:"reviewer",name:"Reviewer",provider:"test",model:"review",notes:"",available:true,problem:"",supportedThinking:[]};
      const task={id:"task",title:"Task",workspaceId:"workspace",profile,runId:"run-a"} as Task;
      await assert.rejects(adapter.createAgent(task,"token","prompt"),/Queue checkout storage unavailable/,absence);
      assert.equal(created,0,`${absence}: no agent is created`);
      assert.equal(existsSync(join(mount,"scratch")),false,`${absence}: no scratch tree lands on the wrong disk`);
    } finally { rmSync(dir,{recursive:true,force:true}); }
  }
});

weighted(4)("a retained run recreates its recorded TMPDIR before sending and refuses when its pinned work volume is unavailable", async () => {
  const dir=mkdtempSync(join(tmpdir(),"nsq-retained-run-tmp-"));
  try {
    const {mount,scratch}=fixtureRunScratch(dir);
    const recorded=runTemporaryDirectory("retained-run",scratch.root);
    runTemporaryEnvironment("retained-run",scratch,recorded);
    rmSync(recorded,{recursive:true,force:true});
    let volume:CheckoutVolumeInfo={MountPoint:mount,VolumeUUID:"fixture",Internal:false,Writable:true,WritableVolume:true};
    let sent=0;
    const adapter=new PaseoAdapter("ws://127.0.0.1:1",join(dir,"callback.sock"),join(dir,"helper.mjs"));
    adapter.runScratch=checkoutRunScratchPlacement({mount,uuid:"fixture",observe:()=>volume});
    (adapter as any).api={agents:{ref:()=>({workspaceId:"workspace",refresh:async()=>true,current:()=>({labels:{"nucleus.mcpBinding":"old-catalog"}}),send:async(prompt:string)=>{
      sent++;
      // A retained session gets the Nucleus instructions only: the retired
      // names are neither offered nor promised to it.
      assert.match(prompt,/nucleus_report/);
      assert.doesNotMatch(prompt,/northstar_(?:report|ask|message)|NORTHSTAR_/);
      assert.equal(existsSync(recorded),true,"the recorded run TMPDIR exists when the prompt is sent");
      assert.ok(prompt.includes(recorded),"the continuation prompt names the recorded TMPDIR");
    }})}};
    const profile:Profile={id:"worker",name:"Worker",provider:"test",model:"test",notes:"",available:true,problem:"",supportedThinking:[]};
    const task={id:"task",title:"Task",repoPath:"/repo",branch:"ns-task",baseBranch:"main",workspaceId:"workspace",directory:"/repo",profile,runId:"retained-run",temporaryDirectory:recorded,
      resolution:{},briefVersions:[],lanes:[],retiredWorkers:[],workerModels:[]} as unknown as Task;
    const run={id:"retained-run",taskId:"task",role:"worker",generation:1,head:"a".repeat(40),agentId:"agent",workspaceId:"workspace",profile,status:"running",temporaryDirectory:recorded} as unknown as Run;
    await adapter.sendRun(task,run,"token");
    assert.equal(sent,1);

    rmSync(recorded,{recursive:true,force:true});
    volume={...volume,VolumeUUID:"different-volume"};
    await assert.rejects(adapter.sendRun(task,run,"token"),/Queue checkout storage unavailable/);
    assert.equal(sent,1,"an unavailable Builds volume refuses before sending the continuation");
    assert.equal(existsSync(recorded),false,"the refusal does not create a scratch tree on an unproved volume");
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

weighted(4)("an explicit unsupported-MCP preflight retries worker creation through the socket callback", async () => {
  const dir=mkdtempSync(join(tmpdir(),"nsq-paseo-"));
  try {
    const calls:any[]=[];
    const adapter=new PaseoAdapter("ws://127.0.0.1:1",join(dir,"callback.sock"),join(dir,"worker-report.mjs"),undefined,join(dir,"mcp-report.mjs"));
    adapter.runScratch=fixtureRunScratch(dir).scratch;
    (adapter as any).api={workspaces:{ref:()=>({agents:{create:async(input:any)=>{
      calls.push(input);
      if(calls.length===1)throw Error("Provider 'omp' does not support MCP servers");
      return{id:"worker",workspaceId:"workspace"};
    }}})}};
    const profile:Profile={id:"omp",name:"OMP",provider:"omp",model:"model",notes:"",available:true,problem:"",supportedThinking:[]};
    const task={id:"task",title:"Task",workspaceId:"workspace",profile,runId:"run",branch:"ns-task",baseBranch:"main"} as Task;
    const created=await adapter.createAgent(task,"token","MCP prompt","socket prompt");
    assert.deepEqual(created,{id:"worker",workspaceId:"workspace"});
    assert.equal(calls[0].config.mcpServers.nucleus.args.at(-1),"report");
    assert.equal(calls[1].config.mcpServers,undefined);
    assert.equal(calls[0].env.CARGO_HOME,sharedCargoEnvironment().CARGO_HOME);
    assert.equal(calls[1].env.CARGO_HOME,sharedCargoEnvironment().CARGO_HOME);
    assert.equal(calls[0].env.CARGO_INCREMENTAL,"0");
    // One environment family: the retired NORTHSTAR_ names are never written.
    for(const call of calls) for(const key of ['SOCKET','TASK_ID','RUN_ID','HELPER','BRANCH','BASE_BRANCH']) {
      assert.ok(call.env[`NUCLEUS_${key}`],`${key} carries its Nucleus name`);
      assert.equal(call.env[`NORTHSTAR_${key}`],undefined,`${key} carries only its Nucleus name`);
    }
    assert.equal(calls[0].env.NUCLEUS_TICKET,join(dir,"tickets","run.json"));
    assert.equal(Object.values(calls[0].env).includes("token"),false,"the callback token stays in the ticket");
    assert.equal(calls[1].prompt,"socket prompt");
    assert.equal(calls[1].requestId,"ns-agent-run-socket");
    assert.equal(existsSync(join(dir,"tickets","mcp-run.json")),false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

weighted(4)("ambiguous creation failures never trigger the socket fallback", async () => {
  const dir=mkdtempSync(join(tmpdir(),"nsq-paseo-"));
  try {
    let calls=0;
    const adapter=new PaseoAdapter("ws://127.0.0.1:1",join(dir,"callback.sock"),join(dir,"worker-report.mjs"),undefined,join(dir,"mcp-report.mjs"));
    adapter.runScratch=fixtureRunScratch(dir).scratch;
    (adapter as any).api={workspaces:{ref:()=>({agents:{create:async()=>{calls++;throw Error("connection lost")}}})}};
    const profile:Profile={id:"omp",name:"OMP",provider:"omp",model:"model",notes:"",available:true,problem:"",supportedThinking:[]};
    const task={id:"task",title:"Task",workspaceId:"workspace",profile,runId:"run",branch:"ns-task",baseBranch:"main"} as Task;
    await assert.rejects(adapter.createAgent(task,"token","MCP prompt","socket prompt"),/connection lost/);
    assert.equal(calls,1);
    assert.equal(existsSync(join(dir,"tickets","mcp-run.json")),true);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

weighted(4)("workspace recovery pages the active inventory before matching the exact Queue slug", async () => {
  const dir=mkdtempSync(join(tmpdir(),"nsq-paseo-"));
  try {
    const adapter=new PaseoAdapter("ws://127.0.0.1:1",join(dir,"callback.sock"),join(dir,"worker-report.mjs"));
    const calls:any[]=[];
    (adapter as any).api={workspaces:{list:async(input:any)=>{
      calls.push(input);
      if(!input.page.cursor)return {entries:[{id:"other",projectRootPath:"/repo",worktreeSlug:"ns-other",workspaceDirectory:"/other"}],pageInfo:{hasMore:true,nextCursor:"page-2"}};
      return {entries:[
        {id:"wrong-repo",projectRootPath:"/elsewhere",worktreeSlug:"ns-task",workspaceDirectory:"/wrong"},
        {id:"workspace",projectRootPath:"/repo",worktreeSlug:"ns-task",workspaceDirectory:"/worktree"},
      ],pageInfo:{hasMore:false,nextCursor:null}};
    }}};
    const found=await adapter.findWorkspaces({id:"task",repoPath:"/repo"} as Task);
    assert.deepEqual(found,[{id:"workspace",directory:"/worktree"}]);
    assert.equal(calls.length,2);
    assert.equal(calls[0].filter,undefined);
    assert.equal(calls[1].page.cursor,"page-2");
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

weighted(4)('workspace lookup includes the exact recorded collision ID without admitting arbitrary suffixes', async () => {
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/report.mjs');
  (adapter as any).api = { workspaces: { list: async () => ({ entries: [
    { id: 'original', projectRootPath: '/repo', worktreeSlug: 'ns-task', workspaceDirectory: '/original' },
    { id: 'recorded', projectRootPath: '/repo', worktreeSlug: 'ns-task-1', workspaceDirectory: '/collision' },
    { id: 'unowned', projectRootPath: '/repo', worktreeSlug: 'ns-task-2', workspaceDirectory: '/unowned' },
    { id: 'recorded', projectRootPath: '/other', worktreeSlug: 'ns-task-1', workspaceDirectory: '/wrong' },
  ], pageInfo: { hasMore: false } }) } };
  assert.deepEqual(await adapter.findWorkspaces({ id: 'task', repoPath: '/repo', workspaceId: 'recorded' } as Task),
    [{ id: 'original', directory: '/original' }, { id: 'recorded', directory: '/collision' }]);
});

weighted(4)('worker continuation preflight requires the retained workspace record and directory to match', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nsq-worker-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'worker');
  await mkdir(directory);
  let current: { projectRootPath: string; worktreeSlug: string } | null = { projectRootPath: '/repo', worktreeSlug: 'ns-task' };
  let registeredDirectory: string | null = directory;
  const workspace = {
    get directory() { return registeredDirectory; },
    refresh: async () => true,
    current: () => current,
  };
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/worker-report.mjs');
  (adapter as any).api = { workspaces: { ref: (id: string) => { assert.equal(id, 'workspace'); return workspace; } } };
  const task = { id: 'task', repoPath: '/repo', workspaceId: 'workspace', directory } as Task;

  assert.deepEqual(await adapter.preflightWorkerContinuation(task), { available: true });
  current = null;
  const archived = await adapter.preflightWorkerContinuation(task);
  assert.equal(archived.available, false);
  if (!archived.available) assert.match(archived.reason, /archived or removed/);

  current = { projectRootPath: '/repo', worktreeSlug: 'ns-task' };
  await rm(directory, { recursive: true, force: true });
  const removed = await adapter.preflightWorkerContinuation(task);
  assert.equal(removed.available, false);
  if (!removed.available) assert.match(removed.reason, /archived or removed/);
});

weighted(4)('workspace creation recovers an existing canonical workspace and refuses ambiguity instead of colliding', async () => {
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/report.mjs');
  let creates = 0;
  let entries = [{ id: 'original', projectRootPath: '/repo', worktreeSlug: 'ns-task', workspaceDirectory: '/original' }];
  (adapter as any).api = { workspaces: {
    list: async () => ({ entries, pageInfo: { hasMore: false } }),
    create: async () => { creates++; return { id: 'new', directory: '/new' }; },
  } };
  const task = { id: 'task', repoPath: '/repo', branch: 'ns-task', workspaceId: null } as Task;
  assert.deepEqual(await adapter.createWorkspace(task), { id: 'original', directory: '/original' });
  assert.equal(creates, 0);
  await assert.rejects(adapter.createWorkspace({ ...task, workspaceId: 'original' }), /already recorded/);
  entries.push({ ...entries[0], id: 'duplicate', workspaceDirectory: '/duplicate' });
  await assert.rejects(adapter.createWorkspace(task), /Ambiguous workspace/);
  assert.equal(creates, 0);
});

weighted(4)("an archived Paseo workspace with a surviving checkout remains a teardown failure on retry", async t => {
  const root = await mkdtemp(join(tmpdir(), "nsq-paseo-archive-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const primary = join(root, "primary"), directory = join(root, "worker");
  await command("git", ["init", "--initial-branch=main", primary], root);
  await git(primary, "config", "user.name", "Queue test");
  await git(primary, "config", "user.email", "queue@example.invalid");
  await writeFile(join(primary, "README.md"), "one\n");
  await git(primary, "add", "-A");
  await git(primary, "commit", "-m", "init");
  await git(primary, "worktree", "add", "-b", "ns-task", directory, await git(primary, "rev-parse", "HEAD"));

  const adapter = new PaseoAdapter("ws://127.0.0.1:1", "/unused/callback.sock", "/unused/report.mjs");
  let catalogued = true;
  (adapter as any).api = {
    workspaces: { ref: () => ({
      directory,
      refresh: async () => {},
      current: () => catalogued ? { projectRootPath: primary, worktreeSlug: "ns-task" } : undefined,
      archive: async () => { catalogued = false; return { archivedAt: new Date().toISOString() }; },
    }) },
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  };
  const task = { id: "task", repoPath: primary, branch: "ns-task", workspaceId: "workspace" } as Task;

  await assert.rejects(adapter.archiveTaskWorkspace(task, "workspace", directory, "", () => true, false),
    error => error instanceof Error && error.message === `worktree.teardown failed: worktree directory remains after archive: ${directory}`);
  assert.equal(existsSync(directory), true, "Queue preserves the checkout after teardown fails");
  await assert.rejects(adapter.archiveTaskWorkspace(task, "workspace", directory, "", () => true, false), /worktree\.teardown failed: worktree directory remains after archive/);
  assert.equal(existsSync(directory), true, "an absent Paseo catalog entry cannot turn the preserved checkout into a clean archive");
});

weighted(5)('accepted report-only workspace archives an empty branch only at the clean pushed planning base', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nsq-report-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = join(root, 'primary'), origin = join(root, 'origin.git'), directory = join(root, 'worker');
  await command('git', ['init', '--bare', '--initial-branch=main', origin], root);
  await command('git', ['init', '--initial-branch=main', primary], root);
  await git(primary, 'config', 'user.name', 'Queue test');
  await git(primary, 'config', 'user.email', 'queue@example.invalid');
  await writeFile(join(primary, 'README.md'), 'one\n');
  await git(primary, 'add', '-A'); await git(primary, 'commit', '-m', 'init');
  await git(primary, 'remote', 'add', 'origin', origin); await git(primary, 'push', 'origin', 'main');
  const head = await git(primary, 'rev-parse', 'HEAD');
  await git(primary, 'worktree', 'add', '-b', 'ns-task', directory, head);
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/report.mjs');
  let archives = 0;
  (adapter as any).api = {
    workspaces: { ref: () => ({ directory, refresh: async () => {},
      current: () => ({ projectRootPath: primary, worktreeSlug: 'ns-task' }),
      archive: async () => { archives++; await git(primary, 'worktree', 'remove', directory); return { archivedAt: new Date().toISOString() }; },
    }) },
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  };
  const task = { id: 'task', repoPath: primary, directory, branch: 'ns-task', baseBranch: 'main', workspaceId: 'workspace',
    planningCommit: head, planningBase: head, phase: 'done', prUrl: null, prHead: null,
    resolution: { mergedCommit: null, syncedCommit: null } } as Task;
  task.reportAcceptance = { artifact: { key: 'report', version: 1, digest: 'sha256:' + 'a'.repeat(64) },
    acceptedBy: 'owner', reason: 'Report accepted', acceptedAt: new Date().toISOString(), taskVersion: 1 };
  await writeFile(join(directory, 'dirty.txt'), 'keep');
  await assert.rejects(adapter.archiveTaskWorkspace(task, 'workspace', directory, head, () => true, false, true), /uncommitted/);
  assert.equal(archives, 0);
  await rm(join(directory, 'dirty.txt'));
  assert.deepEqual(await adapter.archiveTaskWorkspace(task, 'workspace', directory, head, () => true, false, true), []);
  assert.equal(archives, 1);
  assert.equal(existsSync(directory), false);
  assert.equal(task.resolution.mergedCommit, null);
});

/**
 * consumer #689 (2026-10-22): a report-only checkout still at its planning base is
 * published like any head. Once main moves on, the base is an ancestor of the
 * advertised base branch, so the workspace archives; a base rewritten away, a
 * dirty checkout or a foreign origin still preserves it, and nothing is pushed.
 */
weighted(19)('a report-only workspace at its planning base archives after main advances, and is preserved when that base is unpublished', async t => {
  for (const shape of ['advanced', 'rewritten', 'dirty', 'foreign-origin'] as const) {
    const root = await mkdtemp(join(tmpdir(), `nsq-report-moved-${shape}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const primary = join(root, 'primary'), origin = join(root, 'origin.git'), directory = join(root, 'worker');
    await command('git', ['init', '--bare', '--initial-branch=main', origin], root);
    await command('git', ['init', '--initial-branch=main', primary], root);
    await git(primary, 'config', 'user.name', 'Queue test');
    await git(primary, 'config', 'user.email', 'queue@example.invalid');
    await writeFile(join(primary, 'README.md'), 'one\n');
    await git(primary, 'add', '-A'); await git(primary, 'commit', '-m', 'init');
    await git(primary, 'remote', 'add', 'origin', origin); await git(primary, 'push', 'origin', 'main');
    const base = await git(primary, 'rev-parse', 'HEAD');
    await git(primary, 'worktree', 'add', '-b', 'ns-task', directory, base);
    // Ordinary main movement after the report was accepted.
    await writeFile(join(primary, 'README.md'), 'two\n');
    await git(primary, 'commit', '-am', 'later work');
    if (shape === 'rewritten') {
      // The base is rewritten away: no advertised branch contains it any more.
      await git(primary, 'checkout', '--orphan', 'fresh');
      await git(primary, 'commit', '-m', 'rewritten history');
      await git(primary, 'branch', '-M', 'fresh', 'main');
      await git(primary, 'push', '--force', 'origin', 'main');
    } else await git(primary, 'push', 'origin', 'main');
    if (shape === 'dirty') await writeFile(join(directory, 'dirty.txt'), 'keep');
    const before = await git(origin, 'for-each-ref', '--format=%(refname) %(objectname)');
    const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/report.mjs');
    let archives = 0;
    (adapter as any).api = {
      workspaces: { ref: () => ({ directory, refresh: async () => {},
        current: () => ({ projectRootPath: primary, worktreeSlug: 'ns-task' }),
        archive: async () => { archives++; await git(primary, 'worktree', 'remove', '--force', directory); return { archivedAt: new Date().toISOString() }; },
      }) },
      agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    };
    const task = { id: 'task', repoPath: primary, directory, branch: 'ns-task', baseBranch: 'main', workspaceId: 'workspace',
      planningCommit: base, planningBase: base, phase: 'done', prUrl: null, prHead: null,
      ...(shape === 'foreign-origin' ? { repository: 'canonical/repo' } : {}),
      resolution: { mergedCommit: null, syncedCommit: null } } as Task;
    task.reportAcceptance = { artifact: { key: 'report', version: 1, digest: 'sha256:' + 'a'.repeat(64) },
      acceptedBy: 'owner', reason: 'Negative result accepted', acceptedAt: new Date().toISOString(), taskVersion: 1 };
    const archiving = adapter.archiveTaskWorkspace(task, 'workspace', directory, base, () => true, false, true);
    if (shape === 'advanced') {
      assert.deepEqual(await archiving, [], shape);
      assert.equal(archives, 1, 'the planning base is an ancestor of the advanced origin/main');
      assert.equal(existsSync(directory), false);
    } else {
      await assert.rejects(archiving, shape === 'rewritten' ? /unpublished commits/ : shape === 'dirty' ? /uncommitted/ : /origin/, shape);
      assert.equal(archives, 0, `${shape}: no archive`);
      assert.equal(existsSync(directory), true, `${shape}: the workspace is preserved`);
      assert.equal(await git(directory, 'rev-parse', 'HEAD'), base, `${shape}: nothing is reset`);
    }
    assert.equal(await git(origin, 'for-each-ref', '--format=%(refname) %(objectname)'), before, `${shape}: nothing is pushed or deleted on origin`);
    assert.equal(task.resolution.mergedCommit, null);
  }
});

weighted(18)('a report-only workspace whose registered root is redirected is refused before native archive (review #595)', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-report-archive-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = join(root, 'primary'), origin = join(root, 'origin.git'), directory = ownedWorkspacePath(root, join(primary, '.git'), 'task');
  await command('git', ['init', '--bare', '--initial-branch=main', origin], root);
  await command('git', ['init', '--initial-branch=main', primary], root);
  await git(primary, 'config', 'user.name', 'Queue test');
  await git(primary, 'config', 'user.email', 'queue@example.invalid');
  await writeFile(join(primary, 'README.md'), 'one\n');
  await git(primary, 'add', '-A'); await git(primary, 'commit', '-m', 'init');
  await git(primary, 'remote', 'add', 'origin', origin); await git(primary, 'push', 'origin', 'main');
  const head = await git(primary, 'rev-parse', 'HEAD');
  await git(primary, 'worktree', 'add', '-b', 'ns-task', directory, head);
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', join(root, 'report.mjs'));
  let archives = 0;
  (adapter as any).api = {
    workspaces: { ref: () => ({ directory, refresh: async () => {},
      current: () => ({ projectRootPath: primary, worktreeSlug: 'ns-task' }),
      archive: async () => { archives++; throw Error('NATIVE_ARCHIVE_REACHED'); },
    }) },
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  };
  const task = { id: 'task', repoPath: primary, directory, branch: 'ns-task', baseBranch: 'main', workspaceId: 'workspace',
    planningCommit: head, planningBase: head, phase: 'done', prUrl: null, prHead: null,
    resolution: { mergedCommit: null, syncedCommit: null } } as Task;
  task.reportAcceptance = { artifact: { key: 'report', version: 1, digest: 'sha256:' + 'a'.repeat(64) },
    acceptedBy: 'owner', reason: 'Report accepted', acceptedAt: new Date().toISOString(), taskVersion: 1 };
  // Move the worktree and point its registered path at a subdirectory: branch,
  // common dir and publication all still pass; only the root identity differs.
  const moved = join(root, 'moved-worker');
  await git(primary, 'worktree', 'move', directory, moved);
  await mkdir(join(moved, 'nested'));
  await symlink(join(moved, 'nested'), directory);
  assert.notEqual(await realpath(directory), await realpath(await git(directory, 'rev-parse', '--show-toplevel')));
  await assert.rejects(adapter.archiveTaskWorkspace(task, 'workspace', directory, head, () => true, false, true), /registered task worktree root/);
  assert.equal(archives, 0);
});

/** A primary checkout with one commit published to its bare origin; every canonical case starts here. */
const canonicalRepository: GitSeed = { name: "canonical", build: async root => {
  const origin = join(root, "origin.git");
  await command("git", ["init", "--bare", "--initial-branch=main", origin], root);
  const primary = join(root, "primary");
  await command("git", ["init", "--initial-branch=main", primary], root);
  await git(primary, "config", "user.name", "Queue test");
  await git(primary, "config", "user.email", "queue@example.invalid");
  await writeFile(join(primary, "README.md"), "one\n");
  await git(primary, "add", "-A");
  await git(primary, "commit", "-m", "init");
  await git(primary, "remote", "add", "origin", origin);
  await git(primary, "push", "origin", "main");
} };

/** A canonical repository with a bare origin and the Queue-owned populated checkout at its canonical path. */
async function canonicalWorkspaceFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nsq-canonical-archive-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await materializeSeed(canonicalRepository, root);
  const primary = join(root, "primary");
  const baseHead = await git(primary, "rev-parse", "HEAD");
  const dataDir = join(root, "data");
  const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(dataDir, "callback.sock"), join(dataDir, "worker-report.mjs"));
  const ownedPath = join(dataDir, "workspaces", digest(await repoCommonDir(primary)), "ns-task");
  const catalog = bindCatalog(adapter, ownedPath, canonicalDescriptor(primary, ownedPath));
  const task = { id: "task", title: "Fix closeout", repoPath: primary, branch: "ns-task", baseBranch: "main",
    planningCommit: baseHead } as Task;
  await adapter.populateTaskWorktree(task);
  return { root, primary, adapter, ownedPath, baseHead, task, dataDir, catalog };
}

/** The exact SDK shape a canonical-project task workspace reports: no worktreeSlug. */
const canonicalDescriptor = (primary: string, workspaceDirectory: string) => ({
  projectRootPath: primary,
  workspaceKind: "worktree",
  workspaceDirectory,
  checkout: { mainRepoRoot: primary, isPaseoOwnedWorktree: false },
});

/** One Paseo catalog entry; the archive uncatalogues it and leaves any directory in place. */
function bindCatalog(adapter: PaseoAdapter, workspaceDirectory: string, descriptor: Record<string, unknown>, canonicalProjectRoot = descriptor.projectRootPath as string) {
  const archives: string[] = [];
  const creates: any[] = [];
  const state = { catalogued: true };
  (adapter as any).api = {
    projects: { list: async () => ({ projects: canonicalProjectRoot ? [{ projectId: "prj_repo", projectRootPath: canonicalProjectRoot }] : [] }) },
    workspaces: {
      list: async () => ({ entries: [], pageInfo: { hasMore: false } }),
      create: async (input: any) => { creates.push(input); return { id: "workspace", directory: workspaceDirectory }; },
      ref: () => ({
        get directory() { return workspaceDirectory; },
        refresh: async () => {},
        current: () => (state.catalogued ? { ...descriptor } : undefined),
        archive: async (requestId: string) => {
          archives.push(requestId);
          state.catalogued = false;
          return { archivedAt: new Date().toISOString() };
        },
      }),
    },
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  };
  return { archives, creates, setCatalogued: (value: boolean) => { state.catalogued = value; } };
}

async function commitAndPush(checkout: string, primary: string) {
  await writeFile(join(checkout, "task.txt"), "work\n");
  await git(checkout, "add", "-A");
  await git(checkout, "commit", "-m", "task work");
  const head = await git(checkout, "rev-parse", "HEAD");
  await git(primary, "push", "origin", await git(checkout, "branch", "--show-current"));
  return head;
}

weighted(6)("a canonical-project task workspace allocates, registers without a slug and archives through ordinary closeout", async t => {
  const f = await canonicalWorkspaceFixture(t);
  const { archives, creates } = f.catalog;

  // Queue allocates the checkout by Git, then registers it as a directory
  // workspace under the repository's canonical project.
  const bound = await f.adapter.createWorkspace(f.task);
  assert.deepEqual(bound, { id: "workspace", directory: f.ownedPath });
  assert.deepEqual(creates[0].source, { kind: "directory", path: f.ownedPath, projectId: "prj_repo" });

  const head = await commitAndPush(f.ownedPath, f.primary);
  const task = { ...f.task, workspaceId: "workspace", directory: f.ownedPath, prHead: head, phase: "done",
    resolution: { mergedCommit: null, syncedCommit: null } } as Task;

  // The runtime scope is captured from the retained checkout before the archive.
  const store = new Store(join(f.root, "queue.sqlite"));
  t.after(() => store.close());
  const submitted = await store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: "Fix closeout", repoPath: f.primary, planningCommit: f.baseHead,
    handoffPath: "handoff.md", originAgentId: "origin",
  }), "host", "handoff", f.baseHead);
  const token = "a".repeat(32);
  await writeFile(join(await git(f.ownedPath, "rev-parse", "--absolute-git-dir"), "effigy-runtime-scope"), token);
  const effigy: string[][] = [];
  const attempt = (code: number, output = ""): EffigyAttempt => ({ code, timedOut: false, spawnError: "", output });
  const service = new RuntimeRetirementService(store, async args => {
    effigy.push(args);
    return args[1] === "retire" ? attempt(0, "[ok] nothing owned remains") : attempt(2, "no scope subcommand");
  });
  await service.capture(submitted.id, "workspace", f.ownedPath);

  // Ordinary closeout: publish-proven, idle, clean, and recognized without a slug.
  assert.deepEqual(await f.adapter.archiveTaskWorkspace(task, "workspace", f.ownedPath, head, () => true, false, true), []);
  assert.deepEqual(archives, ["ns-archive-task-workspace"]);
  assert.equal(existsSync(f.ownedPath), false, "no retained owned worktree");
  assert.equal((await git(f.primary, "worktree", "list", "--porcelain")).includes(f.ownedPath), false);

  // The archive-success transaction flips the proof to pending and the scoped retire settles it.
  const latest = store.task(submitted.id);
  store.update(submitted.id, { resolution: { ...latest.resolution, archivedWorkspaceIds: ["workspace"],
    runtimeRetirements: service.markArchived(latest, "workspace") } });
  await service.archived(submitted.id, "workspace");
  assert.deepEqual(effigy.at(-1), ["container", "retire", "--scope", token, "--yes"]);
  assert.equal(store.task(submitted.id).resolution.runtimeRetirements[0].state, "retired");

  // Retry after the archive stays idempotent: no second archive request.
  assert.deepEqual(await f.adapter.archiveTaskWorkspace(task, "workspace", f.ownedPath, head, () => true, false, true), []);
  assert.equal(archives.length, 1);
});

weighted(8)("canonical-project ownership never replaces the preserved-state proofs", async t => {
  // An arbitrary directory registered under the canonical project is not Queue-owned.
  {
    const f = await canonicalWorkspaceFixture(t);
    const head = await commitAndPush(f.ownedPath, f.primary);
    const stray = join(f.root, "stray");
    await git(f.primary, "worktree", "add", stray, f.baseHead);
    const { archives } = bindCatalog(f.adapter, stray, canonicalDescriptor(f.primary, stray));
    const task = { ...f.task, workspaceId: "workspace", prHead: head } as Task;
    await assert.rejects(f.adapter.archiveTaskWorkspace(task, "workspace", stray, head, () => true, false, true),
      /Preserving workspace: ownership or directory changed/);
    assert.equal(archives.length, 0);
    assert.equal(existsSync(stray), true);
  }

  // A different canonical repository is refused before any archive request.
  {
    const f = await canonicalWorkspaceFixture(t);
    const head = await commitAndPush(f.ownedPath, f.primary);
    const { archives } = bindCatalog(f.adapter, f.ownedPath, canonicalDescriptor(join(f.root, "elsewhere"), f.ownedPath));
    const task = { ...f.task, workspaceId: "workspace", prHead: head } as Task;
    await assert.rejects(f.adapter.archiveTaskWorkspace(task, "workspace", f.ownedPath, head, () => true, false, true),
      /Preserving workspace: ownership or directory changed/);
    assert.equal(archives.length, 0);
    assert.equal(existsSync(f.ownedPath), true);
  }

  // An already-archived entry with a retained Queue-owned checkout stays a teardown failure.
  {
    const f = await canonicalWorkspaceFixture(t);
    await commitAndPush(f.ownedPath, f.primary);
    const catalog = bindCatalog(f.adapter, f.ownedPath, canonicalDescriptor(f.primary, f.ownedPath));
    catalog.setCatalogued(false);
    const task = { ...f.task, workspaceId: "workspace" } as Task;
    await assert.rejects(f.adapter.archiveTaskWorkspace(task, "workspace", f.ownedPath, "", () => true, false),
      new RegExp(`worktree\\.teardown failed: worktree directory remains after archive: ${f.ownedPath}`));
    assert.equal(catalog.archives.length, 0);
    assert.equal(existsSync(f.ownedPath), true);
  }

  // A foreign thread preserves the workspace.
  {
    const f = await canonicalWorkspaceFixture(t);
    const head = await commitAndPush(f.ownedPath, f.primary);
    const { archives } = bindCatalog(f.adapter, f.ownedPath, canonicalDescriptor(f.primary, f.ownedPath));
    (f.adapter as any).api.agents = { list: async () => ({ entries: [
      { agent: { id: "helper", workspaceId: "workspace", labels: {}, status: "idle" } },
    ], pageInfo: { hasMore: false } }) };
    const task = { ...f.task, workspaceId: "workspace", prHead: head } as Task;
    await assert.rejects(f.adapter.archiveTaskWorkspace(task, "workspace", f.ownedPath, head, () => true, false, true),
      /Preserving workspace containing an unrelated thread/);
    assert.equal(archives.length, 0);
    assert.equal(existsSync(f.ownedPath), true);
  }

  // Dirty state and an unexpected checked-out branch still preserve the workspace.
  {
    const f = await canonicalWorkspaceFixture(t);
    const head = await commitAndPush(f.ownedPath, f.primary);
    const { archives } = bindCatalog(f.adapter, f.ownedPath, canonicalDescriptor(f.primary, f.ownedPath));
    const task = { ...f.task, workspaceId: "workspace", prHead: head } as Task;
    await writeFile(join(f.ownedPath, "dirty.txt"), "keep");
    await assert.rejects(f.adapter.archiveTaskWorkspace(task, "workspace", f.ownedPath, head, () => true, false, true),
      /Preserving workspace with uncommitted files or unexpected commits/);
    await rm(join(f.ownedPath, "dirty.txt"));
    await git(f.ownedPath, "checkout", "-b", "wander");
    await assert.rejects(f.adapter.archiveTaskWorkspace(task, "workspace", f.ownedPath, head, () => true, false, true),
      /Preserving workspace: Git ownership changed/);
    assert.equal(archives.length, 0);
    assert.equal(existsSync(f.ownedPath), true);
  }
});

weighted(4)('Paseo owned-tool reads widen real projected tails without assuming canonical turn IDs', async () => {
  const { readToolTimeline, liveToolIssue } = await import('../core/recovery/stall');
  const { longToolHistory, toolTimelineTail } = await import('./support/tool-timeline');
  const history = longToolHistory(416);
  history[10].item = { type: 'tool_call', callId: 'exec', name: 'exec', status: 'running' };
  history[300].item = { type: 'tool_call', callId: 'exec', name: 'exec', status: 'completed' };
  const requests: unknown[] = [];
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/worker-report.mjs');
  (adapter as any).api = { agents: { ref: (id: string) => {
    assert.equal(id, 'worker');
    return { timeline: { refetch: async (options: { direction: string; limit: number }) => {
      requests.push(options);
      return { ...toolTimelineTail(history, options.limit), error: null };
    } } };
  } } };
  const read = await readToolTimeline(adapter, 'worker');
  assert.ok('entries' in read, JSON.stringify(read));
  assert.deepEqual(read.entries, history);
  assert.equal(liveToolIssue(read.entries), null);
  assert.deepEqual(requests, [200, 400, 800].map(limit => ({ direction: 'tail', limit })));
  requests.length = 0;
  assert.deepEqual(await adapter.agentTimeline('worker', 40), history.slice(-40));
  assert.deepEqual(requests, [{ direction: 'tail', limit: 40 }], 'generic timeline peeks keep one tail');
});

weighted(4)('Paseo preserves absent and unsafe coverage metadata rather than defaulting it to complete', async () => {
  const { readToolTimeline } = await import('../core/recovery/stall');
  const { toolTimelinePage, longToolHistory } = await import('./support/tool-timeline');
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/worker-report.mjs');
  const complete = toolTimelinePage(longToolHistory(2));
  let payload: any;
  (adapter as any).api = { agents: { ref: () => ({ timeline: { refetch: async () => payload } }) } };
  for (const key of ['hasOlder', 'hasNewer', 'gap', 'staleCursor', 'reset', 'epoch', 'startCursor', 'endCursor', 'projection', 'entries']) {
    payload = { ...complete }; delete payload[key];
    const read = await readToolTimeline(adapter, 'worker');
    assert.ok('issue' in read, key);
  }
  for (const key of ['gap', 'staleCursor', 'reset', 'hasNewer']) {
    payload = { ...complete, [key]: true };
    const read = await readToolTimeline(adapter, 'worker');
    assert.ok('issue' in read, key);
  }
  payload = { ...complete, error: 'read failed' };
  assert.equal(await adapter.agentTimelinePage('worker'), null);
});

weighted(4)('Paseo projected tail anchor extension preserves complete, live and unknown tool evidence', async () => {
  const { readToolTimeline, liveToolIssue } = await import('../core/recovery/stall');
  const { interleavedToolHistory, longAnchorToolHistory, projectedToolTimelineTail } = await import('./support/tool-timeline');
  for (const shape of ['cut', 'long'] as const) for (const status of ['completed', 'running', 'unknown', undefined]) {
    const history = shape === 'long' ? longAnchorToolHistory(status) : interleavedToolHistory(status);
    const reads: Array<{ limit: number; count: number }> = [];
    const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/worker-report.mjs');
    (adapter as any).api = { agents: { ref: () => ({ timeline: { refetch: async ({ limit }: { limit: number }) => {
      const page = projectedToolTimelineTail(history, limit);
      reads.push({ limit, count: page.entries.length });
      return { ...page, error: null };
    } } }) } };
    const read = await readToolTimeline(adapter, 'worker');
    assert.ok('entries' in read, JSON.stringify(read));
    assert.deepEqual(reads, shape === 'long'
      ? [{ limit: 200, count: 420 }, { limit: 840, count: 450 }]
      : [{ limit: 200, count: 200 }, { limit: 400, count: 401 }, { limit: 802, count: 450 }]);
    assert.deepEqual(read.entries, history.map(({ seqStart, seqEnd, ...entry }) => entry));
    if (status === 'completed') assert.equal(liveToolIssue(read.entries), null);
    else assert.match(liveToolIssue(read.entries)!, /running|unknown|without a terminal status/);
  }
});

weighted(16)('catalog-absent canonical teardown requires fresh source, inventory and tool proofs', async t => {
  const { toolTimelineTail } = await import('./support/tool-timeline');
  for (const shape of ['eligible', 'dirty', 'unpublished', 'branch', 'head', 'common-dir', 'unbound', 'read-failure', 'inventory', 'live-tool', 'unknown-tool', 'merged-live-tool', 'locked', 'late-head'] as const) await t.test(shape, async t => {
    const f = await canonicalWorkspaceFixture(t);
    const head = await commitAndPush(f.ownedPath, f.primary);
    f.catalog.setCatalogued(false);
    const task = { ...f.task, workspaceId: 'workspace', directory: f.ownedPath, prHead: head } as Task;
    const api = (f.adapter as any).api;
    if (shape === 'dirty') await writeFile(join(f.ownedPath, 'keep.txt'), 'local');
    if (shape === 'unpublished') await git(f.primary, 'push', 'origin', '--delete', task.branch);
    if (shape === 'branch') await git(f.ownedPath, 'checkout', '-b', 'wrong-branch');
    if (shape === 'unbound') task.directory = null;
    if (shape === 'common-dir') task.repoPath = f.root;
    if (shape === 'read-failure') api.workspaces.ref = () => ({ refresh: async () => { throw Error('catalog read failed'); }, current: () => undefined });
    if (shape === 'inventory') api.agents.list = async () => ({ entries: [], pageInfo: { hasMore: true } });
    // Once a task is merged it is free to archive (Tom, 2026-10-19): a stray running tool label on its idle thread no longer preserves it.
    if (shape === 'merged-live-tool') Object.assign(task, { phase: 'done', resolution: { ...task.resolution, mergedCommit: head } });
    if (shape === 'live-tool' || shape === 'unknown-tool' || shape === 'merged-live-tool') {
      api.agents.list = async () => ({ entries: [{ agent: { id: 'worker', workspaceId: 'workspace', status: 'idle', labels: { 'northstar.task': task.id } } }], pageInfo: { hasMore: false } });
      f.adapter.observe = async id => ({ id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
      f.adapter.agentTimelinePage = async () => shape === 'unknown-tool' ? null : toolTimelineTail([
        { timestamp: new Date().toISOString(), item: { type: 'tool_call', callId: 'live', status: 'running', name: 'exec' } },
      ], 200);
    }
    if (shape === 'locked') await git(f.primary, 'worktree', 'lock', f.ownedPath);
    let intents = 0;
    const cleanup = shape === 'late-head' ? { begin: () => 'run' as const, observed: () => {
      // Simulate source changing during an awaited pre-effect cleanup.
      task.branch = 'changed-binding';
    }, uncertain: () => {} } : undefined;
    const attempt = () => f.adapter.archiveTaskWorkspace(task, 'workspace', f.ownedPath, shape === 'head' ? f.baseHead : head,
      () => { intents++; return true; }, true, true, new Set(), true, false, cleanup);
    if (shape === 'eligible' || shape === 'merged-live-tool') {
      assert.deepEqual(await attempt(), []);
      assert.equal(existsSync(f.ownedPath), false);
      assert.equal(intents, 1);
      assert.deepEqual(await attempt(), []);
      assert.equal(intents, 1, 'gone directory is observed without repeating local intent');
    } else {
      await assert.rejects(attempt());
      assert.equal(existsSync(f.ownedPath), true);
      assert.equal(intents, shape === 'locked' ? 1 : 0);
      if (shape === 'locked') {
        await git(f.primary, 'worktree', 'unlock', f.ownedPath);
        assert.deepEqual(await attempt(), []);
        assert.equal(existsSync(f.ownedPath), false);
      }
    }
    assert.deepEqual(f.catalog.archives, [], 'catalog absence never replays native archive');
  });
});

weighted(14)('terminal archive proves HEAD on a live canonical-origin branch without the task branch; disposition agrees', async t => {
  const shapes = ['base', 'ancestor', 'alternate', 'unpublished', 'mirror', 'stale', 'observation', 'moved', 'fetch-race', 'foreign-origin', 'dirty', 'wrong-branch', 'common-dir'] as const;
  const eligible = new Set<string>(['base', 'ancestor', 'alternate']);
  for (const shape of shapes) await t.test(shape, async t => {
    const f = await canonicalWorkspaceFixture(t);
    const sync = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    let head = f.baseHead;
    if (shape !== 'base') {
      // The task branch is published behind HEAD, or never pushed at all.
      if (shape === 'alternate' || shape === 'unpublished') await git(f.ownedPath, 'push', 'origin', `${f.baseHead}:refs/heads/${f.task.branch}`);
      await writeFile(join(f.ownedPath, 'task.txt'), 'work\n');
      await git(f.ownedPath, 'add', '-A'); await git(f.ownedPath, 'commit', '-m', 'task work');
      head = await git(f.ownedPath, 'rev-parse', 'HEAD');
    }
    if (shape === 'ancestor') {
      await git(f.ownedPath, 'push', 'origin', 'HEAD:refs/heads/main');
      const later = await git(f.ownedPath, 'commit-tree', 'HEAD^{tree}', '-p', head, '-m', 'later main');
      await git(f.ownedPath, 'push', 'origin', `${later}:refs/heads/main`);
    }
    if (shape === 'alternate' || shape === 'moved' || shape === 'fetch-race') await git(f.ownedPath, 'push', 'origin', 'HEAD:refs/heads/donor');
    // The task branch contains HEAD, but on an origin that is not the recorded repository.
    if (shape === 'foreign-origin') await git(f.ownedPath, 'push', 'origin', `HEAD:refs/heads/${f.task.branch}`);
    if (shape === 'mirror') {
      // Another remote and its tracking refs never mint canonical publication.
      const mirror = join(f.root, 'mirror.git');
      await command('git', ['init', '--bare', mirror], f.root);
      await git(f.primary, 'remote', 'add', 'mirror', mirror);
      await git(f.ownedPath, 'push', 'mirror', 'HEAD:refs/heads/main');
      await git(f.ownedPath, 'fetch', 'mirror');
      await git(f.ownedPath, 'update-ref', 'refs/remotes/origin-mirror/main', head);
    }
    if (shape === 'stale') {
      // A deleted origin branch leaves a tracking ref that still contains HEAD.
      await git(f.ownedPath, 'push', 'origin', 'HEAD:refs/heads/donor');
      await git(f.ownedPath, 'fetch', 'origin', '+refs/heads/donor:refs/remotes/origin/donor');
      await git(f.ownedPath, 'push', 'origin', '--delete', 'donor');
    }
    if (shape === 'observation') await git(f.primary, 'remote', 'set-url', 'origin', join(f.root, 'missing.git'));
    // Ownership and cleanliness fences refuse even published source.
    if (shape === 'dirty' || shape === 'wrong-branch' || shape === 'common-dir') await git(f.ownedPath, 'push', 'origin', 'HEAD:refs/heads/main');
    if (shape === 'dirty') await writeFile(join(f.ownedPath, 'keep.txt'), 'local');
    if (shape === 'wrong-branch') await git(f.ownedPath, 'checkout', '-b', 'wrong-branch');
    if (shape === 'fetch-race') {
      // Origin deletes the donor while the proof's own fetch commits its refs: the
      // advertisement read before the fetch named it, the tracking ref keeps it,
      // and only a later advertisement shows it gone (review #538).
      const hooks = join(f.root, 'hooks');
      await mkdir(hooks);
      await writeFile(join(hooks, 'reference-transaction'), `#!/bin/sh\n[ "$1" = committed ] && git --git-dir="${join(f.root, 'origin.git')}" update-ref -d refs/heads/donor 2>/dev/null\nexit 0\n`, { mode: 0o755 });
      await git(f.primary, 'config', 'core.hooksPath', hooks);
    }
    const task = { ...f.task, workspaceId: 'workspace', directory: f.ownedPath, phase: 'cancelled', prUrl: null, prHead: null,
      ...(shape === 'common-dir' ? { repoPath: f.root } : {}), ...(shape === 'foreign-origin' ? { repository: 'canonical/repo' } : {}), resolution: { mergedCommit: null, syncedCommit: null } } as Task;
    const store = new Store(join(f.root, 'queue.sqlite'));
    t.after(() => store.close());
    const proof = await proveWorkspaceEmpty(store, task);
    assert.equal(proof.empty, eligible.has(shape) || shape === 'moved', JSON.stringify(proof));
    if (shape === 'alternate') assert.match(proof.detail, /queue branch behind HEAD on origin, but origin\/donor contains every local commit/);
    if (shape === 'base' || shape === 'ancestor') assert.match(proof.detail, /queue branch absent on origin, but origin\/main contains/);
    if (shape === 'foreign-origin') assert.match(proof.uncertain ?? '', /does not match the recorded task identity/);
    if (shape === 'fetch-race') {
      assert.match(proof.detail, /no origin ref contains HEAD/);
      // Re-arm the race for the adapter: the donor is published again and the
      // tracking ref is gone, so the adapter's own fetch commits it once more.
      await git(f.primary, 'update-ref', '-d', 'refs/remotes/origin/donor');
      await command('git', ['--git-dir', join(f.root, 'origin.git'), 'update-ref', 'refs/heads/donor', head], f.root);
    }
    const heads = shape === 'observation' ? '' : await git(f.primary, 'ls-remote', '--heads', 'origin');
    let intents = 0;
    // The published branch disappears while build output is cleaned between proofs.
    const cleanup = shape === 'moved' ? { begin: () => {
      sync(f.ownedPath, 'push', 'origin', '--delete', 'donor');
      return 'complete' as const;
    }, observed: () => {}, uncertain: () => {} } : undefined;
    const attempt = () => f.adapter.archiveTaskWorkspace(task, 'workspace', f.ownedPath, head,
      () => { intents++; return true; }, false, true, new Set(), true, false, cleanup);
    if (eligible.has(shape)) {
      assert.deepEqual(await attempt(), []);
      assert.equal(intents, 2, 'native archive and local teardown each pass the owner gate');
      assert.equal(f.catalog.archives.length, 1);
      assert.equal(existsSync(f.ownedPath), false);
      assert.equal(await git(f.primary, 'ls-remote', '--heads', 'origin'), heads, 'archive creates and removes no remote branch');
      assert.equal(task.phase, 'cancelled');
      assert.equal(task.prHead, null);
      assert.equal(task.resolution.mergedCommit, null);
    } else {
      const refusal = { 'foreign-origin': /repository origin does not match the recorded task identity/, unpublished: /unpublished commits/, 'fetch-race': /unpublished commits/, mirror: /unpublished commits/, stale: /unpublished commits/,
        moved: /unpublished commits/, dirty: /uncommitted/, observation: /missing\.git|does not appear|repository/,
        'wrong-branch': /Git ownership changed/, 'common-dir': WorkspaceObservationUnavailableError }[shape as string]!;
      await assert.rejects(attempt(), refusal);
      assert.equal(intents, 0);
      assert.deepEqual(f.catalog.archives, []);
      assert.equal(existsSync(f.ownedPath), true, 'source stays in the retained checkout');
      assert.equal(await git(f.ownedPath, 'rev-parse', 'HEAD'), head);
    }
  });
});

weighted(4)('archive inventory reaches workspace threads beyond a large unrelated archived history', async t => {
  const { toolTimelineTail } = await import('./support/tool-timeline');
  for (const shape of ['absent-idle', 'post-archive-idle', 'absent-live-foreign', 'late-read-failure'] as const) await t.test(shape, async t => {
    const f = await canonicalWorkspaceFixture(t);
    const head = await commitAndPush(f.ownedPath, f.primary);
    f.catalog.setCatalogued(shape === 'post-archive-idle');
    const task = { ...f.task, workspaceId: 'workspace', directory: f.ownedPath, prHead: head } as Task;
    const history = Array.from({ length: 21_157 }, (_, index) => ({ agent: {
      id: `unrelated-${index}`, workspaceId: 'elsewhere', archivedAt: '2026-01-01T00:00:00Z', status: 'closed', labels: {},
    } }));
    history.push({ agent: { id: 'late-participant', workspaceId: 'workspace', archivedAt: '2026-01-01T00:00:00Z',
      status: shape === 'absent-live-foreign' ? 'running' : 'idle', labels: {},
    } });
    const observations: string[] = [], pageStarts: number[] = [];
    (f.adapter as any).api.agents.list = async (options: { filter: { includeArchived: boolean }; page: { limit: number; cursor?: string } }) => {
      const start = Number(options.page.cursor ?? 0);
      pageStarts.push(start);
      if (shape === 'late-read-failure' && start >= 21_000) throw Error('Late inventory page unavailable');
      const selected = options.filter.includeArchived ? history : [];
      const end = start + options.page.limit;
      return { entries: selected.slice(start, end), pageInfo: { hasMore: end < selected.length, nextCursor: end < selected.length ? String(end) : null } };
    };
    f.adapter.observe = async id => {
      observations.push(id);
      return { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' };
    };
    f.adapter.agentTimelinePage = async () => toolTimelineTail([], 200);
    let intents = 0;
    const attempt = () => f.adapter.archiveTaskWorkspace(task, 'workspace', f.ownedPath, head,
      () => { intents++; return true; }, false, true, new Set(), true, true);
    if (shape === 'absent-live-foreign' || shape === 'late-read-failure') {
      await assert.rejects(attempt(), shape === 'late-read-failure' ? /Late inventory page unavailable/ : /threads to become idle/);
      assert.equal(existsSync(f.ownedPath), true);
      assert.equal(intents, 0);
    } else {
      assert.deepEqual(await attempt(), shape === 'post-archive-idle' ? [] : ['late-participant']);
      assert.equal(existsSync(f.ownedPath), false);
      assert.ok(observations.includes('late-participant'), 'late foreign participant receives fresh idle and tool proofs');
      await attempt();
    }
    assert.ok(pageStarts.includes(21_000), 'inventory reaches the final page beyond the former 100-page cap');
    assert.equal(f.catalog.archives.length, shape === 'post-archive-idle' ? 1 : 0, 'local recovery never replays native archive');
  });
});

weighted(200)('archive inventory narrows to the project bound on the first catalogued pass and falls back to daemon-wide otherwise', async t => {
  const { toolTimelineTail } = await import('./support/tool-timeline');
  const cases = {
    narrowed: { first: true, ids: ['prj_repo', 'prj_repo'], keys: [['prj_repo'], ['prj_repo'], ['prj_repo']] },
    'uncatalogued-first': { first: false, ids: [], keys: [undefined, undefined, undefined] },
    'changed-then-absent': { first: true, ids: ['prj_repo', 'prj_other'], keys: [['prj_repo'], undefined, undefined] },
    blank: { first: true, ids: ['', ''], keys: [undefined, undefined, undefined] },
    'project-key': { first: true, ids: ['remote:github.com/inflatable-cookie/effigy', 'remote:github.com/inflatable-cookie/effigy'], keys: [undefined, undefined, undefined] },
    'wrong-key-misses-participant': { first: true, ids: ['prj_repo', 'prj_repo'], keys: [['prj_repo'], ['prj_repo'], ['prj_repo']] },
  } as const;
  for (const [shape, c] of Object.entries(cases)) await t.test(shape, async t => {
    const f = await canonicalWorkspaceFixture(t);
    const head = await commitAndPush(f.ownedPath, f.primary);
    f.catalog.setCatalogued(c.first);
    const task = { ...f.task, workspaceId: 'workspace', directory: f.ownedPath, prHead: head } as Task;
    const api = (f.adapter as any).api, ref = api.workspaces.ref;
    let pass = 0;
    api.workspaces.ref = () => {
      const handle = ref();
      return { ...handle, refresh: async () => { pass++; },
        current: () => { const current = handle.current(); return current && { ...current, projectId: c.ids[pass - 1] }; } };
    };
    const participant = { agent: { id: 'worker', workspaceId: 'workspace', status: 'idle', labels: { 'northstar.task': task.id } } };
    const calls: { keys?: string[]; limit: number }[] = [];
    api.agents.list = async (options: { filter: { projectKeys?: string[] }; page: { limit: number } }) => {
      calls.push({ keys: options.filter.projectKeys, limit: options.page.limit });
      const hidden = shape === 'wrong-key-misses-participant' && options.filter.projectKeys;
      return { entries: hidden ? [] : [participant], pageInfo: { hasMore: false } };
    };
    f.adapter.observe = async id => ({ id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    f.adapter.agentTimelinePage = async () => toolTimelineTail([], 200);
    const attempt = () => f.adapter.archiveTaskWorkspace(task, 'workspace', f.ownedPath, head,
      () => true, false, true, new Set(['worker']), true, true);
    if (shape === 'wrong-key-misses-participant') {
      await assert.rejects(attempt(), /inventory is incomplete/);
      assert.equal(existsSync(f.ownedPath), true, 'a narrowed inventory missing an observed participant holds teardown');
    } else {
      await attempt();
      assert.equal(existsSync(f.ownedPath), false);
    }
    assert.deepEqual(calls.map(call => call.keys), c.keys);
    assert.ok(calls.every(call => call.limit === 200));
  });
});

weighted(4)('an admitted real archive samples each daemon request through the real SDK, not its Git work or SDK paging loops (Tom, 2026-10-23: "Paseo calls only")', async t => {
  for (const shape of ['paged', 'slow-request'] as const) await t.test(shape, async t => {
    const f = await canonicalWorkspaceFixture(t);
    const head = await commitAndPush(f.ownedPath, f.primary);
    const task = { ...f.task, workspaceId: 'workspace', directory: f.ownedPath, prHead: head } as Task;
    const clock = { now: 0 }, requests: { method: string; ms: number }[] = [];
    const cost: Record<string, number> = { fetchWorkspaces: shape === 'paged' ? 4_000 : 1, fetchAgent: shape === 'slow-request' ? 10_000 : 1 };
    /** Each fake daemon request advances the admission clock; local Git and filesystem work do not. */
    const request = async <T>(method: string, value: T) => { const ms = cost[method] ?? 1; requests.push({ method, ms }); clock.now += ms; return value; };
    let catalogued = true;
    const descriptor = { id: 'workspace', ...canonicalDescriptor(f.primary, f.ownedPath) };
    const participant = { id: 'worker', workspaceId: 'workspace', status: 'idle', labels: { 'northstar.task': task.id }, pendingPermissions: [], activeTurn: null };
    const daemon = {
      // Workspace refresh walks these pages itself; the workspace is on the last one.
      fetchWorkspaces: (options: { page: { cursor?: string } }) => {
        const page = Number(options.page.cursor ?? 0);
        const entries = page < 2 ? [{ id: `other-${page}` }] : catalogued ? [descriptor] : [];
        return request('fetchWorkspaces', { entries, pageInfo: page < 2 ? { hasMore: true, nextCursor: String(page + 1) } : { hasMore: false, nextCursor: null } });
      },
      fetchAgents: (options: { page: { cursor?: string } }) => request('fetchAgents', options.page.cursor
        ? { entries: [{ agent: participant }], pageInfo: { hasMore: false } }
        : { entries: [], pageInfo: { hasMore: true, nextCursor: 'page-2' } }),
      fetchAgent: ({ agentId }: { agentId: string }) => request('fetchAgent', { agent: { ...participant, id: agentId }, project: null }),
      fetchAgentTimeline: () => request('fetchAgentTimeline', { entries: [], hasOlder: false, hasNewer: false, gap: false, staleCursor: false,
        reset: false, epoch: 'history', projection: 'projected', startCursor: null, endCursor: null }),
      archiveWorkspace: (workspaceId: string, requestId: string) => { catalogued = false; return request('archiveWorkspace', { requestId, workspaceId, archivedAt: new Date().toISOString(), error: null }); },
    };
    (f.adapter as any).api = createPaseoApi(timedDaemonRequests(daemon) as any);
    const admission = new Admission({ now: () => clock.now, startIntervalMs: 0 });
    await admitAdapter(f.adapter, admission).archiveTaskWorkspace!(task, 'workspace', f.ownedPath, head, () => true, false, true, new Set(['worker']), true, true);
    assert.equal(existsSync(f.ownedPath), false);
    assert.deepEqual([...new Set(requests.map(r => r.method))].sort(), ['archiveWorkspace', 'fetchAgent', 'fetchAgentTimeline', 'fetchAgents', 'fetchWorkspaces']);
    const latency = admission.snapshot().latency.cleanup, backpressure = admission.snapshot().backpressure;
    assert.equal(latency.samples, requests.length, 'one sample per daemon request, every workspace and agent page included');
    assert.equal(latency.maxMs, Math.max(...requests.map(r => r.ms)), 'no sample spans a paging loop, the whole archive or its Git work');
    if (shape === 'paged') {
      assert.ok(requests.filter(r => r.method === 'fetchWorkspaces').length >= 9, 'each refresh walks the pages; the post-archive refresh walks them all');
      assert.equal(backpressure.degraded, false, 'three 4 s pages are three fast samples, not one 12 s sample');
    } else {
      assert.equal(backpressure.degraded, false, 'slow archive requests are breaker-exempt');
    }
  });
});

weighted(4)('archive inventory refuses missing, repeated or cyclic continuation cursors', async t => {
  for (const cursors of [[undefined], ['a', 'a'], ['a', 'b', 'a']]) await t.test(JSON.stringify(cursors), async t => {
    const f = await canonicalWorkspaceFixture(t);
    const head = await commitAndPush(f.ownedPath, f.primary);
    f.catalog.setCatalogued(false);
    const task = { ...f.task, workspaceId: 'workspace', directory: f.ownedPath, prHead: head } as Task;
    let pages = 0;
    (f.adapter as any).api.agents.list = async () => {
      assert.ok(pages < cursors.length, 'invalid cursor must stop pagination');
      return { entries: [], pageInfo: { hasMore: true, nextCursor: cursors[pages++] } };
    };
    await assert.rejects(f.adapter.archiveTaskWorkspace(task, 'workspace', f.ownedPath, head,
      () => { assert.fail('incomplete inventory cannot authorize teardown'); }, true, true), /inventory is incomplete/);
    assert.equal(pages, cursors.length);
    assert.equal(existsSync(f.ownedPath), true);
    assert.equal(f.catalog.archives.length, 0);
  });
});

weighted(200)("the Paseo adapter supplies the real host worktree validation scan (milestone 6257017a)", () => {
  // Production must keep scanning: an adapter without this method observes no
  // validation, which only synthetic test engines may rely on.
  const adapter = new PaseoAdapter("ws://127.0.0.1:1", "/unused/callback.sock", "/unused/worker-report.mjs");
  assert.equal(typeof adapter.worktreeValidation, "function");
  const scan = adapter.worktreeValidation(join(tmpdir(), `nsq-no-such-worktree-${randomUUID()}`), []);
  assert.ok(["absent", "unverified", "alive"].includes(scan.state), JSON.stringify(scan));
  assert.notEqual(scan.state, "alive", "nothing runs in a directory that does not exist");
});

weighted(4)("reviewer, revision and recovery launches receive only their own Nucleus callback environment", async () => {
  const dir=mkdtempSync(join(tmpdir(),"nsq-run-wire-"));
  try {
    const calls:any[]=[];
    const adapter=new PaseoAdapter("ws://127.0.0.1:1",join(dir,"callback.sock"),join(dir,"helper.mjs"),undefined,join(dir,"mcp-report.mjs"));
    adapter.runScratch=fixtureRunScratch(dir).scratch;
    (adapter as any).api={workspaces:{ref:()=>({agents:{create:async(input:any)=>{calls.push(input);return{id:"agent",workspaceId:"workspace"};}}})}};
    const profile:Profile={id:"p",name:"p",provider:"test",model:"test",notes:"",available:true,problem:"",supportedThinking:[]};
    const task={id:"task",title:"Task",repoPath:"/repo",branch:"ns-task",baseBranch:"main",workspaceId:"workspace",directory:"/repo",profile,runId:"worker-run",resolution:{},briefVersions:[],lanes:[],retiredWorkers:[],workerModels:[],dependsOn:[]} as unknown as Task;
    for(const role of ['reviewer','revision','recovery'] as const) {
      const run={id:`run-${role}`,taskId:task.id,role,generation:1,head:"a".repeat(40),workspaceId:"workspace",profile} as Run;
      await adapter.createRun(task,run,`token-${role}`);
      const launch=calls.at(-1);
      const expected={SOCKET:join(dir,"callback.sock"),TASK_ID:task.id,RUN_ID:run.id,HELPER:join(dir,"helper.mjs"),BRANCH:task.branch,BASE_BRANCH:task.baseBranch};
      for(const [key,value] of Object.entries(expected)) assert.equal(launch.env[`NUCLEUS_${key}`],value);
      assert.equal(launch.env.NUCLEUS_RUN_TOKEN,undefined);
      assert.equal(launch.env.NUCLEUS_TICKET,join(dir,'tickets',`${run.id}.json`));
      assert.equal(Object.values(launch.env).includes(`token-${role}`),false);
      assert.equal(launch.env.NORTHSTAR_TICKET,undefined,'no retired environment family is written');
      for(const family of Object.keys(launch.env).filter(name=>name.startsWith('NORTHSTAR_'))) assert.fail(`an old-name variable is written: ${family}`);
      assert.ok(launch.config.mcpServers.nucleus);
      assert.deepEqual(launch.labels,{'nucleus.plugin':'nucleus','nucleus.task':task.id,'nucleus.run':run.id,'nucleus.role':role,'nucleus.mcpBinding':run.id,
        'nucleus.mcpBindingPath':join(dir,'tickets',`mcp-${run.id}.json`)});
      assert.match(launch.prompt,/nucleus_report/);
      assert.doesNotMatch(launch.prompt,/northstar_(?:report|ask|message)|NORTHSTAR_/);
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
