/**
 * The validation rules every role's prompt carries: how covering checks are run.
 * The per-repository policy is retired (Tom, 2026-11-09, task 985), so this is
 * fixed prompt text and the repository's AGENTS.md Validate section owns the
 * rest. This module owns every validation line a worker, revision or reviewer
 * reads, including the affected-tests rule, so no role prompt states its own.
 */
/**
 * The one validation rule. The repository's AGENTS.md Validate section selects
 * covering checks; this rule says how every role runs them. Effigy admission
 * controls host load, so a check waits rather than fails, and it is never
 * stopped, skipped or repeated.
 */
export const VALIDATION_RUN_RULE =
  'Validate only through Effigy selectors, never raw npx, cargo, bun or vitest: they bypass Effigy\'s host-wide admission. Run each covering check once, in the foreground, to completion, however long it takes; never stop, skip or repeat a passing check. Ending the turn while one runs is a missing callback. "Waiting for QA capacity, position N" is a queue wait, not a hang: leave it running and never kill or retry it. Never kill processes by pattern (pkill -f, killall, pgrep | xargs kill); kill only PIDs you started. Record a background command\'s exit code (cmd > log 2>&1; echo "exit=$?" >> log) and read it before reporting. For tests, use the repository\'s test-runner timeout and forced-exit options. Only a check you would add beyond the brief may be reported instead of run, and only when it would take more than a few minutes.';

export const VALIDATION_RULE_HEADING =
  "Task validation rule (the repository's AGENTS.md Validate section is the authority)";

/**
 * The one validation authority. The per-repository validation policy is retired
 * (Tom, 2026-11-09, task 985): prompts carry this fixed line, and the repository
 * owns the rest in its AGENTS.md Validate section.
 */
export const VALIDATION_AUTHORITY_RULE =
  "Validate per the repository's AGENTS.md Validate section: read it; it is the authority on which checks cover what changed. Full milestone QA runs separately on main as an ordinary report-only task pinned to one commit, never through `project.qa.run`. Missing required proof is a blocker, not permission to report approval.";

/**
 * The affected-test run attributed to the commit (nucleus#1164, Tom 2026-11-12).
 * It belongs to the repository, never to Nucleus: only a repository whose
 * `repository.get` shows `affectedTests.command` gets this rule, and then it
 * runs exactly that command (nucleus#1380, Tom 2026-11-19). It reads committed
 * work, so it runs after the commit at the exact head. Without that setting
 * there is no affected-tests requirement at all; the repository's AGENTS.md
 * Validate section and the brief decide the covering checks. Full suites stay
 * on milestone QA.
 */
export function affectedRunRule(command: string) {
  return `Affected tests: this repository configures its own affected-tests command, so after you commit, run \`${command}\` once at that exact head. If the affected run fails, read the failure summary it prints rather than rerunning to recover failure names. For a baseline, use the repository's baseline route to rerun the file alone on \`origin/main\`. If it fails there too, it was already broken: list the file and failing test in your report and PR instead of fixing it. Only failures unique to your branch block review. Report the affected-run command and file count as evidence, and never run the full suite for it.`;
}

/** Judges that configured command at the reviewed head; says nothing when the repository configures none. */
export function affectedRunReviewerNote(command: string) {
  return `Affected tests: judge the author's \`${command}\` at this exact head from its reported command and file count. If that evidence is missing or names another head, run it once yourself. If the affected run fails, read the failure summary it prints rather than rerunning to recover failure names. For each failing affected file, use the repository's baseline route to rerun it alone on \`origin/main\`; if it fails there too, it was already broken, so list the file and failing test in your report rather than requiring a fix. Only failures unique to the branch block review. Anything wider than the affected set never is.`;
}

export function operatorValidationBlock(
  affectedTestsCommand?: string,
  reviewer = false,
) {
  return `${VALIDATION_RULE_HEADING}\n${VALIDATION_AUTHORITY_RULE}\nRun checks through Effigy in the foreground, one at a time, to completion. Do not end your turn while a required check is running. If a command must run in the background, wait for it to finish, record its exit code, and read its output before reporting. Do not kill other processes or repeat a passing check.\n${affectedTestsCommand ? `${reviewer ? affectedRunReviewerNote(affectedTestsCommand) : affectedRunRule(affectedTestsCommand)}\n` : ""}`;
}
