import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,mkdir,symlink} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {request} from '../http.js';
import {SessionApi} from '../api.js';
import {imageForStory,readImage} from '../images.js';
import {loadStory} from '../content.js';
import {Journal} from '../journal.js';
import {publishStory} from '../publisher.js';
import {reconcileImage} from '../image-upload.js';
import {importLegacy} from '../legacy.js';
import {detailsFor,fixture,options,requireStory,workspace} from './helpers.js';
import type {Payload,Post} from '../types.js';
const jpeg=Buffer.from('ffd8ffe000104a46494600010100000100010000ffdb000800010101010101ffd9','hex');
async function serve(handler:(req:IncomingMessage,res:ServerResponse)=>Promise<void>|void) {
 const server=createServer((req,res)=>{void Promise.resolve(handler(req,res)).catch(()=>{res.statusCode=500;res.end();});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {origin:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,close:()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());})};
}
test('finds Thumbnail beside content, rejects ambiguity, disguises and parent junctions; explicit selection wins',async t=>{
 const root=await workspace(t);const folder=await fixture(root);const story=requireStory(await loadStory(folder));
 const photo=path.join(path.dirname(folder),'Thumbnail.jpg');await writeFile(photo,jpeg);
 const detected=await imageForStory(story,options);assert.equal(detected!.file,photo);assert.equal(detected!.mime,'image/jpeg');
 await writeFile(path.join(folder,'Thumbnail.jpg'),jpeg);
 await assert.rejects(imageForStory(story,options),/nhiều/);
 assert.equal((await imageForStory(story,{...options,imageFile:photo}))!.file,photo);
 assert.equal(await imageForStory(story,{...options,noImage:true}),undefined);
 assert.equal(await imageForStory(story,{...options,imageUrl:'https://cdn.example/image.jpg'}),undefined);
 await assert.rejects(imageForStory(story,{...options,imageFile:photo,imageUrl:'https://cdn.example/image.jpg'}),/Chỉ chọn/);
 const disguised=path.join(root,'fake.jpg');await writeFile(disguised,Buffer.from('This is HTML, not an image.'));
 await assert.rejects(readImage(disguised),/không khớp/);
 await symlink(path.dirname(folder),path.join(root,'linked'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(readImage(path.join(root,'linked','Thumbnail.jpg')),/symlink|junction/);
});
test('CLI dry-run/preview detect image without upload; conflicts fail before browser; source is unchanged',async t=>{
 const root=await workspace(t);const folder=await fixture(root,2);const photo=path.join(path.dirname(folder),'Thumbnail.jpg');await writeFile(photo,jpeg);
 const cli=fileURLToPath(new URL('../cli.js',import.meta.url));const execute=promisify(execFile);
 const result=JSON.parse((await execute(process.execPath,[cli,'publish',folder,'--site','http://127.0.0.1:1'])).stdout);
 assert.equal(result.stories[0].featured_image.file,photo);assert.equal(result.stories[0].apply_image_to_all,true);
 const preview=JSON.parse((await execute(process.execPath,[cli,'preview',folder,'--state',path.join(root,'state')])).stdout);
 const plan=JSON.parse(await readFile(preview.plan,'utf8'));assert.equal(plan.featured_image.file,photo);
 assert(plan.payload.chapters.every((p:{image:string})=>p.image===''));
 await assert.rejects(execute(process.execPath,[cli,'publish',folder,'--execute','--image-file',photo,'--no-image','--site','http://127.0.0.1:1']),/Chỉ chọn/);
 assert.deepEqual(await readFile(photo),jpeg);
});
test('real HTTP presign uploads once without admin cookies, applies URL to every chapter, verifies source bytes and blocks changed image',async t=>{
 const root=await workspace(t);const folder=await fixture(root,3);const photo=path.join(path.dirname(folder),'Thumbnail.jpg');await writeFile(photo,jpeg);
 const story=requireStory(await loadStory(folder));let uploaded:Buffer|undefined;let presigns=0,puts=0,creates=0;let posts:Post[]=[];
 const server=await serve(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  if(url.pathname==='/storage/image') {
   assert.equal(req.headers.cookie,undefined);assert.equal(req.headers['x-csrf-token'],undefined);assert.equal(req.headers.authorization,undefined);
   puts++;const chunks=[];for await(const chunk of req)chunks.push(chunk);uploaded=Buffer.concat(chunks);assert.deepEqual(uploaded,jpeg);res.statusCode=200;res.end();return;
  }
  if(url.pathname==='/public/image.jpg') {
   assert.equal(req.headers.cookie,undefined);assert.equal(req.headers['x-csrf-token'],undefined);
   if(!uploaded){res.statusCode=404;res.end();return;}res.setHeader('Content-Type','image/jpeg');res.end(uploaded);return;
  }
  assert.equal(req.headers.cookie,'admin=session');assert.equal(req.headers['x-csrf-token'],'csrf');
  const json=(data:unknown)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,data}));};
  if(url.pathname.endsWith('/uploads/presigned-image-url')) {
   presigns++;let text='';for await(const chunk of req)text+=chunk;const data=JSON.parse(text);
   assert.deepEqual(data,{fileName:'Thumbnail.jpg',contentType:'image/jpeg',size:jpeg.length,auditContext:{record_type:'Post',action_label:'upload featured image'}});
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({message:'Upload URL generated',data:{disk:'r2',bucket:'bioblog',objectKey:'assets/test/image.jpg',upload:{url:`${server.origin}/storage/image?signature=secret`,method:'PUT',headers:{'Content-Type':'image/jpeg'}},fileUrl:`${server.origin}/public/image.jpg`}}));return;
  }
  if(url.pathname.endsWith('/taxonomies/categories')){json([{id:1,title:'Drama'}]);return;}
  if(url.pathname.endsWith('/taxonomies/tags')){json([{id:2,title:'family'}]);return;}
  if(url.pathname.endsWith('/taxonomies/series')){json([]);return;}
  if(url.pathname.endsWith('/posts/chapter-batch')&&req.method==='POST') {
   creates++;let text='';for await(const chunk of req)text+=chunk;const payload=JSON.parse(text) as Payload;
   assert.equal(payload.image,`${server.origin}/public/image.jpg`);assert(payload.chapters!.every(p=>p.image===payload.image&&p.description.includes(`src="${payload.image}"`)));
   posts=detailsFor(payload);json(posts.map(({id,title,slug})=>({id,title,slug})));return;
  }
  if(url.pathname.endsWith('/posts')){json({current_page:1,last_page:1,data:posts});return;}
  json(posts.find(p=>p.id===Number(url.pathname.split('/').at(-1))));
 });t.after(server.close);
 const context=await request.newContext({origin:server.origin,extraHTTPHeaders:{Cookie:'admin=session'}});t.after(()=>context.dispose());
 const api=new SessionApi(context,server.origin,'csrf');const journal=await Journal.open(path.join(root,'state'));
 const opts={...options,imageFile:photo,bodyImage:true,formatting:'reader' as const};
 const receipt=await publishStory(api,journal,server.origin,story,opts);
 assert.equal(receipt.status,'verified');assert.equal(receipt.featuredImage!.file,photo);
 assert.equal((await publishStory(api,journal,server.origin,story,opts)).id,receipt.id);
 assert.equal(creates,1);assert.equal(presigns,1);assert.equal(puts,1);
 const imageLog=await journal.imageUpload(server.origin,receipt.featuredImage!.sha256);
 assert.equal(imageLog!.status,'verified');assert(!JSON.stringify(imageLog).includes('signature'));assert(!JSON.stringify(imageLog).includes('secret'));
 assert.deepEqual(imageLog!.network!.map(n=>[n.stage,n.method,n.status]),[['presign','POST',200],['storage','PUT',200],['public-image','GET',200]]);
 assert.equal(imageLog!.network![0]!.fileUrl,receipt.payload.image);
 assert.deepEqual(imageLog!.network![0]!.storage,{disk:'r2',bucket:'bioblog',objectKey:'assets/test/image.jpg'});
 assert.deepEqual(imageLog!.network![0]!.responseKeys,['message','data']);
 assert.equal(imageLog!.network![1]!.url,`${server.origin}/storage/image`);
 assert.equal(imageLog!.network![2]!.sha256,receipt.featuredImage!.sha256);
 await writeFile(photo,Buffer.concat([jpeg,Buffer.from('changed')]));
 await assert.rejects(publishStory(api,journal,server.origin,story,opts),/ảnh khác/);assert.equal(presigns,1);assert.equal(creates,1);
});
test('failed upload blocks post dispatch and replay; read-only image reconciliation recovers committed bytes',async t=>{
 const root=await workspace(t);const folder=await fixture(root,1);const photo=path.join(path.dirname(folder),'Thumbnail.jpg');await writeFile(photo,jpeg);
 const image=(await readImage(photo)).image;const story=requireStory(await loadStory(folder));const journal=await Journal.open(path.join(root,'state'));
 let uploads=0,creates=0;const api={
  async catalog(type:string){return type==='categories'?[{id:1,title:'Drama'}]:type==='tags'?[{id:2,title:'family'}]:[];},
  async posts(){return [];},async post(){throw Error('unused');},async create(){creates++;return [];},
  async uploadImage(_image:unknown,_bytes:Buffer,persist:(url:string)=>Promise<void>){uploads++;await persist('https://cdn.example/image.jpg');throw Error('Lost response after write');},
  async verifyImage(){},
 };
 await assert.rejects(publishStory(api,journal,'https://blog.example',story,options),/chưa xác minh upload/);
 assert.equal((await journal.imageUpload('https://blog.example',image.sha256))!.status,'outcome-unknown');
 await assert.rejects(publishStory(api,journal,'https://blog.example',story,options),/upload chưa rõ/);
 assert.equal(uploads,1);assert.equal(creates,0);
 const reconciled=await reconcileImage(api,journal,'https://blog.example',image.sha256);assert.equal(reconciled.status,'verified');assert.equal(uploads,1);
});
test('duplicate posts block image upload; cached verified upload survives post error without second upload',async t=>{
 const root=await workspace(t);const folder=await fixture(root,2);await writeFile(path.join(path.dirname(folder),'Thumbnail.jpg'),jpeg);
 const story=requireStory(await loadStory(folder));let upload=0,creates=0;let duplicates=true;let afterPayload:Payload|undefined;
 const api={
  async catalog(type:string){return type==='categories'?[{id:1,title:'Drama'}]:type==='tags'?[{id:2,title:'family'}]:[];},
  async posts(){return duplicates?[{id:100,title:story.title,slug:story.slug,is_active:true}]:[];},async post(){throw Error('unused');},
  async create(_endpoint:string,payload:Payload){creates++;afterPayload=payload;throw Error('post response lost');},
  async uploadImage(_image:unknown,_bytes:Buffer,persist:(url:string)=>Promise<void>){upload++;await persist('https://cdn.example/photo.jpg');return 'https://cdn.example/photo.jpg';},async verifyImage(){},
 };
 const journal=await Journal.open(path.join(root,'state'));const site='https://blog.example';
 await assert.rejects(publishStory(api,journal,site,story,options),/Đã có/);assert.equal(upload,0);
 duplicates=false;await assert.rejects(publishStory(api,journal,site,story,options),/chưa xác minh kết quả/);
 assert.equal(upload,1);assert.equal(creates,1);assert(afterPayload!.chapters!.every(c=>c.image==='https://cdn.example/photo.jpg'));
 await assert.rejects(publishStory(api,journal,site,story,options),/chưa rõ kết quả/);assert.equal(upload,1);assert.equal(creates,1);
 // Simulate an operator's explicit confirmed-not-created resolution; image remains reusable.
 const receipt=(await journal.all(site))[0]!;receipt.status='resolved-not-created';await journal.write(receipt);
 await assert.rejects(publishStory(api,journal,site,story,options));assert.equal(upload,1);assert.equal(creates,2);
});
test('legacy import carries sibling thumbnail into isolated content, audits source and keeps original bytes',async t=>{
 const root=await workspace(t);const folder=path.join(root,'source','content');await mkdir(folder,{recursive:true});
 await writeFile(path.join(folder,'info.txt'),'Chương 1: A Story\nSEO Title\nA Story\nMeta Description\nA story description.\nFocus & Secondary Keywords\nstory\nCategory\nDrama\nTags\nfamily');
 await writeFile(path.join(folder,'chapter_1.txt'),'A child returned home.');await writeFile(path.join(folder,'article_seo_ready.html'),'<section id="chapter-1"><h1>A Story</h1><p>A child returned home.</p></section>');
 const image=path.join(path.dirname(folder),'Thumbnail.jpg');await writeFile(image,jpeg);
 const result=await importLegacy(folder,path.join(root,'imported'));assert.equal(result[0]!.status,'ready');
 assert.deepEqual(await readFile(path.join(result[0]!.output!,'Thumbnail.jpg')),jpeg);assert.deepEqual(await readFile(image),jpeg);
 const report=JSON.parse(await readFile(path.join(result[0]!.output!,'import_report.json'),'utf8'));assert.equal(report.featuredImage.file,image);
 const imported=requireStory(await loadStory(result[0]!.output!));assert.equal((await imageForStory(imported,options))!.sha256,report.featuredImage.sha256);
});
test('current Antigravity metadata aliases work with video thumbnail and retain readiness/conflict guards',async t=>{
 const root=await workspace(t);const folder=await fixture(root,2);const file=path.join(folder,'metadata.json');
 const source=JSON.parse(await readFile(file,'utf8'));
 source.original_source_url=source.source_url;delete source.source_url;
 source.review_status=source.status;delete source.status;source.review_issues=source.issues;delete source.issues;
 source.seo.title=source.seo.seo_title;delete source.seo.seo_title;
 for(const chapter of source.chapters) {chapter.title=chapter.chapter_title;delete chapter.chapter_title;chapter.filename=chapter.content_file;delete chapter.content_file;chapter.seo.title=chapter.seo.seo_title;delete chapter.seo.seo_title;}
 await writeFile(file,JSON.stringify(source));await writeFile(path.join(path.dirname(folder),'Thumbnail.jpg'),jpeg);
 const before=await readFile(file);const loaded=await loadStory(folder);assert.equal(loaded.ready,true);assert.equal(loaded.story!.sourceUrl,source.original_source_url);
 assert((await imageForStory(loaded.story!,options))!.file.endsWith('Thumbnail.jpg'));assert.deepEqual(await readFile(file),before);
 source.review_status='needs_review';await writeFile(file,JSON.stringify(source));assert.equal((await loadStory(folder)).ready,false);
 source.review_status='ready';source.status='needs_review';await writeFile(file,JSON.stringify(source));
 const conflict=await loadStory(folder);assert.equal(conflict.ready,false);assert.match(conflict.issues[0]!.message,/mâu thuẫn/);
});
test('storage failure is dispatched once, leaves recoverable image intent and never forwards session or signed URLs to journal',async t=>{
 const root=await workspace(t);const folder=await fixture(root,1);await writeFile(path.join(path.dirname(folder),'Thumbnail.jpg'),jpeg);
 const story=requireStory(await loadStory(folder));const image=(await imageForStory(story,options))!;const journal=await Journal.open(path.join(root,'state'));
 let storageCalls=0,presigns=0;let fail=true;let leakedHeader=false;let unsafeHeaders=false;
 const server=await serve(async(req,res)=>{
  if(req.url!.startsWith('/storage')) {
   storageCalls++;leakedHeader ||= !!req.headers.cookie||!!req.headers['x-csrf-token'];
   for await(const _chunk of req){}res.statusCode=500;res.end();return;
  }
  if(req.url==='/public.jpg') {res.setHeader('Content-Type','image/jpeg');res.end(fail?Buffer.concat([jpeg,Buffer.from('wrong')]):jpeg);return;}
  if(req.url!.endsWith('/uploads/presigned-image-url')) {
   presigns++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,data:{upload:{url:`${server.origin}/storage?signature=secret`,headers:unsafeHeaders?{Cookie:'session=secret'}:{}},fileUrl:`${server.origin}/public.jpg`}}));return;
  }
  res.statusCode=404;res.end();
 });t.after(server.close);
 const context=await request.newContext({origin:server.origin,extraHTTPHeaders:{Cookie:'admin=session'}});t.after(()=>context.dispose());const api=new SessionApi(context,server.origin,'csrf');
 const {ensureImage}=await import('../image-upload.js');
 await assert.rejects(ensureImage(api,journal,server.origin,image),/HTTP 500/);
 assert.equal(storageCalls,1);assert.equal(presigns,1);assert.equal(leakedHeader,false);
 const saved=(await journal.imageUpload(server.origin,image.sha256))!;assert.equal(saved.status,'outcome-unknown');assert(!JSON.stringify(saved).includes('secret'));
 await assert.rejects(ensureImage(api,journal,server.origin,image),/chưa rõ/);assert.equal(storageCalls,1);assert.equal(presigns,1);
 await assert.rejects(reconcileImage(api,journal,server.origin,image.sha256),/khác file nguồn/);assert.equal(storageCalls,1);
 fail=false;assert.equal((await reconcileImage(api,journal,server.origin,image.sha256)).status,'verified');assert.equal(storageCalls,1);
 // An unexpected session header in a newly-issued descriptor must never reach storage.
 saved.status='resolved-not-uploaded';await journal.writeImageUpload(saved);unsafeHeaders=true;
 await assert.rejects(ensureImage(api,journal,server.origin,image),/header phiên/);assert.equal(storageCalls,1);
});
