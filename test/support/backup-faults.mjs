import { Readable, Transform } from 'node:stream';

/** A source that fails as soon as it is read, the way a bad read of the snapshot file does. */
const failingRead = (message, code) => new Readable({
  read() { this.destroy(Object.assign(new Error(message), { code })); },
});

/** A stage that fails as soon as data reaches it, the way a broken compressor or full disk does. */
const failingStage = (message, code) => new Transform({
  transform(_chunk, _encoding, callback) { callback(Object.assign(new Error(message), { code })); },
});

/** A valid gzip of other bytes: the "bad snapshot" the decompression check has to catch. */
const corrupting = () => new Transform({
  transform(chunk, _encoding, callback) { callback(null, Buffer.alloc(chunk.length, 0)); },
});

/**
 * The pipeline slots one snapshot fault stands in for, so each failure lands where its
 * component would: a read error in place of the source stream, a corrupt stream after the
 * digest, a broken compressor in place of gzip, and a full disk in place of the compressed
 * write. The worker's own cleanup is the one that runs for each.
 */
export function backupFaultStages(fault) {
  switch (fault) {
    case 'read': return { source: failingRead('injected snapshot read failure', 'EIO') };
    case 'mismatch': return { afterDigest: corrupting() };
    case 'compress': return { compressor: failingStage('injected compressor failure', 'EIO') };
    case 'diskFull': return { writer: failingStage('injected disk full', 'ENOSPC') };
    default: throw new Error(`Unknown backup fault ${fault}`);
  }
}

/** A pass-through that counts the bytes reaching one pipeline boundary. */
export const countingStage = counts => new Transform({
  transform(chunk, _encoding, callback) { counts.chunks++; callback(null, chunk); },
});
