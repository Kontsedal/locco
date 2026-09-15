#!/usr/bin/env node
// Rewrites the one literal 1.x call shape to 2.0 and reports every site it did not touch.
//   node scripts/codemod-v1-to-v2.mjs [--write] <file>...
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const write = args.includes('--write');
const files = args.filter((arg) => arg !== '--write');

if (files.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.error('usage: node scripts/codemod-v1-to-v2.mjs [--write] <file>...');
  process.exit(2);
}

const MANUAL_PATTERNS = [
  ['retryDelayFn', 'retryDelayFn: the context fields changed and stop() is gone'],
  ['setRetrySettings', 'setRetrySettings that the codemod did not rewrite'],
  ['uniqueValue', 'uniqueValue is now token'],
  ['isLocked(', 'isLocked() is now isHeld()'],
  ['throwOnFail', 'release() returns a boolean; there is no throwOnFail'],
  ['LockCreateError', 'contention is LockHeldError'],
  ['RetryError', 'contention is LockHeldError'],
  ['LockReleaseError', 'release() returns false instead of throwing'],
  ['LockExtendError', 'extend() throws LockLostError'],
  ['ILockAdapter', 'the interface is LockAdapter and its methods return booleans'],
  ['retrySettings', 'the Locker option is now retry'],
];

let rewritten = 0;
let manual = 0;

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const { output, count } = rewrite(source);
  rewritten += count;
  if (write && count > 0) {
    writeFileSync(file, output);
  }
  const report = findManual(output);
  manual += report.length;
  if (count > 0 || report.length > 0) {
    console.log(`${file}: ${count} site(s) rewritten`);
    for (const line of report) {
      console.log(`  ${line}`);
    }
  }
}

console.log(`\n${rewritten} site(s) rewritten, ${manual} site(s) need a hand.`);
if (!write && rewritten > 0) {
  console.log('Run again with --write to change the files.');
}

function rewrite(source) {
  let output = '';
  let index = 0;
  let count = 0;
  for (;;) {
    const start = source.indexOf('.lock(', index);
    if (start === -1) {
      output += source.slice(index);
      break;
    }
    const site = parseSite(source, start);
    if (!site) {
      output += source.slice(index, start + 6);
      index = start + 6;
      continue;
    }
    output += source.slice(index, start) + site.replacement;
    index = site.end;
    count += 1;
  }
  return { output, count };
}

/** Matches `.lock(KEY, TTL)[.setRetrySettings({...})].acquire()` and returns the 2.0 text. */
function parseSite(source, start) {
  const lockArgs = balanced(source, start + 5);
  if (!lockArgs) {
    return undefined;
  }
  const parts = splitTopLevel(lockArgs.inner);
  if (parts.length !== 2) {
    return undefined;
  }
  const [key, ttl] = parts.map((part) => part.trim());
  let cursor = lockArgs.end;
  let retry = '';
  const settingsCall = '.setRetrySettings(';
  if (source.startsWith(settingsCall, skipSpace(source, cursor))) {
    const open = skipSpace(source, cursor) + settingsCall.length - 1;
    const settings = balanced(source, open);
    if (!settings) {
      return undefined;
    }
    retry = translateSettings(settings.inner.trim());
    if (retry === undefined) {
      return undefined;
    }
    cursor = settings.end;
  }
  const acquireAt = skipSpace(source, cursor);
  if (!source.startsWith('.acquire()', acquireAt)) {
    return undefined;
  }
  const options = retry ? `{ ttl: ${ttl}, retry: ${retry} }` : `{ ttl: ${ttl} }`;
  return { replacement: `.acquire(${key}, ${options})`, end: acquireAt + '.acquire()'.length };
}

/** Turns a literal `{ retryTimes: N, retryDelay: D, totalTime: T }` into a 2.0 retry object. */
function translateSettings(text) {
  if (!text.startsWith('{') || !text.endsWith('}')) {
    return undefined;
  }
  const fields = splitTopLevel(text.slice(1, -1))
    .map((field) => field.trim())
    .filter(Boolean);
  const out = [];
  let retries;
  let delay;
  for (const field of fields) {
    const match = /^(retryTimes|retryDelay|totalTime)\s*:\s*([\s\S]+)$/.exec(field);
    if (!match) {
      return undefined;
    }
    const [, name, value] = match;
    if (name === 'retryTimes') {
      if (!/^\d+$/.test(value.trim())) {
        return undefined;
      }
      retries = Math.max(0, Number(value) - 1);
    } else if (name === 'retryDelay') {
      delay = value.trim();
    } else {
      out.push(`timeout: ${value.trim()}`);
    }
  }
  if (retries !== undefined) {
    out.unshift(`retries: ${retries}`);
  }
  if (delay !== undefined && retries !== 0) {
    out.splice(retries === undefined ? 0 : 1, 0, `delay: ${delay}`);
  }
  return out.length === 0 ? '{}' : `{ ${out.join(', ')} }`;
}

function findManual(source) {
  const lines = source.split('\n');
  const report = [];
  lines.forEach((line, number) => {
    for (const [needle, hint] of MANUAL_PATTERNS) {
      if (line.includes(needle)) {
        report.push(`line ${number + 1}: ${hint}`);
      }
    }
  });
  return report;
}

/** Returns the text inside the parentheses that open at `open`, and the index after the close. */
function balanced(source, open) {
  if (source[open] !== '(') {
    return undefined;
  }
  let depth = 0;
  let quote;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === '\\') {
        i += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '(' || char === '{' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        return { inner: source.slice(open + 1, i), end: i + 1 };
      }
    }
  }
  return undefined;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      current += char;
      if (char === '\\') {
        current += text[i + 1] ?? '';
        i += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '(' || char === '{' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === '}' || char === ']') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    parts.push(current);
  }
  return parts;
}

function skipSpace(source, index) {
  let i = index;
  while (i < source.length && /\s/.test(source[i])) {
    i += 1;
  }
  return i;
}
