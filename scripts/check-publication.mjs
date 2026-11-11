import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHostEnvironment } from './check-host-environment.mjs';

// Exact synthetic fixture files may retain deliberate artifact samples. This
// never exempts their content or names from the private-name and path rules.
export const syntheticArtifactFixtures = new Set([
  'test/fixtures/publication/synthetic.log',
  'test/fixtures/publication/synthetic-diff.html',
  'test/fixtures/publication/synthetic.png',
]);
// These exact tests exercise mounted-volume behavior using synthetic labels.
// An exception permits only that volume prefix, never a whole file or private name.
export const syntheticVolumeFixtures = {
  'test/checkout-volume.test.ts': ['cache-volume', 'retired-volume'],
  'test/store-backups.test.ts': ['example-volume'],
  'test/builds-runtime-retirement.test.ts': ['retired-volume'],
  'test/workspace-creation-replay.test.ts': ['example-volume', 'retired-volume'],
  'test/order-pins.test.ts': ['retired-volume', 'example-volume'],
  'test/machine-ports.test.ts': ['example-volume'],
  'test/prompts.test.ts': ['retired-volume'],
  'test/settings-pool.test.ts': ['retired-volume'],
  'test/backups-panel-ui.test.ts': ['example-volume'],
};
const imageExtension = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|svg)$/i;
const assetFolder = /^(?:docs\/assets|assets)\//;
const machinePath = /(?<![\w./\\-])(?:file:\/\/(?:localhost)?\/?)?(?:\/(?:Users|Volumes|home|root|var\/root)\/[^\s\x00"'`<>;,)}\]]+|[a-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\s"'<>]+)/gi;

class PublicationConfigError extends Error {}

// Decode one JSON string layer only in data files. Source escapes can describe
// regex syntax rather than a literal path and must retain their original meaning.
function searchableContent(file, text) {
  const content = [file, text];
  if (/\.json$/i.test(file)) {
    const strings = /"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"/g;
    for (const match of text.matchAll(strings)) content.push(JSON.parse(match[0]));
  }
  return content.join('\n');
}

function localSetting(source, key) {
  const match = source.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*?)\\s*$`, 'm'));
  if (!match) return undefined;
  const raw = match[1];
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1);
  return raw.replace(/\s+#.*$/, '').trim();
}

export function publicationDenylist(root, env = process.env) {
  const local = resolve(root, '.agents.local.env');
  const setting = env.NUCLEUS_PUBLICATION_DENYLIST ?? (existsSync(local) ? localSetting(readFileSync(local, 'utf8'), 'NUCLEUS_PUBLICATION_DENYLIST') : undefined);
  const configured = setting?.trim();
  const path = resolve(root, configured || '.publication-denylist');
  if (!existsSync(path)) {
    if (configured) throw new PublicationConfigError('Configured publication denylist is missing');
    return [];
  }
  const source = readFileSync(path, 'utf8');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(source)) throw new PublicationConfigError('Publication denylist must be UTF-8 text with one name per line');
  return source.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

export function checkPublication(root, { env = process.env } = {}) {
  const names = publicationDenylist(root, env).map(name => name.toLowerCase());
  const files = execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean);
  const findings = [];
  const display = file => {
    let safe = file.replace(machinePath, '[machine-path]');
    for (const name of names) safe = safe.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[private]');
    return safe;
  };
  for (const file of new Set(files)) {
    const full = resolve(root, file);
    const label = display(file);
    let stat;
    try { stat = lstatSync(full); } catch (error) {
      if (error.code === 'ENOENT') {
        findings.push(`${label}: tracked file missing; stage its deletion before checking publication`);
        continue;
      }
      throw error;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      findings.push(`${label}: unsupported tracked file (only regular publication files are allowed)`);
      continue;
    }
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(full)) : readFileSync(full);
    const text = bytes.toString('utf8');
    const content = searchableContent(file, text);
    // Do not echo matches: local names and machine paths must stay local.
    if (names.some(name => content.toLowerCase().includes(name))) findings.push(`${label}: private name`);
    const paths = [...content.matchAll(machinePath)].map(match => match[0]);
    const volumes = syntheticVolumeFixtures[file] ?? [];
    const forbiddenPath = paths.some(path => !volumes.some(volume => {
      const prefix = ['', 'Volumes', volume].join('/');
      return !path.split('/').includes('..') && (path === prefix || path.startsWith(`${prefix}/`));
    }));
    if (forbiddenPath) findings.push(`${label}: absolute home or volume path`);
    if (syntheticArtifactFixtures.has(file)) continue;
    const image = imageExtension.test(file);
    const binary = bytes.some(byte => byte < 9 || (byte > 13 && byte < 32)) || /\ufffd/.test(text);
    const log = /(?:^|\/)logs?(?:\/|$)|\.(?:log|log\.\d+|har)$/i.test(file);
    const htmlDiff = /\.html?$/i.test(file) && (/(?:diff|colour-moved|color-moved)/i.test(file) || /(?:class=["'][^"']*\bdiff\b|diff --git |<title>[^<]*\bdiff\b)/i.test(text));
    if (log || htmlDiff || (image ? !assetFolder.test(file) : binary)) findings.push(`${label}: evidence artifact`);
  }
  return [...findings, ...checkHostEnvironment(root)];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const findings = checkPublication(process.cwd());
    if (findings.length) {
      console.error(`Publication check failed:\n${findings.join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log('Publication check passed (tracked tree; private denylist is local and optional).');
    }
  } catch (error) {
    const reason = error instanceof PublicationConfigError ? error.message : 'could not read the tracked tree or local publication settings';
    console.error(`Publication check failed: ${reason}`);
    process.exitCode = 1;
  }
}
