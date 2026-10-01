interface Observable<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
interface Block { readonly reason: string }

/** The native block contract has no source id; match its owning dictionary and routing state. */
export function bridgeComposerTextModelBlock({ mode, directory, block, setBlock, textModelBlockReason }: {
  mode: Observable<{ kind: "text" | "image" | "video" }>;
  directory: Observable<{ routable: boolean | null }>;
  block: Observable<Block | undefined>;
  setBlock(value: Block | undefined): void;
  textModelBlockReason(): string;
}): () => void {
  let suspended: Block | undefined;
  let writing = false;
  const write = (value: Block | undefined) => {
    writing = true;
    try { setBlock(value); } finally { writing = false; }
  };
  const sync = () => {
    if (writing) return;
    const current = block.getSnapshot();
    if (directory.getSnapshot().routable !== false) { suspended = undefined; return; }
    if (mode.getSnapshot().kind !== "text") {
      if (current?.reason === textModelBlockReason()) { suspended = current; write(undefined); }
    } else if (suspended && current === undefined) {
      const original = suspended; suspended = undefined; write(original);
    }
  };
  const stops = [mode.subscribe(sync), directory.subscribe(sync), block.subscribe(sync)];
  sync();
  return () => {
    stops.forEach(stop => stop());
    if (suspended && block.getSnapshot() === undefined && directory.getSnapshot().routable === false) write(suspended);
  };
}
