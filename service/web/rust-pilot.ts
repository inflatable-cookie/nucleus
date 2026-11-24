import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { rustInboxEnginePattern } from "../../shared/rust-inbox";

const pilotFile = "rust-engine-pilot.json";
const filePath = z.string().refine(isAbsolute);
const loopback = z.string().refine((value) => {
  const url = URL.parse(value);
  return (
    url?.protocol === "http:" &&
    ["127.0.0.1", "[::1]"].includes(url.hostname) &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash
  );
});
const pilot = z
  .object({
    repository: z
      .string()
      .refine((value) => normalizeRepositoryOrigin(value) === value),
    endpoint: loopback,
    boardKeyFile: filePath,
    inboxKeyFile: filePath,
    inboxEngine: z.string().regex(rustInboxEnginePattern),
  })
  .strict();

export type RustPilot = z.infer<typeof pilot>;

export function readPrivateText(file: string, limit: number): string {
  const fd = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > limit
    ) {
      throw new Error("Invalid private file");
    }
    const bytes = Buffer.alloc(limit + 1);
    const length = readSync(fd, bytes);
    if (length > limit) throw new Error("Private file exceeds its size limit");
    return bytes.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Read the operator's cutover settings on service start. */
export function readRustPilot(dataDir: string): RustPilot | null {
  try {
    return pilot.parse(
      JSON.parse(readPrivateText(join(dataDir, pilotFile), 4096)),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Use a valid owner-only ${pilotFile} for the Rust pilot.`);
  }
}

/** Keep the legacy service available when a pilot configuration cannot be used. */
export function rustPilotServiceOptions(dataDir: string): {
  rustPilot?: RustPilot | null;
} {
  try {
    const configured = readRustPilot(dataDir);
    return configured ? { rustPilot: configured } : {};
  } catch (error) {
    console.error((error as Error).message);
    return { rustPilot: null };
  }
}

export function readPrivateKey(file: string): string {
  const key = readPrivateText(file, 65);
  if (!/^[0-9a-f]{64}\n?$/.test(key)) throw new Error("Invalid private key");
  return key.trimEnd();
}
