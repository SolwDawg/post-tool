import { chapterName, digest, escapeHtml, htmlText, normalizeText, plainToHtml, sanitizeHtml, slugify } from './content.js';
import { formatContent, insertBodyImage, verifyBodyImages, verifyFormatting } from './formatting.js';
import type { ContentFormat, Payload, Post, PublishOptions, Story, Taxonomy } from './types.js';

export function storyKey(site: string, story: Story, seriesTitle?: string): string {
  const base = `${site}\n${story.sourceId ?? story.sourceUrl.replace(/\/$/, '')}`;
  return digest(seriesTitle ? `${base}\nseries-edition:${normalizeText(seriesTitle)}` : base);
}
/** An explicit separate edition retains source text/identity, with a distinct publication namespace. */
export function publicationStory(story: Story, options: PublishOptions): Story {
  if (!options.seriesTitle) return story;
  const title = normalizeText(options.seriesTitle);
  if (story.chapters.length < 2) throw new Error('--series-title chỉ dùng cho truyện nhiều chương.');
  if (!title || title.length > 255) throw new Error('--series-title cần tên series từ 1 đến 255 ký tự.');
  const slug = slugify(title);
  if (!slug || slug === story.slug || title.toLocaleLowerCase() === normalizeText(story.title).toLocaleLowerCase()) {
    throw new Error('--series-title cần tên và slug khác bản gốc; không bỏ qua bảo vệ bài trùng.');
  }
  return { ...story, title, slug, chapters: story.chapters.map(c => ({ ...c, slug: `${slug}-chapter-${c.order}` })) };
}
export function namesFor(type: 'categories' | 'tags', story: Story, options: PublishOptions): string[] {
  const source = options[type] ?? story.seo[type];
  return [...new Set(source.flatMap(name => options.mapping[type]?.[name] ?? [name]))];
}
export function resolveNames(names: string[], catalog: Taxonomy[], type: string): number[] {
  return [...new Set(names.map(name => {
    const matches = catalog.filter(t => normalizeText(t.title).toLocaleLowerCase() === normalizeText(name).toLocaleLowerCase());
    if (matches.length !== 1) throw new Error(`${type}: "${name}" ${matches.length ? 'trùng tên trong website' : 'chưa có trên website'}. Dùng --mapping hoặc --category/--tag; tool không tự tạo taxonomy.`);
    return matches[0]!.id;
  }))];
}
export function buildPayload(story: Story, options: PublishOptions, categoryIds: number[], tagIds: number[]): Payload {
  story = publicationStory(story, options);
  const body=(html:string,title:string):string=>{
    const formatted=formatContent(html,options.formatting);
    return options.bodyImage&&options.imageUrl&&html.trim()?insertBodyImage(formatted,options.imageUrl,title):formatted;
  };
  if (options.imageUrl) {
    const image = new URL(options.imageUrl);
    if (!['http:', 'https:'].includes(image.protocol) || image.username || image.password) throw new Error('Ảnh phải là URL HTTP/HTTPS không có credentials.');
  }
  const payload: Payload = {
    title: story.title, slug: story.slug, image: options.imageUrl,
    description: body(story.chapters.length > 1 ? plainToHtml(story.intro) : story.chapters[0]!.html,story.title),
    seo_title: story.seo.seo_title, seo_description: story.seo.meta_description,
    seo_keywords: [...new Set([story.seo.focus_keyword, ...story.seo.secondary_keywords].filter(Boolean))].join(', '),
    selected_categories: categoryIds, selected_tags: tagIds,
    is_active: options.visibility === 'public', is_home: options.showHome, is_top: options.topNews,
    series_id: null, prev_chapter: null, next_chapter: null,
  };
  if (story.chapters.length > 1) {
    payload.skip_intro = !story.intro;
    payload.chapters = story.chapters.map(chapter => ({ title: chapterName(chapter.title), slug: chapter.slug, description: body(chapter.html,chapterName(chapter.title)), image: options.imageUrl }));
  }
  return payload;
}
export function duplicates(story: Story, posts: Post[], series: Taxonomy[]): string[] {
  const target = normalizeText(story.title).toLocaleLowerCase();
  const slugs = new Set([story.slug, ...story.chapters.map(c => c.slug)]);
  return [
    ...series.filter(s => s.slug === story.slug || normalizeText(s.title).toLocaleLowerCase() === target).map(s => `Series #${s.id}: ${s.title}`),
    ...posts.filter(p => slugs.has(p.slug) || normalizeText(p.title).toLocaleLowerCase() === target ||
      p.series && (p.series.slug === story.slug || normalizeText(p.series.title).toLocaleLowerCase() === target))
      .map(p => `Post #${p.id}: ${p.title}`),
  ];
}
export function expectedPosts(payload: Payload): { title: string; slug: string; description: string; image: string }[] {
  return payload.chapters ?? [{ title: payload.title, slug: payload.slug, description: payload.description, image: payload.image }];
}
export function expectedSeries(payload: Payload): {title:string;slug:string} {
  // Live Bio Blog chapter-batch with skip_intro=true binds the new series to chapter 1.
  const first = payload.skip_intro && payload.chapters?.[0];
  return first ? {title:first.title,slug:first.slug} : {title:payload.title,slug:payload.slug};
}
export function verifyPosts(payload: Payload, details: Post[], formatting: ContentFormat = 'source'): void {
  const expected = expectedPosts(payload);
  if (details.length !== expected.length || new Set(details.map(d => d.id)).size !== expected.length) throw new Error('Số bài hoặc ID sau lưu không khớp.');
  const seriesIds = new Set(details.map(d => d.series_id));
  if (payload.chapters && (seriesIds.size !== 1 || !details[0]!.series_id)) throw new Error('Các chương không thuộc cùng series.');
  const setMatches = (a: number[] | undefined, b: number[]): boolean =>
    !!a && a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);
  for (const [index, item] of expected.entries()) {
    const detail = details.find(p => p.slug === item.slug);
    if (!detail || normalizeText(detail.title) !== normalizeText(item.title) || typeof detail.description !== 'string' ||
        htmlText(detail.description) !== htmlText(item.description) || detail.is_active !== payload.is_active ||
        detail.is_home !== payload.is_home || detail.is_top !== payload.is_top ||
        (detail.image ?? '') !== item.image || !setMatches(detail.selected_categories, payload.selected_categories) ||
        !setMatches(detail.selected_tags, payload.selected_tags)) throw new Error(`Chương/bài ${index + 1}: dữ liệu lưu khác bản chuẩn bị.`);
    if (formatting === 'reader') verifyFormatting(item.description,detail.description);
    verifyBodyImages(item.description,detail.description);
    if (payload.chapters) {
      const series=expectedSeries(payload);
      if (normalizeText(detail.series?.title ?? '') !== normalizeText(series.title) || detail.series?.slug !== series.slug) {
        throw new Error('Tên/slug series sau lưu không khớp hợp đồng chapter-batch.');
      }
      const previous = expected[index - 1]?.slug ?? null;
      const next = expected[index + 1]?.slug ?? null;
      if ((detail.prev_chapter || null) !== previous || (detail.next_chapter || null) !== next) throw new Error(`Chương ${index + 1}: liên kết trước/sau không đúng thứ tự.`);
    }
    // Bio Blog collapses repeated whitespace in meta descriptions on save.
    // Compare their text while retaining exact title/keyword verification.
    if ((detail.seo_title ?? '') !== payload.seo_title || normalizeText(detail.seo_description ?? '') !== normalizeText(payload.seo_description) ||
        (detail.seo_keywords ?? '') !== payload.seo_keywords) throw new Error(`Chương/bài ${index + 1}: SEO sau lưu không khớp.`);
  }
}

export function previewHtml(story: Story, issues: string[], options?: PublishOptions): string {
  if (options) story = publicationStory(story, options);
  // Remove outbound URLs as well as active content; opening previews never contacts the source site.
  const inertHtml = (value: string): string => sanitizeHtml(value).replace(/\s(?:href|src)="[^"]*"/gi, '');
  return `<!doctype html><html lang="vi"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width"><title>${escapeHtml(story.title)}</title>
<style>*{box-sizing:border-box}body{font:17px/1.7 system-ui;background:#f4f6fa;color:#142034;max-width:900px;margin:35px auto;padding:24px}article,aside{background:white;padding:30px;border-radius:12px;margin:20px 0}h1,h2{line-height:1.3;overflow-wrap:anywhere}small{color:#53637c}img{display:none}li{margin:8px 0}@media(max-width:600px){body{margin:0;padding:12px}article,aside{padding:18px}h1{font-size:25px}}</style></head><body>
<h1>${escapeHtml(story.title)}</h1><small>${story.chapters.length} chương · ${escapeHtml(story.folder)}</small>
<aside><b>SEO Title:</b> ${escapeHtml(story.seo.seo_title)}<br><b>Description:</b> ${escapeHtml(story.seo.meta_description)}
<br><b>Categories:</b> ${escapeHtml(story.seo.categories.join(', '))}<br><b>Tags:</b> ${escapeHtml(story.seo.tags.join(', '))}
<ul>${issues.map(message => `<li>${escapeHtml(message)}</li>`).join('')}</ul></aside>
${story.intro ? `<article><h2>Giới thiệu</h2>${inertHtml(formatContent(plainToHtml(story.intro),options?.formatting))}</article>` : ''}
${story.chapters.map(chapter => `<article><small>Chương ${chapter.order} · ${escapeHtml(chapter.file)}</small><h2>${escapeHtml(chapterName(chapter.title))}</h2>${inertHtml(formatContent(chapter.html,options?.formatting))}</article>`).join('\n')}
</body></html>`;
}
