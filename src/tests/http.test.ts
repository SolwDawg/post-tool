import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readFile,readdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {CookieJar} from 'tough-cookie';
import {HttpClient} from '../http.js';
import {SessionStore} from '../session.js';
import {SessionApi} from '../api.js';
import {Journal} from '../journal.js';
import {digest} from '../content.js';
import {workspace} from './helpers.js';
async function serve(handler:(req:IncomingMessage,res:ServerResponse)=>void|Promise<void>){
 const server=createServer((req,res)=>{void Promise.resolve(handler(req,res)).catch(()=>{res.statusCode=500;res.end();});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {origin:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,close:()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());})};
}
test('native cookie jar applies expiry/path, accepts rotated cookies and rejects credential forwarding or redirects',async t=>{
 const jar=new CookieJar();let visits=0;
 const server=await serve((req,res)=>{
  visits++;
  assert(!req.headers.cookie?.includes('expired=')&&!req.headers.cookie?.includes('otherPath='));
  assert(req.headers.cookie?.includes(visits===1?'auth=old':'auth=new'));
  res.setHeader('Set-Cookie','auth=new; Path=/; HttpOnly');
  if(req.url==='/redirect'){res.statusCode=302;res.setHeader('Location','https://example.com/capture');}
  res.end('OK');
 });t.after(server.close);
 await jar.setCookie('auth=old; Path=/; HttpOnly',server.origin);
 await jar.setCookie('expired=secret; Max-Age=0; Path=/',server.origin);
 await jar.setCookie('otherPath=secret; Path=/private',server.origin);
 const http=new HttpClient({origin:server.origin,jar});t.after(()=>http.dispose());
 await (await http.get(`${server.origin}/admin`)).dispose();
 const response=await http.get(`${server.origin}/redirect`);assert.equal(response.status(),302);await response.dispose();
 await assert.rejects(http.get('https://example.com/capture'),/origin khác/);assert.equal(visits,2);
 assert(!JSON.stringify(http.trace).includes('secret')&&!JSON.stringify(http.trace).includes('auth=old'));
});
test('native HTTP bounds response bytes, aborts slow bodies and cancellation stops requests',async t=>{
 const server=await serve((req,res)=>{
  if(req.url==='/large'){res.end('0123456789');return;}
  res.write('start');const timer=setTimeout(()=>res.end('end'),1500);res.once('close',()=>clearTimeout(timer));
 });t.after(server.close);
 const http=new HttpClient();t.after(()=>http.dispose());
 const large=await http.get(`${server.origin}/large`);await assert.rejects(large.body(8),/giới hạn/);
 const slow=await http.get(`${server.origin}/slow`,{timeout:100});await assert.rejects(slow.body());
 await http.dispose();await assert.rejects(http.get(`${server.origin}/slow`),/không tự gửi lại/);
 const parent=new HttpClient();const child=new HttpClient({signal:parent.signal});
 await parent.dispose();await assert.rejects(child.get(`${server.origin}/slow`),/không tự gửi lại/);await child.dispose();
});
test('session DPAPI roundtrip preserves auth, is site-bound and contains no plaintext cookies on Windows',async t=>{
 const root=await workspace(t);const journal=await Journal.open(path.join(root,'state'));const site='https://example.com';const jar=new CookieJar();
 await jar.setCookie('auth=secret-session-value; Secure; HttpOnly; Path=/',site);
 const store=new SessionStore(journal.root,site);await store.save(jar);const saved=await store.load();
 assert.equal(await saved!.getCookieString(site),'auth=secret-session-value');
 const files=await readdir(path.join(journal.root,'sessions'));assert.equal(files.length,1);
 if(process.platform==='win32')assert(!(await readFile(path.join(journal.root,'sessions',files[0]!))).includes(Buffer.from('secret-session-value')));
 const other='https://other.example.com';await copyFile(path.join(journal.root,'sessions',files[0]!),path.join(journal.root,'sessions',`${digest(other)}.session`));
 await assert.rejects(new SessionStore(journal.root,other).load(),/DPAPI|đúng website/);
});
test('CLI network uses stored HTTP session with browser deliberately unavailable, refreshes CSRF and emits no credential values',async t=>{
 const root=await workspace(t);const journal=await Journal.open(path.join(root,'state'));let posts=0;
 const server=await serve((req,res)=>{
  assert.equal(req.headers.cookie,'auth=secret');
  if(req.url==='/admin/posts'){res.setHeader('Content-Type','text/html');res.end('<meta name="csrf-token" content="private-csrf">');return;}
  assert.equal(req.headers['x-csrf-token'],'private-csrf');
  res.setHeader('Content-Type','application/json');
  if(req.url?.startsWith('/admin/api/v1/posts?')){posts++;res.end(JSON.stringify({ok:true,data:{current_page:1,last_page:1,data:[]}}));return;}
  res.end(JSON.stringify({ok:true,data:[]}));
 });t.after(server.close);
 const jar=new CookieJar();await jar.setCookie('auth=secret; Path=/',server.origin);await new SessionStore(journal.root,server.origin).save(jar);
 const cli=fileURLToPath(new URL('../cli.js',import.meta.url));
 const {stdout}=await promisify(execFile)(process.execPath,[cli,'network','--state',journal.root,'--site',server.origin,'--browser','does-not-exist']);
 const output=JSON.parse(stdout);assert.equal(output.engine,'native-http');assert.equal(posts,2);assert.equal(output.requests.length,6);
 assert(output.requests.every((r:{status:number})=>r.status===200));assert(!stdout.includes('private-csrf')&&!stdout.includes('auth=secret'));
});
test('HTTP auth redirect blocks before any API POST or browser fallback',async t=>{
 let calls=0;const server=await serve((_req,res)=>{calls++;res.statusCode=302;res.setHeader('Location','/admin/login');res.end();});t.after(server.close);
 const http=new HttpClient({origin:server.origin});t.after(()=>http.dispose());
 await assert.rejects(SessionApi.fromHttp(http,server.origin),/HTTP 302/);assert.equal(calls,1);
});
