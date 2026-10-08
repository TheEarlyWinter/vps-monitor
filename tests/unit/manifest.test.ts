import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

test('manifest: valid JSON and version aligns with package.json', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const manifestRaw = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  const pkgRaw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgRaw);

  assert.equal(manifest.id, 'vps-monitor');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.manifestVersion, 2);
});
