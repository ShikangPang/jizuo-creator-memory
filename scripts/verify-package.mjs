import assert from 'node:assert/strict';
import { SourceTextModule } from 'node:vm';
import { readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const archive = join(root, `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`);
const listing = spawnSync('tar', ['-tzf', archive], {encoding: 'utf8'});
assert.equal(listing.status, 0, listing.stderr);
assert.ok(!listing.stdout.split('\n').some(path => /(^|\/)(\.build|\.git|\.DS_Store|\.env|\._[^/]*)(\/|$)/.test(path)), 'archive contains private/build files');
const directory = mkdtempSync(join(tmpdir(), 'jizuo-package-check-'));
try {
  const unpack = spawnSync('tar', ['-xzf', archive, '-C', directory], {encoding: 'utf8'});
  assert.equal(unpack.status, 0, unpack.stderr);
  const packageRoot = join(directory, 'package');
  const core = join(packageRoot, 'node_modules/@jizuo/plugin');
  assert.equal(JSON.parse(readFileSync(join(core, 'package.json'), 'utf8')).version, pkg.version);
  const worker = readFileSync(join(core, 'lib/dream-worker.js'), 'utf8');
  const imports = new SourceTextModule(worker).dependencySpecifiers;
  assert.ok(imports.length > 0 && imports.every(name => name.startsWith('node:')), 'worker must run without the Desktop resolver');
  for (const name of ['novel-workflow', 'novel-video', 'novel-memory', 'creative-prompt']) assert.ok(readFileSync(join(core, 'runtime/skills', name, 'SKILL.md'), 'utf8').includes(`name: ${name}`));
  assert.ok(readdirSync(join(core, 'lib')).includes('client.js'));
  console.log(JSON.stringify({result: 'passed', name: pkg.name, version: pkg.version, sha256: createHash('sha256').update(readFileSync(archive)).digest('hex')}, null, 2));
} finally { rmSync(directory, {recursive: true, force: true}); }
