import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JizuoError } from "@jizuo/contracts";
import { SaveSpeechSettingsInput, SpeechSettings, type SpeechSettingsView } from "../../../contracts/src/video-speech.ts";
import type { MediaCredentialVault } from "./settings.ts";

/** OpenAI-compatible speech configuration is separate from image/video provider credentials. */
export class SpeechSettingsRepository {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string, readonly vault: MediaCredentialVault) {}

  async read(): Promise<SpeechSettings> {
    try { return SpeechSettings.parse(JSON.parse(await readFile(join(this.root, "speech-settings.json"), "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { revision: 0, speech: null };
      throw new JizuoError("validation_error", "语音模型配置读取失败，请检查配置文件");
    }
  }
  async get(): Promise<SpeechSettingsView> {
    const settings = await this.read();
    return { settings, keyConfigured: settings.speech !== null && Boolean(await this.vault.resolve(settings.speech.credentialRef)) };
  }
  save(raw: SaveSpeechSettingsInput): Promise<SpeechSettingsView> {
    const input = SaveSpeechSettingsInput.parse(raw);
    const operation = this.tail.catch(() => undefined).then(async () => {
      const previous = await this.read();
      if (previous.revision !== input.expectedRevision) throw new JizuoError("revision_conflict", "语音模型配置已变化，请刷新后保存");
      const next = SpeechSettings.parse({ revision: previous.revision + 1, speech: input.speech });
      if (next.speech) {
        const old = previous.speech;
        next.speech.credentialRef = old && new URL(old.baseUrl).origin === new URL(next.speech.baseUrl).origin
          ? old.credentialRef : `jizuo_speech_${randomUUID().replaceAll("-", "")}`;
        const key = input.apiKey?.trim();
        if (key) {
          if (/[\r\n]/.test(key)) throw new JizuoError("validation_error", "语音 API Key 不能包含换行");
          next.speech.credentialRef = `jizuo_speech_${randomUUID().replaceAll("-", "")}`;
          await this.vault.set(next.speech.credentialRef, key);
        }
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = join(this.root, `.speech-settings-${randomUUID()}.json`);
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: "wx" });
        await rename(temporary, join(this.root, "speech-settings.json"));
      } finally { await rm(temporary, { force: true }); }
      return this.get();
    });
    this.tail = operation; return operation;
  }
}
