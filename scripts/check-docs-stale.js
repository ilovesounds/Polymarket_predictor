#!/usr/bin/env node
/**
 * Lightweight check: package.json scripts should appear in docs npm table.
 *   node scripts/check-docs-stale.js
 * Exit 1 if mismatch (for CI or pre-commit).
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const docsPath = path.join(root, 'dashboard/public/docs/index.html');

const SKIP = new Set(['test']);

function loadPackageScripts() {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return Object.keys(pkg.scripts || {}).filter((k) => !SKIP.has(k)).sort();
}

function loadDocsScriptIds(html) {
  const ids = new Set();
  const rowRe = /<tr><td><code>([a-z0-9:_-]+)<\/code><\/td>/gi;
  let m;
  const section = html.match(/id="npm-scripts"[\s\S]*?<\/section>/i);
  const block = section ? section[0] : html;
  while ((m = rowRe.exec(block)) !== null) {
    ids.add(m[1]);
  }
  return [...ids].sort();
}

function main() {
  if (!fs.existsSync(docsPath)) {
    console.error('[check:docs] Missing', docsPath);
    process.exit(1);
  }
  const pkgScripts = loadPackageScripts();
  const docScripts = loadDocsScriptIds(fs.readFileSync(docsPath, 'utf8'));

  const missingInDocs = pkgScripts.filter((s) => !docScripts.includes(s));
  const extraInDocs = docScripts.filter((s) => !pkgScripts.includes(s));

  if (!missingInDocs.length && !extraInDocs.length) {
    console.log('[check:docs] OK —', pkgScripts.length, 'scripts documented');
    process.exit(0);
  }

  console.error('[check:docs] Documentation drift detected');
  if (missingInDocs.length) {
    console.error('  In package.json but not docs table:', missingInDocs.join(', '));
  }
  if (extraInDocs.length) {
    console.error('  In docs table but not package.json:', extraInDocs.join(', '));
  }
  console.error('  Update: dashboard/public/docs/index.html (#npm-scripts)');
  process.exit(1);
}

main();
