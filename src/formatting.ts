import { JSDOM } from 'jsdom';
import { htmlText, sanitizeHtml } from './content.js';
import type { ContentFormat } from './types.js';
import {publicImageUrl} from './images.js';

/** An unsigned, verified upload URL can be pasted directly into TinyMCE Source Code. */
export function imageHtml(url:string,alt:string):string {
  const doc=new JSDOM('<body></body>').window.document;
  const figure=doc.createElement('figure');figure.setAttribute('style','margin:1.5em 0;text-align:center');
  const image=doc.createElement('img');image.setAttribute('src',publicImageUrl(url));image.setAttribute('alt',alt);
  image.setAttribute('style','max-width:100%;height:auto;border-radius:8px');figure.append(image);
  return figure.outerHTML;
}
export function insertBodyImage(html:string,url:string,alt:string):string {
  const doc=new JSDOM(`<body>${html}</body>`).window.document;
  const publicUrl=publicImageUrl(url);
  if([...doc.body.querySelectorAll('img')].some(img=>img.getAttribute('src')===publicUrl))return html;
  const fragment=JSDOM.fragment(imageHtml(publicUrl,alt));
  // Keep the reader wrapper as the outermost block and its first paragraph styles intact.
  const first=doc.body.firstElementChild;
  const container=doc.body.children.length===1&&first?.tagName==='DIV'&&first.getAttribute('style')?.includes('max-width:760px')?first:doc.body;
  container.prepend(fragment);
  const result=doc.body.innerHTML;
  if(htmlText(result)!==htmlText(html))throw new Error('Chèn ảnh làm thay đổi nội dung văn bản.');
  return result;
}
export function verifyBodyImages(expected:string,actual:string):void {
  const images=(html:string)=>[...new JSDOM(`<body>${html}</body>`).window.document.querySelectorAll('img')].map(img=>({src:img.getAttribute('src'),alt:img.getAttribute('alt')??''}));
  if(JSON.stringify(images(expected))!==JSON.stringify(images(actual)))throw new Error('HTML sau lưu mất/đổi ảnh hoặc URL ảnh trong nội dung.');
}

const readerStyles: Record<string,string> = {
  p: 'margin:0 0 1.25em;line-height:1.85;text-align:left',
  h2: 'margin:1.8em 0 0.7em;font-family:Arial,Helvetica,sans-serif;font-size:1.5em;font-weight:700;line-height:1.35',
  h3: 'margin:1.6em 0 0.65em;font-family:Arial,Helvetica,sans-serif;font-size:1.25em;font-weight:700;line-height:1.4',
  h4: 'margin:1.4em 0 0.6em;font-family:Arial,Helvetica,sans-serif;font-size:1.1em;font-weight:700;line-height:1.4',
  blockquote: 'margin:1.5em 0;padding:0.75em 1.1em;border-left:3px solid #b58e5f;font-style:italic',
  ul: 'margin:0 0 1.25em;padding-left:1.5em;line-height:1.85',
  ol: 'margin:0 0 1.25em;padding-left:1.5em;line-height:1.85',
  li: 'margin:0 0 0.5em',
  hr: 'margin:2em auto;border:0;border-top:1px solid #d8d3cb;width:65%',
  img: 'max-width:100%;height:auto;border-radius:8px',
  figure: 'margin:1.5em 0',
  figcaption: 'margin:0.5em 0 1.25em;font-family:Arial,Helvetica,sans-serif;font-size:0.8em;line-height:1.5;text-align:center',
  table: 'max-width:100%;width:100%;border-collapse:collapse;font-size:0.9em',
  td: 'padding:0.5em;border:1px solid #d8d3cb',
  th: 'padding:0.5em;border:1px solid #d8d3cb;font-weight:700',
};

/** Static inline HTML, accepted by Source Code/TinyMCE and API without external CSS. */
export function formatContent(html: string, format: ContentFormat = 'source'): string {
  if (format === 'source') return html;
  if (format !== 'reader') throw new Error('--format chỉ nhận source hoặc reader.');
  if (!html.trim()) return '';
  const doc = new JSDOM(`<body>${sanitizeHtml(html)}</body>`).window.document;
  const before = htmlText(doc.body.innerHTML);
  for (const node of doc.body.querySelectorAll<HTMLElement>('*')) {
    const preset = readerStyles[node.tagName.toLowerCase()];
    if (preset) {
      // Keep existing inline emphasis/color; preset controls block typography.
      const patch = doc.createElement('div'); patch.setAttribute('style',preset);
      for (let i=0;i<patch.style.length;i++) {
        const key=patch.style.item(i); node.style.setProperty(key,patch.style.getPropertyValue(key));
      }
    }
  }
  const first = doc.body.firstElementChild;
  if (first?.tagName === 'P') {
    (first as HTMLElement).style.fontSize='1.12em';
    (first as HTMLElement).style.lineHeight='1.75';
    (first as HTMLElement).style.fontWeight='500';
  }
  const wrapper = doc.createElement('div');
  wrapper.setAttribute('style','max-width:760px;width:100%;box-sizing:border-box;margin:0 auto;font-family:Georgia,"Times New Roman",serif;font-size:18px;line-height:1.85;color:inherit;overflow-wrap:anywhere');
  wrapper.append(...doc.body.childNodes);
  doc.body.append(wrapper);
  const result = doc.body.innerHTML;
  if (htmlText(result)!==before) throw new Error('Định dạng làm thay đổi nội dung; dừng xử lý.');
  return result;
}

/** Text verification alone cannot establish that the server kept the layout. */
export function verifyFormatting(expected: string, actual: string): void {
  const wanted = new JSDOM(`<body>${expected}</body>`).window.document;
  const saved = new JSDOM(`<body>${actual}</body>`).window.document;
  const a = [...wanted.body.querySelectorAll<HTMLElement>('*')];
  const b = [...saved.body.querySelectorAll<HTMLElement>('*')];
  if (a.length!==b.length) throw new Error('HTML sau lưu mất/thêm markup định dạng.');
  for (const [i,node] of a.entries()) {
    if (node.tagName!==b[i]!.tagName) throw new Error('HTML sau lưu đổi cấu trúc định dạng.');
    for (let n=0;n<node.style.length;n++) {
      const key=node.style.item(n);
      if (node.style.getPropertyValue(key)!==b[i]!.style.getPropertyValue(key)) {
        throw new Error(`HTML sau lưu không giữ style ${key}; chưa xác minh bố cục reader.`);
      }
    }
  }
}
