import { runPrompt, checkpointPrompt, workerPrompt } from '../../core/dispatch/prompts';
import { handoffTask, retiredTask, prePrTask, runs, intent } from './handoff-prompt-cases';
/**
 * Render every handoff-mode prompt shape from the frozen inputs. After a prompt
 * change, regenerate handoff-prompts.json from this: JSON.stringify(result, null, 2)
 * plus a trailing newline. briefs.test.ts compares the frozen bytes.
 */
export function renderHandoffPrompts(): Record<string,string> {
  const out:Record<string,string>={};
  for(const mcp of [true,false]){
    out[`worker:${mcp}`]=workerPrompt(handoffTask,mcp);
    out[`responsible-worker:${mcp}`]=workerPrompt({...handoffTask,responsible:true},mcp);
    out[`responsible-reviewer:${mcp}`]=runPrompt({...handoffTask,responsible:true},runs[1],'/helper','/ticket',mcp);
    out[`worker-retired:${mcp}`]=workerPrompt(retiredTask,mcp);
    for(const run of runs)out[`${run.role}:${mcp}`]=runPrompt(handoffTask,run,'/helper','/ticket',mcp);
    out[`revision-prepr:${mcp}`]=runPrompt(prePrTask,runs[0],'/helper','/ticket',mcp);
  }
  out.checkpoint=checkpointPrompt(handoffTask,intent);
  return out;
}
