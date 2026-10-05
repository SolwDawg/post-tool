import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import type { Post, Payload, PublishOptions, Story } from '../types.js';
import { expectedPosts, expectedSeries } from '../plan.js';

export async function workspace(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'content-publisher-test-'));
  t.after(async () => {
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('content-publisher-test-')) throw new Error('Unsafe test cleanup path.');
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
export function metadata(count = 2) {
  return { story_title: 'A Family Story', source_url: 'https://source.example/story', intro: null,
    seo: { seo_title: 'A Family Story', meta_description: 'An original family story.', focus_keyword: 'family', categories: ['Drama'], tags: ['family'] },
    status: 'ready', issues: [], chapters: Array.from({ length: count }, (_, i) => ({
      order: i + 1, chapter_title: `Chapter ${i + 1} - Part ${i + 1}`, content_file: `chapter_${i + 1}.txt`,
      seo: { seo_title: `Part ${i + 1}`, meta_description: 'Chapter-specific description.' },
    })) };
}
export async function fixture(root: string, count = 2): Promise<string> {
  const folder = path.join(root, '1', 'content');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'metadata.json'), JSON.stringify(metadata(count)));
  let html = '<!doctype html><html><head><title>A Family Story</title></head><body><h1>A Family Story</h1>';
  for (let i = 1; i <= count; i++) {
    const body = `The family arrived on day ${i}.\n\nThey discussed their plans & promises.`;
    await writeFile(path.join(folder, `chapter_${i}.txt`), body);
    html += `<section id="chapter-${i}"><h2>Chapter ${i} - Part ${i}</h2><p>The family arrived on day ${i}.</p><p>They discussed their plans &amp; promises.</p></section>`;
  }
  await writeFile(path.join(folder, 'article_seo_ready.html'), `${html}</body></html>`);
  return folder;
}
export const options: PublishOptions = { visibility: 'draft', imageUrl: '', mapping: {}, showHome: false, topNews: false };
export function detailsFor(payload: Payload): Post[] {
  const expected = expectedPosts(payload);
  return expected.map((item, i) => ({ id: i + 1, ...item, is_active: payload.is_active,
    is_home: payload.is_home, is_top: payload.is_top,
    selected_categories: payload.selected_categories, selected_tags: payload.selected_tags,
    series_id: payload.chapters ? 20 : null,
    series: payload.chapters ? { id: 20, ...expectedSeries(payload) } : null,
    prev_chapter: payload.chapters ? expected[i - 1]?.slug ?? null : null,
    next_chapter: payload.chapters ? expected[i + 1]?.slug ?? null : null,
    seo_title: payload.seo_title, seo_description: payload.seo_description, seo_keywords: payload.seo_keywords,
  }));
}
export function requireStory(value: { story?: Story; ready: boolean }): Story {
  if (!value.ready || !value.story) throw new Error('Fixture validation failed.');
  return value.story;
}
