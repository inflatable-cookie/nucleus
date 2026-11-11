import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupDirForDataDir } from "../core/store/backup-worker.mjs";
import { runScratchRoot } from "../core/workspaces/run-scratch";
import { getWorkStorage, getWorkRoot, initializeWorkRoot, recordedWorkRoots } from "../core/workspaces/work-root.mjs";
import { assertCheckoutAvailable } from "../core/workspaces/checkout-volume";

function fixture() {
  return realpathSync(mkdtempSync(join(tmpdir(), "work-root-")));
}
const volume = (root: string) => ({ MountPoint: root, VolumeUUID: "synthetic-volume-id", Internal: false, Writable: true, WritableVolume: true });
function database(data: string, records: {table: string; value: unknown}[]) {
  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(join(data, "queue.sqlite"));
  for (const table of new Set(records.map(record => record.table))) db.exec(`CREATE TABLE ${table} (data TEXT)`);
  for (const record of records) db.prepare(`INSERT INTO ${record.table} (data) VALUES (?)`).run(JSON.stringify(record.value));
  db.close();
}

test("a fresh install uses portable work storage without probing a volume", () => {
  const root = fixture(), data = join(root, "data");
  const storage = initializeWorkRoot(data, {}, { observe: () => { throw Error("no volume probe expected"); } });
  assert.deepEqual(storage, { root: join(data, "work") });
  assert.equal(existsSync(join(data, "settings.json")), false);
  assert.equal(getWorkRoot(data, {}), join(data, "work"));
  assert.equal(runScratchRoot(storage.root, "consumer-a"), join(data, "work", "scratch", "consumer-a"));
  assert.equal(backupDirForDataDir(data), join(data, "backups"));
  assertCheckoutAvailable({ mount: storage.root, target: join(storage.root, "queue", "workspaces", "fixture"), read: () => { throw Error("no volume probe expected"); } });
  assert.equal(existsSync(storage.root), true);
});

test("existing workspace, QA, backup and scratch records adopt and pin their shared root once", () => {
  const root = fixture(), data = join(root, "data"), mounted = join(root, "synthetic-volume");
  database(data, [
    {table: "tasks", value: { directory: join(mounted, "queue", "workspaces", "fixture", "ns-task") }},
    {table: "runs", value: { status:"running", released:false, temporaryDirectory: join(mounted, "scratch", "consumer-a", "12345678") }},
    {table: "project_qa_runs", value: { directory: join(mounted, "queue", "project-qa", "fixture") }},
    {table: "outcomes", value: { backupDir: join(mounted, "queue", "backups") }},
  ]);
  writeFileSync(join(data, "settings.json"), JSON.stringify({daemonUrl:"ws://127.0.0.1:6767/ws", unrelated: {keep:true}}));
  let probes = 0;
  assert.deepEqual(initializeWorkRoot(data, {}, { observe: candidate => { probes++; assert.equal(candidate,mounted); return volume(candidate); } }), { root: mounted, volumeId: "synthetic-volume-id" });
  const saved = readFileSync(join(data,"settings.json"),"utf8");
  assert.deepEqual(JSON.parse(saved), { daemonUrl:"ws://127.0.0.1:6767/ws", unrelated:{keep:true}, workRoot:mounted, workVolumeId:"synthetic-volume-id" });
  assert.deepEqual(initializeWorkRoot(data, {}, { records:[{directory:"/different/queue/workspaces/task"}], observe: () => {throw Error("must not re-adopt");} }), { root: mounted, volumeId:"synthetic-volume-id" });
  assert.equal(readFileSync(join(data,"settings.json"),"utf8"), saved);
  assert.equal(probes,1);
});

test("an absent adoption volume refuses without persisting a portable fallback", () => {
  const root=fixture(), data=join(root,"data"), mounted=join(root,"absent-volume");
  database(data,[{table:"runs",value:{status:"running",released:false,temporaryDirectory:join(mounted,"scratch","consumer-a","12345678")}}]);
  assert.throws(()=>initializeWorkRoot(data,{}, {observe:()=>{throw Error("volume absent");}}),/volume absent/);
  assert.equal(existsSync(join(data,"settings.json")),false);
  assert.equal(existsSync(mounted),false);
  assert.throws(()=>initializeWorkRoot(data,{}, {observe:()=>volume("/other-volume")}),/adoption refused/);
  assert.equal(existsSync(join(data,"settings.json")),false);
});

test("explicit root and optional pin override records without adopting or rewriting settings", () => {
  const root=fixture(), data=join(root,"data"); mkdirSync(data);
  writeFileSync(join(data,"settings.json"),JSON.stringify({workRoot:join(root,"configured"),workVolumeId:"configured-id"}));
  const before=readFileSync(join(data,"settings.json"),"utf8");
  assert.deepEqual(initializeWorkRoot(data,{}, {observe:()=>{throw Error("must not adopt");}}),{root:join(root,"configured"),volumeId:"configured-id"});
  assert.deepEqual(getWorkStorage(data,{NUCLEUS_WORK_ROOT:join(root,"override"),NUCLEUS_WORK_VOLUME_ID:"override-id"}),{root:join(root,"override"),volumeId:"override-id"});
  assert.equal(readFileSync(join(data,"settings.json"),"utf8"),before);
  assert.throws(()=>getWorkStorage(data,{NUCLEUS_WORK_ROOT:"relative/path"}),/canonical absolute/);
});

test("ambiguous recorded roots refuse and repository paths cannot select storage", () => {
  const root=fixture(), data=join(root,"data"); mkdirSync(data);
  assert.deepEqual(recordedWorkRoots([{repoPath:"/consumer/queue/workspaces/fixture",summary:"/consumer/scratch/project/x"}]),[]);
  assert.throws(()=>initializeWorkRoot(data,{}, {records:[{directory:"/volume-a/queue/workspaces/task"},{temporaryDirectory:"/volume-b/scratch/consumer/x"}]}),/different work roots/);
  assert.equal(existsSync(join(data,"settings.json")),false);
});

test("a pinned volume cannot be replaced or silently recreated", () => {
  const root=fixture(), absent=join(root,"absent");
  assert.throws(()=>assertCheckoutAvailable({mount:absent,uuid:"synthetic-volume-id",observe:()=>volume(absent)}),/storage unavailable/);
  assert.equal(existsSync(absent),false);
  const mount=join(root,"present");mkdirSync(mount);
  assert.throws(()=>assertCheckoutAvailable({mount,uuid:"synthetic-volume-id",observe:()=>({...volume(mount),VolumeUUID:"other-id"})}),/identity/);
  assert.equal(existsSync(join(mount,"queue")),false);
});

test("invalid settings cannot be replaced by adoption", () => {
  for (const value of [[], { workRoot: false }, { workVolumeId: 0 }]) {
    const root = fixture(), data = join(root, "data");
    mkdirSync(data);
    const original = JSON.stringify(value);
    writeFileSync(join(data, "settings.json"), original);
    assert.throws(() => initializeWorkRoot(data, {}, {
      records: [{ directory: join(root, "volume", "queue", "workspaces", "task") }],
      observe: () => { throw Error("must validate before observing a volume"); },
    }), /must be an object|must be a string/);
    assert.equal(readFileSync(join(data, "settings.json"), "utf8"), original);
  }
});

for (const scenario of [
  { name:"workspace", table:"tasks", field:"directory", suffix:["queue","workspaces","fixture"] },
  { name:"QA", table:"project_qa_runs", field:"checkoutPath", suffix:["queue","project-qa","fixture"] },
  { name:"backup", table:null, field:"backupDir", suffix:["queue","backups"] },
  { name:"scratch", table:"runs", field:"temporaryDirectory", suffix:["scratch","consumer-a","12345678"] },
]) test(`a ${scenario.name}-only history adopts its root`,()=>{
  const root=fixture(),data=join(root,"data"),work=join(root,"volume");
  const record={ [scenario.field]:join(work,...scenario.suffix), ...(scenario.table==="runs"?{status:"running",released:false}:scenario.table==="project_qa_runs"?{state:"running",finishedAt:null}:{}) };
  if(scenario.table) database(data,[{table:scenario.table,value:record}]);
  else { mkdirSync(data);writeFileSync(join(data,"backup-status.json"),JSON.stringify(record)); }
  assert.deepEqual(initializeWorkRoot(data,{}, {observe:candidate=>volume(candidate)}),{root:work,volumeId:"synthetic-volume-id"});
});

test("current allocations outrank retired history and read-only access cannot fall back before adoption",()=>{
  const root=fixture(),data=join(root,"data"),work=join(root,"current-volume"),old=join(root,"retired-volume");
  database(data,[
    {table:"tasks",value:{phase:"working",directory:join(work,"queue","workspaces","current")}},
    {table:"tasks",value:{phase:"done",directory:join(old,"queue","workspaces","old")}},
    {table:"runs",value:{status:"finished",released:true,temporaryDirectory:join(old,"scratch","consumer-a","12345678")}},
  ]);
  const db = new DatabaseSync(join(data,"queue.sqlite"));
  db.exec("CREATE TABLE meta (key TEXT, value TEXT)");
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("oldAllocation", JSON.stringify({directory:join(old,"queue","workspaces","stale-meta")}));
  db.close();
  assert.throws(()=>getWorkStorage(data,{}),/startup adoption/);
  assert.equal(existsSync(join(data,"settings.json")),false);
  assert.deepEqual(initializeWorkRoot(data,{}, {observe:candidate=>volume(candidate)}),{root:work,volumeId:"synthetic-volume-id"});
});

test("portable records remain unpinned on the next startup",()=>{
  const root=fixture(),data=join(root,"data"),work=join(data,"work");
  database(data,[{table:"tasks",value:{directory:join(work,"queue","workspaces","fixture")}}]);
  assert.deepEqual(initializeWorkRoot(data,{}, {observe:()=>{throw Error("portable root must not be probed");}}),{root:work});
  assert.equal(existsSync(join(data,"settings.json")),false);
});


test("blank optional environment values cannot bypass adoption or remove a persisted pin",()=>{
  const root=fixture(),data=join(root,"data"),work=join(root,"volume");
  database(data,[{table:"runs",value:{status:"running",released:false,temporaryDirectory:join(work,"scratch","consumer-a","12345678")}}]);
  const env={NUCLEUS_WORK_ROOT:"",NUCLEUS_WORK_VOLUME_ID:""};
  assert.deepEqual(initializeWorkRoot(data,env,{observe:candidate=>volume(candidate)}),{root:work,volumeId:"synthetic-volume-id"});
  assert.deepEqual(getWorkStorage(data,env),{root:work,volumeId:"synthetic-volume-id"});
  assert.deepEqual(getWorkStorage(data,{NUCLEUS_WORK_ROOT:join(root,"explicit-other-root"),NUCLEUS_WORK_VOLUME_ID:""}),{root:join(root,"explicit-other-root"),volumeId:"synthetic-volume-id"});
});
