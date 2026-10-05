import {spawn} from 'node:child_process';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {CookieJar} from 'tough-cookie';
import {containedPath} from './safe-path.js';
import {digest} from './content.js';

function protect(bytes:Buffer,site:string,decrypt=false):Promise<Buffer>{
  if(process.platform!=='win32')return Promise.resolve(bytes);
  // Credentials only pass stdin/stdout of this hidden process, never process args or logs.
  const script=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $v=ConvertFrom-Json ([Console]::In.ReadToEnd()); $b=[Convert]::FromBase64String($v.bytes); $e=[Text.Encoding]::UTF8.GetBytes($v.site); $r=[Security.Cryptography.ProtectedData]::${decrypt?'Unprotect':'Protect'}($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const chunks:Buffer[]=[];child.stdout.on('data',chunk=>chunks.push(chunk));child.stderr.resume();
    const timer=setTimeout(()=>{child.kill();reject(Error('Mã hóa phiên Windows timeout.'));},15000);
    child.once('error',()=>{clearTimeout(timer);reject(Error('Không chạy được bảo vệ phiên Windows.'));});
    child.once('close',code=>{clearTimeout(timer);if(code!==0){reject(Error('Không mở/lưu được phiên DPAPI của người dùng Windows.'));return;}resolve(Buffer.from(Buffer.concat(chunks).toString().trim(),'base64'));});
    child.stdin.end(JSON.stringify({site,bytes:bytes.toString('base64')}));
  });
}
export class SessionStore {
  constructor(private readonly root:string,readonly site:string){}
  private file():Promise<string>{return containedPath(this.root,`sessions/${digest(this.site)}.session`,true);}
  async load():Promise<CookieJar|undefined>{
    let bytes:Buffer;try{bytes=await readFile(await this.file());}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
    const data=JSON.parse((await protect(bytes,this.site,true)).toString()) as {site:string;jar:unknown};
    if(data.site!==this.site)throw Error('Phiên HTTP không đúng website.');
    return CookieJar.deserialize(JSON.stringify(data.jar));
  }
  async save(jar:CookieJar):Promise<void>{
    const bytes=Buffer.from(JSON.stringify({site:this.site,jar:await jar.serialize()}));
    const encrypted=await protect(bytes,this.site);const file=await this.file();
    const temporary=await containedPath(this.root,`sessions/${randomUUID()}.tmp`);
    await writeFile(temporary,encrypted,{flag:'wx',mode:0o600});await rename(temporary,file);
  }
}
