import type {Submission} from '../../shared/contracts';
import {HOST_KIND_LABELS, hostKindOf} from '../../shared/host-kind';
import type {OriginAgent} from '../host/adapter';

export async function validateCompletionRecipients(
  input:Submission,
  lookup:(agentId:string)=>Promise<OriginAgent|null>,
  hostIdFor?:(agentId:string)=>string|null|undefined,
){
  const origin=await lookup(input.originAgentId);
  if(input.notifyOriginOnCloseout&&(!origin||origin.archived||!origin.workspaceId))throw Error('Origin closeout notification requires a live originating agent with a workspace');
  const recipients:{agentId:string;workspaceId:string}[]=[];
  for(const agentId of input.completionNotificationAgentIds){
    const recipient=agentId===input.originAgentId?origin:await lookup(agentId);
    if(!recipient||recipient.archived||!recipient.workspaceId){
      const hostId=hostIdFor?.(agentId);
      const hostLabel=hostId?HOST_KIND_LABELS[hostKindOf(hostId)]:'host';
      throw Error(`Completion recipient is not a live ${hostLabel} agent with a workspace: ${agentId}`);
    }
    recipients.push({agentId,workspaceId:recipient.workspaceId});
  }
  return {origin,recipients};
}
