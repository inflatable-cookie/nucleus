import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkPublication, publicationDenylist } from '../scripts/check-publication.mjs';

const script = fileURLToPath(new URL('../scripts/check-publication.mjs', import.meta.url));
const env = { ...process.env, NUCLEUS_PUBLICATION_DENYLIST: '' };
function fixture(files: Record<string, string | Buffer>) {
  const root = mkdtempSync(join(tmpdir(), 'publication-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  for (const [file, content] of Object.entries(files)) write(root, file, content);
  execFileSync('git', ['add', '--all'], { cwd: root });
  return root;
}
function write(root: string, file: string, content: string | Buffer) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}
function cli(root: string) {
  return spawnSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8' });
}

test('publication CLI accepts a clean tracked tree with no local denylist', () => {
  const root = fixture({ 'README.md': 'Project examples use example/repo, ~/work and /workspace/root/source.\n', 'app/index.html': '<title>Board</title>' });
  write(root, 'untracked.log', 'Untracked evidence remains local.');
  const result = cli(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Publication check passed/);
});

test('publication CLI rejects a planted host environment literal in core', () => {
  const root = fixture({ 'core/planted.ts': "export const hostVariable = 'PASEO_PLANTED';" });
  const result = cli(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /core\/planted\.ts: host environment PASEO_PLANTED belongs in its host integration/);
});

test('publication CLI rejects planted private names without printing the private match', () => {
  const secret = 'private' + '-consumer-sample';
  const root = fixture({ 'README.md': `Example: ${secret.toUpperCase()}.` });
  write(root, '.publication-denylist', `# Local names only\n${secret}\n`);
  const result = cli(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /README.md: private name/);
  assert.ok(!result.stderr.toLowerCase().includes(secret));
  console.log('Planted private-name sample: rejected.');
});

test('publication CLI rejects planted absolute home and volume paths including Windows homes', () => {
  for (const sample of [join('/', 'Users', 'example', 'work'), join('/', 'home', 'example', 'work'), join('/', 'root', 'work'), join('/', 'var', 'root', 'work'), 'file://' + join('/', 'Users', 'example', 'work'), 'file://localhost' + join('/', 'Users', 'example', 'work'), join('/', 'Volumes', 'example-volume', 'work'), ['C:', 'Users', 'example', 'work'].join('\\'), ['C:', 'Users', 'example', 'work'].join('\\\\')]) {
    const root = fixture({ 'example.md': sample });
    const result = cli(root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /example.md: absolute home or volume path/);
  }
  console.log('Planted home/volume path samples: rejected.');
});

const unicodeJsonString = (value: string) =>
  '"' + [...value].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"';

test('publication CLI rejects JSON-escaped machine paths in keys and nested values', () => {
  for (const sample of [
    join('/', 'Users', 'example', 'work'),
    join('/', 'Volumes', 'example-volume', 'work'),
    ['C:', 'Users', 'example', 'work'].join('\\'),
  ]) {
    for (const source of [
      JSON.stringify({ path: sample }).replaceAll('/', '\\/'),
      `{"nested":[{"path":${unicodeJsonString(sample)}}]}`,
      `{${unicodeJsonString(sample)}:"synthetic"}`,
    ]) {
      const root = fixture({ 'sample.json': source });
      const result = cli(root);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /sample.json: absolute home or volume path/);
      assert.ok(!result.stderr.includes(sample));
    }
  }
  console.log('Planted JSON-escaped home/volume/Windows path samples: rejected.');
});

test('publication checks decoded JSON private names without printing the match', () => {
  const secret = 'private-consumer-sample';
  for (const source of [
    `{"nested":[${unicodeJsonString(secret)}]}`,
    `{${unicodeJsonString(secret)}:"synthetic"}`,
  ]) {
    const root = fixture({ 'sample.json': source });
    write(root, '.publication-denylist', secret);
    const result = cli(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /sample.json: private name/);
    assert.ok(!result.stderr.includes(secret));
  }
});

test('publication preserves escaped regex syntax in JSON data and source files', () => {
  const pattern = String.raw`/^\/Volumes\/([^/]+)(?:\/|$)/`;
  const root = fixture({
    'patterns.json': JSON.stringify({ pattern, nested: ['example/repo', '~/work'] }),
    'matcher.mjs': `const pattern = ${pattern};\n`,
  });
  const result = cli(root);
  assert.equal(result.status, 0, result.stderr);
});

test('publication CLI rejects planted evidence artifacts and binary data', () => {
  for (const [file, content] of [
    ['evidence/screenshot.png', Buffer.from([137, 80, 78, 71, 0])],
    ['notes/session.log', 'Execution receipt'],
    ['logs/session.txt', 'Execution receipt'],
    ['evidence/colour-moved.html', '<html>comparison</html>'],
    ['evidence/report.html', '<div class="diff">comparison</div>'],
    ['evidence/capture.bin', Buffer.from([0, 1, 2])],
  ] as const) {
    const root = fixture({ [file]: content });
    const result = cli(root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /evidence artifact/);
  }
  console.log('Planted image, log, HTML diff and binary samples: rejected.');
});

test('publication redacts private filenames from CLI diagnostics', () => {
  const name = 'private-consumer';
  const root = fixture({ [`${name}.md`]: 'Clean' });
  write(root, '.publication-denylist', name);
  const result = cli(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[private\]\.md: private name/);
  assert.ok(!result.stderr.includes(name));
});

test('publication scans pending tracked edits, staged additions and private names in filenames', () => {
  const root = fixture({ 'README.md': 'Clean' });
  write(root, 'README.md', join('/', 'Users', 'example', 'work'));
  assert.match(checkPublication(root, { env }).join('\n'), /absolute home or volume path/);
  write(root, 'README.md', 'Clean');
  write(root, 'private-consumer.md', 'Clean content');
  execFileSync('git', ['add', 'private-consumer.md'], { cwd: root });
  write(root, '.publication-denylist', 'private-consumer');
  assert.match(checkPublication(root, { env }).join('\n'), /private name/);
});

test('publication allows designated assets and exact synthetic artifacts without hiding sensitive text', () => {
  const image = Buffer.from([137, 80, 78, 71, 0]);
  const root = fixture({
    'docs/assets/diagram.png': image,
    'assets/logo.png': image,
    'test/fixtures/publication/synthetic.png': image,
    'test/fixtures/publication/synthetic.log': 'Synthetic output',
    'test/fixtures/publication/synthetic-diff.html': '<div class="diff">Synthetic change</div>',
  });
  assert.deepEqual(checkPublication(root, { env }), []);
  write(root, 'test/fixtures/publication/synthetic.log', join('/', 'Users', 'example', 'work'));
  assert.match(checkPublication(root, { env }).join('\n'), /absolute home or volume path/);
  write(root, 'test/fixtures/publication/synthetic.log', 'private-consumer');
  write(root, '.publication-denylist', 'private-consumer');
  assert.match(checkPublication(root, { env }).join('\n'), /private name/);
  write(root, 'test/fixtures/publication/unlisted.log', 'Synthetic');
  execFileSync('git', ['add', '--all'], { cwd: root });
  assert.match(checkPublication(root, { env }).join('\n'), /unlisted.log: evidence artifact/);
});

test('publication loads local configuration, honors environment precedence and fails for missing configured input', () => {
  const root = fixture({ 'README.md': 'Clean' });
  write(root, '.agents.local.env', 'NUCLEUS_PUBLICATION_DENYLIST="local-names.txt"\n');
  write(root, 'local-names.txt', '# comment\n\nprivate-consumer\n');
  assert.deepEqual(publicationDenylist(root, {}), ['private-consumer']);
  write(root, 'other-names.txt', 'other-consumer');
  assert.deepEqual(publicationDenylist(root, { NUCLEUS_PUBLICATION_DENYLIST: 'other-names.txt' }), ['other-consumer']);
  assert.throws(() => publicationDenylist(root, { NUCLEUS_PUBLICATION_DENYLIST: 'missing.txt' }), /Configured publication denylist is missing/);
  write(root, 'malformed.txt', Buffer.from([0]));
  assert.throws(() => publicationDenylist(root, { NUCLEUS_PUBLICATION_DENYLIST: 'malformed.txt' }), /must be UTF-8 text/);
});


test('publication synthetic volume exceptions apply only to the exact file and prefix', () => {
  const sample = join('/', 'Volumes', 'example-volume', 'queue');
  const root = fixture({ 'test/store-backups.test.ts': sample });
  assert.deepEqual(checkPublication(root, { env }), []);
  write(root, 'test/store-backups.test.ts', sample.replace('example-volume', 'example-volume-other'));
  assert.match(checkPublication(root, { env }).join('\n'), /absolute home or volume path/);
  write(root, 'test/store-backups.test.ts', `${sample}/../../other-volume/file`);
  assert.match(checkPublication(root, { env }).join('\n'), /absolute home or volume path/);
  write(root, 'test/store-backups.test.ts', sample);
  write(root, 'test/unlisted.test.ts', sample);
  execFileSync('git', ['add', '--all'], { cwd: root });
  assert.match(checkPublication(root, { env }).join('\n'), /unlisted.test.ts: absolute home or volume path/);
  write(root, 'test/store-backups.test.ts', `${sample} private-consumer`);
  write(root, '.publication-denylist', 'private-consumer');
  assert.match(checkPublication(root, { env }).join('\n'), /store-backups.test.ts: private name/);
});

test('publication scans symlink targets without reading through them', () => {
  const root = fixture({ 'README.md': 'Clean' });
  symlinkSync(join('/', 'Users', 'example', 'nonexistent'), join(root, 'machine-link'));
  symlinkSync('README.md', join(root, 'portable-link'));
  execFileSync('git', ['add', '--all'], { cwd: root });
  assert.deepEqual(checkPublication(root, { env }), ['machine-link: absolute home or volume path']);
});


test('publication requires missing tracked files to be staged as deletions', () => {
  const root = fixture({ 'README.md': 'Clean' });
  unlinkSync(join(root, 'README.md'));
  assert.match(checkPublication(root, { env }).join('\n'), /tracked file missing/);
  execFileSync('git', ['add', '--update'], { cwd: root });
  assert.deepEqual(checkPublication(root, { env }), []);
});
