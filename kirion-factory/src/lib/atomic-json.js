'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

function now() { return new Date().toISOString(); }
function safeId(prefix = 'id') { return `${prefix}-${crypto.randomUUID()}`; }

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function renameWithRetry(from, to, attempts = 8) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      last = err;
      if (!RETRYABLE.has(err?.code) || i === attempts - 1) throw err;
      await sleep(20 * (i + 1) + Math.floor(Math.random() * 25));
    }
  }
  throw last;
}

async function atomicJson(file, value) {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fsp.writeFile(temp, payload, 'utf8');
  try {
    await renameWithRetry(temp, file);
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback;
    throw err;
  }
}

module.exports = { now, safeId, ensureDir, atomicJson, readJson, renameWithRetry };
