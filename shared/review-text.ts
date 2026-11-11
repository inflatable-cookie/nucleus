import type { Task, Run, ReviewVerdict } from './contracts';

export function reviewMarker(t: Task, runId: string, head: string, status: string) {
  // Marker names are committed history on the forge: reconciliation matches the
  // exact strings reviewers posted under them (review, cancel and the split
  // checks below), so none of them renames.
  return `<!-- northstar-review:${t.id}:${runId}:${head}:${status} -->`;
}
/**
 * Spec 037: the reviewer's structured verdicts as a table under their text. Cells
 * keep one line and escape table pipes so a subject or note cannot break it.
 */
export function reviewVerdictTable(verdicts: ReviewVerdict[]): string {
  if (!verdicts.length) return '';
  const cell = (value: string) => value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  const rows = verdicts.map(verdict => `| \`${cell(verdict.id)}\` | ${cell(verdict.subject)} | \`${verdict.verdict}\` | ${cell(verdict.evidence)} | ${verdict.note ? cell(verdict.note) : ''} |`);
  return `\n\n### Review verdicts\n\n| ID | Subject | Verdict | Evidence | Note |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}`;
}
export function reviewPublicationBody(t:Task,run:Run,status:string,text:string,verdicts:ReviewVerdict[]=[]) {
  const marker=reviewMarker(t,run.id,run.head,status),body=text.trim(),table=reviewVerdictTable(verdicts);
  if(!body)throw Error('Review text must contain substantive findings');
  if(body.includes('<!-- northstar-review:')) {
    if(body.split('<!-- northstar-review:').length!==2 || !body.includes(marker))throw Error('Review protocol marker must exactly match this task, reviewer run, head and verdict, with no duplicates');
    if(!body.replace(marker,'').trim())throw Error('Review text must contain substantive findings');
    return `${body}${table}`;
  }
  return `${body}${table}\n\n${marker}`;
}

