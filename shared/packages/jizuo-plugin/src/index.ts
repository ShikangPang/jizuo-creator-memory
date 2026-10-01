import { ChatMediaService } from "./video/chat-media-service.ts";
import { registerChatMediaTools, type ChatAttachmentReader } from "./video/chat-media-tools.ts";
import { NspoxMediaClient, NSPOX_MEDIA_REF_PREFIX } from "./video/nspox-media.ts";
import { DreamProcessHost } from "./dream-process-host.ts";
import { DreamModelCatalog } from "./dream-model-catalog.ts";
import type { Context } from "@deepseek-ai/cordis";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, parse } from "node:path";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import type {} from "@deepseek-ai/dsh-subagent";
import type {} from "@deepseek-ai/dsh-tools";
import { AccountGateway } from "@jizuo/account-domain";
import {
  BUILT_IN_WORKFLOW_DEFINITION,
  DEFAULT_WORKFLOW_DEFINITION,
  createConditionResolvers,
  createWorkflowRuntimeRegistries,
  defaultWorkflowRegistry,
  sha256,
  WorkflowDefinitionLoader,
  type WorkflowDefinition,
  type WorkflowTranscriptPort,
} from "@jizuo/workflow-runtime";

import { Config, type Config as ConfigShape } from "./config.ts";
import { VideoProductionService } from "./video/production.ts";
import { VideoEditingService, loadVideoMediaMetadata } from "./video/editing-service.ts";
import { normalizeImageReference } from "./video/renderer.ts";
import { VideoSpeechService } from "./video/speech.ts";
import { SpeechSettingsRepository } from "./video/speech-settings.ts";
import { VideoBatchGenerationService } from "./video/batch.ts";
import { LocalVideoAssets } from "./video/assets.ts";
import { VideoMediaService } from "./video/media-service.ts";
import { VideoGenerationService } from "./video/generation.ts";
import { VideoAuthoringService } from "./video/authoring.ts";
import { createVideoTextGenerator } from "./video/text-model.ts";
import { MediaLibraryService } from "./video/media-library.ts";
import { HarnessNativeMediaProviders } from "./video/native-providers.ts";
import { MediaSettingsRepository } from "./video/settings.ts";
import { JizuoService } from "./service.ts";
import { JizuoRemoteService } from "./remote-service.ts";
import { HarnessModelOutputSettings } from "./model-output-settings.ts";
import { upgradeBuiltinWorkflowSkills } from "./skills.ts";
import { type ToolsContext } from "./tools.ts";
import { JizuoDomainNodeAdapter } from "./workflow/domainAdapter.ts";
import { createJizuoDomainNodeRegistry } from "./workflow/domainRegistry.ts";
import { HarnessAgentAdapter, createHarnessAgentWorkerRegistry } from "./workflow/agentAdapter.ts";
import { createChapterWorkflowNodeExecutors, resolveCandidateContentFromArtifact } from "./workflow/nodeExecutors.ts";
import { createJizuoWorkflowRuntimeHost } from "./workflow/runtimeHost.ts";
import { registerWorkflowMemoryResume } from "./workflow/memoryResume.ts";
import { createWorkflowAgentConversationPublisher, createWorkflowConversationDelivery, createWorkflowTranscriptPublisher, repairWorkflowConversation } from "./workflow/transcript.ts";
import type { WorkflowConversationDelivery } from "./workflow/conversationDelivery.ts";
import type { Session, SessionStore } from "@deepseek-ai/dsh-session";
import {
  HarnessAccountTokenVault,
  HarnessHostedModelRuntime,
} from "./nspox-runtime.ts";

export {
  WorkflowDefinitionSchema,
  WorkflowHarnessManifest,
  BUILT_IN_WORKFLOW_DEFINITION,
  DEFAULT_WORKFLOW_DEFINITION,
  createConditionResolvers,
  createWorkflowRuntimeRegistries,
  defaultWorkflowRegistry,
  sha256,
  validateWorkflowDefinition,
} from "@jizuo/workflow-runtime";

export const name = "jizuo-plugin";
export { Config };
export type { ConfigShape as JizuoPluginConfig };
export * from "./credentials.ts";
export * from "./skills.ts";
export * from "./nspox-runtime.ts";
export * from "./workflow/domainAdapter.ts";
export * from "./workflow/domainRegistry.ts";
export * from "./workflow/agentAdapter.ts";
export * from "./workflow/agentRegistry.ts";
export * from "./workflow/contextBuilder.ts";
export * from "./workflow/nodeExecutors.ts";
export * from "./workflow/runtimeHost.ts";
export * from "./workflow/transcript.ts";
export * from "./workflow/writeCapability.ts";

/** Worker adapter dependencies are explicit so missing live parent sessions park safely. */
export const inject = ["credentials", "settings", "llm", "agentDefaultModel", "agents", "subagents", "sessions"];

export async function apply(ctx: Context, config: ConfigShape): Promise<void> {
  // Ordinary chat loads skills without starting a chapter workflow. Finish the
  // byte-checked upgrade before registering services that can accept a chat.
  await upgradeBuiltinWorkflowSkills(resolveWorkflowResourceRoot(), config.settingsRoot);
  const vault = new HarnessAccountTokenVault({
    resolve: async (ref) => ctx.credentials.resolve(credentialRef(ref)),
    set: async (ref, value) => ctx.credentials.set(credentialRef(ref), value),
    unset: async (ref) => ctx.credentials.unset(credentialRef(ref)),
  });
  const hostedModels = new HarnessHostedModelRuntime({
    get: (namespace) => ctx.settings.describe().find((entry) => entry.ns === namespace)?.value,
    snapshot: (namespace) => {
      const descriptor = ctx.settings.describe().find((entry) => entry.ns === namespace);
      return descriptor && { value: descriptor.value, revision: descriptor.revision };
    },
    mutate: async (namespace, operations, revision) => ctx.settings.mutate(
      namespace,
      operations,
      revision,
    ),
  }, ctx.agentDefaultModel);
  const service = new JizuoService({
    worksRoot: config.worksRoot,
    settingsRoot: config.settingsRoot,
    protectedWorkRoots: [resolveWorkflowResourceRoot()],
    accountGateway: new AccountGateway({ vault }),
    hostedModels,
  });
  const nspoxMedia = new NspoxMediaClient(vault);
  service.mediaSettings = new MediaSettingsRepository(config.settingsRoot, {
    resolve: async (ref) => ref.startsWith(NSPOX_MEDIA_REF_PREFIX) ? nspoxMedia.resolveCredential(ref) : (await ctx.credentials.resolve(credentialRef(ref)))?.value,
    set: async (ref, value) => ctx.credentials.set(credentialRef(ref), value),
  }, nspoxMedia);
  service.mediaLibrary = new MediaLibraryService(service.mediaSettings, {native: new HarnessNativeMediaProviders(ctx.llm, ctx.settings, ctx.credentials)});
  service.videoAuthoring = new VideoAuthoringService(service, createVideoTextGenerator({
    selection: () => ctx.agentDefaultModel.currentSelection(), stream: (input) => ctx.llm.stream(input),
  }));
  const videoAssets = new LocalVideoAssets((workId) => service.resolveMediaPath(workId), async (workId, assetId) => (await service.video.read(workId)).assets.find(asset => asset.id === assetId));
  const videoGeneration = new VideoGenerationService({ repository: service.video, settings: service.mediaSettings, assets: videoAssets, hostReference: (ref, bytes, mimeType) => nspoxMedia.uploadReference(ref, bytes, mimeType), normalizeReference: normalizeImageReference });
  service.videoAssets = videoAssets;
  service.videoMedia = new VideoMediaService(service.video, videoAssets, loadVideoMediaMetadata);
  service.videoGeneration = videoGeneration;
  service.chatMedia = new ChatMediaService(service);
  service.videoBatch = new VideoBatchGenerationService({ repository: service.video, generation: videoGeneration });
  const videoEditing = new VideoEditingService(service.video, videoAssets);
  const speechSettings = new SpeechSettingsRepository(config.settingsRoot, {
    resolve: async ref => (await ctx.credentials.resolve(credentialRef(ref)))?.value,
    set: async (ref, value) => ctx.credentials.set(credentialRef(ref), value),
  });
  const videoSpeech = new VideoSpeechService({ repository: service.video, settings: speechSettings, assets: videoAssets });
  service.videoEditing = videoEditing; service.speechSettings = speechSettings; service.videoSpeech = videoSpeech;
  const videoProduction = new VideoProductionService({ repository: service.video, authoring: service.videoAuthoring, generation: videoGeneration, editing: videoEditing });
  service.videoProduction = videoProduction;
  ctx.effect(() => {
    let closed = false;
    void service.listWorks().then(async works => {
      const ids = [...new Set([...works.map(work=>work.id), ...await service.chatMediaRepository.listRecoverySpaces()])];
      for (const id of ids) {
        if (closed) break;
        await service.video.read(id).then(async project => {
          const owners = new Set(project.jobs.map(job => job.state?.sourceSessionId)
            .filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 128));
          await Promise.allSettled([...owners].map(owner => service.chatMediaRepository.remember(owner, id)));
        }).catch(() => undefined);
        await Promise.allSettled([videoGeneration.recover(id), videoEditing.recover(id), videoSpeech.recover(id)]);
        if (!closed) await videoProduction.recover(id).catch(() => undefined);
      }
    }).catch(() => undefined);
    return async () => { closed = true; await videoProduction.close(); await Promise.all([videoGeneration.close(), videoEditing.close(), videoSpeech.close()]); await videoAssets.close(); };
  }, "jizuo-video-media");
  const domainAdapter = new JizuoDomainNodeAdapter(service);
  service.setWorkflowDomainRegistry(createJizuoDomainNodeRegistry(domainAdapter));
  const workflow = config.chapterWorkflowEnabled ? createEnabledWorkflowHost(ctx, config, service, domainAdapter) : undefined;
  if (workflow) {
    registerWorkflowHostLifecycle(ctx, workflow);
    Object.assign(service, { workflowRuns: workflow.runs });
  }
  const dreamModels = new DreamModelCatalog(ctx.llm);
  const dream = new DreamProcessHost(service, dreamModels, { worksRoot: config.worksRoot, settingsRoot: config.settingsRoot,
    getBusyChapterIds: (workId) => workflow?.runs.getActiveChapterIds(workId) ?? new Set() });
  service.dreamHost = dream;
  ctx.effect(() => { dream.start(); return () => dream.close(); }, "jizuo-dream-memory");
  const remoteService = new JizuoRemoteService(ctx, service, workflow?.runs, new HarnessModelOutputSettings(ctx.llm, ctx.settings), dreamModels);
  ctx.inject(["tools"], (toolsContext) => {
    registerChatMediaTools(toolsContext as unknown as ToolsContext, service.chatMedia!, () => ctx.get("attachments") as ChatAttachmentReader | undefined);
  });
  ctx.provide("jizuoCreationHost", { service, apis: remoteService.creationApis, workflowChapterWrites: workflow?.workflowChapterWrites });
  registerRuntimeCapabilityProbe(ctx, { workflowEnabled: workflow !== undefined });
}

const FIBER_STATES = ["pending", "loading", "active", "failed", "disposed", "unloading"] as const;

type RuntimeCapabilityProbeContext = Readonly<{
  loader: {
    await(): Promise<void>;
    entries(): Iterable<{
      id: string;
      options: { group?: boolean | null; name: string };
      fiber?: { state?: number };
    }>;
  };
  tools: {
    schemas(): Array<{ name: string; parameters: unknown }>;
  };
  agentPresets: {
    list(): Promise<Array<{ id: string }>>;
  };
  clientModules: {
    graph(): { entries: Array<{ id: string }> };
  };
  llm: {
    listProviders(): Array<{ id: string }>;
  };
}> & Record<string, unknown>;

type RuntimeCapabilityProbeInjector = Readonly<{
  inject(
    dependencies: readonly string[],
    callback: (context: RuntimeCapabilityProbeContext) => void | (() => void),
  ): void;
}>;

async function directoryIds(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function fileIds(root: string, extension: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => parse(entry.name).name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function workflowIds(root: string): Promise<string[]> {
  const files = await fileIds(root, ".json");
  return Promise.all(files.map(async (name) => {
    const contents = JSON.parse(await readFile(join(root, `${name}.json`), "utf8")) as { id?: unknown };
    return typeof contents.id === "string" && contents.id.trim() !== "" ? contents.id : name;
  }));
}

async function writeCapabilitySnapshot(path: string, value: unknown): Promise<void> {
  if (!isAbsolute(path)) throw new Error("JIZUO_RUNTIME_CAPABILITY_SNAPSHOT_PATH must be absolute");
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

/** Build-verification-only inventory; ordinary application startup never registers it. */
export function registerRuntimeCapabilityProbe(
  ctx: Context,
  options: Readonly<{ workflowEnabled: boolean }>,
): void {
  const outputPath = process.env.JIZUO_RUNTIME_CAPABILITY_SNAPSHOT_PATH?.trim();
  if (process.env.JIZUO_RUNTIME_VERIFICATION !== "1" || !outputPath) return;
  (ctx as unknown as RuntimeCapabilityProbeInjector).inject(
    ["loader", "tools", "clientModules", "agentPresets"],
    (probeContext) => {
      let cancelled = false;
      queueMicrotask(() => {
        void (async () => {
          await probeContext.loader.await();
          if (cancelled) return;
          const runtimeRoot = resolveWorkflowResourceRoot();
          const plugins = [...probeContext.loader.entries()]
            .filter((entry) => !entry.options.group)
            .map((entry) => ({
              id: entry.options.name,
              status: FIBER_STATES[entry.fiber?.state ?? 0] ?? "unknown",
            }));
          const tools = probeContext.tools.schemas().map((schema) => ({
            name: schema.name,
            schema: schema.parameters,
          }));
          const clientModules = probeContext.clientModules.graph().entries.map((entry) => entry.id);
          const snapshot = {
            plugins,
            tools,
            clientModules,
            agentPresets: (await probeContext.agentPresets.list()).map((preset) => preset.id).sort(),
            skills: await directoryIds(join(runtimeRoot, "skills")),
            teams: await fileIds(join(runtimeRoot, "teams"), ".yaml"),
            workflows: await workflowIds(join(runtimeRoot, "workflows")),
            modelProviders: probeContext.llm.listProviders().map((provider) => provider.id),
            services: [
              "jizuo-domain",
              ...(options.workflowEnabled ? ["jizuo-workflow-runtime"] : []),
              ...(["loader", "tools", "clientModules", "llm", "settings", "credentials"] as const)
                .filter((name) => Boolean(probeContext[name])),
            ],
          };
          await writeCapabilitySnapshot(outputPath, snapshot);
          process.stdout.write(`[jizuo] runtime capability snapshot ready\n`);
        })().catch((error: unknown) => {
          process.stderr.write(`[jizuo] runtime capability snapshot failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
          process.exitCode = 1;
        });
      });
      return () => { cancelled = true; };
    },
  );
}

/** Attach the workflow host to the owning Cordis plugin fiber. */
export function registerWorkflowHostLifecycle(
  ctx: Pick<Context, "effect">,
  workflow: Readonly<{ close(): void }>,
): void {
  try {
    ctx.effect(() => () => workflow.close(), "jizuo-workflow-runtime");
  } catch (error) {
    workflow.close();
    throw error;
  }
}

/** Startup-only, closed scheduler composition; exported for host-level integration coverage. */
export function createEnabledWorkflowHost(
  ctx: Context,
  config: ConfigShape,
  service: JizuoService,
  domain: JizuoDomainNodeAdapter,
  defaultDefinition: WorkflowDefinition = DEFAULT_WORKFLOW_DEFINITION,
) {
  const runtimeRoot = resolveWorkflowResourceRoot();
  let skillsReady: Promise<void> | undefined;
  const prepareSkills = () => skillsReady ??= upgradeBuiltinWorkflowSkills(runtimeRoot, config.settingsRoot);
  const resources = { read: async (resourcePath: string) => {
    await prepareSkills();
    return readFile(join(runtimeRoot, resourcePath.replace(/^runtime\//, "")), "utf8");
  } };
  const workers = createHarnessAgentWorkerRegistry(resources);
  const definitionLoader = new WorkflowDefinitionLoader({ settingsRoot: config.settingsRoot });
  let repairParent = (_session: Session): void => {};
  let delivery: WorkflowConversationDelivery | undefined;
  let transcript: WorkflowTranscriptPort | undefined;
  let detachConversation: (() => void) | undefined;
  let host: ReturnType<typeof createJizuoWorkflowRuntimeHost>;
  try { host = createJizuoWorkflowRuntimeHost({
    databasePath: join(config.settingsRoot, "workflow-runtime.sqlite"),
    service,
    frozen: {
      workflowId: defaultDefinition.id,
      workflowVersion: defaultDefinition.version,
      definitionHash: sha256(defaultDefinition),
      definitionContents: JSON.stringify(defaultDefinition),
      revisionBudget: 5,
    },
    definitionProvider: async ({ target, userRequest }) => {
      await prepareSkills();
      const { path: workRoot } = await service.resolveWorkPath(target.workId);
      const loaded = await definitionLoader.load({ workRoot, workflowId: defaultDefinition.id, target, userRequest });
      return {
        workflowId: loaded.workflowId,
        workflowVersion: loaded.version,
        definitionHash: loaded.definitionHash,
        definitionContents: JSON.stringify(loaded.definition),
        revisionBudget: loaded.initialBudget.maxRevisionRounds,
      };
    },
    parents: {
      hasParentSession: (sessionId) => {
        const parent = ctx.agents.get(sessionId as never);
        if (parent) repairParent(parent.session);
        return Boolean(parent);
      },
      onAgentCreated: (listener) => ctx.on?.("agent/created", ({ agent }) => {
        repairParent(agent.session);
        listener(String(agent.session.id));
        return undefined;
      }),
    },
    transcript: { publishesLiveModelOutput: true, publish: (entry) => transcript?.publish(entry), publishTool: (entry) => transcript?.publishTool?.(entry) },
    createRegistries: ({ artifacts, repository, workflowChapterWrites }) => {
      // Client and host Context declarations share this build; this composition
      // runs on the host and uses the installed SessionStore durability API.
      const sessions = (ctx as unknown as { sessions?: Pick<SessionStore, "flush"> }).sessions;
      const publications = createWorkflowConversationDelivery({ repository,
        ...(typeof sessions?.flush === "function" ? { flush: (session: Session) => sessions.flush(session) } : {}),
      });
      delivery = publications;
      transcript = createWorkflowTranscriptPublisher({ get: (sessionId) => ctx.agents.get(sessionId as never)?.session }, publications);
      detachConversation = ctx.on?.("session/event", (session, event) => {
        if (event.type === "step/end" || event.type === "turn/end" || event.type === "tool/result") void publications.drain(session);
      });
      repairParent = (session) => {
        const owner = repository.listRuns({ sessionId: String(session.id) })[0];
        if (owner) {
          repairWorkflowConversation(session, owner.sessionId, publications, owner.runId);
          void publications.drain(session);
        }
      };
      for (const agent of ctx.agents.list?.() ?? []) repairParent(agent.session);
      const runner = new HarnessAgentAdapter(
        { agents: ctx.agents, subagents: ctx.subagents },
        workers,
        defaultWorkflowRegistry,
        createWorkflowAgentConversationPublisher(publications),
        workflowChapterWrites,
      );
      const executors = createChapterWorkflowNodeExecutors({
        domain, agents: runner, artifacts, workflow: defaultWorkflowRegistry, modelResults: repository,
      });
      const resolveCandidateContent = (candidate: { artifactRef: string; sha256: string }) => resolveCandidateContentFromArtifact(artifacts, candidate);
      return createWorkflowRuntimeRegistries(
        defaultWorkflowRegistry,
        executors,
        createConditionResolvers(defaultWorkflowRegistry, { resolveCandidateContent }),
        resolveCandidateContent,
      );
    },
  }); } catch (error) { detachConversation?.(); delivery?.dispose(); throw error; }
  let detachMemoryResume: (() => void) | undefined;
  try { detachMemoryResume = registerWorkflowMemoryResume(ctx, host.runs); }
  catch (error) { detachConversation?.(); delivery?.dispose(); host.close(); throw error; }
  return Object.freeze({ ...host, close: () => { detachMemoryResume?.(); detachConversation?.(); delivery?.dispose(); host.close(); } });
}

/** Mutable DSH_HOME stores user state; frozen workers always come from the app bundle. */
export function resolveWorkflowResourceRoot(): string {
  const bundled = process.env.JIZUO_RUNTIME_ROOT?.trim();
  if (bundled) return bundled;
  const installed = fileURLToPath(new URL("../runtime", import.meta.url));
  return existsSync(installed) ? installed : fileURLToPath(new URL("../../../runtime", import.meta.url));
}
