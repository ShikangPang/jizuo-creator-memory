/** Isolated official-runtime integration check. Never reads or writes the user's DSH_HOME. */
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [runtimeArg, artifactsArg, version = '0.3.1'] = process.argv.slice(2);
if (!runtimeArg || !artifactsArg) throw new Error('Usage: node scripts/creator-public/verify-desktop.mjs OFFICIAL_RUNTIME_DIR CREATOR_REPOSITORIES_DIR [VERSION]');
const runtime = resolve(runtimeArg);
const artifacts = resolve(artifactsArg);
const home = await mkdtemp(join(tmpdir(), 'jizuo-official-plugins-'));
// Polling makes the real HMR watcher reliable in restricted macOS test hosts.
process.env.CHOKIDAR_USEPOLLING ??= 'true';
process.env.DSH_HOME = home;
process.env.DSH_TELEMETRY_DISABLED = '1';
process.env.JIZUO_RUNTIME_VERIFICATION = '0';
for (const name of ['JIZUO_NSPOX_ACCESS_TOKEN', 'JIZUO_NSPOX_REFRESH_TOKEN', 'JIZUO_NSPOX_EXPIRES_AT']) delete process.env[name];
const profileDir = join(home, 'profiles', 'verification');
const modules = join(profileDir, 'node_modules');
let ctx, verificationResult;
const deadline = setTimeout(() => { console.error(`Official runtime verification timed out; temporary profile: ${home}`); process.exit(124); }, 90000);
try {
  await mkdir(join(modules, '@jizuo'), { recursive: true });
  const runtimeManifest = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'));
  assert.equal(runtimeManifest.version, '0.2.0-rc.2');
  // Match desktop resolution: no profile-level @deepseek-ai dependency symlinks.
  await assert.rejects(access(join(modules, '@deepseek-ai')), { code: 'ENOENT' });
  const features = process.env.JIZUO_VERIFY_FEATURES?.split(',') ?? ['writing', 'video', 'memory', 'account', 'media-models'];
  assert.ok(features.length > 0 && new Set(features).size === features.length && features.every(feature => ['writing', 'video', 'memory', 'account', 'media-models'].includes(feature)), 'invalid feature selection');
  const specs = [
    ...features.map((feature) => [`@jizuo/${feature}-plugin`, join(artifacts, `jizuo-creator-${feature}`, `jizuo-${feature}-plugin-${version}.tgz`)]),
  ];
  for (const [name, archive] of specs) {
    const target = join(modules, name);
    await mkdir(target, { recursive: true });
    const unpack = spawnSync('tar', ['-xzf', archive, '--strip-components=1', '-C', target], { encoding: 'utf8' });
    assert.equal(unpack.status, 0, unpack.stderr);
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, version);
    assert.equal(manifest.dependencies?.['@jizuo/plugin'], version);
    assert.ok(manifest.bundledDependencies?.includes('@jizuo/plugin'), 'core must be bundled without a remote subdependency');
    const coreManifest = JSON.parse(await readFile(join(target, 'node_modules/@jizuo/plugin/package.json'), 'utf8'));
    assert.equal(coreManifest.name, '@jizuo/plugin');
    assert.equal(coreManifest.version, version);
  }
  const serviceName = feature => ({account: "jizuoAccount", "media-models": "jizuoMediaModels"}[feature] ?? `jizuo${feature[0].toUpperCase()}${feature.slice(1)}Api`);
  const selected = features.map((feature) => `@jizuo/${feature}-plugin`);
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'jizuo-desktop-verification', private: true, type: 'module', dependencies: Object.fromEntries(specs.filter(([name]) => name !== '@jizuo/plugin').map(([name, archive]) => [name, `file:${archive}`])), dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...selected] } } }, null, 2));
  // All content roots are disposable. No default ~/.jizuo or Documents/Jizuo writes.
  const config = { hostUi: 'native', chapterWorkflowEnabled: false, worksRoot: join(home, 'works'), settingsRoot: join(home, 'settings') };
  await writeFile(join(profileDir, 'cordis.patch.yml'), JSON.stringify([...features.map(feature => ({ id: `jizuo-${feature}-core`, config })), { id: 'webserver', disabled: true }, { id: 'connection', disabled: true }]));
  const rootConfig = join(profileDir, 'cordis.yml');
  await writeFile(rootConfig, '[]\n');
  const boot = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')).href);
  const installAnchor = join(runtime, 'package.json');
  const profile = boot.loadProfileDirectory('dsh', profileDir, installAnchor);
  assert.deepEqual(profile.skippedBundles, []);
  const resolution = await boot.createRuntimeResolution({ installAnchor, profile, home });
  const coreResolutions = resolution.entries.filter(entry => entry.name === '@jizuo/plugin');
  assert.equal(coreResolutions.length, 1, 'official dependency closure must select one shared core');
  assert.ok(coreResolutions[0].packageDir.includes(`${features[0]}-plugin/node_modules/@jizuo/plugin`), 'core must resolve from the first selected feature bundle');
  const profileContext = { name: 'verification', dir: profileDir, patchPath: profile.patchPath, installAnchor, startedBundles: profile.layers.map(layer => layer.packageName), cwd: home, home, overlays: [], telemetryDisabledEnv: '1' };
  const readinessListeners = new Set();
  console.error('[verify] boot');
  ctx = await boot.boot('dsh', rootConfig, boot.readProfilePatches('dsh', profileContext, profile), async host => {
    ctx = host;
    host.provide('profileContext', profileContext);
    host.provide('appReady', { onReady(listener) { readinessListeners.add(listener); return () => readinessListeners.delete(listener); } });
    await host.plugin(boot.PluginPackages, { resolution });
  });
  for (const ready of readinessListeners) ready();
  console.error('[verify] boot ready');
  const manager = ctx.get('pluginManager');
  assert.ok(manager, 'official pluginManager must activate');
  const bundles = await manager.listBundles();
  const actual = bundles.filter(bundle => selected.includes(bundle.name));
  assert.equal(actual.length, features.length);
  for (const bundle of actual) {
    assert.equal(bundle.enabled, true);
    assert.equal(bundle.error, undefined);
    assert.ok(bundle.meta?.title, `${bundle.name}: title missing`);
    assert.ok(bundle.meta?.description, `${bundle.name}: description missing`);
  }
  assert.equal(bundles.some(bundle => bundle.name === '@jizuo/plugin'), false, 'shared dependency must not need a separately installed bundle');
  const graph = ctx.get('clientModules');
  assert.ok(graph, 'official client module graph must activate');
  const factories = new Map();
  const browser = { window: { __ModuleLoader__: { load: record => factories.set(record.id, record.factory) } } };
  runInNewContext(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh-client-modules/lib/client.js'), 'utf8'), browser);
  const clientModules = factories.get('@deepseek-ai/dsh-client-modules')(() => { throw new Error('Unexpected client module dependency'); });
  const parsedBoot = clientModules.parseBootManifest(JSON.parse(JSON.stringify(graph.graph())));
  assert.equal(parsedBoot.plugins.filter(plugin => plugin.id === '@jizuo/plugin').length, 1, 'official browser parser must create a core plugin entry');
  for (const name of selected) assert.ok(parsedBoot.modules.find(module => module.id === name).inject.includes('@jizuo/plugin'), 'feature import must arrange core arrival');
  for (const batch of graph.graph().batches.filter(batch => batch.entries.some(id => id === '@jizuo/plugin' || selected.includes(id)))) {
    const response = await graph.fetchBundle(new Request(new URL(batch.url, 'http://localhost/')));
    assert.equal(response.status, 200);
    runInNewContext(await response.text(), browser);
  }
  for (const name of ['@jizuo/plugin', ...selected]) assert.equal(typeof factories.get(name), 'function', `${name} must register from the actual HTTP batch payload`);
  assert.ok(graph.graph().entries.some(entry => entry.id === '@deepseek-ai/dsh-client-ui-sidebar'), 'native sidebar must remain in the graph');
  for (const name of ['@jizuo/plugin', ...selected]) assert.equal(graph.graph().entries.filter(entry => entry.id === name).length, 1, `${name} must appear once in the client graph`);
  const original = ctx.get('jizuoCreationHost');
  assert.ok(original, 'creation host must activate');
  assert.equal(original.service.isAccountEnabled(), features.includes('account'));
  const skillOwners = {
    'novel-workflow': ['writing'], 'worldbuilding': ['writing'], 'style': ['writing'],
    'novel-video': ['video'], 'novel-memory': ['memory'],
    'creative-prompt': ['video', 'media-models'],
    'h3-prompt-writing': ['video', 'media-models'],
    'minimax-story-visuals': ['video', 'media-models'],
  };
  const verifySkills = async activeFeatures => {
    const skills = ctx.get('skills');
    assert.ok(skills, 'official skill registry must activate');
    const names = (await skills.list({ cwd: home })).map(skill => skill.name);
    for (const [name, owners] of Object.entries(skillOwners)) {
      const expected = owners.some(owner => activeFeatures.includes(owner));
      assert.equal(names.includes(name), expected, `${name}: list visibility must follow its active owners`);
      const skill = await skills.get(name, { cwd: home });
      if (expected) {
        assert.equal(skill?.name, name, `${name}: get must resolve the registered provider`);
        assert.ok(skill.content?.trim(), `${name}: body must be readable`);
      } else assert.equal(skill, undefined, `${name}: disabled skill must not remain callable`);
    }
  };
  await verifySkills(features);
  const toolSchemas = ctx.get('tools').schemas();
  const assertObjectInput = name => {
    const schema = toolSchemas.find(tool => tool.name === name)?.parameters;
    assert.ok(schema?.required?.includes('input'), `${name}: input must be required`);
    assert.equal(schema.properties.input.type, 'object', `${name}: input must publish object shape`);
    return schema.properties.input;
  };
  if (features.includes('video')) {
    const read = assertObjectInput('jizuo_read_video_project');
    assert.equal(read.properties.workId.type, 'string');
    const update = assertObjectInput('jizuo_update_video_episode');
    assert.equal(update.properties.expectedRevision.type, 'integer');
    assert.equal(update.properties.patch.properties.shots.items.properties.durationSec.type, 'number');
  }
  if (features.includes('media-models')) {
    const media = assertObjectInput('jizuo_generate_chat_media');
    assert.equal(media.properties.prompt.type, 'string');
    assert.ok(media.required.includes('prompt'));
    assertObjectInput('jizuo_list_chat_media');
  }
  const service = original.service;
  const novel = await service.createWork({ title: '推广验收小说', projectKind: 'novel' });
  const volume = await service.createVolume({ workId: novel.id, title: '第一卷' });
  const chapter = await service.createChapter({ workId: novel.id, volumeId: volume.id, title: '验收章节' });
  const target = { workId: novel.id, volumeId: volume.id, chapterId: chapter.id };
  const content = '仅用于隔离验收的正文。';
  await service.replaceChapter({ ...target, expectedRevision: chapter.revisionToken, content });
  assert.equal((await service.readChapter(target)).content, content);
  await assert.rejects(service.replaceChapter({ ...target, expectedRevision: chapter.revisionToken, content: '过期覆盖' }), { code: 'revision_conflict' });
  const video = await service.createWork({ title: '推广验收视频', projectKind: 'video' });
  await assert.rejects(service.createVolume({ workId: video.id, title: '错误的卷' }));
  const episodeProject = await service.video.createEpisode({ workId: video.id, title: '第一集', sourceChapters: [{ sourceWorkId: novel.id, volumeId: volume.id, chapterId: chapter.id }] });
  assert.equal(episodeProject.episodes[0].sourceChapters[0].sourceWorkId, novel.id);
  assert.equal((await service.renameWork({ workId: novel.id, title: '验收重命名' })).title, '验收重命名');
  const trash = await service.moveToTrash({ kind: 'work', workId: video.id });
  assert.equal((await service.listWorks()).some(work => work.id === video.id), false);
  assert.equal((await service.readChapter(target)).content, content, 'trashing independent video must preserve its novel source');
  await service.restoreFromTrash({ workId: video.id, trashId: trash.trashId });
  assert.equal((await service.video.read(video.id)).episodes.length, 1);
  assert.equal((await service.readChapter(target)).content, content);
  const dream = await service.dreamHost.report(novel.id);
  assert.notEqual(dream.status.state, 'error', JSON.stringify(dream.status));
  assert.equal(dream.status.lastError, undefined, 'dream worker must load and serve its report without runtime errors');
  console.error('[verify] skills, structured tools, isolated content and dream worker ready');
  const mediaTool = () => ctx.get('tools').get('jizuo_generate_chat_media');
  assert.equal(Boolean(mediaTool()), features.includes('media-models'), 'chat media tools must belong to the media plugin');
  for (let index = 0; index < features.length; index++) {
    console.error('[verify] disable', selected[index]);
    const result = await manager.setBundleEnabled(selected[index], false);
    assert.equal(result.application, 'applied', JSON.stringify(result));
    await ctx.loader.await();
    await verifySkills(features.slice(index + 1));
    assert.ok(graph.graph().entries.some(entry => entry.id === '@deepseek-ai/dsh-client-ui-sidebar'));
    assert.equal(ctx.get(serviceName(features[index])), undefined);
    if (features[index] === 'account') assert.equal(original.service.isAccountEnabled(), false);
    if (features[index] === 'media-models') assert.equal(mediaTool(), undefined);
    if (index < features.length - 1) assert.equal(ctx.get('jizuoCreationHost'), original, 'remaining features must keep the same shared runtime');
    else assert.equal(ctx.get('jizuoCreationHost'), undefined, 'last bundle removal must dispose the shared runtime');
  }
  for (const name of selected) {
    console.error('[verify] enable', name);
    const result = await manager.setBundleEnabled(name, true);
    assert.equal(result.application, 'applied', JSON.stringify(result));
    await ctx.loader.await();
  }
  await verifySkills(features);
  assert.ok(ctx.get('jizuoCreationHost'));
  assert.notEqual(ctx.get('jizuoCreationHost'), original);
  for (const feature of features) assert.ok(ctx.get(serviceName(feature)));
  verificationResult = { result: 'passed', runtime: runtimeManifest.version, node: process.version, version, bundles: actual.map(({ name, meta }) => ({ name, title: meta.title, description: meta.description, hasIcon: Boolean(meta.icon) })), checks: ['official manager metadata', 'official browser manifest consumption', 'HTTP batch factory registration', 'native sidebar retained', 'client module deduplication', 'independent disable', 'shared runtime retention', 'final-owner disposal', 'reenable all', 'skills list/get and owner lifecycle', 'structured media tool input', 'isolated content revision conflict', 'independent video source', 'rename/trash/restore', 'dream worker report', 'awaited disposal and clean temporary profile removal'] };
} finally {
  try { await ctx?.fiber.dispose(); }
  finally {
    clearTimeout(deadline);
    // No retry masks a background write racing disposal (ENOTEMPTY must fail).
    await rm(home, { recursive: true, force: true });
    await assert.rejects(access(home), { code: 'ENOENT' });
  }
}

console.log(JSON.stringify(verificationResult, null, 2));
