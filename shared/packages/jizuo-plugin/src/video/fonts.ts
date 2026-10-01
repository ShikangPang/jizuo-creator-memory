import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { bundledVideoFonts } from "../../../contracts/src/video-fonts/index.ts";
/** Private per-render directory, shared font bytes with the player; no system installation needed. */
export async function prepareVideoFonts(temp: string, families: string[]): Promise<void> {
  const directory = join(temp, "fonts");
  await mkdir(directory, { recursive: true });
  for (const font of bundledVideoFonts.filter(font => families.includes(font.family))) {
    await writeFile(join(directory, font.filename), gunzipSync(Buffer.from(font.gzipBase64, "base64")));
    await writeFile(join(directory, `${font.filename}.OFL.txt`), font.license);
  }
}
