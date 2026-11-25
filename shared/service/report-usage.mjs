/**
 * The words an agent reads about the CLI report: one owner for `nucleus helper
 * report --help`, the service-written helper's own `--help` and the shape a
 * refused report repeats.
 *
 * The service interpolates these strings into the standalone worker-report
 * helper it writes into the data home.
 */

/** One accepted report shape, as a single line a refusal can repeat. */
export const REPORT_SHAPE_EXAMPLE = '{"status":"ready_to_merge","summary":"What happened and what is next","head":"<full 40-character commit SHA>","prNumber":123,"reviewText":"Full findings"}';

/** Field names agents reach for instead of the canonical ones, mapped to the field the schema takes. */
export const REPORT_FIELD_ALIASES = Object.freeze({
  headSha: 'head', head_sha: 'head', headCommit: 'head', head_commit: 'head', headRef: 'head', commit: 'head',
  commitSha: 'head', commit_sha: 'head', sha: 'head', prHead: 'head', exactHead: 'head', reviewedHead: 'head',
  pr: 'prNumber', pr_number: 'prNumber', prNum: 'prNumber', pullRequest: 'prNumber', pull_request: 'prNumber',
  commentId: 'reviewCommentId', review_comment_id: 'reviewCommentId', reviewComment: 'reviewCommentId',
  state: 'status', verdict: 'status', result: 'status', message: 'summary', text: 'summary', review: 'reviewText', findings: 'reviewText',
});

/** How long the helper waits for the first stdin byte, or for more after a pause, before it gives up. */
export const REPORT_STDIN_WAIT_MS = 10_000;

export const REPORT_USAGE = [
  'Usage: nucleus helper report <<\'JSON\'',
  '  {"status": "...", "summary": "...", ...}',
  '  JSON',
  '       nucleus helper report ask|message|answer <<\'JSON\' ... JSON',
  '       nucleus helper report context [rules|validation|proofs|history]',
  '       nucleus helper report next',
  '',
  'Sends this run\'s report to Nucleus. The report is one JSON object on stdin, so pipe it',
  'or use a heredoc. Without input the helper exits with an error after ' + (REPORT_STDIN_WAIT_MS / 1000) + ' seconds;',
  'it never waits for a terminal. Unknown fields are refused by name.',
  '',
  'Report fields:',
  '  status           required. ready_for_review | report_ready | progress_checkpoint |',
  '                   review_in_progress | ready_to_merge | changes_required | verified |',
  '                   proof_executed | closed | blocked | error | recovered | escalate',
  '  summary          required. What happened and what is next.',
  '  headline         optional one-line headline; derived from the summary when omitted.',
  '  head             the full 40-character lowercase commit SHA the report is about.',
  '                   The field is "head", not headSha, sha or commit.',
  '  prNumber         the pull request number (integer).',
  '  reviewText       a reviewer verdict\'s full findings.',
  '  reviewCommentId  a durable PR issue comment ID (integer), instead of reviewText.',
  '  reviewResponsibility  author | reviewer | environment.',
  '  verdicts         [{id, subject, verdict, evidence, note?}]',
  '  reviewedInputs   [{path, sha256}] repository files an approval relied on.',
  '  checkpoint       {covered, remaining, notes, exhausted?} with review_in_progress.',
  '  proofFiles       [{label, path}] local proof files for the reviewer.',
  '  cause            {kind: "external", name} | {kind: "internal"} | {kind: "unfinished"}',
  '                   on blocked or error.',
  '  impediment       the failing command or provider message, on blocked or error.',
  '  sourceApproved, awaitingProofs, artifact, proofResult, coordinatorAction,',
  '  providerUnavailable, providerRetryAt, closeoutCommit: see your role\'s prompt.',
  '',
  'Example (a reviewer verdict):',
  '  nucleus helper report <<\'JSON\'',
  '  {"status": "ready_to_merge", "summary": "Reviewed the exact head; no findings.",',
  '   "head": "0123456789abcdef0123456789abcdef01234567", "prNumber": 123,',
  '   "reviewText": "Full findings, one per line."}',
  '  JSON',
].join('\n');

/** The one-line instruction a helper without input prints before it exits non-zero. */
export const REPORT_NO_INPUT = 'No report JSON arrived on stdin. Pipe the report JSON on stdin, e.g. nucleus helper report <<\'JSON\' ' + REPORT_SHAPE_EXAMPLE + ' JSON. Run nucleus helper report --help for every field.';
