import { Transform } from 'node:stream';

/**
 * The snapshot-pipeline failure a test stands in for. The worker runs this stage
 * between its digest and its compressor, so each fault lands where the component it
 * names would fail and the round-trip check still has to catch what reaches it.
 */
const faults = {
  // A read error: the pipeline fails after the first bytes, so nothing is published.
  read: () => Object.assign(new Error('injected snapshot read failure'), { code: 'EIO' }),
  // A compressor that fails as soon as data reaches it.
  compress: () => Object.assign(new Error('injected compressor failure'), { code: 'EIO' }),
  // A full disk while the compressed bytes are written.
  diskFull: () => Object.assign(new Error('injected disk full'), { code: 'ENOSPC' }),
};

/** A valid gzip of other bytes: the "bad snapshot" the round-trip check has to catch. */
const corrupting = () => new Transform({
  transform(chunk, _encoding, callback) { callback(null, Buffer.alloc(chunk.length, 0)); },
});

export function backupFaultStage(fault) {
  if (fault === 'mismatch') return corrupting();
  const failure = faults[fault];
  if (!failure) throw new Error(`Unknown backup fault ${fault}`);
  return new Transform({
    transform(_chunk, _encoding, callback) { callback(failure()); },
  });
}
