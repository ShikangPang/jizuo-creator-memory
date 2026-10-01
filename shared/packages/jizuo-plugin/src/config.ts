import { homedir } from "node:os";
import { join } from "node:path";

import Schema from "@deepseek-ai/schemastery";

export interface Config {
  worksRoot: string;
  settingsRoot: string;
  /** Local emergency opt-out for the durable chapter scheduler. */
  chapterWorkflowEnabled: boolean;
}

export function defaultWorksRoot(): string {
  return join(homedir(), "Documents", "Jizuo", "works");
}

export function defaultSettingsRoot(): string {
  return join(homedir(), ".jizuo");
}

export const Config: Schema<Config> = Schema.object({
  worksRoot: Schema.string().default(defaultWorksRoot()).description("即作作品目录"),
  settingsRoot: Schema.string().default(defaultSettingsRoot()).description("即作配置目录"),
  chapterWorkflowEnabled: Schema.boolean().default(true).description("启用耐久章节生产工作流（紧急本地关闭开关）"),
});
