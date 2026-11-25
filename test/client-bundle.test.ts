import { execFile } from "node:child_process";
import { test } from "node:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("the standalone board and its shared modules bundle for the browser", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nucleus-browser-bundle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // The browser build cannot resolve Node built-ins through any reached module.
  const builder = fileURLToPath(new URL("../scripts/build-web.mjs", import.meta.url));
  await promisify(execFile)(process.execPath, [builder, directory]);
  await Promise.all([
    access(join(directory, "app.js")),
    access(join(directory, "index.html")),
  ]);
});
