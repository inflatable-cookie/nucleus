import {command} from '../git/index';
import type {Task} from '../../shared/contracts';
import {repo} from './github-client';
import {taskPrNumber} from './pr-identity';
export type PrState='OPEN'|'CLOSED'|'MERGED';
type ReadCommand = typeof command;
type RepositoryReader = typeof repo;
type ReadFailureReporter = (error: Error) => void;
export async function readPrStates(tasks:Task[],read:ReadCommand=command,readRepository:RepositoryReader=repo,reportFailure:ReadFailureReporter=error=>console.warn('PR state refresh failed',error)):Promise<Record<string,PrState>> {
  const states:Record<string,PrState>={};
  // Display-only observations; never used as merge or review authority.
  const pending=tasks.filter(t=>t.prUrl&&!t.resolution.mergedCommit);
  for(let i=0;i<pending.length;i+=4){
    const batch=pending.slice(i,i+4);
    const results=await Promise.allSettled(batch.map(async t=>{
      const [repository,number]=await Promise.all([readRepository(t),Promise.resolve(taskPrNumber(t))]);
      const result=JSON.parse(await read('gh',['pr','view',String(number),'--repo',repository,'--json','state'],t.repoPath));
      if(!['OPEN','CLOSED','MERGED'].includes(result.state))throw Error('Unknown PR state');
      return result.state as PrState;
    }));
    results.forEach((result,index)=>{
      if(result.status==='fulfilled')states[batch[index].id]=result.value;
      else reportFailure(new Error(`Could not read PR state for task ${batch[index].id}: ${String(result.reason)}`,{cause:result.reason}));
    });
  }
  return states;
}
