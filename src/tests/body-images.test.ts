import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {formatContent,imageHtml,insertBodyImage,verifyBodyImages} from '../formatting.js';
import {htmlText,loadStory} from '../content.js';
import {buildPayload,verifyPosts} from '../plan.js';
import {detailsFor,fixture,options,requireStory,workspace} from './helpers.js';
const url='https://blog.igallery.blog/assets/tenant/2026/1005/photo.jpg';
test('Source Code image escapes attributes, keeps text and reader layout, avoids duplicate image and rejects signed URLs',()=>{
 const html=formatContent('<p>A family &amp; their promises.</p>','reader');
 const inserted=insertBodyImage(html,url,'" onclick="evil <story>');
 assert.equal(htmlText(inserted),htmlText(html));
 const doc=new JSDOM(inserted).window.document;
 assert.equal(doc.querySelector('body > div > figure > img')!.getAttribute('src'),url);
 assert.equal(doc.querySelector('img')!.getAttribute('alt'),'" onclick="evil <story>');
 assert.equal(doc.querySelector('img')!.getAttribute('onclick'),null);
 assert.equal(doc.querySelector('p')!.style.fontSize,'1.12em');
 assert.equal(insertBodyImage(inserted,url,'other title'),inserted);
 assert.throws(()=>imageHtml(url+'?X-Amz-Signature=secret','photo'),/URL/);
 assert.throws(()=>imageHtml('javascript:alert(1)','photo'),/URL/);
});
test('every chapter uses exact public image URL; verification detects lost or changed img even with identical text',async t=>{
 const root=await workspace(t);const story=requireStory(await loadStory(await fixture(root,3)));
 for(const formatting of ['source','reader'] as const){
  const payload=buildPayload(story,{...options,imageUrl:url,bodyImage:true,formatting},[1],[2]);
  assert(payload.chapters!.every(c=>new JSDOM(c.description).window.document.querySelector('img')!.getAttribute('src')===url));
  const posts=detailsFor(payload);verifyPosts(payload,posts,formatting);
  posts[1]!.description=posts[1]!.description!.replace(url,url.replace('photo','wrong'));
  assert.throws(()=>verifyPosts(payload,posts,formatting),/URL ảnh/);
 }
 assert.throws(()=>verifyBodyImages(imageHtml(url,'test'),'<p></p>'),/mất/);
});
test('upload-image dry-run never opens browser or uploads; preview exports public img URL in Source Code fragments only',async t=>{
 const root=await workspace(t);const cli=fileURLToPath(new URL('../cli.js',import.meta.url));const execute=promisify(execFile);
 const photo=path.join(root,'Thumbnail.jpg');const bytes=Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9','hex');await writeFile(photo,bytes);
 const result=JSON.parse((await execute(process.execPath,[cli,'upload-image',photo,'--site','http://127.0.0.1:1'])).stdout);
 assert.equal(result.mode,'offline-dry-run');assert.equal(result.image.size,bytes.length);
 const folder=await fixture(root,2);
 const preview=JSON.parse((await execute(process.execPath,[cli,'preview',folder,'--image-url',url,'--body-image','--format','reader','--state',path.join(root,'state')])).stdout);
 const plan=JSON.parse(await readFile(preview.plan,'utf8'));assert.equal(plan.body_image,true);
 for(const fragment of preview.source_html)assert((await readFile(fragment.file,'utf8')).includes(`src="${url}"`));
 const inert=await readFile(preview.preview,'utf8');assert(!inert.includes(url));
 await assert.rejects(execute(process.execPath,[cli,'publish',folder,'--execute','--no-image','--body-image','--site','http://127.0.0.1:1']),/không kết hợp/);
 assert.deepEqual(await readFile(photo),bytes);
});
