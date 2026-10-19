// Builds / copies browser bundles from node_modules into web/vendor (no CDN at runtime).
// d3 is bundled down to the functions listed in scripts/d3-entry.mjs (the full build is ~75% unused).
import { copyFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

mkdirSync('web/vendor', { recursive: true });
await build({
  entryPoints: ['scripts/d3-entry.mjs'],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'd3',
  target: 'es2019',
  legalComments: 'none',
  banner: { js: '// d3 v7.9.0 (subset: scripts/d3-entry.mjs) https://d3js.org Copyright 2010-2023 Mike Bostock, ISC license' },
  outfile: 'web/vendor/d3.min.js',
});
copyFileSync('node_modules/topojson-client/dist/topojson-client.min.js', 'web/vendor/topojson-client.min.js');
console.log('vendored d3 (subset) + topojson-client');
