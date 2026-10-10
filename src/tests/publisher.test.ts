import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { BlogApi } from '../api.js';
import type { Payload, Post, Taxonomy } from '../types.js';
import { Journal } from '../journal.js';
import { loadStory } from '../content.js';
import { publishStory, reconcileReceipt } from '../publisher.js';
import { buildPayload, duplicates, publicationStory, resolveNames, storyKey, verifyPosts } from '../plan.js';
import { detailsFor, fixture, options, requireStory, workspace } from './helpers.js';

class FakeApi implements BlogApi {
  created: Post[] = []; creates = 0; failAfterWrite = false; failWithoutWrite = false;
  async catalog(type: 'categories' | 'tags' | 'series'): Promise<Taxonomy[]> {
    return type === 'categories' ? [{ id: 1, title: 'Drama' }] : type === 'tags' ? [{ id: 2, title: 'family' }] : [];
  }
  async posts() { return this.created; }
  async post(id: number) { const result = this.created.find(p => p.id === id); if (!result) throw new Error('Not found'); return result; }
  async create(_endpoint: string, payload: Payload) {
    this.creates++;
    if (this.failWithoutWrite) throw new Error('Connection lost before response');
    this.created = detailsFor(payload);
    if (this.failAfterWrite) throw new Error('Connection lost after server committed');
    return this.created;
  }
}
const site = 'https://blog.example';
test('draft batch preserves order, content, taxonomy, SEO and verifies receipt; rerun does not create again', async t => {
  const root = await workspace(t); const story = requireStory(await loadStory(await fixture(root, 3)));
  const journal = await Journal.open(path.join(root, 'state')); const api = new FakeApi();
  const receipt = await publishStory(api, journal, site, story, options);
  assert.equal(receipt.status, 'verified'); assert.equal(receipt.posts.length, 3); assert.equal(api.creates, 1);
  assert(api.created.every(p => !p.is_active));
  assert.equal((await publishStory(api, journal, site, story, options)).id, receipt.id);
  assert.equal(api.creates, 1);
  await assert.rejects(publishStory(api, journal, site, story, { ...options, showHome: true }), /đã thay đổi/);
  assert.equal(api.creates, 1);
});
test('lost response blocks replay; read-only reconciliation recovers committed posts', async t => {
  const root = await workspace(t); const story = requireStory(await loadStory(await fixture(root)));
  const journal = await Journal.open(path.join(root, 'state')); const api = new FakeApi(); api.failAfterWrite = true;
  await assert.rejects(publishStory(api, journal, site, story, options), /chưa xác minh/);
  const receipt = (await journal.all(site))[0]!;
  assert.equal(receipt.status, 'outcome-unknown'); assert.equal(receipt.posts.length, 0);
  await assert.rejects(publishStory(api, journal, site, story, options), /chưa rõ kết quả/);
  assert.equal(api.creates, 1);
  const reconciled = await reconcileReceipt(api, journal, receipt);
  assert.equal(reconciled.status, 'verified'); assert.equal(reconciled.posts.length, 2); assert.equal(api.creates, 1);
});
test('no matching posts after timeout does not silently reset or resend', async t => {
  const root = await workspace(t); const story = requireStory(await loadStory(await fixture(root)));
  const journal = await Journal.open(path.join(root, 'state')); const api = new FakeApi(); api.failWithoutWrite = true;
  await assert.rejects(publishStory(api, journal, site, story, options));
  await assert.rejects(reconcileReceipt(api, journal, (await journal.all(site))[0]!), /0\/2/);
  assert.equal((await journal.all(site))[0]!.status, 'outcome-unknown'); assert.equal(api.creates, 1);
});
test('verification rejects swapped links, truncated text, wrong visibility, SEO and taxonomy', async t => {
  const story = requireStory(await loadStory(await fixture(await workspace(t))));
  const payload = buildPayload(story, options, [1], [2]);
  for (const change of [(p: Post) => { p.next_chapter = 'wrong'; }, (p: Post) => { p.description = 'truncated'; },
    (p: Post) => { p.is_active = true; }, (p: Post) => { p.seo_title = 'wrong'; }, (p: Post) => { p.selected_tags = []; }]) {
    const details = detailsFor(payload); change(details[0]!); assert.throws(() => verifyPosts(payload, details));
  }
});
test('taxonomy names must resolve exactly; global chapter slug collisions and series duplicates are detected', async t => {
  assert.throws(() => resolveNames(['missing'], [], 'Tag'), /chưa có/);
  assert.throws(() => resolveNames(['Drama'], [{ id: 1, title: 'Drama' }, { id: 2, title: 'drama' }], 'Category'), /trùng tên/);
  const story = requireStory(await loadStory(await fixture(await workspace(t))));
  assert.equal(duplicates(story, [], [{ id: 3, title: story.title }]).length, 1);
  assert.equal(duplicates(story, [{ id: 2, title: 'Different title', slug: story.chapters[0]!.slug, is_active: true }], []).length, 1);
});
test('SEO description whitespace normalization is accepted, but missing words and changed keywords fail', async t => {
  const story = requireStory(await loadStory(await fixture(await workspace(t), 1)));
  const payload = buildPayload(story, options, [1], [2]);
  payload.seo_description = 'A story.  Courage\n and kindness.';
  const details = detailsFor(payload);
  details[0]!.seo_description = 'A story. Courage and kindness.';
  assert.doesNotThrow(() => verifyPosts(payload, details));
  details[0]!.seo_description = 'A story. Courage.';
  assert.throws(() => verifyPosts(payload, details), /SEO/);
  details[0]!.seo_description = 'A story. Courage and kindness.';
  details[0]!.seo_keywords = 'different';
  assert.throws(() => verifyPosts(payload, details), /SEO/);
});
test('single-chapter normal mode creates one post; public is explicit', async t => {
  const root = await workspace(t); const story = requireStory(await loadStory(await fixture(root, 1)));
  const api = new FakeApi(); const journal = await Journal.open(path.join(root, 'state'));
  const receipt = await publishStory(api, journal, site, story, { ...options, visibility: 'public' });
  assert.equal(receipt.endpoint, '/posts'); assert.equal(receipt.posts.length, 1); assert.equal(api.created[0]!.is_active, true);
});
test('site lock prevents concurrent CLI writers and keeps receipt files intact', async t => {
  const journal = await Journal.open(path.join(await workspace(t), 'state'));
  const release = await journal.lock(site);
  await assert.rejects(journal.lock(site), /tiến trình publisher khác/);
  await release(); const releaseAgain = await journal.lock(site); await releaseAgain();
});
test('reader receipts retain format, verify saved CSS and prevent duplicate create when changing the presentation',async t=>{
  const root=await workspace(t);const story=requireStory(await loadStory(await fixture(root,1)));
  const api=new FakeApi();const journal=await Journal.open(path.join(root,'state'));
  const formatted={...options,formatting:'reader' as const};
  const receipt=await publishStory(api,journal,site,story,formatted);
  assert.equal(receipt.formatting,'reader');assert.equal(receipt.status,'verified');
  await assert.rejects(publishStory(api,journal,site,story,options),/đã thay đổi/);
  api.created[0]!.description=api.created[0]!.description!.replace(/ style="[^"]*"/g,'');
  await assert.rejects(reconcileReceipt(api,journal,receipt),/style/);
  assert.equal(api.creates,1);
});
test('skip-intro production series uses chapter 1 identity; wrong binding is rejected even when posts match',async t=>{
  const story=requireStory(await loadStory(await fixture(await workspace(t),2)));
  const payload=buildPayload(story,{...options,seriesTitle:'A Family Story — Separate Edition'},[1],[2]);
  const saved=detailsFor(payload);
  assert.equal(saved[0]!.series!.title,payload.chapters![0]!.title);
  assert.equal(saved[0]!.series!.slug,payload.chapters![0]!.slug);
  verifyPosts(payload,saved);
  saved[0]!.series!.title=payload.title;
  assert.throws(()=>verifyPosts(payload,saved),/series/);
  saved[0]!.series!.title=payload.chapters![0]!.title;
  saved[0]!.series!.slug='unrelated-series';
  assert.throws(()=>verifyPosts(payload,saved),/series/);
  const withIntro=buildPayload({...story,intro:'Story introduction.'},options,[1],[2]);
  assert.equal(detailsFor(withIntro)[0]!.series!.title,story.title);
});
test('explicit series edition keeps source text, avoids an existing normal post and still blocks collisions/replay',async t=>{
  const root=await workspace(t);const story=requireStory(await loadStory(await fixture(root,2)));
  const edition={...options,seriesTitle:'A Family Story — Complete Chapters',formatting:'reader' as const};
  const variant=publicationStory(story,edition);
  const old={id:172,title:story.title,slug:story.slug,is_active:true};
  assert.equal(duplicates(story,[old],[]).length,1);
  assert.equal(duplicates(variant,[old],[]).length,0);
  assert.equal(duplicates(variant,[],[{id:21,title:variant.title,slug:variant.slug}]).length,1);
  assert.equal(duplicates(variant,[{...old,slug:variant.chapters[0]!.slug}],[]).length,1);
  assert.deepEqual(variant.chapters.map(c=>c.html),story.chapters.map(c=>c.html));
  assert.notEqual(storyKey(site,story),storyKey(site,story,edition.seriesTitle));
  assert.throws(()=>publicationStory(story,{...options,seriesTitle:story.title}),/khác bản gốc/);
  assert.throws(()=>publicationStory({...story,chapters:[story.chapters[0]!]},edition),/nhiều chương/);
  const api=new FakeApi();api.created=[old];
  const journal=await Journal.open(path.join(root,'state'));
  const receipt=await publishStory(api,journal,site,story,edition);
  assert.equal(receipt.title,variant.title);assert.equal(receipt.seriesTitle,edition.seriesTitle);
  assert.equal((await publishStory(api,journal,site,story,edition)).id,receipt.id);
  assert.equal(api.creates,1);
});
