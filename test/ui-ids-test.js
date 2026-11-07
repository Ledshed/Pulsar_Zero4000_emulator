#!/usr/bin/env node
// Fails if app.js refers to an element id that index.html doesn't have. Run by `npm run build` and `npm test`.
'use strict';
const fs = require('fs');
const path = require('path');
const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const defined = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const used = new Set();
for (const re of [/\$\('([A-Za-z0-9_-]+)'\)/g, /\bon\('([A-Za-z0-9_-]+)'/g, /\bwithEl\('([A-Za-z0-9_-]+)'/g]) {
  for (const m of js.matchAll(re)) used.add(m[1]);
}
const missing = [...used].filter(id => !defined.has(id)).sort();
if (missing.length) {
  console.error(`✖ app.js uses element ids that index.html doesn't define: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`✔ all ${used.size} element ids used by app.js exist in index.html`);
