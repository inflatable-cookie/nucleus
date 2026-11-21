#!/usr/bin/env node
// Internal implementation: the host-independent main-channel roll owner (nucleus#1454).
// A local T3Code launch or a Paseo bridge starts it through `ensureRollOwner`. It
// rolls the configured main channel while a service serves or a roll is pending,
// and exits by itself once neither holds.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRollOwnerEntry } from '../service/transport/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reason = await runRollOwnerEntry(process.argv.slice(2), root);
process.stderr.write(`Nucleus roll owner exited: ${reason}\n`);
process.exit(0);
