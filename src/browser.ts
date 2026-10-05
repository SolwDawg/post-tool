import {spawn} from 'node:child_process';
import {access,mkdir,readFile,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Cookie,CookieJar} from 'tough-cookie';
import {containedPath} from './safe-path.js';
import {digest} from './content.js';
import type {RequestTrace} from './http.js';

class Cdp {
  private id=0;
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(reason:Error)=>void;timer:NodeJS.Timeout}>();
  readonly events:((event:{method:string;params:Record<string,unknown>;sessionId?:string})=>void)[]=[];
  private constructor(private readonly socket:WebSocket){
    socket.addEventListener('message',event=>{
      const data=JSON.parse(String(event.data));
      if(typeof data.id==='number'){
        const pending=this.pending.get(data.id);if(!pending)return;this.pending.delete(data.id);clearTimeout(pending.timer);
        if(data.error)pending.reject(Error('Chrome CDP trả lỗi.'));else pending.resolve(data.result);
      }else if(data.method)for(const listener of this.events)listener(data);
    });
    socket.addEventListener('close',()=>{for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(Error('Chrome CDP đã đóng.'));}this.pending.clear();});
  }
  static connect(url:string):Promise<Cdp>{
    return new Promise((resolve,reject)=>{
      const socket=new WebSocket(url);const timer=setTimeout(()=>{socket.close();reject(Error('Chrome CDP connect timeout.'));},10000);
      socket.addEventListener('open',()=>{clearTimeout(timer);resolve(new Cdp(socket));},{once:true});
      socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Không kết nối được Chrome CDP.'));},{once:true});
    });
  }
  call<T=Record<string,unknown>>(method:string,params:Record<string,unknown>={},sessionId?:string):Promise<T>{
    const id=++this.id;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`Chrome ${method} timeout.`));},10000);
      this.pending.set(id,{resolve:value=>resolve(value as T),reject,timer});this.socket.send(JSON.stringify({id,method,params,sessionId}));
    });
  }
  close():void{this.socket.close();}
}
async function executable(channel:string):Promise<string>{
  if(channel!=='chrome'&&channel!=='msedge')throw Error('--browser nhận chrome hoặc msedge cho đăng nhập.');
  const suffix=channel==='chrome'?'Google/Chrome/Application/chrome.exe':'Microsoft/Edge/Application/msedge.exe';
  const candidates=process.platform==='win32'?[process.env.PROGRAMFILES,process.env['PROGRAMFILES(X86)'],process.env.LOCALAPPDATA].filter(Boolean).map(root=>path.join(root!,suffix)):
    process.platform==='darwin'?[channel==='chrome'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']:
    channel==='chrome'?['/usr/bin/google-chrome','/usr/bin/chromium']:['/usr/bin/microsoft-edge'];
  for(const candidate of candidates)try{await access(candidate);return candidate;}catch{}
  throw Error(`Không tìm thấy ${channel}; cài browser để đăng nhập một lần.`);
}
interface BrowserCookie {name:string;value:string;domain:string;path:string;expires:number;secure:boolean;httpOnly:boolean;sameSite?:string;partitionKey?:unknown}
/** Chrome only for explicit login/session sync. Publishing itself never launches a browser. */
export async function captureBrowserSession(root:string,site:string,channel:string,headless:boolean,onReady?:()=>Promise<void>,signal?:AbortSignal):Promise<{jar:CookieJar;network:RequestTrace[]}>{
  const profile=await containedPath(root,`profiles/${digest(site).slice(0,20)}`,true);await mkdir(profile,{recursive:true});
  const portFile=await containedPath(profile,'DevToolsActivePort');await unlink(portFile).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});
  const binary=await executable(channel);
  const child=spawn(binary,[`--user-data-dir=${profile}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run','--no-default-browser-check',...(headless?['--headless=new','--disable-gpu']:[]),'about:blank'],{windowsHide:true,stdio:'ignore',signal});
  let failed=false;child.once('error',()=>{failed=true;});
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  let cdp:Cdp|undefined;
  const network:RequestTrace[]=[];
  try{
    let port=0;const deadline=Date.now()+20000;
    while(Date.now()<deadline){
      signal?.throwIfAborted();
      if(failed||child.exitCode!==null)throw Error('Chrome không mở được profile; kiểm tra browser đang dùng profile CLI.');
      try{port=Number((await readFile(portFile,'utf8')).split(/\r?\n/)[0]);if(Number.isInteger(port)&&port>0&&port<65536)break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!port)throw Error('Chrome chưa sẵn sàng cho session sync.');
    const response=await fetch(`http://127.0.0.1:${port}/json/version`,{redirect:'error',signal:AbortSignal.timeout(5000)});
    const data=await response.json() as {webSocketDebuggerUrl:string};const ws=new URL(data.webSocketDebuggerUrl);
    if(ws.protocol!=='ws:'||ws.hostname!=='127.0.0.1'||Number(ws.port)!==port)throw Error('Chrome CDP target không đúng process riêng.');
    cdp=await Cdp.connect(ws.href);
    const {targetId}=await cdp.call<{targetId:string}>('Target.createTarget',{url:'about:blank'});
    const {sessionId}=await cdp.call<{sessionId:string}>('Target.attachToTarget',{targetId,flatten:true});
    const requests=new Map<string,RequestTrace>();
    cdp.events.push(event=>{
      if(event.sessionId!==sessionId)return;
      if(event.method==='Network.requestWillBeSent'){
        const request=event.params.request as {url:string;method:string;headers:Record<string,string>};const url=new URL(request.url);
        if(url.origin!==site||!url.pathname.startsWith('/admin/'))return;
        const item:RequestTrace={method:request.method,url:`${url.origin}${url.pathname}`,requestHeaders:Object.keys(request.headers)};requests.set(String(event.params.requestId),item);network.push(item);
      }
      if(event.method==='Network.responseReceived'){const item=requests.get(String(event.params.requestId));if(item)item.status=(event.params.response as {status:number}).status;}
    });
    await cdp.call('Network.enable',{},sessionId);await cdp.call('Page.navigate',{url:`${site}/admin/posts`},sessionId);
    if(onReady)await onReady();
    let loaded=false;const loadDeadline=Date.now()+20000;
    while(Date.now()<loadDeadline){
      signal?.throwIfAborted();
      const result=await cdp.call<{result:{value?:{url:string;ready:string}}}>('Runtime.evaluate',{expression:'({url:location.href,ready:document.readyState})',returnByValue:true},sessionId);
      const value=result.result.value;
      if(value&&value.ready==='complete'&&value.url!=='about:blank'){
        const url=new URL(value.url);if(url.origin!==site||!url.pathname.startsWith('/admin/')||/login|sign-in/i.test(url.pathname))throw Error('Phiên chưa đăng nhập. Chạy login để đăng nhập thủ công.');
        loaded=true;break;
      }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!loaded)throw Error('Trang admin chưa tải xong để đồng bộ phiên.');
    const {cookies}=await cdp.call<{cookies:BrowserCookie[]}>('Network.getCookies',{urls:[site,`${site}/admin/posts`]},sessionId);
    const jar=new CookieJar();
    for(const cookie of cookies){
      if(cookie.partitionKey)continue;
      await jar.setCookie(new Cookie({key:cookie.name,value:cookie.value,domain:cookie.domain.startsWith('.')?cookie.domain.slice(1):undefined,path:cookie.path,hostOnly:!cookie.domain.startsWith('.'),secure:cookie.secure,httpOnly:cookie.httpOnly,expires:cookie.expires>0?new Date(cookie.expires*1000):'Infinity',sameSite:cookie.sameSite?.toLowerCase() as 'lax'|'strict'|'none'|undefined}),`${site}${cookie.path}`);
    }
    return {jar,network};
  }finally{
    if(cdp){await cdp.call('Browser.close').catch(()=>undefined);cdp.close();}
    const closed=await Promise.race([exited.then(()=>true),new Promise<false>(resolve=>{const timer=setTimeout(()=>resolve(false),3000);timer.unref();})]);
    if(!closed)child.kill();
    await writeFile(await containedPath(root,`network/session-${digest(site)}.json`,true),JSON.stringify(network,null,2));
  }
}
