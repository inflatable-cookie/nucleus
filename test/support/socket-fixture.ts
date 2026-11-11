import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SOCKET_PATH_BOUND = 104;

function createSocketFixtureDirectory(
  socketLeaf: string,
  prefix = "",
  nameLength = 6,
): string {
  const parent = realpathSync(tmpdir());
  for (let attempt = 0; attempt < 8; attempt++) {
    const name = createHash("sha256")
      .update(`${prefix}${randomUUID()}`)
      .digest("hex")
      .slice(0, nameLength);
    const directory = join(parent, name);
    if (
      socketLeaf &&
      Buffer.byteLength(join(directory, socketLeaf)) >= SOCKET_PATH_BOUND
    )
      throw new Error(
        `Test socket path exceeds ${SOCKET_PATH_BOUND} bytes: ${join(directory, socketLeaf)}`,
      );
    try {
      mkdirSync(directory, { mode: 0o700 });
      return realpathSync(directory);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
    }
  }
  throw new Error("Could not allocate a unique short socket fixture directory");
}

/** Create one short, exclusive fixture directory directly inside TMPDIR. */
export function socketFixtureDirectory(
  socketLeaf: string,
  nameLength = 6,
): string {
  if (!Number.isInteger(nameLength) || nameLength < 1 || nameLength > 6)
    throw new Error("Socket fixture hash length must be between 1 and 6");
  return createSocketFixtureDirectory(socketLeaf, "", nameLength);
}

/** Compatibility for socket fixtures that state their derived socket separately. */
export function socketFixtureRoot(prefix: string): string {
  return createSocketFixtureDirectory("", prefix);
}

/** Refuse a socket path that cannot bind within sockaddr_un.sun_path. */
export function assertSocketPathFits(socketPath: string): void {
  const length = Buffer.byteLength(socketPath);
  if (length >= SOCKET_PATH_BOUND)
    throw new Error(
      `fixture socket path is ${length} bytes and the local transport binds fewer than ${SOCKET_PATH_BOUND}: ${socketPath}. Shorten the fixture root or derived socket directory.`,
    );
}

export function assertSocketPathWithinBound(socketPath: string): void {
  assertSocketPathFits(socketPath);
}
