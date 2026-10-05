import path from 'node:path';
import {createHash} from 'node:crypto';
import {lstat,readdir,readFile} from 'node:fs/promises';
import {checkedRoot,containedPath} from './safe-path.js';
import type {LocalImage,PublishOptions,Story} from './types.js';
export const maxImageBytes=20*1024*1024;
export async function readImage(input:string):Promise<{image:LocalImage;buffer:Buffer}> {
  const file=path.resolve(input);
  // Check every ancestor, including the video folder above content.
  const disk=await checkedRoot(path.parse(file).root);
  const safe=await containedPath(disk,path.relative(disk,file));
  const stat=await lstat(safe);
  if(!stat.isFile()||stat.size<12||stat.size>maxImageBytes)throw new Error('Ảnh phải là file JPEG/PNG/WebP từ 12 byte đến 20 MB.');
  const buffer=await readFile(safe);
  if(buffer.length!==stat.size||buffer.length>maxImageBytes)throw new Error('File ảnh thay đổi trong khi đọc.');
  const extension=path.extname(safe).toLowerCase();
  const jpeg=buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff;
  const png=buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const webp=buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP';
  const mime=jpeg&&['.jpg','.jpeg'].includes(extension)?'image/jpeg':png&&extension==='.png'?'image/png':webp&&extension==='.webp'?'image/webp':undefined;
  if(!mime)throw new Error('Định dạng ảnh không khớp phần mở rộng; chỉ nhận JPEG, PNG, WebP.');
  return {image:{file:safe,name:path.basename(safe),mime,size:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex')},buffer};
}
export async function imageForStory(story:Story,options:PublishOptions):Promise<LocalImage|undefined> {
  if(options.noImage&&(options.imageFile||options.imageUrl)||options.imageFile&&options.imageUrl)throw new Error('Chỉ chọn một trong --image-file, --image-url, --no-image.');
  if(options.noImage)return undefined;
  if(options.imageFile)return (await readImage(options.imageFile)).image;
  if(options.imageUrl)return undefined;
  return thumbnailInFolder(story.folder);
}
export async function thumbnailInFolder(folder:string):Promise<LocalImage|undefined> {
  const root=await checkedRoot(folder);
  const directories=[root,...(path.basename(root).toLowerCase()==='content'?[path.dirname(root)]:[])];
  const found:string[]=[];
  for(const directory of directories) {
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      if(entry.name.toLowerCase()==='thumbnail.jpg')found.push(await containedPath(await checkedRoot(directory),entry.name));
    }
  }
  if(found.length>1)throw new Error('Có nhiều Thumbnail.jpg cạnh content; dùng --image-file để chọn đúng ảnh.');
  return found[0]?(await readImage(found[0])).image:undefined;
}
export function publicImageUrl(value:string):string {
  const url=new URL(value);const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if(url.username||url.password||url.hash||url.search||url.protocol!=='https:'&&!(loopback&&url.protocol==='http:')) {
    throw new Error('URL ảnh công khai cần HTTPS, không có credentials/query/hash.');
  }
  return url.href;
}
