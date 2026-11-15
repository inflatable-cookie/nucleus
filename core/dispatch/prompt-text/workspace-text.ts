/**
 * The run's workspace and scratch text: the one workspace rule, the changelog
 * fragment rule, the source-immutable format rule, the run temporary directory
 * note, and the shell quoting every command line in a prompt is built with.
 */
export const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

/**
 * The one workspace rule, shared by every worktree-facing prompt. `refs/stash` is
 * shared by every worktree of a repository, and the scratch root keeps other
 * tasks' and the internal drive's files out of reach.
 */
export const CHANGELOG_FRAGMENT_RULE = "For repository changes, add a Markdown changelog fragment under changelog.d/, named <task-number>-<short-slug>.md. Do not edit CHANGELOG.md's [Unreleased] section; release preparation folds fragments there.";

export const WORKSPACE_RULE = "Never run git stash here: its stash list is shared by every worktree, so a pop can move another task's changes. Keep work in progress as commits on your own branch. Never remove, prune or recreate a worktree you did not create (git worktree list shows every task's and planner's checkouts). Use this run's TMPDIR, TMP and TEMP. Nucleus owns this run's recorded temporary root and removes only that root after release. Put fixtures in a fresh mktemp -d directory under \"$TMPDIR\" and write only inside that fixture. You must not remove this run's recorded temporary root, its parent, or any directory created outside this run by another task, planner or Nucleus. A test, fixture or selector may remove temporary directories it created during this run inside this run's $TMPDIR; that is ordinary teardown. A tool that would delete outside $TMPDIR or a root it did not create is a finding to report, not a reason to skip the selector. Never use the internal drive or a fixed /tmp path, and never link to real checkouts or write through ../sibling paths. If this run's scratch volume is absent, stop and report blocked.";

export const SOURCE_IMMUTABLE_FORMAT_RULE = "Source-immutable roles (reviewer and proof executor) must run the check-only form of any formatter that writes tracked files. If the repository has no check-only form, report a selector gap with the formatter command and still run the other required selectors. Never skip all selectors for this reason.";

export function runTemporaryPromptNote(directory?: string | null): string {
  return directory
    ? `\nRun temporary directory: ${directory}\nUse this run's directory for commands: prefix commands with TMPDIR=${quote(directory)} TMP=${quote(directory)} TEMP=${quote(directory)}. This applies to retained agents too, whose launch environment may still name an earlier run. Do not remove this recorded root or its parent, or a root you did not create. Tests, fixtures and selectors may remove only temporary directories they created during this run inside this run's TMPDIR.\n`
    : "";
}
