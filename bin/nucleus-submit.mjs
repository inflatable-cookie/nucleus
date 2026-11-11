import { resolveCliCaller } from './caller.mjs';
// Submission helper: submit committed handoffs or Nucleus-held briefs to the queue.

import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {queueClient} from './queue-client.mjs';
const {values,positionals}=parseArgs({allowPositionals:true,options:{origin:{type:'string'},coordinator:{type:'string'},base:{type:'string',default:'main'},commit:{type:'string'},'dry-run':{type:'boolean',default:false},'via-paseo':{type:'boolean',default:false},brief:{type:'boolean',default:false},repo:{type:'string'},help:{type:'boolean'}}});
if(values.help){console.log('node bin/nucleus-submit.mjs [--origin AGENT_ID] [--coordinator AGENT_ID] [--base main] [--commit EXPECTED_HEAD] [--dry-run] [--via-paseo] /absolute/docs/handoffs/worker.md [/absolute/docs/handoffs/another.md ...]\nnode bin/nucleus-submit.mjs --brief [--repo INTEGRATION_CHECKOUT] [options] /absolute/brief.md [...]\n--brief submits each file as a Nucleus-held brief (Spec 020): same frontmatter as a handoff, need not be committed; the planning commit is the pushed integration head (fetched origin/<base>, Spec 022) of --repo (default: current directory). Only repositories with a v5 control manifest or none accept briefs. --dry-run returns the brief digest.\nSeveral paths share one direct Nucleus socket connection. --via-paseo explicitly selects the compatibility bridge. A receipt confirms durable acceptance; inspect its operation for validation progress. Origin defaults to the calling thread (its Nucleus ticket or host identity). Handoffs must be committed and explicitly queue-approved; pushed planning is checked before task creation.');process.exit(0)}
if(!positionals.length)throw Error('Supply at least one handoff path; use --help for options');
const origin=values.origin??(await resolveCliCaller({viaPaseo:values['via-paseo']})).caller;
const client=await queueClient({viaPaseo:values['via-paseo']});
const submit=path=>client.request('queue.handoff',{...(values.brief?{briefPath:resolve(path),repoPath:resolve(values.repo??process.cwd())}:{handoffPath:resolve(path)}),originAgentId:origin,coordinatorAgentId:values.coordinator,baseBranch:values.base,planningCommit:values.commit,dryRun:values['dry-run']});
const rejected=[];
try{
  await client.connect();
  for(const handoffPath of positionals){
    try{
      const result=await submit(handoffPath);
      const failed=result?.backpressured || ['failed','needs_attention'].includes(result?.operation?.state);
      if(failed)rejected.push(handoffPath);
      if(positionals.length===1){console.log(JSON.stringify(result,null,2));if(failed)process.exitCode=1;continue}
      const task=result?.task??(result?.id?result:null);
      console.log(JSON.stringify({handoffPath,ok:!failed,backpressured:result?.backpressured??false,reason:result?.reason??result?.operation?.diagnostic??'',taskId:task?.id??result?.operation?.result?.taskId??null,number:task?.number??result?.operation?.result?.number??null,reference:task?.reference??result?.operation?.result?.reference??null,phase:task?.phase??null,operation:result?.operation?{id:result.operation.id,state:result.operation.state}:null}));
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      rejected.push(handoffPath);
      if(positionals.length===1)throw error;
      console.log(JSON.stringify({handoffPath,ok:false,outcome:'unknown-or-rejected',error:message.slice(0,600)}));
    }
  }
}finally{await client.close()}
if(positionals.length>1){
  if(rejected.length){console.error(`\n${rejected.length} of ${positionals.length} handoffs need inspection before retry (a lost response may already be accepted):`);for(const path of rejected)console.error(`  ${path}`);process.exitCode=1}
  else console.error(`\nAll ${positionals.length} handoffs were accepted.`);
}
