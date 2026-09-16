#!/usr/bin/env node
// Rewrites the one literal 1.x call shape to 2.0 and reports every site it did not touch.
//   npx locco-migrate-v2 [--write] <file>...
// It parses each file with the TypeScript package of your project, so text inside a string, a
// comment or a regular expression is never touched.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const args = process.argv.slice(2);
const write = args.includes('--write');
const files = args.filter((arg) => arg !== '--write');

if (files.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.error('usage: locco-migrate-v2 [--write] <file>...');
  process.exit(2);
}

const ts = loadTypeScript();

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

function loadTypeScript() {
  try {
    return createRequire(path.join(process.cwd(), 'package.json'))('typescript');
  } catch {
    console.error('locco-migrate-v2 needs the "typescript" package in your project.');
    process.exit(2);
  }
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
  const visit = (node) => {
    const site = matchSite(node, sourceFile);
    if (site) {
      edits.push(site);
      return;
    }
    if (isLockCall(node)) {
      leftover.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
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
