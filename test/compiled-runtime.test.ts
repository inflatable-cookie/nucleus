import { copyNodeRuntime } from "../scripts/copy-node-runtime.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { rpcContractDigests } from "../shared/rpc-contracts";
import { dataHome } from "../shared/data-home.mjs";

const exec = promisify(execFile);
test("data home is ~/.nucleus and ignores PASEO_HOME", () => {
  assert.equal(
    dataHome({ HOME: "/fixture" }),
    "/fixture/.nucleus",
  );
  assert.equal(
    dataHome({ HOME: "/fixture", PASEO_HOME: "/private" }),
    "/fixture/.nucleus",
  );
});

test("compiled package runs relocated without sources, dependencies or a loader", async () => {
  const root = await mkdtemp(join(tmpdir(), "c-"));
  const built = await exec(
    process.execPath,
    ["scripts/build-runtime.mjs", join(root, "build")],
    { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const receipt = JSON.parse(built.stdout);
  assert.ok(Array.isArray(receipt.nodeLibraries.libraries));
  assert.ok(receipt.nodeLibraries.systemLibraries.length > 0);
  const manifest = JSON.parse(await readFile(join(root, "build", "manifest.json"), "utf8"));
  for (const library of receipt.nodeLibraries.libraries) {
    assert.ok(manifest.files[`runtime/${library.file}`], "bundled library is manifest-covered");
  }
  const relocated = join(root, "isolated");
  await cp(join(root, "build"), relocated, { recursive: true });
  assert.ok(receipt.entries.includes("server/service/executor-worker.mjs"));
  assert.ok(receipt.entries.includes("server/host-run-front-worker.mjs"));
  async function inventory(dir: string): Promise<string[]> {
    const paths: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) paths.push(...(await inventory(join(dir, e.name))));
      else paths.push(join(dir, e.name));
    }
    return paths;
  }
  assert.match(await readFile(join(relocated, "index.server.ts"), "utf8"), /\.\/server\/index\.server\.mjs/);
  // The host provides these. A bundled copy has its own context and no provider, so the
  // board failed with "No QueryClient set" on 2026-11-05.
  const client = await readFile(join(relocated, "client/index.client.js"), "utf8");
  assert.doesNotMatch(client, /No QueryClient set/);
  assert.match(client, /from "@tanstack\/react-query"/);
  assert.match(await readFile(join(relocated, "index.client.tsx"), "utf8"), /\.\/client\/index\.client\.js/);
  assert.ok((await readdir(join(relocated, "shared")).catch(() => [])).length === 0, "compiled plugin must not expose Node imports under shared/");
  const files = await inventory(relocated);
  assert.ok(
    files.every((p) => (!p.endsWith(".ts") || p === join(relocated, "index.server.ts")) && !p.includes("node_modules")),
  );
  const env = {
    ...process.env,
    NODE_OPTIONS: "",
    NODE_PATH: "",
    PASEO_HOME: join(root, "p"),
    HOME: join(root, "h"),
  };
  const runtime = join(relocated, "runtime", "node");
  const run = (file: string, args: string[] = []) =>
    exec(runtime, [join(relocated, file), ...args], {
      cwd: relocated,
      env,
      timeout: 30_000,
    });
  assert.match((await run("bin/queue-cli.mjs", ["--help"])).stdout, /Usage:/);
  const identity = JSON.parse((await run("bin/queue-build-id.mjs")).stdout);
  assert.equal(identity.buildId, receipt.buildId);
  assert.equal(identity.digest, receipt.digest);
  assert.deepEqual(receipt.rpcContracts, rpcContractDigests());
  // The same service class as production, with its existing worker-side adapter fixture.
  await writeFile(
    join(relocated, "proof.mjs"),
    `
import { QueueService } from './server/service/server.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HostRunFront } from './server/host-run-front.mjs';
const service = new QueueService({ owner: { timers: false }, fixture: 'fake' });
await service.start();
const stateDir = join(process.env.PASEO_HOME, 'f');
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const front = await HostRunFront.start({ stateDir, socketPath: join(stateDir, 'run', 'scheduler.sock') });
console.log('READY');
process.on('SIGTERM', () => { void front.stop().then(() => service.stop()).then(() => process.exit(0)); });
`,
  );
  const child = spawn(runtime, [join(relocated, "proof.mjs")], {
    cwd: relocated,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error(`Startup timed out: ${diagnostics}`)),
        30_000,
      );
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(Error(`Service exited ${code}: ${diagnostics}`));
      });
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const answer = JSON.parse(
      (await run("bin/queue-cli.mjs", ["capacity-state"])).stdout,
    );
    assert.ok(answer);
    // The helper a provider without the report tool falls back to: it must run
    // as a script after the build, or every report it carries is silently lost.
    const reportHelper = await exec(
      runtime,
      [join(env.HOME, ".nucleus", "worker-helper.mjs")],
      {
        cwd: relocated,
        env: {
          ...env,
          NUCLEUS_SOCKET: "",
          NUCLEUS_RUN_TOKEN: "",
          NUCLEUS_TICKET: "",
        },
        timeout: 30_000,
      },
    ).then(
      () => "exited 0 without reporting",
      (error: { stderr: string }) => error.stderr,
    );
    assert.match(reportHelper, /Missing Nucleus callback environment/);
    const planPath = join(root, "plan.json");
    const resultPath = join(root, "result.json");
    const identityToken = "compiled-fixture-token";
    await writeFile(
      planPath,
      JSON.stringify({
        format: "queue.project-validation.plan",
        version: 1,
        runId: "compiled-proof",
        epoch: 1,
        identityToken,
        root,
        argv: [runtime, "-e", 'console.log("detached-proof")'],
        timeoutMs: 10_000,
        maxOutputBytes: 4096,
        terminationGraceMs: 100,
        launchedAt: new Date().toISOString(),
        statePath: join(root, "state.json"),
        resultPath,
        hostRunToken: "private-fixture-token",
      }),
      { mode: 0o600 },
    );
    const helper = spawn(
      runtime,
      [
        join(relocated, "bin/queue-validation-supervisor.mjs"),
        planPath,
        identityToken,
      ],
      {
        cwd: relocated,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let helperError = "";
    helper.stderr.on("data", (chunk) => {
      helperError += chunk;
    });
    const code = await new Promise((resolve) => helper.once("exit", resolve));
    assert.equal(code, 0, helperError);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.match(result.outputTail, /detached-proof/);
  } finally {
    child.kill("SIGTERM");
    assert.equal(await exited, 0, diagnostics);
  }
  console.log(
    JSON.stringify({
      packageBytes: receipt.bytes,
      buildMs: receipt.buildMs,
      buildId: receipt.buildId,
    }),
  );
});

// A private library tree proves relocation without relying on the host's Homebrew
// copies remaining available. The executable accepts --version like Node.
test("packaged libraries resolve transitively and missing libraries name the dependency", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "node-libs-"));
  const source = join(root, "source");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(source);
  await writeFile(join(source, "leaf.c"), "int leaf(void) { return 42; }\n");
  await writeFile(join(source, "middle.c"), "extern int leaf(void); int middle(void) { return leaf(); }\n");
  await writeFile(join(source, "main.c"), '#include <stdio.h>\nextern int middle(void); int main(void) { printf("%d\\n", middle()); return 0; }\n');
  const leaf = join(source, "libleaf.dylib");
  const middle = join(source, "libmiddle.dylib");
  await exec("cc", ["-dynamiclib", join(source, "leaf.c"), "-o", leaf, "-Wl,-install_name,@rpath/libleaf.dylib"]);
  await exec("cc", ["-dynamiclib", join(source, "middle.c"), leaf, "-o", middle, `-Wl,-install_name,${middle}`, "-Wl,-rpath,@loader_path"]);
  const binary = join(source, "node");
  await exec("cc", [join(source, "main.c"), middle, "-o", binary, "-Wl,-rpath,@loader_path"]);
  const copied = join(root, "package", "node");
  const receipt = copyNodeRuntime(copied, binary);
  assert.equal(receipt.libraries.length, 2);
  await rename(source, join(root, "hidden"));
  assert.equal((await exec(copied, ["--version"])).stdout.trim(), "42");
  await rename(join(root, "hidden"), source);
  await rename(leaf, join(source, "missing.dylib"));
  assert.throws(() => copyNodeRuntime(join(root, "broken", "node"), binary), /cannot resolve library @rpath\/libleaf.dylib/);
});
