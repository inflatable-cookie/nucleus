import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEngineBoard } from './build-web.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function cleanRevision() {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const revision = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain')) {
    throw Error('Stage the engine from a clean checkout of the intended release revision.');
  }
  return revision;
}

function buildEngine() {
  const build = spawnSync('oxide', [
    'build', '--profile', 'release', '--locked', '--manifest-path', 'engine/Cargo.toml',
    '-p', 'nucleus-cli', '--bin', 'nucleus', '--message-format=json-render-diagnostics',
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (build.error) throw build.error;
  if (build.status !== 0) throw Error(`Oxide build failed (${build.signal ?? build.status}).`);
  // Cargo reports the executable even when it reuses a fresh artifact.
  const artifacts = build.stdout.trim().split('\n').map(line => JSON.parse(line));
  const executable = artifacts.find(artifact =>
    artifact.reason === 'compiler-artifact' && artifact.target.name === 'nucleus' && artifact.executable
  )?.executable;
  if (!executable) throw Error('The Oxide build reported no nucleus executable.');
  return executable;
}

async function stageRelease(buildsRoot) {
  const revision = cleanRevision();
  const releases = join(buildsRoot, 'releases');
  const release = join(releases, revision);
  await mkdir(releases, { recursive: true, mode: 0o700 });
  if (!(await lstat(releases)).isDirectory()) {
    throw Error(`Expected a real engine releases directory at ${releases}.`);
  }
  if (existsSync(release)) throw Error(`Engine release already exists at ${release}.`);
  const staging = await mkdtemp(join(releases, '.stage-'));
  try {
    const binary = join(staging, 'nucleus');
    await copyFile(buildEngine(), binary);
    await chmod(binary, 0o700);
    await buildEngineBoard(join(staging, 'board-assets'));
    const skill = join('skills', 'nucleus');
    await mkdir(join(staging, skill), { recursive: true, mode: 0o700 });
    await copyFile(join(root, skill, 'SKILL.md'), join(staging, skill, 'SKILL.md'));
    if (cleanRevision() !== revision) throw Error('The checkout revision changed during the engine build.');
    // Publish the release together. A concurrent stage's nonempty release wins.
    await rename(staging, release);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  console.log(release);
}

const args = process.argv.slice(2);
if (args.length !== 1 || !isAbsolute(args[0])) {
  throw Error('Usage: effigy engine:stage -- /absolute/builds-root');
}
await stageRelease(args[0]);
