import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ChapterDocument, NovelFileFormat, VolumeSummary, WorkSummary } from "@jizuo/contracts";
import { Document, HeadingLevel, Packer, Paragraph } from "docx";

export interface ExportVolume {
  volume: VolumeSummary;
  chapters: ChapterDocument[];
}

export interface ExportResult {
  workId: string;
  format: NovelFileFormat;
  destination: string;
  chapterCount: number;
  byteLength: number;
}

function markdownOf(work: WorkSummary, volumes: ExportVolume[]): string {
  const sections = [`# ${work.title}`];
  for (const { volume, chapters } of volumes) {
    sections.push(`## ${volume.title}`);
    for (const chapter of chapters) sections.push(`### ${chapter.title}\n\n${chapter.content}`);
  }
  return `${sections.join("\n\n")}\n`;
}

function textOf(work: WorkSummary, volumes: ExportVolume[]): string {
  const sections = [work.title];
  for (const { volume, chapters } of volumes) {
    sections.push(volume.title);
    for (const chapter of chapters) sections.push(`${chapter.title}\n\n${chapter.content}`);
  }
  return `${sections.join("\n\n")}\n`;
}

async function docxOf(work: WorkSummary, volumes: ExportVolume[]): Promise<Buffer> {
  const children: Paragraph[] = [new Paragraph({ text: work.title, heading: HeadingLevel.TITLE })];
  for (const { volume, chapters } of volumes) {
    children.push(new Paragraph({ text: volume.title, heading: HeadingLevel.HEADING_1 }));
    for (const chapter of chapters) {
      children.push(new Paragraph({ text: chapter.title, heading: HeadingLevel.HEADING_2 }));
      children.push(...chapter.content.split("\n").map((line) => new Paragraph(line)));
    }
  }
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

export async function exportMaterializedWork(input: {
  work: WorkSummary;
  volumes: ExportVolume[];
  format: NovelFileFormat;
  destination: string;
}): Promise<ExportResult> {
  const destination = resolve(input.destination);
  const content = input.format === "docx"
    ? await docxOf(input.work, input.volumes)
    : Buffer.from(input.format === "markdown"
      ? markdownOf(input.work, input.volumes)
      : textOf(input.work, input.volumes), "utf8");
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.jizuo-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    workId: input.work.id,
    format: input.format,
    destination,
    chapterCount: input.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0),
    byteLength: content.byteLength,
  };
}
