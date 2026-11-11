import { existsSync, rmSync } from 'node:fs';
import { constants, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { command, git } from '../../core/git/index';

/**
 * Immutable per-process Git fixture seeds (task 372).
 *
 * A fixture family whose starting repositories are identical in every case
 * declares its construction once as a seed. The first fixture in a process runs
 * that construction with real Git in a private seed root; every fixture then
 * gets its own copy of those real repositories inside its own fresh root. Each
 * copy has independent files (copy-on-write clones, never hard links), so a
 * fixture's refs, config, objects and worktree changes never reach the seed or
 * another fixture. Absolute seed paths that Git recorded (remote URLs, clone
 * reflog messages) are rewritten to the fixture root, and copied indexes are
 * refreshed so stat data matches the copied files. Construction content must
 * not depend on the fixture root; root-specific files are written after
 * materialization.
 */
export interface GitSeed {
  /** Seed root directory name prefix, for diagnosis. */
  readonly name: string;
  /** Builds the starting repositories under `root` with real Git. */
  readonly build: (root: string) => Promise<void>;
}

const roots = new Map<GitSeed, Promise<string>>();

/** The seed's private root, built once per process. Tests may read it, never write it. */
export function seedRoot(seed: GitSeed): Promise<string> {
  let root = roots.get(seed);
  if (!root) {
    root = (async () => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), `nsq-git-seed-${seed.name}-`)));
      process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
      await seed.build(directory);
      return directory;
    })();
    roots.set(seed, root);
  }
  return root;
}

/** Copy the seed's repositories into `root`, an existing fresh fixture directory. */
export async function materializeSeed(seed: GitSeed, root: string): Promise<void> {
  const source = await seedRoot(seed);
  const from = Buffer.from(source), to = Buffer.from(root);
  await copyTree(source, root, async (file, target) => {
    // Object files are compressed and content-addressed; recorded paths live in
    // config and reflogs.
    if (relative(source, file).split(sep).includes('objects')) return false;
    const bytes = await readFile(file);
    if (!bytes.includes(from)) return false;
    await writeFile(target, Buffer.from(bytes.toString('latin1').split(from.toString('latin1')).join(to.toString('latin1')), 'latin1'), { flag: 'wx' });
    return true;
  });
  for (const entry of await readdir(root)) {
    if (existsSync(join(root, entry, '.git', 'index'))) await git(join(root, entry), 'update-index', '-q', '--refresh');
  }
}

async function copyTree(from: string, to: string, rewrite: (file: string, target: string) => Promise<boolean>): Promise<void> {
  await mkdir(to, { recursive: true });
  await Promise.all((await readdir(from, { withFileTypes: true })).map(async entry => {
    const source = join(from, entry.name), target = join(to, entry.name);
    if (entry.isDirectory()) return copyTree(source, target, rewrite);
    if (!entry.isFile()) throw new Error(`Git seed holds an unexpected entry: ${source}`);
    if (!await rewrite(source, target)) await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  }));
}

/** A bare `origin.git` with an unborn `main` and its configured clone at `repo`. */
export async function buildConfiguredClone(root: string): Promise<void> {
  await command('git', ['init', '--bare', '--initial-branch=main', join(root, 'origin.git')], root);
  await command('git', ['clone', join(root, 'origin.git'), join(root, 'repo')], root);
  await git(join(root, 'repo'), 'config', 'user.name', 'Queue test');
  await git(join(root, 'repo'), 'config', 'user.email', 'queue@example.invalid');
}

export const configuredClone: GitSeed = { name: 'clone', build: buildConfiguredClone };
