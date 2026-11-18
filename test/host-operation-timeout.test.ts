import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostOperationTimeoutError, HostUnknownDeliveryError } from '../core/host/errors';
import { isTransportFailure } from '../shared/transport';

test('a host operation timeout retains unknown delivery and names the host', () => {
  const error = new HostOperationTimeoutError('bb:synthetic', 'observe', 100);
  assert.ok(error instanceof HostUnknownDeliveryError);
  assert.ok(isTransportFailure(error));
  assert.match(error.message, /bb:synthetic operation observe timed out after 100 ms/);
});
