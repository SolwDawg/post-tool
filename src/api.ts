import {HttpClient,request as isolatedRequest} from './http.js';
import {JSDOM} from 'jsdom';
import {createHash} from 'node:crypto';
import {publicImageUrl,maxImageBytes} from './images.js';
import type { CreatedPost, ImageNetworkRequest, LocalImage, Payload, Post, PublishOptions, Story, Taxonomy } from './types.js';

export interface BlogApi {
  imageNetwork?: ImageNetworkRequest[];
  skipImageVerification?: boolean;
  catalog(type: 'categories' | 'tags' | 'series'): Promise<Taxonomy[]>;
  posts(): Promise<Post[]>;
  findDuplicatePosts?(story: Story, options?: PublishOptions): Promise<Post[]>;
  post(id: number): Promise<Post>;
  create(endpoint: '/posts' | '/posts/chapter-batch', payload: Payload): Promise<CreatedPost[]>;
  creationResponseShape?: { keys: string[]; isActiveType: string }[];
  uploadImage?(image:LocalImage,buffer:Buffer,onPresigned:(url:string)=>Promise<void>):Promise<string>;
  verifyImage?(url:string,sha256:string,size:number):Promise<void>;
}
export function siteOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:') || url.username || url.password || url.search || url.hash) {
    throw new Error('Website cần HTTPS (HTTP chỉ cho localhost), không có credentials/query/hash.');
  }
  return url.origin;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('API trả về schema không hợp lệ.');
  return value as Record<string, unknown>;
}
function checkPost(value: unknown): Post {
  const data = record(value);
  if (!Number.isSafeInteger(data.id) || Number(data.id) < 1 || typeof data.title !== 'string' ||
      typeof data.slug !== 'string' || !data.slug || typeof data.is_active !== 'boolean') {
    throw new Error('API post thiếu id/title/slug/is_active; dừng để tránh xác nhận nhầm.');
  }
  return data as unknown as Post;
}

export class SessionApi implements BlogApi {
  imageNetwork?: ImageNetworkRequest[];
  creationResponseShape?: { keys: string[]; isActiveType: string }[];
  skipImageVerification?: boolean;
  private taxonomyCache = new Map<string, Taxonomy[]>();
  private postsCache?: Post[];
  get network(){return this.request.trace;}
  constructor(private readonly request: HttpClient, readonly site: string, private readonly csrf: string) {}

  static async fromHttp(context:HttpClient,site:string):Promise<SessionApi>{
    const response=await context.get(`${site}/admin/posts`);
    let html:string;
    try{if(response.status()!==200)throw Error(`Phiên HTTP không hợp lệ (admin HTTP ${response.status()}). Chạy login hoặc session-sync.`);html=await response.text();}finally{await response.dispose();}
    const token = html.match(/meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i)?.[1]
      ?? new JSDOM(html).window.document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
    if (!token) throw new Error('Không có CSRF token của Bio Blog; kiểm tra lại website/phiên đăng nhập.');
    const api = new SessionApi(context, site, token);
    await api.call('GET', '/posts?per_page=1');
    return api;
  }

  private async call(method: 'GET' | 'POST', endpoint: string, data?: unknown, observed?: (status:number,json?:Record<string,unknown>)=>void): Promise<unknown> {
    const response = await this.request.fetch(`${this.site}/admin/api/v1${endpoint}`, {
      method, data, headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-TOKEN': this.csrf },
      timeout: 30_000, maxRedirects: 0, maxRetries: 0, failOnStatusCode: false,
    });
    try {
      const status = response.status();
      observed?.(status);
      if ([401, 403, 419].includes(status)) throw new Error(`HTTP ${status}: phiên đăng nhập/quyền không hợp lệ. Chạy login lại.`);
      if (status < 200 || status >= 300) throw new Error(`API ${method} ${endpoint.split('?')[0]}: HTTP ${status}; không tự thử lại.`);
      const json = record(await response.json());
      observed?.(status,json);
      // The observed upload endpoint uses {message,data}; post APIs require {ok:true,data}.
      const uploadEnvelope=endpoint==='/uploads/presigned-image-url'&&json.ok===undefined&&typeof json.message==='string'&&
        json.data&&typeof json.data==='object'&&!Array.isArray(json.data)&&
        typeof (json.data as Record<string,unknown>).fileUrl==='string'&&
        !!(json.data as Record<string,unknown>).upload;
      if ((json.ok !== true&&!uploadEnvelope) || !('data' in json)) throw new Error('API không xác nhận thành công bằng ok=true và data.');
      return json.data;
    } finally { await response.dispose(); }
  }

  private async list(endpoint: string, params: Record<string, number>): Promise<unknown[]> {
    const items: unknown[] = [];
    let lastPage = 1;
    for (let page = 1; page <= lastPage; page++) {
      const search = new URLSearchParams(Object.entries({ ...params, page }).map(([key, value]) => [key, String(value)]));
      const data = await this.call('GET', `${endpoint}?${search}`);
      if (Array.isArray(data)) {
        if (page !== 1) throw new Error('API phân trang thay đổi schema.');
        return data;
      }
      const paginated = record(data);
      if (!Array.isArray(paginated.data) || !Number.isSafeInteger(paginated.last_page) ||
          Number(paginated.last_page) < page || paginated.current_page !== page) {
        throw new Error('API thiếu phân trang đầy đủ; không thể bảo đảm kiểm tra trùng.');
      }
      lastPage = Number(paginated.last_page);
      if (lastPage > 10_000) throw new Error('Danh sách quá lớn; cần adapter kiểm tra trùng qua tìm kiếm.');
      items.push(...paginated.data);
    }
    return items;
  }

  async catalog(type: 'categories' | 'tags' | 'series'): Promise<Taxonomy[]> {
    const cached = this.taxonomyCache.get(type);
    if (cached) return cached;
    const result = (await this.list(`/taxonomies/${type}`, { per_page: 100 })).map(value => {
      const data = record(value);
      if (!Number.isSafeInteger(data.id) || Number(data.id) < 1 || typeof data.title !== 'string') throw new Error('Taxonomy API thiếu id/title.');
      return data as unknown as Taxonomy;
    });
    this.taxonomyCache.set(type, result);
    return result;
  }
  async posts(): Promise<Post[]> {
    return (await this.list('/posts', { per_page: 100 })).map(checkPost);
  }
  async findDuplicatePosts(story: Story, _options?: PublishOptions): Promise<Post[]> {
    const queries = new Set<string>();
    if (story.title) queries.add(story.title.slice(0, 50).trim());
    if (story.slug) queries.add(story.slug.slice(0, 50).trim());
    for (const ch of story.chapters) {
      if (ch.slug) queries.add(ch.slug.slice(0, 50).trim());
    }
    const candidates = new Map<number, Post>();
    for (const q of queries) {
      try {
        const search = new URLSearchParams({ search: q, per_page: '50' });
        const res = await this.call('GET', `/posts?${search}`);
        const data = record(res);
        const list = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
        for (const item of list) {
          try {
            const p = checkPost(item);
            candidates.set(p.id, p);
          } catch {}
        }
      } catch {
        return this.posts();
      }
    }
    return Array.from(candidates.values());
  }
  async post(id: number): Promise<Post> {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Post ID không hợp lệ.');
    return checkPost(await this.call('GET', `/posts/${id}`));
  }
  async uploadImage(image:LocalImage,buffer:Buffer,onPresigned:(url:string)=>Promise<void>):Promise<string> {
    if(buffer.length!==image.size||createHash('sha256').update(buffer).digest('hex')!==image.sha256)throw new Error('Dữ liệu ảnh đã thay đổi trước upload.');
    const presign:ImageNetworkRequest={stage:'presign',method:'POST',url:`${this.site}/admin/api/v1/uploads/presigned-image-url`,fileName:image.name,contentType:image.mime,bytes:image.size};
    this.imageNetwork=[presign];
    const data=record(await this.call('POST','/uploads/presigned-image-url',{
      fileName:image.name,contentType:image.mime,size:image.size,auditContext:{record_type:'Post',action_label:'upload featured image'},
    },(status,json)=>{presign.status=status;if(json)presign.responseKeys=Object.keys(json);}));
    presign.dataKeys=Object.keys(data);
    presign.storage={};
    for(const key of ['disk','bucket','objectKey'] as const)if(typeof data[key]==='string')presign.storage[key]=data[key];
    const upload=record(data.upload);
    if(typeof data.fileUrl!=='string'||typeof upload.url!=='string')throw new Error('Upload API thiếu URL ảnh.');
    const fileUrl=publicImageUrl(data.fileUrl);
    presign.fileUrl=fileUrl;
    const target=new URL(upload.url);
    if(target.username||target.password||target.hash||target.protocol!=='https:'&&!(new URL(this.site).protocol==='http:'&&target.origin===new URL(this.site).origin))throw new Error('Upload target không hợp lệ.');
    const method=upload.method??'PUT';
    if(method!=='PUT'&&method!=='POST')throw new Error('Upload chỉ hỗ trợ PUT/POST như Choose image.');
    const headers:Record<string,string>={};
    if(upload.headers!==undefined)for(const [key,value] of Object.entries(record(upload.headers))) {
      if(typeof value!=='string'||/[\r\n]/.test(key+value))throw new Error('Upload header không hợp lệ.');
      if(/^(cookie|authorization|proxy-authorization|x-csrf-token|x-xsrf-token|host)$/i.test(key))throw new Error('Upload không được chuyển header phiên website.');
      if(key.toLowerCase()!=='content-length')headers[key]=value;
    }
    if(!Object.keys(headers).some(k=>k.toLowerCase()==='content-type'))headers['Content-Type']=image.mime;
    const storageTrace:ImageNetworkRequest={stage:'storage',method,url:`${target.origin}${target.pathname}`,bytes:image.size,sha256:image.sha256};
    this.imageNetwork.push(storageTrace);
    // Persist only the unsigned public URL; never persist signed storage credentials.
    await onPresigned(fileUrl);
    const storage=await isolatedRequest.newContext({timeout:30000,signal:this.request.signal});
    try {
      let response;
      try {response=await storage.fetch(target.href,{method,headers,data:buffer,maxRedirects:0,maxRetries:0,failOnStatusCode:false});}
      catch {throw new Error('Upload storage không có phản hồi; kết quả chưa rõ, không tự gửi lại.');}
      const status=response.status();storageTrace.status=status;await response.dispose();
      if(status<200||status>=300)throw new Error(`Upload storage HTTP ${status}; không tự gửi lại.`);
    }finally {await storage.dispose();}
    const publicTrace:ImageNetworkRequest={stage:'public-image',method:'GET',url:fileUrl};
    this.imageNetwork.push(publicTrace);
    if (!this.skipImageVerification) {
      await this.verifyImage(fileUrl,image.sha256,image.size,publicTrace);
    } else {
      publicTrace.status = 200;
      publicTrace.bytes = image.size;
      publicTrace.sha256 = image.sha256;
    }
    return fileUrl;
  }
  async verifyImage(value:string,sha256:string,size:number,trace?:ImageNetworkRequest):Promise<void> {
    const url=publicImageUrl(value);
    const context=await isolatedRequest.newContext({timeout:30000,signal:this.request.signal});
    try {
      let response;
      try {response=await context.get(url,{maxRedirects:0,maxRetries:0,failOnStatusCode:false});}
      catch {throw new Error('Không đọc được ảnh công khai để xác minh.');}
      try {
        if(trace)trace.status=response.status();
        if(response.status()!==200||!/^image\//i.test(response.headers()['content-type']??''))throw new Error('Ảnh công khai không trả HTTP 200 với Content-Type image.');
        const length=Number(response.headers()['content-length']);
        if(length>maxImageBytes)throw new Error('Ảnh công khai vượt giới hạn 20 MB.');
        const bytes=await response.body(maxImageBytes);
        if(trace){trace.bytes=bytes.length;trace.sha256=createHash('sha256').update(bytes).digest('hex');}
        if(bytes.length!==size||bytes.length>maxImageBytes||createHash('sha256').update(bytes).digest('hex')!==sha256)throw new Error('Ảnh công khai khác file nguồn (size/SHA-256).');
      }finally {await response.dispose();}
    }finally {await context.dispose();}
  }
  async create(endpoint: '/posts' | '/posts/chapter-batch', payload: Payload): Promise<CreatedPost[]> {
    const data = await this.call('POST', endpoint, payload);
    const items = Array.isArray(data) ? data : [data];
    this.creationResponseShape = items.map(value=>({keys:Object.keys(record(value)),isActiveType:typeof record(value).is_active}));
    this.postsCache = undefined;
    // Creation responses may be compact/model-shaped. Only identities are used here;
    // all content, flags and SEO still require strict GET-detail verification.
    return items.map(value=>{
      const item=record(value);
      if (!Number.isSafeInteger(item.id) || Number(item.id)<1 || typeof item.title!=='string' || typeof item.slug!=='string' || !item.slug) {
        throw new Error(`API create thiếu identity id/title/slug; fields: ${Object.keys(item).join(', ')}.`);
      }
      return {id:Number(item.id),title:item.title,slug:item.slug};
    });
  }
}
