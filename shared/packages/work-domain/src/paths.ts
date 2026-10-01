import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import { JizuoError } from "@jizuo/contracts";

export function defaultWorksRoot(home: string = homedir()): string {
  return resolve(home, "Documents", "Jizuo", "works");
}

export function resolveWithin(root: string, ...segments: string[]): string {
  const normalizedRoot = resolve(root);
  const candidate = resolve(normalizedRoot, ...segments);
  const pathFromRoot = relative(normalizedRoot, candidate);
  if (pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))) {
    return candidate;
  }
  throw new JizuoError("validation_error", "路径超出作品目录");
}

export function portableTitle(title: string): string {
  const value = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (value.length === 0) throw new JizuoError("validation_error", "标题不能生成有效目录名");
  return value;
}
