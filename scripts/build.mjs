import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(readFileSync(resolve(root, 'creator-source.json'), 'utf8'));
const workspace = resolve(root, '.build/workspace');
const run = (args, cwd = workspace) => execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
mkdirSync(workspace, { recursive: true });
// Remove only generated source trees, keeping the dependency cache reusable.
for (const entry of readdirSync(resolve(root, 'shared/packages'), { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
  rmSync(resolve(workspace, 'packages', entry.name, 'src'), { recursive: true, force: true });
}
for (const directory of ['runtime', 'scripts']) rmSync(resolve(workspace, directory), { recursive: true, force: true });
const sourceFile = file => !basename(file).startsWith('._') && basename(file) !== '.DS_Store';
cpSync(resolve(root, 'shared'), workspace, { recursive: true, filter: file => sourceFile(file) && !file.split(/[\\/]/).includes('node_modules') });
const target = resolve(workspace, 'packages', metadata.feature + '-plugin');
rmSync(resolve(target, 'src'), { recursive: true, force: true });
cpSync(resolve(root, 'src'), resolve(target, 'src'), { recursive: true });
for (const file of ['tsconfig.json', 'tsdown.config.ts']) cpSync(resolve(root, 'build', file), resolve(target, file));
const install = ['install', '--frozen-lockfile', '--ignore-scripts'];
if (process.env.JIZUO_BUILD_OFFLINE === '1') install.push('--offline');
run(install);
run(['--filter', '@jizuo/' + metadata.feature + '-plugin', 'typecheck']);
run(['--filter', '@jizuo/plugin', 'typecheck']);
if (process.argv[2] !== 'typecheck') {
  run(['--filter', '@jizuo/' + metadata.feature + '-plugin', 'build']);
  run(['--filter', '@jizuo/plugin', 'build']);
  rmSync(resolve(root, 'lib'), { recursive: true, force: true });
  cpSync(resolve(target, 'lib'), resolve(root, 'lib'), { recursive: true });
  const core = resolve(root, 'core');
  mkdirSync(core, { recursive: true });
  rmSync(resolve(core, 'lib'), { recursive: true, force: true });
  cpSync(resolve(workspace, 'packages/jizuo-plugin/lib'), resolve(core, 'lib'), { recursive: true, filter: path => sourceFile(path) && !path.endsWith('.map') });
  rmSync(resolve(core, 'runtime'), { recursive: true, force: true });
  cpSync(resolve(workspace, 'runtime'), resolve(core, 'runtime'), { recursive: true, filter: sourceFile });
  cpSync(resolve(root, 'LICENSE'), resolve(core, 'LICENSE'));
  cpSync(resolve(root, 'README.md'), resolve(core, 'README.md'));
  for (const directory of [resolve(root, 'lib'), resolve(core, 'lib')]) {
    for (const file of readdirSync(directory).filter(file => sourceFile(file) && file.endsWith('.js'))) {
      const path = resolve(directory, file);
      const text = readFileSync(path, 'utf8').replace(/\/\/#[^\n]*region[^\n]*/g, comment => comment.replaceAll(workspace, '<shared-source>'));
      writeFileSync(path, text);
    }
  }
}
