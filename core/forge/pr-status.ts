import {command} from '../git/index';
import type {Task} from '../../shared/contracts';
export type PrState='OPEN'|'CLOSED'|'MERGED';
export async function readPrStates(tasks:Task[],read=command):Promise<Record<string,PrState>> {
  const states:Record<string,PrState>={};
  // Display-only observations; never used as merge or review authority.
  const pending=tasks.filter(t=>t.prUrl&&!t.resolution.mergedCommit);
  for(let i=0;i<pending.length;i+=4){
    const batch=pending.slice(i,i+4);
    const results=await Promise.allSettled(batch.map(async t=>{
      const match=t.prUrl!.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/);
      if(!match)throw Error('Unknown PR URL');
      const result=JSON.parse(await read('gh',['pr','view',match[2],'--repo',match[1],'--json','state'],t.repoPath));
      if(!['OPEN','CLOSED','MERGED'].includes(result.state))throw Error('Unknown PR state');
      return result.state as PrState;
    }));
    results.forEach((result,index)=>{if(result.status==='fulfilled')states[batch[index].id]=result.value;});
  }
  return states;
}
