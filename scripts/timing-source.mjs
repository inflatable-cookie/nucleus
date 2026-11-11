/** A shard entry and its case source, used to find serial wall-clock tests. */
export function entrySource(source, read) {
  const cases = [...source.matchAll(/^require\(['"]\.\/([^'"/]+\.cases)['"]\);?$/gm)].map(match => read(`test/${match[1]}.ts`));
  return [source, ...cases].join('\n');
}
export const SERIAL_LANE_MARKER = './support/timing';
export function isSerialLaneSource(source) { return source.includes(SERIAL_LANE_MARKER); }
/** Explicit files override discovery; the expensive benchmark is opt-in. */
export function selectTimingFiles(requested, available, read) {
  if (requested.length) return [...requested];
  return available.filter(name => name.endsWith('.test.ts')).map(name => `test/${name}`)
    .filter(path => path !== 'test/store-compaction-bench.test.ts' && isSerialLaneSource(entrySource(read(path), read)));
}
