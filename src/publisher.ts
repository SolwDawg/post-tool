import { randomUUID } from 'node:crypto';
import type { BlogApi } from './api.js';
import { Journal } from './journal.js';
import {imageForStory} from './images.js';
import {ensureImage} from './image-upload.js';
import { buildPayload, duplicates, expectedPosts, namesFor, publicationStory, resolveNames, storyKey, verifyPosts } from './plan.js';
import type { CreatedPost, Post, PublishOptions, Receipt, Story } from './types.js';

export async function prepareOnline(api: BlogApi, story: Story, options: PublishOptions) {
  const image=await imageForStory(story,options);
  if(options.bodyImage&&!image&&!options.imageUrl)throw new Error('--body-image cần Thumbnail.jpg, --image-file hoặc --image-url.');
  const [categories, tags, series, posts] = await Promise.all([
    api.catalog('categories'), api.catalog('tags'), api.catalog('series'),
    api.findDuplicatePosts ? api.findDuplicatePosts(story, options) : api.posts(),
  ]);
  const existing = duplicates(publicationStory(story, options), posts, series);
  const payload = buildPayload(story, options,
    resolveNames(namesFor('categories', story, options), categories, 'Category'),
    resolveNames(namesFor('tags', story, options), tags, 'Tag'));
  return { payload, existing, image };
}

function links(site: string, posts: CreatedPost[]): Receipt['posts'] {
  return posts.map(post => ({ id: post.id, slug: post.slug, url: `${site}/blog/${encodeURIComponent(post.slug)}` }));
}

export async function publishStory(api: BlogApi, journal: Journal, site: string, story: Story, options: PublishOptions): Promise<Receipt> {
  if (options.fast) {
    api.skipImageVerification = true;
  }
  publicationStory(story, options); // Validate the namespace before any read or dispatch.
  const key = storyKey(site, story, options.seriesTitle);
  const previous = (await journal.all(site)).filter(r => r.storyKey === key && r.status !== 'resolved-not-created');
  if (previous.some(r => r.status !== 'verified')) throw new Error('Bộ truyện có request chưa rõ kết quả. Chạy reconcile, không gửi lại.');
  const verified = [...previous].reverse().find(r => r.status === 'verified');
  if (verified) {
    const local=await imageForStory(story,options);
    if(local&&verified.featuredImage?.sha256!==local.sha256)throw new Error('Bài đã đăng có ảnh khác; không upload hoặc tạo bài trùng.');
    const current = await prepareOnline(api, story,local?{...options,imageFile:undefined,imageUrl:verified.payload.image}:options);
    if (verified.fingerprint !== story.fingerprint || JSON.stringify(verified.payload) !== JSON.stringify(current.payload)) {
      throw new Error('Bộ truyện đã đăng nhưng content/trạng thái đã thay đổi. Bản này chỉ tạo mới; cập nhật trên website, không tạo bản trùng.');
    }
    // Check current server state before calling a prior receipt successful again.
    verifyPosts(verified.payload, await Promise.all(verified.posts.map(p => api.post(p.id))),verified.formatting);
    if(local) {
      if(!api.verifyImage)throw new Error('Adapter chưa hỗ trợ xác minh ảnh.');
      await api.verifyImage(verified.payload.image,local.sha256,local.size);
    }
    return verified;
  }
  const prepared = await prepareOnline(api, story, options);
  if (prepared.existing.length) throw new Error(`Đã có bài/series trên website: ${prepared.existing.join('; ')}. Bỏ qua, không ghi đè.`);
  if(prepared.image) {
    const url=await ensureImage(api,journal,site,prepared.image);
    prepared.payload=buildPayload(story,{...options,imageUrl:url},prepared.payload.selected_categories,prepared.payload.selected_tags);
  }
  const now = new Date().toISOString();
  const receipt: Receipt = {
    id: randomUUID(), site, storyKey: key, sourceUrl: story.sourceUrl, sourceId: story.sourceId, folder: story.folder,
    title: prepared.payload.title, seriesTitle: options.seriesTitle, fingerprint: story.fingerprint, payload: prepared.payload,formatting:options.formatting ?? 'source',
    endpoint: prepared.payload.chapters ? '/posts/chapter-batch' : '/posts',
    createdAt: now, updatedAt: now, status: 'dispatched', posts: [],
    featuredImage:prepared.image?{sha256:prepared.image.sha256,file:prepared.image.file,url:prepared.payload.image}:undefined,
  };
  // Persist intent BEFORE any mutation. A crash, timeout, malformed response or Ctrl+C blocks replay.
  await journal.write(receipt);
  try {
    const created = await api.create(receipt.endpoint as '/posts' | '/posts/chapter-batch', receipt.payload);
    receipt.creationResponseShape = api.creationResponseShape;
    receipt.posts = links(site, created);
    receipt.updatedAt = new Date().toISOString();
    await journal.write(receipt);
    const details = await Promise.all(created.map(post => api.post(post.id)));
    verifyPosts(receipt.payload, details,receipt.formatting);
    receipt.status = 'verified';
    receipt.updatedAt = new Date().toISOString();
    await journal.write(receipt);
    return receipt;
  } catch (error) {
    receipt.creationResponseShape = api.creationResponseShape;
    receipt.status = 'outcome-unknown';
    receipt.message = (error as Error).message;
    receipt.updatedAt = new Date().toISOString();
    await journal.write(receipt);
    throw new Error(`Receipt ${receipt.id}: chưa xác minh kết quả. ${(error as Error).message} Chạy reconcile trước; không tự gửi lại.`);
  }
}

export async function reconcileReceipt(api: BlogApi, journal: Journal, receipt: Receipt): Promise<Receipt> {
  if (receipt.status === 'resolved-not-created') throw new Error('Receipt đã được xác nhận không tạo bài.');
  let details: Post[];
  if (receipt.posts.length) details = await Promise.all(receipt.posts.map(post => api.post(post.id)));
  else {
    const expected = expectedPosts(receipt.payload);
    const posts = await api.posts();
    const candidates = posts.filter(post => expected.some(item => item.slug === post.slug));
    if (candidates.length !== expected.length) throw new Error(`Tìm thấy ${candidates.length}/${expected.length} bài dự kiến. Giữ trạng thái chưa rõ kết quả; không tự gửi lại.`);
    details = await Promise.all(candidates.map(post => api.post(post.id)));
  }
  verifyPosts(receipt.payload, details,receipt.formatting);
  if(receipt.featuredImage) {
    const image=await journal.imageUpload(receipt.site,receipt.featuredImage.sha256);
    if(!api.verifyImage||!image||image.url!==receipt.featuredImage.url)throw new Error('Thiếu nhật ký ảnh để xác minh receipt post.');
    await api.verifyImage(image.url,image.image.sha256,image.image.size);
  }
  receipt.posts = links(receipt.site, details);
  receipt.status = 'verified';
  receipt.updatedAt = new Date().toISOString();
  receipt.message = 'Đối chiếu API xác nhận toàn bộ bài, nội dung, SEO, trạng thái và thứ tự chương.';
  await journal.write(receipt);
  return receipt;
}
