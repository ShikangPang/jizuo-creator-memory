import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { feature, version, harnessVersion } = JSON.parse(readFileSync(resolve(root, 'creator-source.json'), 'utf8'));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/install.mjs [--profile web] [--all] [--local]\nRequires dsh ' + harnessVersion + ', Node 22.19+, pnpm. --local uses pnpm pack outputs.');
  process.exit(0);
}
const profileIndex = args.indexOf('--profile');
const profile = profileIndex < 0 ? 'web' : args[profileIndex + 1];
if (!profile || !/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('Invalid profile name');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--profile') { i++; continue; }
  if (!['--all', '--local'].includes(args[i])) throw new Error('Unknown argument: ' + args[i]);
}
const dsh = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
const check = spawnSync(dsh, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
if (check.status !== 0 || check.stdout.trim() !== harnessVersion) {
  throw new Error('This release requires DeepSeek Harness ' + harnessVersion + '. Install it with: npm install -g @deepseek-ai/dsh@' + harnessVersion);
}
const features = args.includes('--all') ? ['writing', 'video', 'memory'] : [feature];
if (args.includes('--local') && features.length > 1) throw new Error('--local installs this repository only; omit --all.');
const url = (repo, file) => 'https://github.com/ShikangPang/jizuo-creator-' + repo + '/releases/download/v' + version + '/' + file;
const coreName = 'jizuo-plugin-' + version + '.tgz';
const packages = args.includes('--local')
  ? [resolve(root, 'core', coreName), resolve(root, 'jizuo-' + feature + '-plugin-' + version + '.tgz')]
  : [url('writing', coreName), ...features.map(name => url(name, 'jizuo-' + name + '-plugin-' + version + '.tgz'))];
const result = spawnSync(dsh, ['plugin', '--profile', profile, 'add', ...packages], { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
