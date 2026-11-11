#!/usr/bin/env node
// Prints this checkout's backend digest and build identity as JSON. The bridge
// runs it after a source change: the identity must come from the checkout's own
// RPC catalogue, not the one the already-loaded plugin holds in memory.
import { fileURLToPath } from 'node:url';
const { backendSourceDigest, serviceBuildIdentity } = await import('../shared/service/build.ts');
const root = fileURLToPath(new URL('..', import.meta.url));
const digest = backendSourceDigest(root);
console.log(JSON.stringify({ digest, buildId: serviceBuildIdentity(root, undefined, digest) }));
