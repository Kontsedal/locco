#!/usr/bin/env node
// Rewrites the one literal 1.x call shape to 2.0 and reports every site it did not touch.
//   npx locco-migrate-v2 [--write] [--typescript <path>] <file, directory or glob>...
// It parses each file with a TypeScript package, so text inside a string, a comment or a regular
// expression is never touched.
import { globSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const USAGE =
  'usage: locco-migrate-v2 [--write] [--typescript <path>] <file, directory or glob>...';
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

const { write, typescript, patterns } = parseArgs(process.argv.slice(2));
const files = expand(patterns);
const ts = loadTypeScript(typescript);

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
  ['locksCollectionName', 'the MongoAdapter option is now collectionName'],
];

let rewritten = 0;
let manual = 0;

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const { output, count, leftover } = rewrite(file, source);
  rewritten += count;
  if (write && count > 0) {
    writeFileSync(file, output);
  }
  const report = [
    ...leftover.map((line) => `line ${line}: a Locker.lock() call the codemod did not rewrite`),
    ...findManual(output),
  ];
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

function parseArgs(args) {
  const parsed = { write: false, typescript: undefined, patterns: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      fail(USAGE);
    } else if (arg === '--write') {
      parsed.write = true;
    } else if (arg === '--typescript') {
      index += 1;
      parsed.typescript = args[index];
      if (parsed.typescript === undefined) {
        fail('--typescript needs the path of a TypeScript package.');
      }
    } else if (arg.startsWith('--typescript=')) {
      parsed.typescript = arg.slice('--typescript='.length);
    } else {
      parsed.patterns.push(arg);
    }
  }
  if (parsed.patterns.length === 0) {
    fail(USAGE);
  }
  return parsed;
}

/**
 * Expands every glob and directory itself. Bash expands a `**` glob one directory level deep
 * unless globstar is on, and PowerShell and cmd do not expand globs at all.
 */
function expand(args) {
  const found = new Set();
  const unmatched = [];
  for (const arg of args) {
    const matches = matchesOf(arg);
    if (matches.length === 0) {
      unmatched.push(arg);
    }
    for (const match of matches) {
      found.add(match);
    }
  }
  if (unmatched.length > 0) {
    fail(`No file matches ${unmatched.map((arg) => `"${arg}"`).join(', ')}. Nothing was changed.`);
  }
  return [...found].sort();
}

function matchesOf(arg) {
  if (/[*?[\]{}]/.test(arg)) {
    return globFiles(arg);
  }
  let stats;
  try {
    stats = statSync(arg);
  } catch {
    return [];
  }
  return stats.isDirectory() ? globFiles(path.join(arg, '**', '*')) : [arg];
}

function globFiles(pattern) {
  // Node 22 hands `exclude` a path and later versions can hand it a Dirent, so read either.
  const skip = (entry) =>
    (typeof entry === 'string' ? path.basename(entry) : entry.name) === 'node_modules';
  return globSync(pattern.split(path.sep).join('/'), { exclude: skip }).filter(
    (file) =>
      SOURCE_FILE.test(file) &&
      !file.split(/[\\/]/).includes('node_modules') &&
      statSync(file).isFile(),
  );
}

/**
 * The first TypeScript that still has the classic syntax API: the one `--typescript` names, the
 * project's own, then any that `npx --package` put on the PATH. TypeScript 7 ships the native
 * compiler and does not expose that API, so a project on 7 needs a 5 or a 6 beside it.
 */
function loadTypeScript(explicit) {
  const project = createRequire(path.join(process.cwd(), 'package.json'));
  const candidates = explicit
    ? [() => project(path.resolve(explicit))]
    : [() => project('typescript'), ...onPath().map((root) => () => root('typescript'))];
  // npm puts the project's own `.bin` on the PATH too, so one copy can turn up more than once.
  const unusable = new Set();
  for (const load of candidates) {
    let loaded;
    try {
      loaded = load();
    } catch {
      continue;
    }
    if (typeof loaded.createSourceFile === 'function' && loaded.ScriptTarget) {
      return loaded;
    }
    unusable.add(`typescript@${loaded.version ?? '?'}`);
  }
  if (explicit && unusable.size === 0) {
    fail(`--typescript ${explicit} is not a TypeScript package.`);
  }
  if (unusable.size === 0) {
    fail(
      'locco-migrate-v2 needs the "typescript" package. Install it in the project, or run:',
      '  npx --package typescript@5 -- locco-migrate-v2 --write "src/**/*.ts"',
    );
  }
  fail(
    `locco-migrate-v2 needs the classic TypeScript syntax API, which ${[...unusable].join(' and ')} ${unusable.size > 1 ? 'do' : 'does'} not expose.`,
    'Run it once with TypeScript 5 beside it, for example:',
    '  npx --package typescript@5 -- locco-migrate-v2 --write "src/**/*.ts"',
    'or point it at a copy with --typescript <path>.',
  );
}

/** A `require` for every `node_modules/.bin` on the PATH, rooted where that `node_modules` lives. */
function onPath() {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => /node_modules[\\/]\.bin[\\/]?$/.test(entry))
    .map((entry) => createRequire(path.join(entry, '..', '..', 'package.json')));
}

function fail(...lines) {
  for (const line of lines) {
    console.error(line);
  }
  process.exit(2);
}

function rewrite(file, source) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
  const edits = [];
  const leftover = [];
  const lineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const visit = (node) => {
    const site = matchSite(node, sourceFile);
    // A site is rebuilt from the source text of its key and ttl, so a second 1.x call nested in
    // either would be carried across verbatim and the two edits would overlap. Leave the whole
    // nest to a human rather than rewrite half of it, and report every lock() call inside it.
    if (site && countLockCalls(node) === 1) {
      edits.push(site);
      return;
    }
    if (isLockCall(node)) {
      leftover.push(lineOf(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  let output = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  return { output, count: edits.length, leftover };
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  if (file.endsWith('.jsx')) {
    return ts.ScriptKind.JSX;
  }
  if (/\.(m|c)?js$/.test(file)) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

/** Matches `X.lock(KEY, TTL)[.setRetrySettings({...})].acquire()` and returns the 2.0 text. */
function matchSite(node, sourceFile) {
  if (!ts.isCallExpression(node) || node.arguments.length !== 0) {
    return undefined;
  }
  const acquire = node.expression;
  if (!ts.isPropertyAccessExpression(acquire) || acquire.name.text !== 'acquire') {
    return undefined;
  }
  let target = acquire.expression;
  let retry;
  if (isMethodCall(target, 'setRetrySettings')) {
    if (target.arguments.length !== 1) {
      return undefined;
    }
    retry = translateSettings(target.arguments[0], sourceFile);
    if (retry === undefined) {
      return undefined;
    }
    target = target.expression.expression;
  }
  if (!isLockCall(target)) {
    return undefined;
  }
  const [key, ttl] = target.arguments;
  const receiver = target.expression.expression.getText(sourceFile);
  const ttlText = ttl.getText(sourceFile);
  const options = retry ? `{ ttl: ${ttlText}, retry: ${retry} }` : `{ ttl: ${ttlText} }`;
  return {
    start: node.getStart(sourceFile),
    end: node.getEnd(),
    text: `${receiver}.acquire(${key.getText(sourceFile)}, ${options})`,
  };
}

function isMethodCall(node, name) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === name
  );
}

function isLockCall(node) {
  return isMethodCall(node, 'lock') && node.arguments.length === 2;
}

/** How many `X.lock(key, ttl)` calls sit in this subtree, the node itself included. */
function countLockCalls(node) {
  let count = isLockCall(node) ? 1 : 0;
  ts.forEachChild(node, (child) => {
    count += countLockCalls(child);
  });
  return count;
}

/** Turns a literal `{ retryTimes: N, retryDelay: D, totalTime: T }` into a 2.0 retry object. */
function translateSettings(node, sourceFile) {
  if (!ts.isObjectLiteralExpression(node)) {
    return undefined;
  }
  const out = [];
  let retries;
  let delay;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
      return undefined;
    }
    const name = property.name.text;
    const value = property.initializer;
    if (name === 'retryTimes') {
      if (!ts.isNumericLiteral(value)) {
        return undefined;
      }
      retries = Math.max(0, Number(value.text) - 1);
    } else if (name === 'retryDelay') {
      delay = value.getText(sourceFile);
    } else if (name === 'totalTime') {
      out.push(`timeout: ${value.getText(sourceFile)}`);
    } else {
      return undefined;
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
  const report = [];
  source.split('\n').forEach((line, number) => {
    for (const [needle, hint] of MANUAL_PATTERNS) {
      if (line.includes(needle)) {
        report.push(`line ${number + 1}: ${hint}`);
      }
    }
  });
  return report;
}
