// Internal implementation; agents use the installed `nucleus` command.
import { resolveCliCaller } from './caller.mjs';
// Task ownership helper: change the owner of open tasks in one write each, or
// read one thread's unfinished responsibilities before a handover.

import { queueClient } from './queue-client.mjs';
const viaPaseo=process.argv.includes('--via-paseo');
process.argv=process.argv.filter(arg=>arg!=='--via-paseo');

// Spec 040: change the owner of open tasks in one write each. The caller is this
// calling thread: the tasks' current owner, registered project/Queue planner, or
// the operator at the board. nucleus#1447: `--inventory` reads the same owner
// facts for one thread, across every project, and writes nothing.
const usage='Usage: nucleus helper reparent TO_AGENT_ID --task TASK_ID [--task TASK_ID ...] --reason TEXT | '
 +'nucleus helper reparent TO_AGENT_ID --project PROJECT --from AGENT_ID --reason TEXT | '
 +'nucleus helper reparent --inventory AGENT_ID [--project PROJECT]';
const args=process.argv.slice(2);
if(args.some(arg=>arg==='--help'||arg==='-h')){console.log(usage);process.exit(0);}
// The reparent forms name the new owner as their one positional; `--inventory`
// carries its subject as the flag's own value and has no positional.
const positional=args[0]!==undefined&&!args[0].startsWith('--')?args[0]:null;
const pairs=args.slice(positional===null?0:1);
const taskIds=[];let project=null,fromAgentId=null,reason=null,inventoryAgentId=null;
for(let i=0;i<pairs.length;i+=2){
 const flag=pairs[i],value=pairs[i+1];
 if(!value||value.startsWith('--'))throw Error(usage);
 if(flag==='--task')taskIds.push(value);
 else if(flag==='--project'&&project===null)project=value;
 else if(flag==='--from'&&fromAgentId===null)fromAgentId=value;
 else if(flag==='--reason'&&reason===null)reason=value;
 else if(flag==='--inventory'&&inventoryAgentId===null)inventoryAgentId=value;
 else throw Error(usage);
}
const byTask=taskIds.length>0,byProject=project!==null||fromAgentId!==null,byInventory=inventoryAgentId!==null;
if(byInventory){
 if(positional!==null||taskIds.length||fromAgentId!==null||reason!==null)throw Error(usage);
}else if(positional===null||!reason||byTask===byProject||(byProject&&(!project||!fromAgentId)))throw Error(usage);
const toAgentId=positional;
const caller=(await resolveCliCaller({viaPaseo})).caller;

const client=await queueClient({viaPaseo});
try{
 await client.connect();
 if(byInventory){
  // The read-only inventory: this thread's own unfinished work, grouped by
  // project, with what a project-scoped handover would leave behind.
  const input={agentId:inventoryAgentId,caller,...(project===null?{}:{project})};
  console.log(JSON.stringify(await client.request('queue.owner-inventory',input),null,2));
 } else {
  const input=byTask?{toAgentId,caller,reason,taskIds}:{toAgentId,caller,reason,project,fromAgentId};
  console.log(JSON.stringify(await client.request('queue.reparent',input),null,2));
 }
}finally{await client.close();}
