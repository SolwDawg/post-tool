import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { checkedRoot, readContained } from './safe-path.js';
import type { Chapter, Issue, Seo, Story, Validation } from './types.js';

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const normalizeText = (value: string): string => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function slugify(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90).replace(/-$/, '') || `story-${digest(value).slice(0, 12)}`;
}
export function plainToHtml(value: string): string {
  if (!value.trim()) return '';
  return value.trim().split(/\r?\n\s*\r?\n/).map(p => `<p>${escapeHtml(p).replace(/\r?\n/g, '<br>')}</p>`).join('\n');
}
export function htmlText(value: string): string {
  const doc = new JSDOM(`<body>${value}</body>`).window.document;
  for (const element of doc.querySelectorAll('script,style')) element.remove();
  for (const element of doc.querySelectorAll('p,div,section,li,h1,h2,h3,h4,blockquote,br,tr')) {
    element.after(doc.createTextNode(' '));
  }
  return normalizeText(doc.body.textContent ?? '');
}
const allowedTags = new Set('p br strong em b i u s span blockquote ul ol li a img h2 h3 h4 hr table tbody thead tfoot tr td th figure figcaption div section'.split(' '));
const styles = new Set('color background-color font-size font-family font-weight font-style text-align text-decoration line-height margin margin-top margin-bottom padding padding-left width max-width height box-sizing overflow-wrap border border-left border-top border-radius border-collapse white-space'.split(' '));
export function sanitizeHtml(html: string): string {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  for (const element of [...doc.body.querySelectorAll('*')]) {
    const name = element.tagName.toLowerCase();
    if (!allowedTags.has(name)) {
      if (['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'svg', 'math', 'link', 'meta', 'base'].includes(name)) element.remove();
      else element.replaceWith(...element.childNodes);
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const key = attribute.name.toLowerCase();
      const value = attribute.value;
      let keep = ['alt', 'title', 'colspan', 'rowspan'].includes(key);
      if (key === 'href' && name === 'a' || key === 'src' && name === 'img') {
        try { const url = new URL(value); keep = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
        catch { keep = false; }
      }
      if (key === 'style') {
        const clean = value.split(';').filter(declaration => {
          const colon = declaration.indexOf(':');
          return colon > 0 && styles.has(declaration.slice(0, colon).trim().toLowerCase()) &&
            !/url\s*\(|expression|@|\\|[<>]/i.test(declaration.slice(colon + 1));
        }).join(';');
        if (clean) element.setAttribute('style', clean); else element.removeAttribute('style');
        continue;
      }
      if (!keep) element.removeAttribute(attribute.name);
    }
  }
  return doc.body.innerHTML.trim();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Metadata phải là object JSON.');
  return value as Record<string, unknown>;
}
/** Antigravity's current exports use these explicit aliases; contradictory declarations fail. */
function metadataAliases(input:Record<string,unknown>):Record<string,unknown> {
  const rename=(value:Record<string,unknown>,aliases:Record<string,string>):Record<string,unknown>=>{
    const data={...value};
    for(const [canonical,alias] of Object.entries(aliases)) {
      if(data[canonical]!==undefined&&data[alias]!==undefined&&JSON.stringify(data[canonical])!==JSON.stringify(data[alias])) {
        throw new Error(`Metadata mâu thuẫn giữa ${canonical} và ${alias}.`);
      }
      if(data[canonical]===undefined&&data[alias]!==undefined)data[canonical]=data[alias];
    }
    return data;
  };
  const data=rename(input,{source_url:'original_source_url',status:'review_status',issues:'review_issues'});
  if(data.seo!=null)data.seo=rename(object(data.seo),{seo_title:'title'});
  if(Array.isArray(data.chapters))data.chapters=data.chapters.map(raw=>{
    const entry=rename(object(raw),{chapter_title:'title',content_file:'filename'});
    if(entry.seo!=null)entry.seo=rename(object(entry.seo),{seo_title:'title'});
    return entry;
  });
  return data;
}
function text(value: unknown, label: string, required = true): string {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || required && !value.trim()) throw new Error(`${label}: thiếu chuỗi hợp lệ.`);
  return value.trim();
}
function strings(value: unknown, label: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim())) throw new Error(`${label}: phải là mảng chuỗi không rỗng.`);
  return [...new Set(value.map(v => (v as string).trim()))];
}
function seo(value: unknown, required = true): Seo {
  const data = value == null && !required ? {} : object(value);
  return {
    seo_title: text(data.seo_title, 'SEO title', required),
    meta_description: text(data.meta_description, 'Meta description', required),
    focus_keyword: text(data.focus_keyword, 'Focus keyword', false),
    secondary_keywords: strings(data.secondary_keywords, 'Secondary keywords'),
    categories: strings(data.categories, 'Categories'), tags: strings(data.tags, 'Tags'),
  };
}
export function chapterName(value: string): string {
  return value.replace(/^chapter\s+\d+\s*[:—–-]\s*/i, '').trim();
}

export async function loadStory(input: string): Promise<Validation> {
  const result: Validation = { folder: input, ready: false, issues: [] };
  const issue = (level: Issue['level'], code: string, message: string): void => { result.issues.push({ level, code, message }); };
  try {
    const folder = await checkedRoot(input);
    result.folder = folder;
    let metadata: Record<string, unknown>;
    try { metadata = metadataAliases(object(JSON.parse(await readContained(folder, 'metadata.json')))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Thiếu metadata.json. Tạo lại metadata trong Antigravity; tool không đoán chương từ info.txt.');
      throw error;
    }
    const title = text(metadata.story_title, 'story_title');
    let sourceUrl = '';
    let sourceId: string | undefined;
    if (metadata.source_url) {
      const url = new URL(text(metadata.source_url, 'source_url'));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('source_url không hợp lệ.');
      url.hash = ''; sourceUrl = url.href;
    } else {
      sourceId = text(metadata.source_id, 'source_id (khi không lưu URL nguồn)');
      if (!/^local-sha256:[a-f0-9]{64}$/.test(sourceId)) throw new Error('source_id phải là local-sha256:<64 ký tự hex>.');
      issue('warning', 'LOCAL_SOURCE', 'Nguồn chỉ có định danh nội dung cục bộ; không có URL nguồn để xác minh crawl.');
    }
    const intro = text(metadata.intro, 'intro', false);
    const storySeo = seo(metadata.seo);
    if (metadata.status !== 'ready') issue('error', 'SOURCE_NOT_READY', 'Antigravity chưa đánh dấu bộ content là ready.');
    if (Array.isArray(metadata.issues) && metadata.issues.length) issue('error', 'SOURCE_ISSUES', 'Metadata còn issues; sửa trong Antigravity trước.');
    if (/[.…]{3}$|…$/.test(storySeo.meta_description)) issue('warning', 'SEO_TRUNCATED', 'Meta description có dấu cắt cuối câu; kiểm tra lại.');
    if (intro === '') issue('warning', 'NO_INTRO', 'Không có intro; dùng chế độ đi thẳng vào Chapter 1.');
    if (!Array.isArray(metadata.chapters) || !metadata.chapters.length) throw new Error('chapters phải có ít nhất một chương.');
    let document: Document | undefined;
    try { document = new JSDOM(await readContained(folder, 'article_seo_ready.html')).window.document; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      issue('warning', 'NO_HTML', 'Thiếu HTML; tạo định dạng đoạn văn từ TXT.');
    }
    if (document?.querySelector('script,iframe,object,embed,form,base') ||
        document && [...document.querySelectorAll('*')].some(e => [...e.attributes].some(a => /^on/i.test(a.name)))) {
      issue('error', 'ACTIVE_HTML', 'HTML chứa script, iframe, form hoặc event handler; sửa nguồn trước khi đăng.');
    }
    const slug = slugify(title);
    const chapters: Chapter[] = [];
    const orders = new Set<number>();
    const filenames = new Set<string>();
    const bodies = new Set<string>();
    for (const raw of metadata.chapters) {
      const entry = object(raw);
      const order = entry.order;
      if (typeof order !== 'number' || !Number.isSafeInteger(order) || order < 1 || orders.has(order)) throw new Error('order chương phải là số nguyên dương, không trùng.');
      orders.add(order);
      const chapterTitle = text(entry.chapter_title, `Chương ${order}: chapter_title`);
      const declaredNumber = /^chapter\s+(\d+)\b/i.exec(chapterTitle);
      if (declaredNumber && Number(declaredNumber[1]) !== order) issue('error', 'TITLE_NUMBER_MISMATCH', `Chương ${order}: số trong tiêu đề không khớp order.`);
      const file = text(entry.content_file, `Chương ${order}: content_file`);
      if (filenames.has(file.toLowerCase())) throw new Error('Hai chương tham chiếu cùng file nội dung.');
      filenames.add(file.toLowerCase());
      const body = (await readContained(folder, file)).trim();
      const normalized = normalizeText(body);
      if (!normalized) issue('error', 'EMPTY_CHAPTER', `Chương ${order} rỗng.`);
      const onlyTitle = normalized.replace(/\s*009\s*$/, '');
      if ([title, chapterTitle, chapterName(chapterTitle)].some(t => normalizeText(t) === onlyTitle)) {
        issue('error', 'TITLE_ONLY', `Chương ${order} chỉ có tiêu đề, không có nội dung truyện.`);
      }
      const openingNumber = /^chapter\s+(\d+)\b/i.exec(body);
      if (openingNumber && Number(openingNumber[1]) !== order) issue('error', 'BODY_NUMBER_MISMATCH', `Chương ${order}: nội dung bắt đầu bằng chương ${openingNumber[1]}.`);
      if (/Comments\s+0\s*$/i.test(body)) issue('error', 'TRAILING_UI', `Chương ${order}: còn Comments 0 ở cuối.`);
      if (bodies.has(normalized)) issue('error', 'DUPLICATE_BODY', `Chương ${order}: trùng toàn bộ nội dung với chương khác.`);
      bodies.add(normalized);
      let html = plainToHtml(body);
      if (document) {
        const sections = document.querySelectorAll(`[id="chapter-${order}"]`);
        if (sections.length !== 1) issue('error', 'HTML_SECTION', `HTML cần đúng một section chapter-${order}.`);
        else {
          const section = sections[0]!.cloneNode(true) as Element;
          const heading = section.querySelector('h1,h2');
          if (heading) {
            if (chapterName(normalizeText(heading.textContent ?? '')) !== chapterName(normalizeText(chapterTitle))) {
              issue('error', 'HTML_TITLE_MISMATCH', `Chương ${order}: tiêu đề HTML không khớp metadata.`);
            }
            heading.remove();
          }
          if (htmlText(section.innerHTML) !== normalized) issue('error', 'HTML_TEXT_MISMATCH', `Chương ${order}: nội dung HTML và TXT khác nhau.`);
          html = sanitizeHtml(section.innerHTML);
        }
      }
      chapters.push({ order, title: chapterTitle, slug: `${slug}-chapter-${order}`, file, text: body, html, seo: seo(entry.seo, false) });
    }
    chapters.sort((a, b) => a.order - b.order);
    if (chapters.some((c, i) => c.order !== i + 1)) issue('error', 'MISSING_ORDER', 'order chương phải liên tục từ 1 đến n.');
    if (document && document.querySelectorAll('[id^="chapter-"]').length !== chapters.length) issue('error', 'HTML_COUNT', 'Số section HTML khác số chương metadata.');
    for (const entry of await readdir(folder)) {
      if (/^chapter_\d+\.txt$/i.test(entry) && !filenames.has(entry.toLowerCase())) issue('error', 'UNDECLARED_CHAPTER', `File ${entry} chưa được khai báo trong metadata.`);
    }
    const story: Story = { folder, title, slug, sourceUrl, sourceId, intro, seo: storySeo, chapters, fingerprint: '' };
    story.fingerprint = digest(JSON.stringify({ title, sourceUrl: story.sourceUrl, sourceId, intro, seo: storySeo,
      chapters: chapters.map(({ order, title: name, slug: chapterSlug, html, seo: chapterSeo }) => ({ order, name, chapterSlug, html, seo: chapterSeo })) }));
    result.story = story;
    result.ready = !result.issues.some(i => i.level === 'error');
  } catch (error) { issue('error', 'INVALID_CONTENT', (error as Error).message); }
  return result;
}
