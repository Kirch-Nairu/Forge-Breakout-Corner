'use strict';

const os = require('os');

function hardwareSnapshot(config) {
  const total = os.totalmem();
  const free = os.freemem();
  const cpus = os.cpus() || [];
  return {
    at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    cpuModel: cpus[0]?.model || 'unknown',
    logicalCpus: cpus.length,
    loadAverage: os.loadavg(),
    memory: {
      totalBytes: total,
      freeBytes: free,
      usedBytes: total - free,
      freeRatio: total ? free / total : 0
    },
    admission: {
      light: free >= config.memory.lightModelFreeBytes,
      code: free >= config.memory.codeModelFreeBytes,
      denied: free < config.memory.denyBelowFreeBytes
    }
  };
}

function admissionForClass(snapshot, jobClass) {
  if (snapshot.admission.denied) return { allowed: false, reason: 'MEMORY_PRESSURE_DENY' };
  if (jobClass === 'CODE' && !snapshot.admission.code) return { allowed: false, reason: 'INSUFFICIENT_FREE_RAM_FOR_CODE_MODEL' };
  if (jobClass === 'LIGHT' && !snapshot.admission.light) return { allowed: false, reason: 'INSUFFICIENT_FREE_RAM_FOR_LIGHT_MODEL' };
  return { allowed: true, reason: 'ADMITTED' };
}

module.exports = { hardwareSnapshot, admissionForClass };
