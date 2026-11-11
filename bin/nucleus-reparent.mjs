// Task ownership helper: change the owner of open tasks in one write each.

import { queueClient } from './queue-client.mjs';
const viaPaseo=process.argv.includes('--via-paseo');
process.argv=process.argv.filter(arg=>arg!=='--via-paseo');

// Spec 040: change the owner of open tasks in one write each. The caller is this
// thread (PASEO_AGENT_ID): the tasks' current owner, registered project/Queue
// planner, or the operator at the board.
const usage='Usage: node bin/nucleus-reparent.mjs TO_AGENT_ID --task TASK_ID [--task TASK_ID ...] --reason TEXT | '
 +'node bin/nucleus-reparent.mjs TO_AGENT_ID --project PROJECT --from AGENT_ID --reason TEXT';
const args=process.argv.slice(2);
const [toAgentId,...rest]=args;
const taskIds=[];let project=null,fromAgentId=null,reason=null;
for(let i=0;i<rest.length;i+=2){
 const flag=rest[i],value=rest[i+1];
 if(!value||value.startsWith('--'))throw Error(usage);
 if(flag==='--task')taskIds.push(value);
 else if(flag==='--project'&&project===null)project=value;
 else if(flag==='--from'&&fromAgentId===null)fromAgentId=value;
 else if(flag==='--reason'&&reason===null)reason=value;
 else throw Error(usage);
}
const byTask=taskIds.length>0,byProject=project!==null||fromAgentId!==null;
if(!toAgentId||toAgentId.startsWith('--')||!reason||byTask===byProject||(byProject&&(!project||!fromAgentId)))throw Error(usage);
const caller=process.env.PASEO_AGENT_ID;
if(!caller)throw Error('PASEO_AGENT_ID is required; caller identity cannot be supplied as an argument');

const client=await queueClient({viaPaseo});
try{
 await client.connect();
 const input=byTask?{toAgentId,caller,reason,taskIds}:{toAgentId,caller,reason,project,fromAgentId};
 console.log(JSON.stringify(await client.request('queue.reparent',input),null,2));
}finally{await client.close();}
