import { createHash, timingSafeEqual } from "node:crypto";
import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  RUST_INBOX_PREFIX, rustInboxEnginePattern, rustInboxReply, rustInboxRequest,
  type RustInboxRequest,
} from "../../shared/rust-inbox";

export interface RustInboxBridge {
  authorization(header: string | undefined): boolean;
  call(input: unknown): Promise<unknown>;
}

const keyPattern = /^[0-9a-f]{64}\n?$/;

function readKey(file: string): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error("invalid key permissions");
    }
    const contents = Buffer.alloc(66);
    const bytes = readSync(fd, contents);
    const key = contents.subarray(0, bytes).toString("utf8");
    if (!keyPattern.test(key)) throw new Error("invalid key");
    return digest(key.trimEnd());
  } finally {
    closeSync(fd);
  }
}

function digest(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

export function configuredRustInbox(
  env: NodeJS.ProcessEnv,
  call: (request: RustInboxRequest) => Promise<unknown>,
): RustInboxBridge | null {
  const engine = env.NUCLEUS_RUST_INBOX_ENGINE;
  const file = env.NUCLEUS_RUST_INBOX_KEY_FILE;
  if (!engine && !file) return null;
  if (!engine || !rustInboxEnginePattern.test(engine) || !file || !isAbsolute(file)) {
    throw new Error("Invalid Rust Inbox bridge configuration.");
  }
  let key: Buffer;
  try {
    key = readKey(file);
  } catch {
    throw new Error("The Rust Inbox bridge needs a valid owner-only key file.");
  }
  return {
    authorization(header) {
      const bearer = header?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
      return bearer !== undefined && timingSafeEqual(key, digest(bearer));
    },
    async call(input) {
      const request = rustInboxRequest.parse(input);
      if (!request.id.startsWith(`${RUST_INBOX_PREFIX}${engine}:`)) {
        throw new Error("The decision belongs to another engine.");
      }
      return rustInboxReply.parse(await call(request));
    },
  };
}
