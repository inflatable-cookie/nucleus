import { spawnSync } from 'node:child_process';

// cargo-deny combines target-specific edges when multiple targets are passed together.
const targets = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
];

for (const target of targets) {
  console.log(`Checking dependencies for ${target}`);
  const result = spawnSync('cargo', [
    'deny', '--manifest-path', 'engine/Cargo.toml', '--all-features', '--locked',
    '--target', target, 'check', '--config', 'engine/deny.toml', '--show-stats',
    ...process.argv.slice(2),
  ], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
