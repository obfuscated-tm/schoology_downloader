// node --test "test/**/*.test.js"   (from schoology_archiver_extension/)
//
// overlays/boot.js imports the overlays into Schoology pages with
// import(chrome.runtime.getURL(…)). Chrome only serves a module there if the
// manifest lists it in web_accessible_resources, and one missing file fails
// the whole import chain: every overlay silently stops showing. So every
// module an overlay reaches, however indirectly, must be listed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT_RE = /(?:import|export)\s[^;]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function reachable(start) {
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = readFileSync(join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) walk(normalize(join(dirname(rel), m[1] || m[2])));
  };
  start.forEach(walk);
  return seen;
}

test('every module an overlay imports is web-accessible', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const listed = new Set(manifest.web_accessible_resources.flatMap((w) => w.resources));
  const overlays = readdirSync(join(ROOT, 'overlays')).filter((f) => f.endsWith('.js') && !f.startsWith('theme-early') && f !== 'boot.js').map((f) => `overlays/${f}`);
  const missing = [...reachable(overlays)].filter((f) => !listed.has(f));
  assert.deepEqual(missing, []);
});
