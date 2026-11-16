import { existsSync } from "node:fs";
import type { Store } from "../store/store";

/** Resolve a lead's checkout without changing the recorded planning source. */
export function leadRepository(store: Store, input: { origin: string; path: string }, requireCheckout = false) {
  const identity = store.resolveRepositoryIdentity(input);
  const registered = store.repositoryFor(identity.origin)?.repository.path?.trim()
    || store.projects().flatMap(project => project.repositories)
      .find(repository => repository.origin === identity.origin && repository.path.trim())?.path;
  const path = registered || identity.path;
  if (requireCheckout && !existsSync(path))
    throw new Error(`No usable checkout for ${identity.origin}: no usable checkout is registered and the stored path is unavailable`);
  return { origin: identity.origin, path };
}
