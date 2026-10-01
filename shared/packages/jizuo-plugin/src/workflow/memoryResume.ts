import type {} from "../message-source.js";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { WorkflowRunService } from "@jizuo/workflow-runtime";

/** Deliberately narrow: questions, quoted instructions and compound edits stay in chat. */
function isMemoryRetry(text: string): boolean {
  return /^(?:请)?(?:继续|重试|重新|恢复)(?:保存(?:本章|章节)?记忆|(?:本章|章节)?记忆(?:保存|存储))(?:吧)?[。！!\s]*$/.test(text.trim());
}

export function registerWorkflowMemoryResume(ctx: Pick<Context, "on">, runs: Pick<WorkflowRunService, "resumeMemory">): () => void {
  return ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const decision = await next();
    const header = agent.session.header as { origin?: string; delegationDepth?: number };
    if (decision.kind !== "enter" || signal.aborted || agent.options.subagentDepth || header.delegationDepth || header.origin === "subagent") return decision;
    const users = messages.filter((message) => message.source.kind === "user");
    if (users.length !== 1 || !decision.messages.some((message) => message.id === users[0]!.id)) return decision;
    const blocks = users[0]!.content;
    if (blocks.some((block) => block.type !== "text")) return decision;
    const text = blocks.map((block) => block.type === "text" ? block.text : "").join("\n");
    if (!isMemoryRetry(text)) return decision;
    let notice: string;
    try {
      const resumed = await runs.resumeMemory(String(agent.session.id), text, undefined, signal);
      if (!resumed) return decision;
      notice = "原章节工作流的记忆步骤已恢复，将核对已保存正文及记忆证据后继续保存；证据无效时才重新提取。正文不会重写，进度沿用原任务。只需告知用户已恢复，不要另行调用记忆保存工具。";
    } catch (error) {
      if (signal.aborted) return decision;
      notice = error instanceof Error && error.name === "WorkflowRunError" ? error.message : "原任务暂时无法恢复，请核对章节工作流状态后再重试；不要绕过原任务直接保存记忆。";
    }
    return { kind: "enter", messages: [...decision.messages, createUserMessage({
      source: { kind: "jizuo-workflow", form: "notice", summary: "章节记忆恢复结果" },
      content: [{ type: "text", text: notice }],
    })] };
  });
}
