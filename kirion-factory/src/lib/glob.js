'use strict';

const path = require('path');

function normalizeRepoPath(input) {
  return String(input || '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
}

function globToRegExp(glob) {
  const normalized = normalizeRepoPath(glob);
  let out = '^';
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        i += 1;
        if (normalized[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if ('\\.^$+?()[]{}|'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += '$';
  return new RegExp(out);
}

function matchesAny(file, patterns = []) {
  const normalized = normalizeRepoPath(file);
  return patterns.some(pattern => globToRegExp(pattern).test(normalized));
}

function relativeInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative === '.') return '';
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path escapes root.');
  return normalizeRepoPath(relative);
}

module.exports = { normalizeRepoPath, globToRegExp, matchesAny, relativeInside };
