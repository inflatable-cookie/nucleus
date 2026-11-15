import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOST_RUN_REDACTED, hostRunEnvKeys, redactHostRunData } from '../core/host-runs/host-run-redact';

test('host-run redaction keeps only environment names and masks secret-shaped string fields recursively', () => {
  const input = {
    env: { Z_TOKEN: 'token-value', PUBLIC: 'visible' },
    envKeys: ['A_KEY'],
    nested: { password: 'password-value', label: 'visible', values: [{ authHeader: 'auth-value' }] },
  };

  const redacted = redactHostRunData(input);
  assert.deepEqual(redacted, {
    envKeys: ['A_KEY', 'PUBLIC', 'Z_TOKEN'],
    nested: { password: HOST_RUN_REDACTED, label: 'visible', values: [{ authHeader: HOST_RUN_REDACTED }] },
  });
  assert.deepEqual(redactHostRunData(redacted), redacted, 'redaction is idempotent');
  assert.deepEqual(hostRunEnvKeys(input.env), ['PUBLIC', 'Z_TOKEN']);
});
