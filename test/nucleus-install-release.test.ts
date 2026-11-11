import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readlink, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installerFixture } from "./support/nucleus-install-fixture";

test("upgrade activates complete versions atomically, recovers the previous version and fetches a loopback release", async () => {
  const { root, home, build, receipt, tarball, digest, pack, installed, current, first } = await installerFixture();
  // Build a distinct version and refresh its complete inventory, then observe
  // the live pointer while activation happens: readers see one complete version.
  const pkg = JSON.parse(await readFile(join(build, "package.json"), "utf8"));
  pkg.version = "0.0.1";
  await writeFile(join(build, "package.json"), JSON.stringify(pkg));
  const inventory: Record<string, string> = {};
  async function inventoryTree(directory: string, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await inventoryTree(join(directory, entry.name), name + "/");
      else if (name !== "manifest.json") inventory[name] = createHash("sha256").update(await readFile(join(directory, entry.name))).digest("hex");
    }
  }
  await inventoryTree(build);
  await writeFile(join(build, "manifest.json"), JSON.stringify({ format: "nucleus-package-v1", files: inventory }));
  await pack();
  let done = false;
  const observed = new Set<string>();
  const installing = installed("install", tarball).finally(() => { done = true; });
  while (!done) {
    const target = await readlink(current);
    observed.add(target);
    assert.ok(JSON.parse(await readFile(join(target, "package.json"), "utf8")).version);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  await installing;
  const second = await realpath(current);
  assert.notEqual(second, first);
  assert.equal(JSON.parse((await installed("version")).stdout).version, "0.0.1");
  assert.ok([...observed].every(target => target === first || target === second));

  await installed("channel", "main", root, root);
  const recovery = JSON.parse((await installed("recover-previous")).stdout);
  assert.match(recovery.next, /paseo plugin reload nucleus/);
  assert.equal(await realpath(current), first);
  const channel = JSON.parse(await readFile(join(home, ".local/share/nucleus/channel.json"), "utf8"));
  assert.equal(channel.ignoredRevision, receipt.revision);
  await installed("channel", "release");
  await installed("install", tarball);
  assert.equal(await realpath(current), second);

  // The HTTP fixture stands in for GitHub's release metadata and asset endpoints.
  const archive = await readFile(tarball);
  const archiveHash = await digest();
  const server = createServer((request, response) => {
    if (request.url === "/asset.tar.gz") { response.end(archive); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/asset.tar.gz`, sha256: archiveHash }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await installed("install", `http://127.0.0.1:${(server.address() as { port: number }).port}/release`);
    assert.equal(await realpath(current), second);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }

  await assert.rejects(installed("link", root));
  assert.equal(await realpath(current), second, "retired link command leaves the install active");
});
