import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { importLegacy } from '../legacy.js';
import { loadStory, slugify } from '../content.js';
import { workspace } from './helpers.js';

async function legacy(root: string, body='A Story 009 A child returned home.\n\nComments 0') {
  const folder=path.join(root,'source','1','content'); await mkdir(folder,{recursive:true});
  await writeFile(path.join(folder,'info.txt'),'Chương 1: A Story\n- SEO Title:\nA Story SEO\n- Meta Description:\nA child returns home.\n- Focus & Secondary Keywords:\nfamily, home\n- Category:\nBiker Stories & Heartwarming Life Lessons\n- Tags:\ndrama');
  await writeFile(path.join(folder,'chapter_1.txt'),body);
  await writeFile(path.join(folder,'article_seo_ready.html'),'<section id="chapter-1"><h1>A Story</h1><p>A Story009 A child returned home.</p><p>Comments 0</p></section>');
  return folder;
}
test('legacy import cleans known artifacts, keeps source unchanged and creates honest local identity',async t=>{
  const root=await workspace(t); const source=await legacy(root);
  const before=await readFile(path.join(source,'chapter_1.txt'));
  const results=await importLegacy(path.join(root,'source'),path.join(root,'converted'));
  assert.equal(results[0]!.status,'ready',JSON.stringify(results));
  const loaded=await loadStory(results[0]!.output!);
  assert.equal(loaded.ready,true); assert.equal(loaded.story!.sourceUrl,'');
  assert.match(loaded.story!.sourceId!,/^local-sha256:[a-f0-9]{64}$/);
  assert.equal(loaded.story!.chapters[0]!.text,'A child returned home.');
  assert.deepEqual(await readFile(path.join(source,'chapter_1.txt')),before);
  await assert.rejects(importLegacy(source,path.join(root,'converted')),/trống/);
  await assert.rejects(importLegacy(source,path.join(source,'converted')),/ngoài cây nguồn/);
});
test('legacy HTML/TXT mismatch is a review error rather than an invented repair',async t=>{
  const root=await workspace(t); const source=await legacy(root,'A child disappeared forever.');
  const result=await importLegacy(source,path.join(root,'converted'));
  assert.equal(result[0]!.status,'needs_review'); assert.match(result[0]!.error!,/HTML\/TXT khác/);
});
test('local identity requires strict digest and chapter slugs leave room for suffix',async t=>{
  const root=await workspace(t); const source=await legacy(root);
  const result=await importLegacy(source,path.join(root,'converted'));
  const file=path.join(result[0]!.output!,'metadata.json');
  const metadata=JSON.parse(await readFile(file,'utf8'));
  metadata.source_id='../outside'; await writeFile(file,JSON.stringify(metadata));
  assert.equal((await loadStory(result[0]!.output!)).ready,false);
  assert(slugify('word '.repeat(100)).length+ '-chapter-100000'.length<=110);
});
test('crawler title prefix with one doubled character is cleaned only with marker 009 and audited',async t=>{
  const root=await workspace(t);const source=await legacy(root);
  const text='A Storry 009 A Story 009 A child returned home.';
  await writeFile(path.join(source,'chapter_1.txt'),text);
  await writeFile(path.join(source,'article_seo_ready.html'),`<section id="chapter-1"><h1>A Story</h1><p>${text}</p></section>`);
  const result=await importLegacy(source,path.join(root,'converted'));
  assert.equal(result[0]!.status,'ready');
  assert.equal((await loadStory(result[0]!.output!)).story!.chapters[0]!.text,'A child returned home.');
  assert(result[0]!.edits!.some(e=>e.includes('ký tự lặp')));
  assert.equal(await readFile(path.join(source,'chapter_1.txt'),'utf8'),text);
  const ordinary='A Storry is the name of our home. 009 It stays.';
  await writeFile(path.join(source,'chapter_1.txt'),ordinary);
  await writeFile(path.join(source,'article_seo_ready.html'),`<section id="chapter-1"><h1>A Story</h1><p>${ordinary}</p></section>`);
  const kept=await importLegacy(source,path.join(root,'ordinary'));
  assert.equal((await loadStory(kept[0]!.output!)).story!.chapters[0]!.text,ordinary);
});
