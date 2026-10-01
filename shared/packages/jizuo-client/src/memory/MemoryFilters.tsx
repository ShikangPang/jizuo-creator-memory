import { IconButton } from "../ui/IconButton.tsx";
import type { MemoryQueryInput } from "@jizuo/memory-domain";

export type MemoryFilterDraft = Omit<MemoryQueryInput, "workId">;

export function MemoryFilters({
  value,
  loading,
  onChange,
  onSubmit,
}: {
  value: MemoryFilterDraft;
  loading: boolean;
  onChange: (value: MemoryFilterDraft) => void;
  onSubmit: () => void;
}) {
  const setNumber = (field: "chapter" | "from" | "to", raw: string) => {
    const number = Number(raw);
    onChange({ ...value, [field]: Number.isInteger(number) && number > 0 ? number : undefined });
  };
  return (
    <form
      className="jz-memory-filters"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label>
        <span>查询模式</span>
        <select
          aria-label="查询模式"
          value={value.mode}
          onChange={(event) => { onChange({ ...value, mode: event.target.value as MemoryFilterDraft["mode"] }); }}
        >
          <option value="chapter">单章</option>
          <option value="range_strict">严格范围</option>
          <option value="range_with_prior">范围并带入前情</option>
          <option value="current">当前状态</option>
          <option value="entity_timeline">身份全过程</option>
          <option value="multi_entity_relationships">多身份关系</option>
        </select>
      </label>
      <label>
        <span>当前章节</span>
        <input aria-label="当前章节" type="number" min="1" value={value.chapter ?? ""} onChange={(event) => { setNumber("chapter", event.target.value); }} />
      </label>
      <label>
        <span>开始章节</span>
        <input aria-label="开始章节" type="number" min="1" value={value.from ?? ""} onChange={(event) => { setNumber("from", event.target.value); }} />
      </label>
      <label>
        <span>结束章节</span>
        <input aria-label="结束章节" type="number" min="1" value={value.to ?? ""} onChange={(event) => { setNumber("to", event.target.value); }} />
      </label>
      <label className="jz-memory-identities">
        <span>Identity IDs</span>
        <input
          aria-label="身份 ID 列表"
          value={value.identities?.join(", ") ?? ""}
          onChange={(event) => {
            onChange({
              ...value,
              identities: event.target.value.split(",").map((item) => item.trim()).filter(Boolean),
            });
          }}
        />
      </label>
      <IconButton icon="search" label={"查询记忆"} type="submit" disabled={loading} />
    </form>
  );
}
