#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { SessionApi, siteOrigin, type BlogApi } from './api.js';
import {captureBrowserSession} from './browser.js';
import {HttpClient,type RequestTrace} from './http.js';
import {SessionStore} from './session.js';
import { importLegacy } from './legacy.js';
import { digest, loadStory } from './content.js';
import { Journal } from './journal.js';
import {imageForStory,readImage} from './images.js';
import {ensureImage,reconcileImage} from './image-upload.js';
import {imageHtml} from './formatting.js';
import { buildPayload, expectedPosts, expectedSeries, namesFor, previewHtml } from './plan.js';
import { prepareOnline, publishStory, reconcileReceipt } from './publisher.js';
import { checkedRoot, containedPath, findContentFolders, readContained } from './safe-path.js';
import type { PublishOptions, Receipt, Story, Validation } from './types.js';

const help = `Content Publisher CLI 0.1.0 — nhận folder content có sẵn, không cào nguồn.

publisher.cmd scan PATH                 Liệt kê truyện, chương và lỗi
publisher.cmd import PATH --out PATH    Chuyển info.txt + HTML/TXT sang folder riêng
publisher.cmd validate PATH             Kiểm tra; exit 2 nếu có lỗi
publisher.cmd preview PATH              Xuất HTML xem trước và plan JSON, không truy cập web
publisher.cmd login                     Mở Chrome profile riêng; bạn tự đăng nhập
publisher.cmd session-sync --headless   Đồng bộ phiên Chrome cũ sang HTTP một lần
publisher.cmd network [POST_ID]         Ghi request HTTP chỉ đọc, không lộ token/cookies
publisher.cmd upload-image FILE         Kiểm tra file offline
publisher.cmd upload-image FILE --execute  Upload, bắt URL công khai, xuất HTML Source Code
publisher.cmd catalog                   Đọc danh mục, tags và series từ website
publisher.cmd check PATH                Đối chiếu taxonomy và bài trùng, chỉ đọc website
publisher.cmd publish PATH              In bản chuẩn bị offline; không đăng nếu thiếu --execute
publisher.cmd publish PATH --execute    Tạo và xác minh bài nháp
publisher.cmd publish PATH --execute --public  Tạo và xác minh bài công khai
publisher.cmd status                    Đọc nhật ký cục bộ
publisher.cmd reconcile RECEIPT_ID      Kiểm tra lại request chưa rõ kết quả, không gửi lại
publisher.cmd reconcile-image SHA256   Đọc ảnh công khai, xác minh upload; không gửi lại
publisher.cmd resolve-image SHA256 --not-created --note "..."
                                       Xác nhận thủ công ảnh không được upload
publisher.cmd resolve RECEIPT_ID --not-created --note "..."
                                       Người vận hành xác nhận đã kiểm tra không tạo bài

Tùy chọn:
  --site URL          Mặc định https://aftertheuniform.cfx.bz
  --state PATH        Profile, preview và nhật ký; mặc định .publisher trong tool
  --browser NAME      chrome (mặc định), msedge; chỉ dùng login/session-sync
  --headless          Browser ẩn cho session-sync; lệnh đăng chạy HTTP không cần browser
  --draft / --public  Mặc định draft; không thể chọn cả hai
  --image-url URL     Ảnh cho truyện và mọi chương
  --image-file PATH   Upload ảnh JPEG/PNG/WebP, gán cho bài và tất cả chương
  --no-image          Bỏ tìm Thumbnail.jpg tự động cạnh content
  --body-image        Chèn ảnh featured vào đầu nội dung mỗi bài/chapter
  --category NAME     Thay danh mục metadata; có thể lặp nhiều lần
  --tag NAME          Thay tags metadata; có thể lặp nhiều lần
  --mapping FILE      JSON ánh xạ tên danh mục/tags; xem mapping.example.json
  --out PATH          Folder đích trống cho lệnh import, ngoài cây nguồn
  --format MODE       source (giữ HTML, mặc định) hoặc reader (bố cục dễ đọc)
  --series-title NAME Đặt tên edition để tạo slug riêng; series không intro lấy tên chapter 1
  --show-home         Hiện trên home (mặc định tắt)
  --top-news          Bật top news (mặc định tắt)
  --json              In dữ liệu JSON thay cho bảng

Không tự tạo taxonomy, ghi đè bài cũ, sửa nguồn hoặc thử lại request tạo bài.
`;
const parsed = parseArgs({ allowPositionals: true, options: {
  help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, execute: { type: 'boolean' },
  site: { type: 'string', default: 'https://aftertheuniform.cfx.bz' }, state: { type: 'string' },
  browser: { type: 'string', default: 'chrome' }, headless: { type: 'boolean' },
  draft: { type: 'boolean' }, public: { type: 'boolean' },
  'image-url': { type: 'string', default: '' }, category: { type: 'string', multiple: true }, tag: { type: 'string', multiple: true },
  'image-file': {type:'string'}, 'no-image': {type:'boolean'},
  'body-image': {type:'boolean'},
  mapping: { type: 'string' }, 'show-home': { type: 'boolean' }, 'top-news': { type: 'boolean' },
  'not-created': { type: 'boolean' }, note: { type: 'string' },
  out: { type: 'string' },
  format: { type: 'string', default: 'source' },
  'series-title': { type: 'string' },
} });
const values = parsed.values;
const [command, argument, ...rest] = parsed.positionals;
const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const statePath = path.resolve(values.state ?? path.join(toolRoot, '.publisher'));
const site = siteOrigin(values.site!);
const output = (data: unknown): void => { console.log(JSON.stringify(data, null, 2)); };
const summarize = (validation: Validation) => ({
  folder: validation.folder, title: validation.story?.title ?? '', chapters: validation.story?.chapters.length ?? 0,
  status: validation.ready ? 'ready' : 'needs_review', issues: validation.issues,
});
function showValidations(validations: Validation[]): void {
  if (values.json) output(validations.map(summarize));
  else {
    console.table(validations.map(v => ({ folder: v.folder, chapters: v.story?.chapters.length ?? 0, status: v.ready ? 'ready' : 'needs_review', title: v.story?.title ?? '' })));
    for (const v of validations) for (const issue of v.issues) console.log(`[${issue.level}] ${v.folder}: ${issue.message}`);
  }
}
function receiptSummary(receipt: Receipt) {
  return { receipt: receipt.id, status: receipt.status, site: receipt.site, folder: receipt.folder, title: receipt.title, posts: receipt.posts, message: receipt.message };
}
async function publishOptions(): Promise<PublishOptions> {
  if(Number(!!values['image-file'])+Number(!!values['image-url'])+Number(!!values['no-image'])>1)throw new Error('Chỉ chọn một trong --image-file, --image-url, --no-image.');
  if(values['image-file']!==undefined&&!values['image-file'].trim())throw new Error('--image-file không được trống.');
  if(values['body-image']&&values['no-image'])throw new Error('--body-image cần ảnh; không kết hợp --no-image.');
  if (values.draft && values.public) throw new Error('Chọn --draft hoặc --public, không chọn cả hai.');
  if (!['source','reader'].includes(values.format!)) throw new Error('--format chỉ nhận source hoặc reader.');
  if (values['series-title'] !== undefined && !values['series-title'].trim()) throw new Error('--series-title không được trống.');
  let mapping: PublishOptions['mapping'] = {};
  if (values.mapping) {
    const file = path.resolve(values.mapping);
    const data: unknown = JSON.parse(await readContained(await checkedRoot(path.dirname(file)), path.basename(file)));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Mapping cần object JSON.');
    mapping = data as PublishOptions['mapping'];
    for (const [type, entries] of Object.entries(mapping)) {
      if (!['categories', 'tags'].includes(type) || !entries || typeof entries !== 'object' || Array.isArray(entries) ||
          Object.values(entries).some(list => !Array.isArray(list) || list.some(v => typeof v !== 'string' || !v.trim()))) {
        throw new Error('Mapping cần {categories: {tên_nguồn: [tên_website]}, tags: {...}}.');
      }
    }
  }
  return { visibility: values.public ? 'public' : 'draft', imageUrl: values['image-url']!,
    imageFile:values['image-file'],noImage:!!values['no-image'],bodyImage:!!values['body-image'],
    categories: values.category, tags: values.tag, mapping, showHome: !!values['show-home'], topNews: !!values['top-news'],
    formatting: values.format as 'source' | 'reader', seriesTitle: values['series-title']?.trim() };
}

async function withApi<T>(journal: Journal, operation: (api: BlogApi, context: HttpClient, browserNetwork?:RequestTrace[]) => Promise<T>, login = false): Promise<T> {
  const release = await journal.lock(site);
  let context:HttpClient|undefined;
  const store=new SessionStore(journal.root,site);
  const aborted=new AbortController();
  const interrupt = (): void => { aborted.abort();void context?.dispose(); };
  process.once('SIGINT', interrupt);
  try {
    if(login&&!stdin.isTTY)throw Error('Lệnh login cần terminal tương tác để bạn tự đăng nhập.');
    const captured=login||command==='session-sync'?await captureBrowserSession(journal.root,site,values.browser!,!login&&!!values.headless,login?async()=>{
      const terminal=createInterface({input:stdin,output:stdout});
      try{await terminal.question('Tự đăng nhập trong Chrome vừa mở. Khi xong nhấn Enter: ',{signal:aborted.signal});}finally{terminal.close();}
    }:undefined,aborted.signal):undefined;
    const jar=captured?.jar??await store.load();
    if(!jar)throw Error('Chưa có phiên HTTP. Chạy session-sync --headless để dùng profile cũ, hoặc login.');
    context=new HttpClient({origin:site,jar});
    const api=await SessionApi.fromHttp(context,site);
    await store.save(context.jar);
    return await operation(api,context,captured?.network);
  } finally {
    process.removeListener('SIGINT', interrupt);
    try{if(context){await context.dispose();await store.save(context.jar);}}finally{await release();}
  }
}

async function main(): Promise<void> {
  if (!command || values.help) { console.log(help); return; }
  if (rest.length) throw new Error('Chỉ nhận một PATH hoặc receipt ID.');
  if (command === 'import') {
    if (!argument || !values.out) throw new Error('import cần PATH nguồn và --out PATH đích trống.');
    const results = await importLegacy(argument, values.out);
    output(results);
    if (results.some(r=>r.status!=='ready')) process.exitCode=2;
    return;
  }
  const inputCommands = ['scan', 'validate', 'preview', 'check', 'publish'];
  let validations: Validation[] = [];
  if (inputCommands.includes(command)) {
    if (!argument) throw new Error(`${command} cần PATH.`);
    validations = await Promise.all((await findContentFolders(argument)).map(loadStory));
    if (['scan', 'validate'].includes(command)) {
      showValidations(validations);
      if (validations.some(v => !v.ready)) process.exitCode = 2;
      return;
    }
  } else if (!['login','session-sync','network', 'catalog', 'status', 'reconcile', 'resolve','reconcile-image','resolve-image','upload-image'].includes(command)) throw new Error(`Lệnh không hợp lệ: ${command}. Dùng --help.`);
  if (['login','session-sync', 'catalog', 'status'].includes(command) && argument) throw new Error(`${command} không nhận PATH.`);
  if(command==='network'&&argument&&(!Number.isSafeInteger(Number(argument))||Number(argument)<1))throw Error('network POST_ID phải là số nguyên dương.');
  if (validations.length) {
    // Tool-owned outputs must never be written into a content folder.
    for (const v of validations) {
      const relative = path.relative(v.folder, statePath);
      if (!relative || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
        throw new Error('--state không được nằm trong folder content.');
      }
    }
  }
  if (command === 'publish' && !values.execute) {
    const options = await publishOptions();
    const images=await Promise.all(validations.map(v=>v.story?imageForStory(v.story,options):undefined));
    output({ mode: 'offline-dry-run', site, visibility: options.visibility, format:options.formatting, stories: validations.map((v,index) => ({ ...summarize(v),
      featured_image:images[index]??(options.imageUrl?{url:options.imageUrl}:null),apply_image_to_all:!!images[index]||!!options.imageUrl,body_image:!!options.bodyImage,
      publication_title: v.story ? buildPayload(v.story,options,[],[]).title : undefined,
      categories: v.story ? namesFor('categories', v.story, options) : [], tags: v.story ? namesFor('tags', v.story, options) : [],
      endpoint: v.story?.chapters.length === 1 ? '/posts' : '/posts/chapter-batch',
    })), next: 'Để đăng thật: chạy cùng lệnh với --execute. Chưa kiểm tra taxonomy hoặc bài trùng trên website.' });
    if (validations.some(v => !v.ready)) process.exitCode = 2;
    return;
  }
  if (['check', 'publish'].includes(command) && validations.some(v => !v.ready)) {
    showValidations(validations);
    throw new Error('Có content chưa đạt kiểm tra. Sửa trong Antigravity rồi chạy validate lại.');
  }
  if(['check','publish'].includes(command)) {
    const options=await publishOptions();
    // Validate every local image before opening a browser or mutating any story.
    await Promise.all(validations.map(v=>imageForStory(v.story!,options)));
    if(options.bodyImage)for(const v of validations)if(!options.imageUrl&&!await imageForStory(v.story!,options))throw new Error('--body-image cần Thumbnail.jpg, --image-file hoặc --image-url.');
  }
  const uploadImage=command==='upload-image'?(argument?await readImage(argument):undefined):undefined;
  if(command==='upload-image'&&!uploadImage)throw new Error('upload-image cần FILE ảnh.');
  if(uploadImage&&!values.execute){output({mode:'offline-dry-run',site,image:uploadImage.image,next:'Thêm --execute để upload và lấy URL; không tạo bài.'});return;}
  const journal = await Journal.open(statePath);
  if (command === 'preview') {
    const options = await publishOptions();
    for (const validation of validations) {
      if (!validation.story) continue;
      const story = validation.story;
      const image=await imageForStory(story,options);
      const key = digest(story.folder).slice(0, 16);
      const file = await containedPath(journal.root, `previews/${key}.html`, true);
      const planFile = await containedPath(journal.root, `previews/${key}.json`);
      const payload=buildPayload(story,options,[],[]);
      const fragments=[];
      for (const [index,post] of expectedPosts(payload).entries()) {
        const fragment=await containedPath(journal.root,`previews/${key}.chapter-${index+1}.html`);
        await writeFile(fragment,post.description);
        fragments.push({order:index+1,title:post.title,file:fragment});
      }
      const warnings = validation.issues.map(i => `[${i.level}] ${i.message}`);
      if (story.chapters.length > 1) warnings.push('API chapter-batch dùng SEO toàn truyện cho các chương; SEO riêng trong metadata chưa được áp dụng.');
      await writeFile(file, previewHtml(story, warnings,options));
      await writeFile(planFile, JSON.stringify({ ...summarize(validation), fingerprint: story.fingerprint,
        categories: namesFor('categories', story, options), tags: namesFor('tags', story, options),
        payload,featured_image:image??(options.imageUrl?{url:options.imageUrl}:null),apply_image_to_all:!!image||!!options.imageUrl,body_image:!!options.bodyImage,
        series:payload.chapters?expectedSeries(payload):undefined,format:options.formatting,source_html:fragments,note: 'Offline preview: taxonomy ID chưa được đối chiếu. Ảnh local chưa upload; payload image còn trống. Không dùng trực tiếp file này để gửi API.' }, null, 2));
      output({ status: validation.ready ? 'ready' : 'needs_review',featured_image:image??(options.imageUrl?{url:options.imageUrl}:null),format:options.formatting,preview: file,plan:planFile,source_html:fragments });
    }
    if (validations.some(v => !v.ready)) process.exitCode = 2;
    return;
  }
  if (command === 'status') { output((await journal.all(site)).map(receiptSummary)); return; }
  if(command==='resolve-image') {
    if(!argument||!values['not-created']||!values.note?.trim())throw new Error('Cần SHA256, --not-created và --note sau khi kiểm tra ảnh không upload.');
    const release=await journal.lock(site);
    try {
      const receipt=await journal.imageUpload(site,argument);
      if(!receipt||!['dispatched','outcome-unknown'].includes(receipt.status))throw new Error('Không có upload chưa rõ kết quả.');
      receipt.status='resolved-not-uploaded';receipt.message=values.note.trim();receipt.updatedAt=new Date().toISOString();
      await journal.writeImageUpload(receipt);output(receipt);
    }finally {await release();}
    return;
  }
  if (command === 'resolve') {
    if (!argument || !values['not-created'] || !values.note?.trim()) throw new Error('Cần receipt ID, --not-created và --note sau khi bạn đã kiểm tra website không có bài được tạo.');
    const release = await journal.lock(site);
    try {
      const receipt = (await journal.all(site)).find(r => r.id === argument);
      if (!receipt || !['dispatched', 'outcome-unknown'].includes(receipt.status)) throw new Error('Không tìm thấy receipt chưa rõ kết quả.');
      receipt.status = 'resolved-not-created'; receipt.message = `Người vận hành xác nhận không tạo bài: ${values.note.trim()}`;
      receipt.updatedAt = new Date().toISOString(); await journal.write(receipt); output(receiptSummary(receipt));
    } finally { await release(); }
    return;
  }
  await withApi(journal, async (api,context,browserNetwork) => {
    if(command==='session-sync'){
      output({engine:'native-http',session:'verified',cookie_names:(await context.jar.getCookies(`${site}/admin/posts`)).map(c=>c.key),browser_network:browserNetwork,http_network:context.trace});return;
    }
    if(command==='network'){
      const [categories,tags,series,posts]=await Promise.all([api.catalog('categories'),api.catalog('tags'),api.catalog('series'),api.posts()]);
      const post=argument?await api.post(Number(argument)):undefined;
      output({engine:'native-http',site,categories:categories.length,tags:tags.length,series:series.length,posts:posts.length,post:post?{id:post.id,slug:post.slug,is_active:post.is_active}:undefined,requests:context.trace});return;
    }
    if(uploadImage){
      const url=await ensureImage(api,journal,site,uploadImage.image);
      const receipt=await journal.imageUpload(site,uploadImage.image.sha256);
      const html=imageHtml(url,path.parse(uploadImage.image.name).name);
      const file=await containedPath(journal.root,`previews/image-${uploadImage.image.sha256}.html`,true);
      await writeFile(file,html);
      output({status:'verified',url,sha256:uploadImage.image.sha256,network:receipt?.network,source_html:file,html});return;
    }
    if (command === 'login') { console.log(`Đã kiểm tra/lưu phiên HTTP: ${site}. Chrome đã đóng; đăng bài bằng HTTP trực tiếp.`); return; }
    if (command === 'catalog') {
      const [categories, tags, series] = await Promise.all([api.catalog('categories'), api.catalog('tags'), api.catalog('series')]);
      output({ categories, tags, series }); return;
    }
    if(command==='reconcile-image') {
      if(!argument)throw new Error('reconcile-image cần SHA256 ảnh.');
      output(await reconcileImage(api,journal,site,argument));return;
    }
    if (command === 'reconcile') {
      if (!argument) throw new Error('reconcile cần receipt ID (xem status).');
      const receipt = (await journal.all(site)).find(r => r.id === argument);
      if (!receipt) throw new Error('Không tìm thấy receipt thuộc website này.');
      output(receiptSummary(await reconcileReceipt(api, journal, receipt))); return;
    }
    const options = await publishOptions();
    for (const validation of validations) {
      const story = validation.story as Story;
      if (command === 'check') {
        const prepared = await prepareOnline(api, story, options);
        output({ ...summarize(validation), site, visibility: options.visibility, existing: prepared.existing,
          publication_title: prepared.payload.title, publication_slug: prepared.payload.slug,
          series:prepared.payload.chapters?expectedSeries(prepared.payload):undefined,
          featured_image:prepared.image??(options.imageUrl?{url:options.imageUrl}:null),apply_image_to_all:!!prepared.image||!!options.imageUrl,
          format:options.formatting,
          selected_categories: prepared.payload.selected_categories, selected_tags: prepared.payload.selected_tags,
          note: 'Chỉ đọc website. Nếu existing không rỗng thì publish sẽ dừng.' });
      } else {
        console.log(`${story.title} — ${story.chapters.length} chương — ${options.visibility}`);
        if (story.chapters.length > 1) console.log('SEO: dùng SEO toàn truyện cho các chương; không áp dụng SEO riêng từng chương trong bản 0.1.');
        output(receiptSummary(await publishStory(api, journal, site, story, options)));
      }
    }
  }, command === 'login');
}

main().catch(error => {
  console.error(`Lỗi: ${(error as Error).message}`);
  process.exitCode = 1;
});
