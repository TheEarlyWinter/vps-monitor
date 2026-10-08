#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputArgIndex = process.argv.indexOf('--output');
const outputArg = outputArgIndex >= 0 ? process.argv[outputArgIndex + 1] : null;
const output = path.resolve(root, outputArg || path.join('dist', 'vps-monitor-app'));

if (!fs.existsSync(path.join(root, 'node_modules', '@hana', 'app-sdk', 'package.json'))) {
  throw new Error('Missing @hana/app-sdk. Run npm ci before packaging.');
}
if (!fs.existsSync(path.join(root, 'node_modules', 'ssh2', 'package.json'))) {
  throw new Error('Missing ssh2. Run npm ci before packaging.');
}

const relative = (file) => path.relative(root, file).split(path.sep).join('/');
const isInside = (candidate, parent) => candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
const BUNDLE_EXCLUDED_PATHS = new Set([
  '.github',
  '.gitignore',
  'README.md',
  'scripts',
  'tests',
  'M0阶段实施交付与核验报告.md',
  '工程落地与阶段核验交付报告.md',
  '技术实施规范.md'
]);
const BUNDLE_ROOT_PATHS = new Set(['assets', 'index.js', 'manifest.json', 'runtime', 'src', 'ui', 'node_modules']);
const appPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lockfile = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

function isBundleExcluded(rel) {
  for (const excluded of BUNDLE_EXCLUDED_PATHS) {
    if (rel === excluded || rel.startsWith(`${excluded}/`)) return true;
  }
  return false;
}

function shouldSkip(source) {
  const rel = relative(source);
  if (!rel) return false;
  if (rel === '.git' || rel.startsWith('.git/')) return true;
  if (rel === 'dist' || rel.startsWith('dist/')) return true;
  if (rel === 'node_modules/.cache' || rel.startsWith('node_modules/.cache/')) return true;
  if (isBundleExcluded(rel)) return true;
  if (isInside(source, output)) return true;
  return false;
}

function resolvePackageLockKey(packageName) {
  const directKey = `node_modules/${packageName}`;
  if (lockfile.packages[directKey]) return directKey;
  return Object.keys(lockfile.packages).find(key => key.endsWith(`/${directKey}`)) ?? null;
}

function collectRuntimePackages() {
  const queue = Object.keys(appPackage.dependencies ?? {});
  const packages = new Set();
  while (queue.length > 0) {
    const packageName = queue.shift();
    if (!packageName || packages.has(packageName)) continue;
    const lockKey = resolvePackageLockKey(packageName);
    if (!lockKey) throw new Error(`Missing production dependency in lockfile: ${packageName}`);
    packages.add(packageName);
    const lockEntry = lockfile.packages[lockKey];
    for (const dependency of Object.keys({
      ...(lockEntry.dependencies ?? {}),
      ...(lockEntry.optionalDependencies ?? {})
    })) {
      if (!packages.has(dependency)) queue.push(dependency);
    }
  }
  return packages;
}

function copyDereferenced(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    copyDereferenced(fs.realpathSync(source), destination);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      const child = path.join(source, entry);
      if (!shouldSkip(child)) copyDereferenced(child, path.join(destination, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const entry of BUNDLE_ROOT_PATHS) {
  if (entry === 'node_modules') continue;
  const source = path.join(root, entry);
  if (!fs.existsSync(source)) throw new Error(`Missing app bundle path: ${entry}`);
  copyDereferenced(source, path.join(output, entry));
}

const runtimePackages = collectRuntimePackages();
for (const packageName of runtimePackages) {
  const source = path.join(root, 'node_modules', ...packageName.split('/'));
  if (!fs.existsSync(source)) throw new Error(`Missing installed runtime dependency: ${packageName}`);
  copyDereferenced(source, path.join(output, 'node_modules', ...packageName.split('/')));
}

function assertNoSymlinks(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Package contains a symbolic link: ${full}`);
    if (entry.isDirectory()) assertNoSymlinks(full);
  }
}

assertNoSymlinks(output);
console.log(`Hana App bundle ready: ${output}`);
