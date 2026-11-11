// Completion-subscription helper: subscribe or unsubscribe the calling thread.

import { queueClient } from './queue-client.mjs';
const viaPaseo=process.argv.includes('--via-paseo');
process.argv=process.argv.filter(arg=>arg!=='--via-paseo');

const [taskId,action]=process.argv.slice(2);
if(!taskId||!['subscribe','unsubscribe'].includes(action))throw Error('Usage: node bin/nucleus-subscribe.mjs TASK_ID subscribe|unsubscribe');
const agentId=process.env.PASEO_AGENT_ID;
if(!agentId)throw Error('PASEO_AGENT_ID is required; this helper only changes the calling thread subscription');
// Subscribing is idempotent, so a moved task version or a transient transport fault is
// retried with a fresh version read. Anything else, or exhaustion, fails with one line.
const reasonOf=error=>(error instanceof Error?error.message:String(error)).split('\n')[0].replace(/^Queue service request failed \([a-z_]+\): /,'');
const retryable=error=>/Task changed|stream|socket|disconnect|ECONNRESET|EPIPE|timed out|timeout/i.test(reasonOf(error));
const client=await queueClient({viaPaseo});
try{
  await client.connect();
  let lastError;
  for(let attempt=1;attempt<=3;attempt++){
    try{
      const detail=await client.request('queue.detail',{taskId});
      const task=await client.request('queue.completion-subscription',{taskId,version:detail.task.version,agentId,action});
      console.log(JSON.stringify({taskId:task.id,agentId,action,version:task.version},null,2));
      lastError=undefined;break;
    }catch(error){
      lastError=error;
      if(!retryable(error)||attempt===3)break;
      await new Promise(resolve=>setTimeout(resolve,1000*attempt));
    }
  }
  if(lastError){
    const reason=reasonOf(lastError);
    console.error(`Completion ${action} for task ${taskId} failed: ${reason}${retryable(lastError)?' (still changing after 3 attempts; retry shortly)':''}`);
    process.exitCode=1;
  }
}finally{await client.close();}
