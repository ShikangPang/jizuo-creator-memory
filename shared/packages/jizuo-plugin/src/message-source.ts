import type { ContextFormed } from "@deepseek-ai/dsh-llm/message";

/** Producer identities persisted in Harness V4 messages. */
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "jizuo-dream": { kind: "jizuo-dream" } & ContextFormed;
    "jizuo-video": { kind: "jizuo-video" } & ContextFormed;
    "jizuo-workflow": { kind: "jizuo-workflow" } & ContextFormed;
  }
}
