import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readlink, readdir, realpath, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { exec, installerFixture } from "./support/nucleus-install-fixture";

test("installed commands, integration and private service stay inside a scratch home", async () => {
  const { root, env, build, receipt, home, tarball, digest, command, installed, current, first } = await installerFixture();
  await assert.rejects(exec(process.execPath, ["--input-type=module", "-e",
    `Object.defineProperty(process.versions, 'electron', { value: 'fixture' });
     const { buildRuntime } = await import('./scripts/build-runtime.mjs');
     await buildRuntime(${JSON.stringify(join(root, "electron-package"))});`], { env }), /Runtime builds require standalone Node/);
  // The running roller and retained callers still require these installed names.
  for (const entry of ["server/backup-worker.mjs", "server/backup-cli.mjs", "server/checkout-mounts.mjs", "server/normalize-directory-helper.mjs"]) {
    assert.ok(receipt.entries.includes(entry), `${entry} remains an installed entry`);
    await readFile(join(build, entry));
  }
  const backupSource = join(root, "backup-source", "queue.db");
  await mkdir(dirname(backupSource));
  await exec(process.execPath, ["--input-type=module", "-e",
    `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(${JSON.stringify(backupSource)}); db.exec('CREATE TABLE fixture(value TEXT)'); db.close();`], { env });
  const backup = await exec(process.execPath, [join(build, "server/backup-cli.mjs"), "manual", backupSource, join(root, "backups")], { env });
  assert.ok(JSON.parse(backup.stdout).snapshots.length > 0, "installed backup CLI creates a verified snapshot");
  const primary = join(root, "worktree-primary"), taskCheckout = join(root, "worktree-checkout");
  await mkdir(primary);
  const git = (...args: string[]) => exec("git", args, { env, cwd: primary });
  await git("init", "-b", "main");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "init");
  await git("worktree", "add", "--detach", taskCheckout);
  const setupOutput = await exec(command, ["worktree", "prepare"], { env, cwd: taskCheckout });
  assert.match(setupOutput.stdout, /Paseo sibling preparation: OK/);
  assert.ok(first.startsWith(join(home, ".local/share/nucleus/versions/")));
  // `nucleus` is the only skill name the package installs and links.
  for (const folder of [join(home, ".agents/skills"), join(home, ".codex/skills"), join(home, ".claude/skills"), ...env.NUCLEUS_SKILL_DIRS.split(delimiter)]) {
    const canonical = await readFile(join(folder, "nucleus/SKILL.md"), "utf8");
    assert.match(canonical, /name: nucleus/);
    await assert.rejects(readlink(join(folder, "northstar-queue")));
  }
  // Every installed reference must work without a checkout or Node on PATH.
  async function checkInstructions(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await checkInstructions(path);
      else if (path.endsWith(".md")) {
        const text = await readFile(path, "utf8");
        assert.doesNotMatch(text, /node (?:<queue-plugin>\/)?bin\/|from the plugin root|From the Queue plugin root|Resolve the real plugin root/);
      }
    }
  }
  const skill = join(home, ".agents/skills/nucleus");
  await checkInstructions(skill);
  const instructions = await readFile(join(skill, "SKILL.md"), "utf8");
  assert.match(instructions, /nucleus helper submit --brief/);
  assert.match(instructions, /nucleus helper reparent/);
  for (const helper of ["submit", "review-entry"]) {
    const help = (await installed("helper", helper, "--help")).stdout;
    assert.match(help, new RegExp(`nucleus helper ${helper}`));
    assert.doesNotMatch(help, /node bin\//);
  }
  await assert.rejects(installed("helper", "../queue-cli"), /Choose a helper/);
  const version = JSON.parse((await installed("version")).stdout);
  assert.equal(version.version, JSON.parse(await readFile("package.json", "utf8")).version);
  assert.equal(version.revision, receipt.revision);
  assert.equal(version.dataHome, join(home, ".nucleus"));
  assert.ok(version.version);
  assert.ok(version.channel);
  await installed("channel", "main", root, root);
  assert.equal(JSON.parse((await installed("version")).stdout).channel, "main");
  await installed("channel", "release");
  assert.equal(JSON.parse((await installed("version")).stdout).channel, "release");
  // Host registration is an explicit integration step, and keeps other hosts/config.
  const configBefore = JSON.parse(await readFile(join(env.PASEO_HOME, "config.json"), "utf8"));
  assert.equal(configBefore.plugins["nucleus"], undefined);
  await installed("integrate", "paseo");
  const config = JSON.parse(await readFile(join(env.PASEO_HOME, "config.json"), "utf8"));
  assert.equal(config.fixture, true);
  assert.deepEqual(config.plugins.other, { path: "/fixture/other" });
  assert.equal(await realpath(config.plugins["nucleus"].path), first);
  config.plugins.nucleus = { path: current };
  await writeFile(join(env.PASEO_HOME, "config.json"), JSON.stringify(config));
  await assert.rejects(installed("integrate", "paseo"), /already registers nucleus/);
  assert.deepEqual(JSON.parse(await readFile(join(env.PASEO_HOME, "config.json"), "utf8")), config);
  delete config.plugins.nucleus;
  await writeFile(join(env.PASEO_HOME, "config.json"), JSON.stringify(config));
  await installed("install", tarball, "--sha256", await digest());
  assert.equal(await realpath(current), first);

  // A private compiled service proves the new command shares the existing RPC route.
  const proof = join(root, "service.mjs");
  await writeFile(proof, `
import { QueueService } from ${JSON.stringify(pathToFileURL(join(first, "server/service/server.mjs")).href)};
const service = new QueueService({ owner: { timers: false }, fixture: 'fake' });
await service.start();
console.log('READY');
process.on('SIGTERM', () => { void service.stop().then(() => process.exit(0)); });
`);
  const service = spawn(join(first, "runtime/node"), [proof], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = "";
  service.stderr.on("data", chunk => { diagnostics += chunk; });
  const exited = new Promise<number | null>(resolve => service.once("exit", resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`Service startup: ${diagnostics}`)), 30_000);
      service.once("exit", code => { clearTimeout(timer); reject(Error(`Service exited ${code}: ${diagnostics}`)); });
      service.stdout.on("data", chunk => { if (String(chunk).includes("READY")) { clearTimeout(timer); resolve(); } });
    });
    // The default UI command launches the link with the platform opener.
    const openerDir = join(root, "opener");
    await mkdir(openerDir);
    const capture = join(root, "opened-link");
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    await writeFile(join(openerDir, opener), `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(capture)}\n`, { mode: 0o755 });
    const ui = await exec(command, ["ui"], { env: { ...env, PATH: `${openerDir}:${env.PATH}` }, cwd: root, timeout: 30_000 });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if (await readFile(capture, "utf8")) break; } catch { /* opener still starting */ }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const opened = await readFile(capture, "utf8");
    assert.equal(opened, ui.stdout.trim());
    const url = new URL(opened);
    assert.equal(url.hostname, "127.0.0.1");
    assert.match(url.hash, /^#token=/);
    const page = await fetch(`${url.origin}/`);
    assert.match(await page.text(), /app\.js/);
    assert.equal((await fetch(`${url.origin}/app.js`)).status, 200);
    const answer = JSON.parse((await installed("capacity-state")).stdout);
    const legacy = JSON.parse((await exec(join(first, "runtime/node"), [join(first, "bin/queue-cli.mjs"), "capacity-state"], { env, cwd: root })).stdout);
    assert.deepEqual(answer, legacy);
    // Exercise submit and reparent against the private service. These deliberately
    // missing inputs must return the same refusal and exit code as the helpers,
    // rather than creating tasks or changing ownership.
    const helperEnv = { ...env, PASEO_AGENT_ID: "fixture-helper-caller" };
    for (const [helper, args] of [
      ["submit", ["--dry-run", join(root, "repo/docs/handoffs/missing.md")]],
      ["reparent", ["fixture-owner", "--task", "missing-task", "--reason", "scratch proof"]],
    ] as const) {
      const failure = async (run: Promise<unknown>) => {
        try { await run; assert.fail("Missing fixture input must be refused"); }
        catch (error: any) {
          assert.equal(error.code, 1);
          assert.doesNotMatch(error.stderr, /Cannot find (?:module|package)|Supply at least one handoff/);
          return { stdout: error.stdout, stderr: error.stderr, code: error.code };
        }
      };
      const direct = await failure(exec(join(first, "runtime/node"), [join(first, `bin/nucleus-${helper}.mjs`), ...args], { env: helperEnv, cwd: root }));
      const wrapped = await failure(exec(command, ["helper", helper, ...args], { env: helperEnv, cwd: root }));
      assert.deepEqual(wrapped, direct);
      if (helper === "reparent") assert.match(wrapped.stderr, /Unknown task missing-task/);
    }
    const cli = spawn(command, ["capacity-state", "-"], { env, cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    cli.stdout.on("data", chunk => { output += chunk; });
    cli.stdin.end("{}");
    assert.equal(await new Promise(resolve => cli.once("exit", resolve)), 0);
    assert.deepEqual(JSON.parse(output), answer);
  } finally {
    service.kill("SIGTERM");
    assert.equal(await exited, 0, diagnostics);
  }


});
