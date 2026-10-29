import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const staging = mkdtempSync(path.join(tmpdir(), 'dsh-annotator-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const [packed] = JSON.parse(run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', staging]));
const tarball = path.join(staging, packed.filename);
run('tar', ['-xzf', tarball, '-C', staging]);
const unpacked = path.join(staging, 'package');
const manifest = JSON.parse(readFileSync(path.join(unpacked, 'package.json'), 'utf8'));
const required = ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json', 'README.md', 'README.en.md', 'LICENSE', 'CHANGELOG.md', 'dsh-plugin.naming.json'];
for (const file of required) assert.ok(existsSync(path.join(unpacked, file)), `Missing packaged file: ${file}`);
for (const entry of Object.values(manifest.exports)) {
  if (!entry.includes('*')) assert.ok(existsSync(path.join(unpacked, entry)), `Missing export: ${entry}`);
}
assert.ok(existsSync(path.join(unpacked, manifest.dsh.bundle.patch)));
assert.equal(typeof (await import(pathToFileURL(path.join(unpacked, 'index.js')).href)).apply, 'function');
for (const file of ['client.js', 'index.js', 'cordis.patch.yml']) {
  const text = readFileSync(path.join(unpacked, file), 'utf8');
  assert.doesNotMatch(text, /\/Users\/|\/home\//, `Local user path in ${file}`);
}
run(process.execPath, ['--check', 'client.js'], unpacked);
// Keep tests outside the package's shipped file list, but exercise the unpacked runtime.
cpSync(path.join(root, 'tests'), path.join(unpacked, 'tests'), { recursive: true });
process.stdout.write(run(process.execPath, ['--test', 'tests/delivery.test.mjs'], unpacked));
console.log(`Package smoke passed: ${packed.filename} (${packed.entryCount} files)`);
console.log(`Artifact: ${tarball}`);
