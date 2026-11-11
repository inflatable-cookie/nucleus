// Review-entry intake helper: preview or start an external PR review entry.

import { compiledIdentity } from '../shared/runtime.mjs';
import {readFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {queueClient} from './queue-client.mjs';

const {values,positionals}=parseArgs({allowPositionals:true,options:{preview:{type:'boolean',default:false},key:{type:'string'},lead:{type:'string'},pr:{type:'string'},workspace:{type:'string'},repository:{type:'string'},authority:{type:'string'},models:{type:'string'},'github-author':{type:'string'},'authoring-system':{type:'string'},'attested-by':{type:'string'},provenance:{type:'string'},'workspace-ownership':{type:'string'},'via-paseo':{type:'boolean',default:false},help:{type:'boolean'}}});
if(values.help){
  console.log('node bin/nucleus-review-entry.mjs [--preview | --key STABLE_KEY] [--via-paseo] input.json\nnode bin/nucleus-review-entry.mjs --lead ID --pr N [--workspace ID --workspace-ownership intake|external] --authority TEXT --models PROVIDER/MODEL --github-author LOGIN --authoring-system NAME --attested-by NAME --provenance TEXT [--repository ORIGIN] [--preview | --key STABLE_KEY]\nThe lead route derives the submission from the approved Nucleus lead, reads PR branch/head from GitHub, prepares an intake-owned checkout-pr workspace when needed, then previews and submits review entry. When supplying a workspace, state whether it was created for this intake (intake) or predates it (external).');
  process.exit(0);
}
let input;
const leadRoute=Boolean(values.lead);
if(values.lead){
  if(positionals.length||!values.pr)throw Error('--lead requires --pr and takes no JSON file');
  if(!values.preview&&!values.key)throw Error('Lead intake starts only with --key STABLE_KEY; use --preview for a read-only check');
  if(values.preview&&!values.workspace)throw Error('--preview is read-only and requires an existing --workspace; omit --preview to prepare a checkout-pr workspace and submit');
  if(values.workspace&&!values['workspace-ownership'])throw Error('--workspace requires --workspace-ownership intake|external; use intake for a workspace created specifically for this intake, otherwise external');
  if(values['workspace-ownership']&&!['intake','external'].includes(values['workspace-ownership']))throw Error('--workspace-ownership must be intake or external');
  for(const name of ['authority','models','github-author','authoring-system','attested-by','provenance'])if(!values[name]?.trim())throw Error(`--lead requires --${name}`);
  if (!compiledIdentity) await import('tsx');
  const client=await queueClient({viaPaseo:values['via-paseo']});
  try{
    await client.connect();
    const lead=await client.request('lead.get',{id:values.lead});
    const digestModule=await import('../service/transport/index.mjs');
    const handoff=await import('../service/transport/index.mjs');
    const digest=digestModule.briefDigest(lead.body);
    if(lead.state!=='open'||!lead.check?.ok||lead.approval?.version!==lead.version||lead.approval?.digest!==digest||lead.check.planningCommit!==lead.approval.planningCommit)
      throw Error('Lead must be open, successfully checked and approved at its current version and digest');
    if(!/^---\r?\n/.test(lead.body))throw Error('Lead has no brief to review');
    const repository=values.repository
      ?lead.repositories.find(item=>item.origin===values.repository||item.path===values.repository)
      :lead.repositories.length===1?lead.repositories[0]:null;
    if(!repository)throw Error(lead.repositories.length>1?'--repository must select one repository listed on this lead':'Lead has no matching repository');
    const repositoryPath=repository.path;
    if(!repositoryPath)throw Error('Selected lead repository has no checkout path');
    const latest=lead.versions.find(version=>version.version===lead.version);
    if(!latest?.author)throw Error('Lead does not retain its latest author identity');
    const leadSourceId=createHash('sha256').update(JSON.stringify(['lead',lead.id,repository.origin,digest,lead.version])).digest('hex');
    const prepared=await handoff.prepareDraftContent({text:lead.body,repoPath:repositoryPath,baseBranch:lead.baseBranch,originAgentId:latest.author,draftId:leadSourceId});
    const laneInventory=await client.request('lanes',{});
    const laneKeys=lead.lanes.filter(key=>laneInventory.some(lane=>lane.key===key&&lane.repositories?.some(item=>item.origin===repository.origin||item.path===repositoryPath)));
    const pr=JSON.parse(execFileSync('gh',['api',`repos/${repository.origin.replace(/^.*github\.com[:/]/,'').replace(/\.git$/,'')}/pulls/${values.pr}`],{cwd:repositoryPath,encoding:'utf8'}));
    const submission={...prepared.submission,lanes:[...new Set([...prepared.submission.lanes,...laneKeys])],planningSource:{kind:'lead',id:lead.id},leadProvenance:{version:lead.version,approval:lead.approval,earlierDigests:lead.versions.filter(version=>version.version<lead.version).map(version=>version.digest).filter(Boolean)}};
    let workspaceId=values.workspace,workspaceOwnership=values['workspace-ownership']??'external';
    if(!workspaceId){
      const created=await client.request('queue.review-entry-workspace',{hostId:submission.hostId,leadId:lead.id,leadVersion:lead.version,prNumber:Number(values.pr),title:lead.title,repoPath:repositoryPath});
      workspaceId=created.workspaceId;
      workspaceOwnership='intake';
    }
    input={submission,workspaceId,prNumber:Number(values.pr),expectedBranch:pr.head.ref,expectedHead:pr.head.sha,expectedBaseCommit:prepared.planningCommit,
      authority:values.authority,workspaceOwnership,workspaceMode:'isolated',
      authorDeclaration:{models:values.models.split(',').map(value=>value.trim()).filter(Boolean),githubAuthor:values['github-author'],authoringSystem:values['authoring-system'],attestedBy:values['attested-by'],provenance:values.provenance}};
  }finally{await client.close()}
}else{
  if(positionals.length!==1)throw Error('Supply one review-entry JSON input file, or use --lead ID --pr N');
  input=JSON.parse(readFileSync(positionals[0],'utf8'));
}
if(!values.preview&&!values.key)throw Error('Start requires --key STABLE_KEY; use --preview for a nonmutating check');
const client=await queueClient({viaPaseo:values['via-paseo']});
try{
  await client.connect();
  if(leadRoute&&!values.preview&&!values.key)throw Error('Lead intake starts only with --key STABLE_KEY; use --preview for a read-only check');
  const preview=leadRoute?await client.request('queue.review-entry-preview',input):null;
  if(preview?.eligible===false){console.log(JSON.stringify(preview,null,2));process.exitCode=1;}
  const result=values.preview
    ?preview??await client.request('queue.review-entry-preview',input)
    :preview?.eligible===false
      ?preview
    :await client.request('queue.operation-start',{key:values.key,kind:'review_entry',payload:{type:'review_entry',input},repoPath:input.submission?.repoPath,submissionId:input.submission?.submissionId});
  console.log(JSON.stringify(result,null,2));
  if(result?.eligible===false||result?.backpressured)process.exitCode=1;
}finally{await client.close()}
