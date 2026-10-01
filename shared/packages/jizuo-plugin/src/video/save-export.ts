import { copyFile, constants } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { JizuoError } from "@jizuo/contracts";
import type { LocalVideoAssets } from "./assets.ts";

/** Destination comes from the user's save dialog. Never overwrite an existing file. */
export async function copyVideoExport(assets:LocalVideoAssets,input:{workId:string;assetId:string;destination:string}):Promise<{path:string}>{
  if(!isAbsolute(input.destination)||extname(input.destination).toLowerCase()!==".mp4")throw new JizuoError("validation_error","请选择绝对路径的 MP4 文件位置");
  const {path,asset}=await assets.pathFor(input.workId,input.assetId);
  if(asset.kind!=="export"||asset.mimeType!=="video/mp4")throw new JizuoError("validation_error","只能另存已完成的 MP4 成片");
  const destination=resolve(input.destination);
  try{await copyFile(path,destination,constants.COPYFILE_EXCL);}
  catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")throw new JizuoError("revision_conflict","目标文件已存在，请选择新的文件名");throw new JizuoError("validation_error","成片保存失败，请检查目录权限和可用空间");}
  return {path:destination};
}
