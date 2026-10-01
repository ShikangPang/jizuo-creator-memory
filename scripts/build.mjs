import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(resolve(root, 'core-source.json'), 'utf8'));
const core = resolve(root, '.build/core');
const run = (cmd, args, cwd = core) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
mkdirSync(resolve(root, '.build'), { recursive: true });
if (!existsSync(resolve(core, '.git'))) {
  run('git', ['clone', '--no-local', '--no-checkout', process.env.JIZUO_CORE_REPOSITORY || config.repository, core], root);
}
run('git', ['checkout', '--detach', config.revision]);
const target = resolve(core, 'packages', config.feature + '-plugin');
// This checkout is disposable; never point it at a user's development checkout.
rmSync(resolve(target, 'src'), { recursive: true, force: true });
cpSync(resolve(root, 'src'), resolve(target, 'src'), { recursive: true });
for (const file of ['tsconfig.json', 'tsdown.config.ts']) cpSync(resolve(root, 'build', file), resolve(target, file));
const install = ['install', '--frozen-lockfile', '--ignore-scripts'];
if (process.env.JIZUO_BUILD_OFFLINE === '1') install.push('--offline');
run('pnpm', install);
run('pnpm', ['--filter', '@jizuo/' + config.feature + '-plugin', 'typecheck']);
if (process.argv[2] !== 'typecheck') {
  run('pnpm', ['--filter', '@jizuo/' + config.feature + '-plugin', 'build']);
  rmSync(resolve(root, 'lib'), { recursive: true, force: true });
  cpSync(resolve(target, 'lib'), resolve(root, 'lib'), { recursive: true });
}
