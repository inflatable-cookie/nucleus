import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  RUST_INBOX_PREFIX,
  rustInboxEnginePattern,
  rustInboxReply,
  rustInboxRequest,
  type RustInboxRequest,
} from "../../shared/rust-inbox";
import { readPrivateKey } from "./rust-pilot";

export interface RustInboxBridge {
  authorization(header: string | undefined): boolean;
  call(input: unknown): Promise<unknown>;
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
  if (
    !engine ||
    !rustInboxEnginePattern.test(engine) ||
    !file ||
    !isAbsolute(file)
  ) {
    throw new Error("Invalid Rust Inbox bridge configuration.");
  }
  let key: Buffer;
  try {
    key = digest(readPrivateKey(file));
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
