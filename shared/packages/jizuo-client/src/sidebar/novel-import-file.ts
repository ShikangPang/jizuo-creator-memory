import { MAX_NOVEL_IMPORT_BYTES, type PreviewImportInput } from "@jizuo/contracts";

export async function readNovelImportFile(file: File): Promise<PreviewImportInput> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  const format = extension === "txt" ? "text" : extension === "docx" ? "docx"
    : extension === "md" || extension === "markdown" ? "markdown" : undefined;
  if (!format) throw new Error("请选择 TXT、Markdown 或 DOCX 格式的小说文件");
  if (!file.size) throw new Error("文件为空，请选择有正文的小说文件");
  if (file.size > MAX_NOVEL_IMPORT_BYTES) throw new Error("文件超过 10 MB，请拆分后再导入");
  const sourceBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string" || !reader.result.includes(",")) {
        reject(new Error("文件读取失败，请重新选择小说文件"));
        return;
      }
      resolve(reader.result.slice(reader.result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("文件读取失败，请检查文件是否可访问后重试"));
    reader.onabort = () => reject(new Error("文件读取已取消，请重新选择小说文件"));
    reader.readAsDataURL(file);
  });
  return { sourcePath: file.name, format, sourceBase64 };
}
