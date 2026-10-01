import { ChapterMemoryOutputSchema, ChapterMemoryOutputSchemaV2 } from "@jizuo/workflow-runtime";

export class MemoryExtractionEvidenceInvalid extends Error {
  readonly code = "memory_evidence_invalid";

  constructor(readonly factNumbers: readonly number[]) {
    super(`第 ${factNumbers.join("、")} 条记忆证据不是正文中的连续原文。正文已保留，可在对话中输入“继续保存记忆”重新提取。`);
    this.name = "MemoryExtractionEvidenceInvalid";
  }
}

/** Only presentation wrappers may be removed, and only with exact source proof. */
function groundEvidence<T extends { facts: readonly { evidence: string }[] }>(body: string, extracted: T): T {
  const invalid: number[] = [];
  const wrappers = [["「", "」"], ["『", "』"], ["“", "”"], ["\"", "\""], ["‘", "’"], ["'", "'"], ["`", "`"]] as const;
  const facts = extracted.facts.map((fact, index) => {
    if (body.includes(fact.evidence)) return fact;
    for (const [open, close] of wrappers) {
      if (!fact.evidence.startsWith(open) || !fact.evidence.endsWith(close)) continue;
      const unwrapped = fact.evidence.slice(open.length, -close.length).trim();
      if (unwrapped && body.includes(unwrapped)) return { ...fact, evidence: unwrapped };
    }
    invalid.push(index + 1);
    return fact;
  });
  if (invalid.length) throw new MemoryExtractionEvidenceInvalid(invalid);
  return { ...extracted, facts };
}

export function groundMemoryEvidence(body: string, output: unknown) {
  return groundEvidence(body, ChapterMemoryOutputSchema.parse(output));
}

export function groundTypedMemoryEvidence(body: string, output: unknown) {
  return groundEvidence(body, ChapterMemoryOutputSchemaV2.parse(output));
}
