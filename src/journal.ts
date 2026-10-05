import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkedRoot, containedPath } from './safe-path.js';
import { digest } from './content.js';
import type { ImageUploadReceipt, Receipt } from './types.js';

export class Journal {
  private constructor(readonly root: string) {}
  static async open(input: string): Promise<Journal> {
    await mkdir(path.resolve(input), { recursive: true });
    return new Journal(await checkedRoot(input));
  }
  async write(receipt: Receipt): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(receipt.id)) throw new Error('Receipt ID không hợp lệ.');
    const relative = `receipts/${receipt.id}.json`;
    const file = await containedPath(this.root, relative, true);
    const temporary = await containedPath(this.root, `receipts/${receipt.id}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
    const handle = await open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  }
  async all(site?: string): Promise<Receipt[]> {
    const directory = await containedPath(this.root, 'receipts');
    let entries: string[];
    try { entries = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const receipts: Receipt[] = [];
    for (const file of entries) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      const receipt = JSON.parse(await readFile(await containedPath(this.root, `receipts/${file}`), 'utf8')) as Receipt;
      if (!receipt || `${receipt.id}.json` !== file || typeof receipt.site !== 'string' ||
          !['dispatched', 'outcome-unknown', 'verified', 'resolved-not-created'].includes(receipt.status)) {
        throw new Error(`Journal hỏng: ${file}. Giữ nguyên file và kiểm tra thủ công.`);
      }
      if (!site || receipt.site === site) receipts.push(receipt);
    }
    return receipts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  private imagePath(site:string,sha256:string):string {
    if(!/^[a-f0-9]{64}$/.test(sha256))throw new Error('Image SHA-256 không hợp lệ.');
    return `images/${digest(site)}-${sha256}.json`;
  }
  async imageUpload(site:string,sha256:string):Promise<ImageUploadReceipt|undefined> {
    const file=await containedPath(this.root,this.imagePath(site,sha256));
    let data:ImageUploadReceipt;
    try {data=JSON.parse(await readFile(file,'utf8')) as ImageUploadReceipt;}
    catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
    if(data.site!==site||data.image?.sha256!==sha256||!['dispatched','outcome-unknown','verified','resolved-not-uploaded'].includes(data.status))throw new Error('Nhật ký upload ảnh không hợp lệ.');
    return data;
  }
  async writeImageUpload(data:ImageUploadReceipt):Promise<void> {
    const file=await containedPath(this.root,this.imagePath(data.site,data.image.sha256),true);
    const temporary=await containedPath(this.root,`images/${randomUUID()}.tmp`);
    await writeFile(temporary,JSON.stringify(data,null,2),{flag:'wx',mode:0o600});
    const handle=await open(temporary,'r+');try {await handle.sync();}finally {await handle.close();}
    await rename(temporary,file);
  }
  async lock(site: string): Promise<() => Promise<void>> {
    const file = await containedPath(this.root, `locks/${digest(site)}.lock`, true);
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(file, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
        await handle.close();
        return async () => {
          const current = JSON.parse(await readFile(file, 'utf8')) as { token?: string };
          if (current.token === token) await unlink(file);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const current = JSON.parse(await readFile(file, 'utf8')) as { pid?: number };
        if (!Number.isSafeInteger(current.pid) || !current.pid || current.pid < 1) throw new Error('Lock không hợp lệ; kiểm tra process trước khi xử lý thủ công.');
        try { process.kill(current.pid, 0); throw new Error('Website đang có một tiến trình publisher khác.'); }
        catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause;
          // Only the ephemeral lock of a confirmed dead process is removed. Receipts stay intact.
          await unlink(file);
        }
      }
    }
    throw new Error('Không lấy được lock.');
  }
}
