import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Run } from "../../shared/contracts";

export function purgeReportingFiles(helperPath:string,taskId:string,runIds:string[]) {
    for(const id of runIds){
      if(!/^[a-zA-Z0-9_-]+$/.test(id))continue;
      for(const name of [`${id}.json`,`mcp-${id}.json`]){
        const path=join(dirname(helperPath),'tickets',name);
        if(existsSync(path)&&JSON.parse(readFileSync(path,'utf8')).taskId===taskId)unlinkSync(path);
      }
    }
}

/** Remove one run's callback tickets after its release — and credential revocation — are durable. */
export function purgeReleasedRunTicket(dataDir:string,taskId:string,runId:string) {
    if(!/^[a-zA-Z0-9_-]+$/.test(runId))return;
    for(const name of [`${runId}.json`,`mcp-${runId}.json`]){
      const path=join(dataDir,'tickets',name);
      if(existsSync(path)&&JSON.parse(readFileSync(path,'utf8')).taskId===taskId)unlinkSync(path);
    }
}

export function reportingFallback(helperPath:string,run:Run) {
    const quote=(s:string)=>"'"+s.replaceAll("'", "'\\''")+"'";
    return `If nucleus_report is absent, feed actual result JSON to node ${quote(helperPath)} ${quote(join(dirname(helperPath),'tickets',`${run.id}.json`))}. Include status, summary, head ${run.head} and coordinatorGeneration ${run.generation}. The ticket supplies authentication; never print it. Require an accepted response. Do not bypass rejected callbacks. Never send test or probe reports; report only an actual result.`;
}
