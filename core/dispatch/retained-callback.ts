import type { Run } from "../../shared/contracts";
import { runTicketPath } from "./agent-creation";

/**
 * The callback sentence a retained run's continuation carries on a host that
 * injects no per-thread environment (BB, nucleus#1315). Such a thread's shell
 * holds nothing to report with, so a continuation that only says "report via
 * your existing callback" leaves the bare helper to refuse with `Missing Nucleus
 * callback environment` after a plugin roll or a shell reset. The sentence names
 * this run's own helper and ticket and its run identity, the same command the
 * first dispatch's prompt named. Hosts with a per-thread environment keep their
 * continuation text unchanged, so the sentence is empty for them.
 */
export function retainedCallbackSentence(input: {
  run: Pick<Run, "id">;
  helperPath: string | undefined;
  perThreadEnvironment: boolean | undefined;
}): string {
  if (input.perThreadEnvironment !== false || !input.helperPath) return "";
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const ticket = runTicketPath({ helperPath: input.helperPath }, input.run.id);
  return `Report through this run's callback: NUCLEUS_HELPER=${quote(input.helperPath)} NUCLEUS_CONTINUATION_RUN_ID=${quote(input.run.id)} NUCLEUS_CONTINUATION_TICKET=${quote(ticket)} nucleus helper report. Feed the actual result JSON on stdin; never print the ticket.`;
}
