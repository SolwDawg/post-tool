import { lstat, realpath, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Đường dẫn vượt ra ngoài thư mục được chọn.');
  }
}

export async function checkedRoot(input: string): Promise<string> {
  const absolute = path.resolve(input);
  if ((await lstat(absolute)).isSymbolicLink()) throw new Error('Không nhận folder symlink/junction.');
  const root = await realpath(absolute);
  if (!(await lstat(root)).isDirectory()) throw new Error('Đầu vào phải là thư mục.');
  return root;
}

/** Reject both Windows and POSIX traversal, including symlinked intermediate directories. */
export async function containedPath(root: string, relative: string, createParent = false): Promise<string> {
  if (!relative || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) ||
      /^[a-z]:/i.test(relative) || relative.includes(':') || relative.includes('\0')) {
    throw new Error('Tên file phải là đường dẫn tương đối trong folder.');
  }
  const parts = relative.split(/[\\/]/);
  if (parts.some(p => !p || p === '.' || p === '..')) throw new Error('Tên file có thành phần đường dẫn không hợp lệ.');
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    assertInside(root, current);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Không đọc/ghi qua symlink hoặc junction.');
      assertInside(root, await realpath(current));
      if (index < parts.length - 1 && !info.isDirectory()) throw new Error('Thư mục cha không hợp lệ.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (createParent && index < parts.length - 1) await mkdir(current);
    }
  }
  return current;
}

export async function readContained(root: string, name: string): Promise<string> {
  const file = await containedPath(root, name);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('File không hợp lệ hoặc lớn hơn 20 MB.');
  return (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
}

export async function findContentFolders(input: string): Promise<string[]> {
  const root = await checkedRoot(input);
  const result: string[] = [];
  async function visit(folder: string, depth: number): Promise<void> {
    const entries = await readdir(folder, { withFileTypes: true });
    if (entries.some(e => e.isFile() && e.name === 'metadata.json') ||
        path.basename(folder).toLowerCase() === 'content') {
      result.push(folder);
      return;
    }
    if (depth > 12) throw new Error('Cây folder quá sâu; chọn thư mục gần content hơn.');
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') ||
          ['raw', 'node_modules', 'preview'].includes(entry.name.toLowerCase())) continue;
      const child = await containedPath(root, path.relative(root, path.join(folder, entry.name)));
      await visit(child, depth + 1);
    }
  }
  await visit(root, 0);
  if (!result.length) throw new Error('Không tìm thấy folder content hoặc metadata.json.');
  return result;
}
