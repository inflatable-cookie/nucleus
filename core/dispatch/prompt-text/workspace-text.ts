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

export const WORKSPACE_RULE = "Never use git stash or remove another worktree. Use a fresh fixture directory under this run's scratch; never link real checkouts, write through siblings, or use the internal drive or fixed /tmp. Never remove the scratch root, its parent, or anything another run owns. Tests may remove only their own fixture directories. Report deletion outside that boundary as a finding. If scratch is absent, stop and report blocked.";

export const SOURCE_IMMUTABLE_FORMAT_RULE = "Source-immutable roles (reviewer and proof executor) must never edit tracked files, commit, push or switch branches. Run the check-only form of any formatter that writes tracked files. If the repository has no check-only form, report a selector gap with the formatter command and still run the other required selectors. Never skip all selectors for this reason.";

export function runTemporaryPromptNote(directory?: string | null): string {
  return directory
    ? `Run scratch: ${directory}. Set TMPDIR=${quote(directory)} TMP=${quote(directory)} TEMP=${quote(directory)} for commands.\n`
    : "";
}
