import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { apiHelpCatalog } from './api-help.ts';

// The catalog must describe exactly the routes the server registers. The
// hand-maintained list in api-help.test.ts pins the expected shape; this test
// removes the human from the loop by reading the route registrations straight
// out of the source files, so a route added or removed without a matching
// catalog entry fails here instead of drifting quietly.

const SRC = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CALL = /\b(?:app|fastify|server)\.(get|post|put|patch|delete|head|options)\(\s*['"`]([^'"`]+)['"`]/g;
const ROUTE_A = /\.route\(\s*\{[^}]*?method:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`][^}]*?url:\s*['"`]([^'"`]+)['"`]/gs;
const ROUTE_B = /\.route\(\s*\{[^}]*?url:\s*['"`]([^'"`]+)['"`][^}]*?method:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/gs;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { out.push(...sourceFiles(full)); continue; }
    if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function registeredRoutes(): Map<string, string> {
  const routes = new Map<string, string>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(CALL)) routes.set(`${(match[1] ?? '').toUpperCase()} ${match[2] ?? ''}`, file);
    for (const match of text.matchAll(ROUTE_A)) routes.set(`${(match[1] ?? '').toUpperCase()} ${match[2] ?? ''}`, file);
    for (const match of text.matchAll(ROUTE_B)) routes.set(`${(match[2] ?? '').toUpperCase()} ${match[1] ?? ''}`, file);
  }
  return routes;
}

test('every registered route has a catalog entry and every catalog entry is a registered route', () => {
  const registered = registeredRoutes();
  assert.ok(registered.size > 100, `route extraction found only ${registered.size} routes; the regexes no longer match the registration style`);
  const documented = new Set(apiHelpCatalog().endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`));
  const missing = [...registered.keys()].filter((key) => !documented.has(key)).sort();
  const stale = [...documented].filter((key) => !registered.has(key)).sort();
  assert.deepEqual(
    { missing, stale },
    { missing: [], stale: [] },
    `API help drift. Missing from api-help.ts: ${missing.join(', ') || 'none'}. Documented but not registered: ${stale.join(', ') || 'none'}.`,
  );
});

test('catalog entries are unique per method and path', () => {
  const seen = new Set<string>();
  for (const endpoint of apiHelpCatalog().endpoints) {
    const key = `${endpoint.method} ${endpoint.path}`;
    assert.ok(!seen.has(key), `duplicate catalog entry ${key}`);
    seen.add(key);
  }
});
