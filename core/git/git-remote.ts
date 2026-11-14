/**
 * Remote-URL facts: which GitHub repository a remote names.
 *
 * One parser, so a proof, a client and a PR read all agree on the same remote.
 */
export function githubRepositoryFromRemote(remote: string): string | null {
  const match = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}
