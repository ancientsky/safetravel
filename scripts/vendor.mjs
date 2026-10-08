// Copies browser bundles from node_modules into web/vendor (no CDN at runtime).
import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('web/vendor', { recursive: true });
copyFileSync('node_modules/d3/dist/d3.min.js', 'web/vendor/d3.min.js');
copyFileSync('node_modules/topojson-client/dist/topojson-client.min.js', 'web/vendor/topojson-client.min.js');
console.log('vendored d3 + topojson-client');
