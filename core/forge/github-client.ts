import { type Task } from '../../shared/contracts';
import { git, githubRepositoryFromRemote, command } from '../git/index';


export async function repo(t: Task) {
  const remote = await git(t.repoPath, 'remote', 'get-url', 'origin');
  const repository = githubRepositoryFromRemote(remote);
  if (!repository) throw new Error('Resolution requires a GitHub origin');
  return repository;
}
export const api = async (t: Task, endpoint: string, args: string[] = []) => JSON.parse(await command('gh', ['api', endpoint, ...args], t.repoPath, undefined, args.includes('--paginate') ? {maxBuffer: 32 * 1024 * 1024} : undefined));

/** The real `gh` refusal reason lives in stderr, not in the "Command failed" argv echo. */
export function commandErrorText(error: unknown): string {
  if (error instanceof Error) {
    const extra = error as Error & { stderr?: unknown; stdout?: unknown };
    return `${error.message}\n${String(extra.stderr ?? '')}\n${String(extra.stdout ?? '')}`;
  }
  return String(error);
}

export type CheckEvidenceTransport = (t: Task, endpoint: string, args?: string[]) => Promise<unknown>;
