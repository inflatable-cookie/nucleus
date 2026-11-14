// CLI bootstrap: import the CLI runtime from a source snapshot that stopped moving.
//
// The checkout is shared, so a compiler or formatter can rewrite a TypeScript
// source between the moment this process starts and the moment it imports it.
// That race used to fail a CLI call with a half-read module. This module owns the
// one rule: fingerprint the bootstrap closure, import in place only when the
// fingerprint is unchanged across the import, otherwise wait for two matching
// samples and import a private snapshot of exactly those bytes.
import { compiledIdentity } from '../shared/runtime.mjs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { queueClient } from './queue-client.mjs';
import { bootstrapEntries, bootstrapSources } from './bootstrap-sources.mjs';

const SOURCE_STABILITY_INTERVAL_MS = 250;
const SOURCE_STABILITY_TIMEOUT_MS = 10_000;

export const repoDirFrom = cliDir => join(cliDir, '..');

function fingerprintSources(sources) {
  const hash = createHash('sha256');
  for (const [path, bytes] of sources) {
    hash.update(path);
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function bootstrapSourceFingerprint(repoDir) {
  return fingerprintSources(await bootstrapSources(repoDir));
}

async function waitForStableBootstrapSources(repoDir) {
  const deadline = Date.now() + SOURCE_STABILITY_TIMEOUT_MS;
  let previous;
  let matchingSamples = 0;
  while (Date.now() < deadline) {
    try {
      const fingerprint = await bootstrapSourceFingerprint(repoDir);
      if (fingerprint === previous) matchingSamples++;
      else matchingSamples = 0;
      if (matchingSamples >= 2) return fingerprint;
      previous = fingerprint;
    } catch {
      previous = undefined;
      matchingSamples = 0;
    }
    await new Promise(resolve => setTimeout(resolve, SOURCE_STABILITY_INTERVAL_MS));
  }
  throw new Error(`Nucleus TypeScript sources did not settle within ${SOURCE_STABILITY_TIMEOUT_MS / 1000} seconds`);
}

async function createBootstrapSnapshot(repoDir) {
  const sources = await bootstrapSources(repoDir);
  const before = fingerprintSources(sources);
  const snapshotParent = join(repoDir, '.effigy', 'cache');
  await mkdir(snapshotParent, { recursive: true });
  const snapshotRoot = await mkdtemp(join(snapshotParent, 'queue-cli-bootstrap-'));
  try {
    for (const [path, bytes] of sources) {
      const destination = join(snapshotRoot, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { mode: 0o600 });
    }
    const copied = fingerprintSources(await bootstrapSources(snapshotRoot));
    const after = await bootstrapSourceFingerprint(repoDir);
    if (before !== copied || copied !== after) {
      throw new Error('Nucleus sources changed while creating the CLI bootstrap snapshot');
    }
    return { root: snapshotRoot, fingerprint: copied };
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

async function importCliRuntime({ repoDir, snapshotRoot, viaPaseo }) {
  if (compiledIdentity) {
    const { RPC_CATALOGUE } = await import("../shared/rpc-catalogue.ts");
    const { parseContractValue } = await import("../shared/schema-refusal.ts");
    return { RPC_CATALOGUE, parseContractValue, client: await queueClient({ viaPaseo }) };
  }
  if (!compiledIdentity) await import('tsx');
  const base = snapshotRoot || repoDir;
  const { RPC_CATALOGUE } = await import(pathToFileURL(join(base, bootstrapEntries[0])).href);
  const { parseContractValue } = await import(pathToFileURL(join(base, bootstrapEntries[1])).href);
  const client = snapshotRoot && !viaPaseo
    ? (await import(pathToFileURL(join(base, bootstrapEntries[2])).href)).localQueueClient()
    : await queueClient({ viaPaseo });
  return { RPC_CATALOGUE, parseContractValue, client };
}

async function loadFromBootstrapSnapshot(repoDir, expectedFingerprint, viaPaseo) {
  const snapshot = await createBootstrapSnapshot(repoDir);
  try {
    if (expectedFingerprint && snapshot.fingerprint !== expectedFingerprint) {
      throw new Error('Nucleus sources changed after the CLI bootstrap stability proof');
    }
    return await importCliRuntime({ repoDir, snapshotRoot: snapshot.root, viaPaseo });
  } finally {
    await rm(snapshot.root, { recursive: true, force: true });
  }
}

/** Load the CLI runtime, failing closed rather than importing a moving source tree. */
export async function loadCliRuntime({ repoDir, viaPaseo }) {
  if (compiledIdentity) return importCliRuntime({ repoDir, viaPaseo });
  let firstError;
  try {
    const before = await bootstrapSourceFingerprint(repoDir);
    const runtime = await importCliRuntime({ repoDir, viaPaseo });
    const after = await bootstrapSourceFingerprint(repoDir);
    if (before === after) return runtime;
    firstError = new Error('Nucleus sources changed during CLI bootstrap');
  } catch (error) {
    firstError = error;
  }

  const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
  let stableFingerprint;
  try {
    stableFingerprint = await waitForStableBootstrapSources(repoDir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Nucleus CLI bootstrap failed before any service request (${firstMessage}); ${detail}; no service request was sent.`);
  }

  try {
    return await loadFromBootstrapSnapshot(repoDir, stableFingerprint, viaPaseo);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Nucleus CLI bootstrap still failed after source stabilization; no service request was sent. ${detail}`);
  }
}
