import {CookieJar} from 'tough-cookie';

export interface RequestTrace {method:string;url:string;status?:number;requestHeaders:string[];bodyKeys?:string[];responseKeys?:string[]}
interface FetchOptions {method?:string;data?:unknown;headers?:Record<string,string>;timeout?:number;maxRedirects?:number;maxRetries?:number;failOnStatusCode?:boolean}
export class HttpResponse {
  constructor(private readonly response:Response,private readonly trace:RequestTrace){}
  status():number{return this.response.status;}
  headers():Record<string,string>{return Object.fromEntries(this.response.headers.entries());}
  async body(limit=32*1024*1024):Promise<Buffer>{
    const reader=this.response.body?.getReader();if(!reader)return Buffer.alloc(0);
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('HTTP response vượt giới hạn bytes.');chunks.push(value);}}
    finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
    return Buffer.concat(chunks,size);
  }
  async text():Promise<string>{return (await this.body()).toString('utf8');}
  async json():Promise<unknown>{const value:unknown=JSON.parse(await this.text());if(value&&typeof value==='object'&&!Array.isArray(value))this.trace.responseKeys=Object.keys(value);return value;}
  async dispose():Promise<void>{if(!this.response.body?.locked)await this.response.body?.cancel().catch(()=>undefined);}
}
/** Single-attempt native fetch; credentials are strictly restricted to one origin. */
export class HttpClient {
  readonly trace:RequestTrace[]=[];
  readonly jar:CookieJar;
  private readonly abort=new AbortController();
  get signal():AbortSignal{return this.abort.signal;}
  constructor(private readonly options:{origin?:string;jar?:CookieJar;extraHTTPHeaders?:Record<string,string>;timeout?:number;signal?:AbortSignal}={}){
    this.jar=options.jar??new CookieJar();
    if(options.extraHTTPHeaders&&Object.keys(options.extraHTTPHeaders).length&&!options.origin)throw Error('HTTP headers phiên cần origin scope.');
  }
  async fetch(value:string,options:FetchOptions={}):Promise<HttpResponse>{
    const url=new URL(value);if(this.options.origin&&url.origin!==this.options.origin)throw Error('HTTP session không được gửi sang origin khác.');
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error('HTTP URL không hợp lệ.');
    if(options.maxRedirects&&options.maxRedirects!==0||options.maxRetries&&options.maxRetries!==0)throw Error('HTTP chỉ hỗ trợ redirect/retry=0.');
    const headers=new Headers({...this.options.extraHTTPHeaders,...options.headers});
    if(this.options.origin){const cookie=await this.jar.getCookieString(url.href);if(cookie&&!headers.has('Cookie'))headers.set('Cookie',cookie);}
    let body:BodyInit|undefined;const data=options.data;
    if(data!==undefined){
      if(Buffer.isBuffer(data))body=new Uint8Array(data);
      else if(typeof data==='string')body=data;
      else{body=JSON.stringify(data);if(!headers.has('Content-Type'))headers.set('Content-Type','application/json');}
    }
    const trace:RequestTrace={method:options.method??'GET',url:`${url.origin}${url.pathname}`,requestHeaders:[...headers.keys()]};
    if(data&&typeof data==='object'&&!Buffer.isBuffer(data))trace.bodyKeys=Object.keys(data);
    this.trace.push(trace);
    let response:Response;
    try{response=await fetch(url,{method:trace.method,headers,body,redirect:'manual',signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(options.timeout??this.options.timeout??30000),...(this.options.signal?[this.options.signal]:[])])});}
    catch{throw Error(`HTTP ${trace.method} ${url.pathname}: lỗi kết nối hoặc timeout; không tự gửi lại.`);}
    trace.status=response.status;
    if(this.options.origin)for(const cookie of response.headers.getSetCookie())await this.jar.setCookie(cookie,url.href);
    return new HttpResponse(response,trace);
  }
  get(url:string,options:FetchOptions={}):Promise<HttpResponse>{return this.fetch(url,{...options,method:'GET'});}
  async dispose():Promise<void>{this.abort.abort();}
}
export const request={async newContext(options:ConstructorParameters<typeof HttpClient>[0]={}):Promise<HttpClient>{return new HttpClient(options);}};
