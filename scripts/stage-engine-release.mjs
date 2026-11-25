import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, renameSync, statSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
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

const fileIdentity = { bigint: true, throwIfNoEntry: false };

function sameDirectory(expected, actual) {
  return actual?.isDirectory() && expected.dev === actual.dev && expected.ino === actual.ino;
}

async function stageRelease(buildsRoot) {
  const revision = cleanRevision();
  const buildsDirectory = statSync(buildsRoot, fileIdentity);
  if (!buildsDirectory?.isDirectory()) {
    throw Error(`Expected an existing engine builds root at ${buildsRoot}.`);
  }
  const signingIdentity = (process.env.NUCLEUS_CODESIGN_IDENTITY ?? 'Nucleus Local Signing').trim();
  if (process.platform === 'darwin' && (!signingIdentity || signingIdentity === '-')) {
    throw Error('Set NUCLEUS_CODESIGN_IDENTITY to the name of a local code-signing identity.');
  }
  const changed = () => Error(`The engine builds destination changed during staging: ${buildsRoot}.`);
  // Relative writes stay on the directory we entered, even if its name is replaced.
  process.chdir(buildsRoot);
  if (!sameDirectory(buildsDirectory, statSync('.', fileIdentity))) throw changed();
  const releases = join(buildsRoot, 'releases');
  try {
    await mkdir('releases', { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const releasesDirectory = lstatSync('releases', fileIdentity);
  if (!releasesDirectory?.isDirectory()) {
    throw Error(`Expected a real engine releases directory at ${releases}.`);
  }
  process.chdir('releases');
  if (!sameDirectory(releasesDirectory, statSync('.', fileIdentity))) throw changed();
  function checkDestination() {
    if (!sameDirectory(buildsDirectory, statSync(buildsRoot, fileIdentity)) ||
        !sameDirectory(releasesDirectory, lstatSync(releases, fileIdentity))) throw changed();
  }
  checkDestination();
  const release = join(releases, revision);
  if (existsSync(revision)) throw Error(`Engine release already exists at ${release}.`);
  const staging = await mkdtemp('.stage-');
  try {
    const binary = join(staging, 'nucleus');
    const executable = buildEngine();
    checkDestination();
    await copyFile(executable, binary);
    await chmod(binary, 0o700);
    if (process.platform === 'darwin') {
      try {
        execFileSync('codesign', [
          '--force', '--sign', signingIdentity, '--identifier', 'com.inflatable-cookie.nucleus',
          '--timestamp=none', binary,
        ], { stdio: 'inherit' });
      } catch (cause) {
        throw Error(`Could not sign the engine with "${signingIdentity}". Check that the named identity is installed and available to codesign.`, { cause });
      }
      execFileSync('codesign', ['--verify', '--strict', binary], { stdio: 'inherit' });
    }
    await buildEngineBoard(join(staging, 'board-assets'));
    const skill = join('skills', 'nucleus');
    await mkdir(join(staging, skill), { recursive: true, mode: 0o700 });
    await copyFile(join(root, skill, 'SKILL.md'), join(staging, skill, 'SKILL.md'));
    if (cleanRevision() !== revision) throw Error('The checkout revision changed during the engine build.');
    // Publish the release together. A concurrent stage's nonempty release wins.
    checkDestination();
    renameSync(staging, revision);
    try {
      checkDestination();
    } catch (error) {
      // Withdraw our release from the anchored directory if it moved across the rename.
      renameSync(revision, staging);
      throw error;
    }
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
