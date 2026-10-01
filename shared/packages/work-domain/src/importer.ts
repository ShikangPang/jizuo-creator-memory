import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import {
  PreviewImportInput,
  type ImportChapterPreview,
  type ImportPreview,
  type NovelFileFormat,
} from "@jizuo/contracts";
import mammoth from "mammoth";

import { sha256Text } from "./revisions.ts";

function isChapterTitle(title: string): boolean {
  return /^第[\d零〇一二三四五六七八九十百千万两]+章(?:$|[\s:：、.．—-])/u.test(title.trim());
}

function splitMarkdown(markdown: string, fallbackTitle: string): ImportChapterPreview[] {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const headings = lines.flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    return match === null ? [] : [{ index, level: match[1]!.length, title: match[2]!.trim() }];
  });
  const chapterHeadings = headings.filter((heading) => isChapterTitle(heading.title));
  if (chapterHeadings.length === 0) {
    const plainChapters = splitText(markdown, fallbackTitle);
    if (plainChapters.some((chapter) => isChapterTitle(chapter.title))) return plainChapters;
  }
  const selected = chapterHeadings.length > 0
    ? chapterHeadings
    : headings.filter((heading) => heading.level === Math.max(...headings.map(({ level }) => level)));
  if (selected.length === 0) {
    return [{ title: fallbackTitle, content: markdown.trim() }];
  }
  return selected.map((heading, index) => {
    const next = selected[index + 1];
    return {
      title: heading.title,
      content: lines.slice(heading.index + 1, next?.index ?? lines.length).join("\n").trim(),
    };
  });
}

function splitText(text: string, fallbackTitle: string): ImportChapterPreview[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const headings = lines.flatMap((line, index) => {
    const title = line.trim();
    return isChapterTitle(title) ? [{ index, title }] : [];
  });
  if (headings.length === 0) return [{ title: fallbackTitle, content: text.trim() }];
  const chapters = headings.map((heading, index) => ({
    title: heading.title,
    content: lines.slice(heading.index + 1, headings[index + 1]?.index ?? lines.length).join("\n").trim(),
  }));
  const preface = lines.slice(0, headings[0]!.index).join("\n").trim();
  return preface === "" ? chapters : [{ title: "前言", content: preface }, ...chapters];
}

function decodeText(source: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    return new TextDecoder("gb18030", { fatal: true }).decode(source);
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

function htmlToMarkdown(html: string): string {
  return html
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/giu, (_match, level: string, content: string) => (
      `\n${"#".repeat(Number(level))} ${decodeHtml(content).trim()}\n`
    ))
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/giu, (_match, content: string) => `\n${decodeHtml(content)}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/giu, (_match, content: string) => `\n- ${decodeHtml(content)}\n`)
    .replace(/<[^>]+>/gu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export async function previewImport(rawInput: { sourcePath: string; format: NovelFileFormat }): Promise<ImportPreview> {
  const input = PreviewImportInput.parse(rawInput);
  const source = await readFile(input.sourcePath);
  const suggestedTitle = basename(input.sourcePath, extname(input.sourcePath));
  let chapters: ImportChapterPreview[];
  const warnings: string[] = [];
  if (input.format === "docx") {
    const converted = await mammoth.convertToHtml({ path: input.sourcePath });
    chapters = splitMarkdown(htmlToMarkdown(converted.value), suggestedTitle);
    warnings.push(...converted.messages.map((message) => message.message));
  } else if (input.format === "markdown") {
    chapters = splitMarkdown(decodeText(source), suggestedTitle);
  } else {
    chapters = splitText(decodeText(source), suggestedTitle);
  }
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const previewHash = sha256Text(JSON.stringify({
    sourcePath: input.sourcePath,
    format: input.format,
    sourceHash,
    chapters,
  }));
  return {
    sourcePath: input.sourcePath,
    format: input.format,
    suggestedTitle,
    sourceHash,
    previewHash,
    chapters,
    warnings,
  };
}
