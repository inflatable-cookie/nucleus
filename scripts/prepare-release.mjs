import { scratchDirectory } from '../shared/scratch-root.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntime } from './build-runtime.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const repository = 'inflatable-cookie/nucleus';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export async function prepareRelease(destination, commit = 'HEAD') {
  if (!destination || !isAbsolute(destination)) throw Error('Pass an absolute new output directory under NUCLEUS_SCRATCH_ROOT');
  const out = resolve(destination);
  // Prove the existing parent before creating release output.
  scratchDirectory(dirname(out));
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('The first release supports macOS arm64 only');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  if (git('status', '--porcelain', '--untracked-files=normal')) throw Error('Release preparation requires a clean committed checkout');
  const revision = git('rev-parse', 'HEAD');
  if (git('rev-parse', '--verify', `${commit}^{commit}`) !== revision) throw Error('Checkout HEAD must equal the requested release commit');
  const { version } = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Release version must be a stable semantic version');
  const changelog = await readFile(join(repo, 'CHANGELOG.md'), 'utf8');
  const section = changelog.split(`## [${version}] - `)[1];
  if (!section) throw Error(`CHANGELOG.md has no release notes for ${version}`);
  const notes = section.slice(section.indexOf('\n') + 1).split('\n## [')[0].trim() + '\n';
  await mkdir(out); // Never overwrite a prior preparation, including a failed one.
  const build = await buildRuntime(join(out, 'package'));
  const name = `nucleus-${version}-darwin-arm64.tar.gz`;
  const archive = join(out, name);
  execFileSync('/usr/bin/tar', ['--format=ustar', '-czf', archive, '-C', join(out, 'package'), '.']);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  const manifest = join(out, 'nucleus-darwin-arm64.json');
  await writeFile(manifest, JSON.stringify({ url: `https://github.com/${repository}/releases/download/v${version}/${name}`, sha256 }, null, 2) + '\n');
  const notesFile = join(out, 'release-notes.md');
  await writeFile(notesFile, notes);
  const command = ['gh', 'release', 'create', `v${version}`, '--repo', repository, '--target', revision,
    '--title', `Nucleus ${version}`, '--notes-file', notesFile, archive, manifest].map(quote).join(' ');
  const receipt = { version, revision: build.revision, archive, sha256, manifest, notesFile, publishCommand: command };
  await writeFile(join(out, 'release.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
  console.log(`\nTom's publish command (not executed):\n${command}`);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 4) throw Error('Usage: effigy release:prepare -- /absolute/new/output-directory [commit]');
  await prepareRelease(process.argv[2], process.argv[3]);
}
