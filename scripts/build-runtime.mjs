import { copyNodeRuntime } from './copy-node-runtime.mjs';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function addFileToHash(hash, path) {
  return new Promise((resolveHash, reject) => {
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', resolveHash);
  });
}

function fileDigest(path) {
  const hash = createHash('sha256');
  return addFileToHash(hash, path).then(() => hash.digest('hex'));
}

const root = fileURLToPath(new URL('..', import.meta.url));

function installedCommands(text) {
  return text.replace(/node (?:<queue-plugin>\/)?bin\/queue-cli\.mjs/g, 'nucleus')
    .replace(/node bin\/nucleus-(submit|reparent|review-entry)\.mjs/g, 'nucleus helper $1');
}

export async function buildWeb(out) {
  await mkdir(out, { recursive: true });
  await build({ absWorkingDir: root, entryPoints: ['client/web/index.tsx'], outfile: join(out, 'app.js'), bundle: true, platform: 'browser', format: 'esm', alias: { 'react-native': 'react-native-web' }, plugins: [{ name: 'web-shell', setup(api) {
    api.onResolve({ filter: /^\./ }, args => {
      const target = resolve(args.resolveDir, args.path);
      if (args.importer.startsWith(join(root, 'client') + '/') && (target === join(root, 'client/shell') || target === join(root, 'client/shell/index'))) return { path: join(root, 'client/web/shell.tsx') };
      return null;
    });
  } }] });
  await writeFile(join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nucleus</title><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
}

export async function buildRuntime(destination) {
  if (process.versions.electron) throw Error('Runtime builds require standalone Node; Electron helpers cannot be packaged');
  const started = performance.now();
  const out = resolve(destination);
  const sourceState = () => execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' });
  if (sourceState().trim()) throw Error('Compiled runtime requires a clean committed checkout');
  // New directories only: never overwrite a checkout or an existing package.
  await mkdir(out);
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const hash = createHash('sha256');
  async function hashTree(dir) {
    for (const entry of (await readdir(join(root, dir), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await hashTree(path);
      else if (entry.isFile()) {
        hash.update(path);
        await addFileToHash(hash, join(root, path));
      }
      else throw Error(`Nonregular build input: ${path}`);
    }
  }
  for (const dir of ['core', 'service', 'shared', 'hosts', 'bin', 'scripts', 'skills', 'client']) await hashTree(dir);
  for (const path of ['package.json', 'package-lock.json']) hash.update(await readFile(join(root, path)));
  const digest = hash.digest('hex');
  // Contract digests include function source text. Capture checkout values before
  // bundling renames locals, so installed and checkout clients stay compatible.
  const rpcContracts = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '-e',
    'console.log(JSON.stringify(require("./shared/rpc-contracts.ts").rpcContractDigests()))'], { cwd: root, encoding: 'utf8' }));
  const identity = { rpcContracts, revision, digest, buildId: createHash('sha256').update(revision).update(digest).digest('hex') };
  const entries = [
    ...(await readdir(join(root, 'bin'))).filter(name => name.endsWith('.mjs')).map(name => `bin/${name}`),
    'core/store/backup-cli.mjs', 'core/store/backup-worker.mjs',
    'core/machine/owned-file.mjs',
    'core/intake/callback-client.mjs', 'core/intake/report-binding.mjs',
    'core/workspaces/work-root.mjs', 'core/workspaces/normalize-directory-helper.mjs',
    'service/install/install.mjs', 'service/install/main-channel.mjs',
    'index.server.ts', 'mcp-report.mjs', 'service/executor/executor-worker.ts', 'service/executor/host-run-front-worker.ts',
    'service/transport/server.ts', 'shared/service/local-client.ts', 'service/executor/host-run-front.ts',
  ];
  // Store source moves independently of the installed worker/CLI contract.
  const sourceAliases = {
    "core/workspaces/work-root.mjs": "server/checkout-mounts.mjs",
  'core/engine.ts': 'server/engine.ts',
  'core/resolution.ts': 'server/resolution.ts',
  'core/resolution-adapter.ts': 'server/resolution-adapter.ts',
  'core/scheduling/lane-scheduler.ts': 'server/lane-scheduler.ts',
  'core/scheduling/lane-priorities.ts': 'server/lane-priorities.ts',
  'core/scheduling/task-wakes.ts': 'server/task-wakes.ts',
  'core/scheduling/sweep.ts': 'server/sweep.ts',
  'core/closeout/workspace-lifecycle.ts': 'server/lifecycle.ts',
  'core/host/host-policies.ts': 'server/host-policies.ts',
  'shared/backoff.ts': 'server/backoff.ts',
  'core/runtime/request-ledger.ts': 'server/request-ledger.ts',
  'core/recovery/resolution-decisions.ts': 'server/resolution-decisions.ts',
  "core/machine/process-exec.ts": "server/process-exec.ts",
  "core/machine/process-group.ts": "server/process-group.ts",
  "core/machine/process-identity.ts": "server/process-identity.ts",
  "core/machine/pid.ts": "server/pid.ts",
  "core/machine/start-identity.ts": "server/start-identity.ts",
  "core/machine/supervisor-liveness.ts": "server/supervisor-liveness.ts",
  "core/machine/supervisor-watchdog.ts": "server/supervisor-watchdog.ts",
  "core/machine/machine-ports.ts": "server/machine-ports.ts",
  "core/machine/owned-file.mjs": "server/owned-file.mjs",
  "core/machine/owned-file.d.mts": "server/owned-file.d.mts",
  "core/machine/owned-tool.ts": "server/owned-tool.ts",
  "core/machine/execution-participants.ts": "server/execution-participants.ts",
  "core/machine/file-facts.ts": "server/file-facts.ts",
  "core/machine/live-evidence.ts": "server/live-evidence.ts",
  "core/machine/live-output.ts": "server/live-output.ts",
  "core/machine/output-retention.ts": "server/output-retention.ts",
  "core/machine/token-redactor.ts": "server/token-redactor.ts",
  "core/machine/cargo-cache.ts": "server/cargo-cache.ts",
  "core/machine/host-process-reap.ts": "server/host-process-reap.ts",
  "core/telemetry/telemetry.ts": "server/telemetry.ts",
  "core/telemetry/task-detail.ts": "server/task-detail.ts",
  "core/telemetry/ui-snapshot.ts": "server/ui-snapshot.ts",
  "core/telemetry/run-usage.ts": "server/run-usage.ts",
  "core/telemetry/run-usage-tracker.ts": "server/run-usage-tracker.ts",
  "core/telemetry/live-run-presence.ts": "server/live-run-presence.ts",
  "core/telemetry/cpu-profile.ts": "server/cpu-profile.ts",
  "core/telemetry/event-loop-delay.ts": "server/event-loop-delay.ts",
  "core/dispatch/agent-policy.ts": "server/agent-policy.ts",
  "core/workspaces/archive-delivery.ts": "server/archive-delivery.ts",
  "core/workspaces/archive-intent.ts": "server/archive-intent.ts",
  "core/workspaces/thread-archive.ts": "server/thread-archive.ts",
  "core/scheduling/cohort.ts": "server/cohort.ts",
  "core/scheduling/repository-contention.ts": "server/repository-contention.ts",
  "core/planning/enclosing-operation.ts": "server/enclosing-operation.ts",
  "core/recovery/fence-settlement.ts": "server/fence-settlement.ts",
  "core/recovery/task-reasons.ts": "server/task-reasons.ts",
  "core/recovery/wait-context.ts": "server/wait-context.ts",
  "core/stages.ts": "server/stages.ts",
  "core/task-decision-rules.ts": "server/task-decision-rules.ts",
  "core/runtime/runtime-retirement.ts": "server/runtime-retirement.ts",
  "core/store/data-home-retention.ts": "server/data-home-retention.ts",
  "core/closeout/closeout.ts": "server/closeout.ts",
  "core/closeout/closeout-renewal.ts": "server/closeout-renewal.ts",
  "core/closeout/queue-drain.ts": "server/queue-drain.ts",
  "core/intake/report-binding.mjs": "server/report-binding.mjs",
  "core/intake/result-application.ts": "server/result-application.ts",
  "core/intake/report.ts": "server/report.ts",
  "core/intake/reporting-identity.ts": "server/reporting-identity.ts",
  "core/intake/callback-client.d.mts": "server/callback-client.d.mts",
  "core/intake/callback-reminders.ts": "server/callback-reminders.ts",
  "core/intake/reporting-files.ts": "server/reporting-files.ts",
  "core/intake/report-binding.d.mts": "server/report-binding.d.mts",
  "core/intake/callback-client.mjs": "server/callback-client.mjs",
  "core/intake/applied-result.ts": "server/applied-result.ts",
  "core/intake/report-binding.ts": "server/report-binding.ts",
  "core/intake/current-binding.ts": "server/current-binding.ts",
  "core/intake/run-settlement.ts": "server/run-settlement.ts",
  "core/intake/checkpoint.ts": "server/checkpoint.ts",
  "core/intake/callback-intake.ts": "server/callback-intake.ts",
  "shared/service/callback-client.mjs": "server/callback-client.mjs",
  "shared/service/callback-client.d.mts": "server/callback-client.d.mts",
  "shared/service/report-binding.mjs": "server/report-binding.mjs",
  "shared/service/report-binding.d.mts": "server/report-binding.d.mts",


  "core/merge/merge-gates.ts": "server/merge-gates.ts",
  "core/merge/merge-hold.ts": "server/merge-hold.ts",
  "core/merge/merge-intent.ts": "server/merge-intent.ts",
  "core/merge/check-waits.ts": "server/check-waits.ts",
  "core/merge/integration-turns.ts": "server/integration-turns.ts",
  "core/merge/external-merge.ts": "server/external-merge.ts",
  "core/merge/prospective-merge.ts": "server/prospective-merge.ts",
  "service/callbacks/host-run-serving.ts": "server/host-run-serving.ts",
  "core/host-runs/host-run-scheduler-types.ts": "server/host-run-scheduler-types.ts",
  "service/executor/host-run-front.ts": "server/host-run-front.ts",
  "core/host-runs/host-run-watch.ts": "server/host-run-watch.ts",
  "core/host-runs/host-run-retention.ts": "server/host-run-retention.ts",
  "service/executor/host-run-supervisor.ts": "server/host-run-supervisor.ts",
  "core/host-runs/host-run-settlement.ts": "server/host-run-settlement.ts",
  "core/host-runs/host-run-endpoint-types.ts": "server/host-run-endpoint-types.ts",
  "core/host-runs/host-run-accounting.ts": "server/host-run-accounting.ts",
  "core/host-runs/host-run-scheduler.ts": "server/host-run-scheduler.ts",
  "core/host-runs/host-run-admission.ts": "server/host-run-admission.ts",
  "core/host-runs/host-run-redact.ts": "server/host-run-redact.ts",
  "core/host-runs/host-run-cpu-coverage.ts": "server/host-run-cpu-coverage.ts",
  "core/host-runs/host-run-output-ownership.ts": "server/host-run-output-ownership.ts",
  "core/host-runs/host-run-queue-order.ts": "server/host-run-queue-order.ts",
  "core/host-runs/host-run-identity.ts": "server/host-run-identity.ts",
  "core/host-runs/host-run-launch.ts": "server/host-run-launch.ts",
  "core/host-runs/host-run-capacity.ts": "server/host-run-capacity.ts",
  "core/host-runs/host-run-attach.ts": "server/host-run-attach.ts",
  "core/host-runs/host-run-meta-keys.ts": "server/host-run-meta-keys.ts",
  "core/host-runs/host-run-output-failures.ts": "server/host-run-output-failures.ts",
  "service/executor/host-run-front-worker.ts": "server/host-run-front-worker.ts",
  "core/host-runs/host-run-files.ts": "server/host-run-files.ts",
  "core/host-runs/host-run-token.ts": "server/host-run-token.ts",
  "core/host-runs/host-run-wire.ts": "server/host-run-wire.ts",
  "core/host-runs/host-run-paths.ts": "server/host-run-paths.ts",

  "service/executor/project-qa-supervisor.ts": "server/project-qa-supervisor.ts",
  "core/qa/effigy-admission-hook.ts": "server/effigy-admission-hook.ts",
  "core/qa/effigy-admission-metrics.ts": "server/effigy-admission-metrics.ts",
  "core/qa/effigy-admission.ts": "server/effigy-admission.ts",
  "core/qa/effigy-artifact-digest.ts": "server/effigy-artifact-digest.ts",
  "core/qa/effigy-run-control.ts": "server/effigy-run-control.ts",
  "core/qa/effigy-runtime.ts": "server/effigy-runtime.ts",
  "core/qa/project-qa-escapees.ts": "server/project-qa-escapees.ts",
  "core/qa/project-qa-inspection.ts": "server/project-qa-inspection.ts",
  "core/qa/project-qa-notice.ts": "server/project-qa-notice.ts",
  "core/qa/project-qa-schedule.ts": "server/project-qa-schedule.ts",
  "core/qa/project-qa-supervision-files.ts": "server/project-qa-supervision-files.ts",
  "core/qa/project-qa-detached-io.ts": "server/project-qa-detached-io.ts",
  "core/qa/project-qa-pipeline.ts": "server/project-qa-pipeline.ts",
  "core/qa/project-qa-teardown.ts": "server/project-qa-teardown.ts",
  "core/qa/project-qa-worktree.ts": "server/project-qa-worktree.ts",
  "core/qa/project-qa-tap-failures.ts": "server/project-qa-tap-failures.ts",
  "core/qa/project-qa.ts": "server/project-qa.ts",
  "core/qa/project-validation-caller.ts": "server/project-validation-caller.ts",
  "service/executor/project-validation-supervisor-runner.ts": "server/project-validation-supervisor-runner.ts",
  "core/qa/project-validation-supervisor.ts": "server/project-validation-supervisor.ts",
  "core/qa/project-validation.ts": "server/project-validation.ts",
  "core/qa/proof-activation.ts": "server/proof-activation.ts",
  "core/qa/proof-autorun.ts": "server/proof-autorun.ts",
  "core/qa/proof-execution.ts": "server/proof-execution.ts",
  "core/qa/proof-only-go.ts": "server/proof-only-go.ts",
  "core/qa/qa-board.ts": "server/qa-board.ts",
  "core/qa/qa-caller-provenance.ts": "server/qa-caller-provenance.ts",
  "core/qa/qa-caller.ts": "server/qa-caller.ts",
  "core/qa/qa-fence.ts": "server/qa-fence.ts",
  "core/qa/validation-evidence.ts": "server/validation-evidence.ts",

  "service/runtime-owner.ts": "server/runtime-owner.ts",
  "service/callbacks/callback.ts": "server/callback.ts",
  "service/callbacks/effigy-admission-endpoint.ts": "server/effigy-admission-endpoint.ts",
  "service/callbacks/host-run-endpoint.ts": "server/host-run-endpoint.ts",
  "core/forge/formal-review-http.ts": "server/formal-review-http.ts",
  "service/executor/executor.ts": "server/service/executor.ts",
  "service/install/bridge-process-actions.ts": "server/service/bridge-process-actions.ts",
  "service/transport/identity.ts": "server/service/identity.ts",
  "service/executor/executor-fixtures.ts": "server/service/executor-fixtures.ts",
  "service/web/web-board.ts": "server/service/web-board.ts",
  "service/install/install.d.mts": "server/service/install.d.mts",
  "service/executor/executor-worker.ts": "server/service/executor-worker.ts",
  "service/web/publication-budget.ts": "server/service/publication-budget.ts",
  "service/install/standby.ts": "server/service/standby.ts",
  "service/install/standby-handoff.ts": "server/service/standby-handoff.ts",
  "service/transport/dispatch.ts": "server/service/dispatch.ts",
  "service/install/main-channel.d.mts": "server/service/main-channel.d.mts",
  "service/install/install.mjs": "server/service/install.mjs",
  "service/install/roll-request.ts": "server/service/roll-request.ts",
  "service/standalone.ts": "server/service/standalone.ts",
  "service/transport/server.ts": "server/service/server.ts",
  "service/install/main-channel.mjs": "server/service/main-channel.mjs",
  "service/install/build.ts": "server/service/build.ts"
};
  const installedPath = path => sourceAliases[path] ?? (path === 'shared/service/local-client.ts' ? 'server/service/local-client.ts' : path.startsWith('core/recovery/') ? path.replace('core/recovery/', 'server/') : path.startsWith('core/dispatch/') ? path.replace('core/dispatch/', 'server/') : path.startsWith('core/store/') ? path.replace('core/store/', 'server/') : path.startsWith('core/workspaces/') ? path.replace('core/workspaces/', 'server/') : path);
  const outputPath = entry => entry === 'index.server.ts' ? 'server/index.server.mjs' : installedPath(entry).replace(/\.ts$/, '.mjs');
  for (const entry of entries) {
    const output = outputPath(entry);
    await build({
      absWorkingDir: root, entryPoints: [entry], outfile: join(out, output),
      bundle: true, platform: 'node', target: 'node22', format: 'esm', minify: false,
      external: ['tsx'],
      banner: { js: `import { createRequire as __nucleusRequire } from 'node:module'; const require = __nucleusRequire(${entry === 'index.server.ts' ? 'process.execPath' : 'import.meta.url'});` },
      plugins: [{ name: 'runtime-layout', setup(api) {
        api.onLoad({ filter: /\.(ts|mjs)$/ }, async ({ path }) => {
          if (path.includes('/node_modules/')) return;
          let contents = await readFile(path, 'utf8');
          if (path === join(root, 'shared/runtime.mjs')) contents = contents.replace('compiledIdentity = null', `compiledIdentity = ${JSON.stringify(identity)}`);
          if (path.startsWith(join(root, 'bin/nucleus-'))) contents = installedCommands(contents);
          // Translate source-relative assets through the same installed aliases as modules.
          contents = contents.replace(/new URL\((["'])([^"']+)\1, import\.meta\.url\)/g, (expression, quote, asset) => {
            if (!asset.startsWith('.')) return expression;
            const target = installedPath(relative(root, resolve(dirname(path), asset)));
            const adjusted = relative(dirname(installedPath(relative(root, path))), target).replaceAll('\\', '/');
            return `new URL(${JSON.stringify(adjusted || '.')}, import.meta.url)`;
          });
          // Bundles retain each original module's asset anchor, relative to this entry.
          const anchor = relative(dirname(output), installedPath(relative(root, path))).replaceAll('\\', '/');
          contents = contents.replaceAll('import.meta.url', `new URL(${JSON.stringify(anchor)}, import.meta.url).href`);
          return { contents, loader: path.endsWith('.ts') ? 'ts' : 'js' };
        });
      } }],
    });
  }
  // callback.ts appends code to these exact bytes; keep the plain helper intact.
  await writeFile(join(out, 'server/callback-client.mjs'), await readFile(join(root, 'shared/service/callback-client.mjs')));
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(join(out, 'package.json'), JSON.stringify({ name: 'nucleus-runtime', type: 'module', version })+'\n');
  await cp(join(root, 'skills'), join(out, 'skills'), { recursive: true });
  async function installSkillInstructions(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await installSkillInstructions(path);
      else if (entry.name.endsWith('.md')) {
        const text = installedCommands(await readFile(path, 'utf8'))
          .replace('Work from the plugin\nroot (walk up from this file\'s directory to the ancestor holding\n`bin/nucleus-submit.mjs`).', 'Run `nucleus` from any directory; it finds the service through the data home.')
          .replace('Run commands from the plugin root', 'Run commands from any directory')
          .replace('From the plugin root (see [SKILL.md](../SKILL.md))', 'From any directory (see [SKILL.md](../SKILL.md))')
          .replace('From the Queue plugin root', 'From any directory')
          .replace('Resolve the real plugin root as described\nin SKILL.md; all commands below run there and connect directly to Nucleus.', 'Run these commands from any directory; they connect directly to Nucleus.');
        await writeFile(path, text);
      }
    }
  }
  await installSkillInstructions(join(out, 'skills'));
  await copyFile(join(root, 'hosts/paseo/plugin/paseo-plugin.json'), join(out, 'paseo-plugin.json'));
  await writeFile(join(out, 'index.server.ts'), "export { default } from './server/index.server.mjs';\n");
  await build({ absWorkingDir: root, entryPoints: ['index.client.tsx'], outfile: join(out, 'client/index.client.js'), bundle: true, platform: 'neutral', format: 'esm', external: ['react', 'react/*', 'react-native', 'react-native/*', 'zod', 'zod/*', '@tanstack/react-query', '@tanstack/react-query/*', '@getpaseo/plugin', '@getpaseo/plugin/*'] });
  await buildWeb(join(out, 'web/dist'));
  await writeFile(join(out, 'index.client.tsx'), "export { default } from './client/index.client.js';\n");
  await mkdir(join(out, 'runtime'));
  const nodeLibraries = copyNodeRuntime(join(out, 'runtime', 'node'));
  let bytes = 0;
  async function size(dir) { for (const e of await readdir(dir, { withFileTypes: true })) { const p=join(dir,e.name); if(e.isDirectory()) await size(p); else bytes+=(await stat(p)).size; } }
  await size(out);
  const receipt = { ...identity, nodeLibraries, platform: process.platform, arch: process.arch, nodeVersion: process.version, bytes, buildMs: Math.round(performance.now() - started), entries: entries.map(outputPath) };
  if (sourceState().trim() || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== revision) throw Error('Sources changed during the build; discard this incomplete package');
  await writeFile(join(out, 'build.json'), JSON.stringify(receipt, null, 2)+'\n');
  const files = {};
  async function inventory(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) await inventory(path);
      else files[relative(out, path)] = await fileDigest(path);
    }
  }
  await inventory(out);
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ format: 'nucleus-package-v1', files }, null, 2) + '\n');
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('Usage: effigy build:runtime -- /absolute/new/package-directory');
  console.log(JSON.stringify(await buildRuntime(process.argv[2]), null, 2));
}
