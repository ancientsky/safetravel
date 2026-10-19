// Fails when web/ uses a d3 function that the vendored subset (scripts/d3-entry.mjs) does not export.
// Run before publishing: node scripts/check-d3.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ctx = { console };
ctx.window = ctx;
ctx.globalThis = ctx;
vm.runInNewContext(readFileSync('web/vendor/d3.min.js', 'utf8'), ctx);
const exported = new Set(Object.keys(ctx.d3 || {}));

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { if (!['vendor', 'data'].includes(name)) walk(p); } else if (p.endsWith('.js')) files.push(p);
  }
}('web'));

const missing = [];
for (const f of files) {
  for (const [, fn] of readFileSync(f, 'utf8').matchAll(/\bd3\.([A-Za-z_$][\w$]*)/g)) {
    if (!exported.has(fn)) missing.push(`${f}: d3.${fn}`);
  }
}
if (missing.length) {
  console.error(`d3 functions used but not in web/vendor/d3.min.js (add them to scripts/d3-entry.mjs, run npm run vendor):\n  ${[...new Set(missing)].join('\n  ')}`);
  process.exit(1);
}
console.log(`d3 subset ok: ${exported.size} exports cover ${files.length} files`);
