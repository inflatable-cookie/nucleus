import type {Submission} from '../../shared/contracts';
import type {OriginAgent} from '../host/adapter';

export async function validateCompletionRecipients(input:Submission,lookup:(agentId:string)=>Promise<OriginAgent|null>){
  const origin=await lookup(input.originAgentId);
  if(input.notifyOriginOnCloseout&&(!origin||origin.archived||!origin.workspaceId))throw Error('Origin closeout notification requires a live originating agent with a workspace');
  const recipients:{agentId:string;workspaceId:string}[]=[];
  for(const agentId of input.completionNotificationAgentIds){
    const recipient=agentId===input.originAgentId?origin:await lookup(agentId);
    if(!recipient||recipient.archived||!recipient.workspaceId)throw Error(`Completion recipient is not a live Paseo agent with a workspace: ${agentId}`);
    recipients.push({agentId,workspaceId:recipient.workspaceId});
  }
  return {origin,recipients};
}
