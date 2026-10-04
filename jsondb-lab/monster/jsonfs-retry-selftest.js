'use strict';

const assert = require('assert/strict');
const { replaceFileAtomic, TRANSIENT_REPLACE_CODES } = require('./jsonfs');

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function main() {
  assert(TRANSIENT_REPLACE_CODES.has('EPERM'));
  assert(TRANSIENT_REPLACE_CODES.has('EACCES'));
  assert(TRANSIENT_REPLACE_CODES.has('EBUSY'));

  let transientCalls = 0;
  const transient = await replaceFileAtomic('tmp-a', 'dest-a', {
    attempts: 8,
    baseDelayMs: 1,
    rename: async (tmp, dest) => {
      assert.equal(tmp, 'tmp-a');
      assert.equal(dest, 'dest-a');
      transientCalls++;
      if (transientCalls <= 3) throw codedError('EPERM', 'simulated Windows destination lock');
    }
  });
  assert.equal(transientCalls, 4);
  assert.deepEqual(transient, { attempts: 4, retried: true });

  let busyCalls = 0;
  const busy = await replaceFileAtomic('tmp-b', 'dest-b', {
    attempts: 4,
    baseDelayMs: 1,
    rename: async () => {
      busyCalls++;
      if (busyCalls === 1) throw codedError('EBUSY');
    }
  });
  assert.equal(busyCalls, 2);
  assert.deepEqual(busy, { attempts: 2, retried: true });

  let permanentCalls = 0;
  await assert.rejects(
    () => replaceFileAtomic('tmp-c', 'dest-c', {
      attempts: 12,
      baseDelayMs: 1,
      rename: async () => {
        permanentCalls++;
        throw codedError('EIO', 'permanent I/O failure');
      }
    }),
    error => error.code === 'EIO'
  );
  assert.equal(permanentCalls, 1, 'permanent errors must not be retried');

  let exhaustedCalls = 0;
  await assert.rejects(
    () => replaceFileAtomic('tmp-d', 'dest-d', {
      attempts: 3,
      baseDelayMs: 1,
      rename: async () => {
        exhaustedCalls++;
        throw codedError('EACCES', 'persistent lock');
      }
    }),
    error => error.code === 'EACCES'
  );
  assert.equal(exhaustedCalls, 3, 'transient errors should stop at the configured bound');

  console.log(JSON.stringify({
    ok: true,
    transientEPERMAttempts: transientCalls,
    transientEBUSYAttempts: busyCalls,
    permanentAttempts: permanentCalls,
    exhaustedAttempts: exhaustedCalls
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
