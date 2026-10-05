import type {BlogApi} from './api.js';
import {Journal} from './journal.js';
import {publicImageUrl,readImage} from './images.js';
import type {ImageUploadReceipt,LocalImage} from './types.js';
export async function ensureImage(api:BlogApi,journal:Journal,site:string,image:LocalImage):Promise<string> {
  if(!api.uploadImage||!api.verifyImage)throw new Error('Adapter website chưa hỗ trợ upload ảnh.');
  const previous=await journal.imageUpload(site,image.sha256);
  if(previous&&previous.status!=='resolved-not-uploaded') {
    if(previous.status!=='verified'||!previous.url)throw new Error(`Ảnh ${image.sha256}: upload chưa rõ kết quả. Chạy reconcile-image, không upload lại.`);
    await api.verifyImage(previous.url,image.sha256,image.size);
    return previous.url;
  }
  const current=await readImage(image.file);
  if(current.image.sha256!==image.sha256)throw new Error('Ảnh thay đổi sau kiểm tra; dừng trước upload.');
  const now=new Date().toISOString();
  const receipt:ImageUploadReceipt={site,image,createdAt:now,updatedAt:now,status:'dispatched'};
  await journal.writeImageUpload(receipt);
  try {
    const url=await api.uploadImage(image,current.buffer,async url=>{
      receipt.url=publicImageUrl(url);receipt.network=api.imageNetwork?structuredClone(api.imageNetwork):undefined;receipt.updatedAt=new Date().toISOString();await journal.writeImageUpload(receipt);
    });
    receipt.url=publicImageUrl(url);receipt.network=api.imageNetwork?structuredClone(api.imageNetwork):undefined;receipt.status='verified';receipt.updatedAt=new Date().toISOString();await journal.writeImageUpload(receipt);
    return receipt.url;
  }catch(error) {
    receipt.network=api.imageNetwork?structuredClone(api.imageNetwork):undefined;
    receipt.status='outcome-unknown';receipt.message=(error as Error).message;receipt.updatedAt=new Date().toISOString();await journal.writeImageUpload(receipt);
    throw new Error(`Ảnh ${image.sha256}: chưa xác minh upload. ${receipt.message} Chạy reconcile-image trước; không tự gửi lại.`);
  }
}
export async function reconcileImage(api:BlogApi,journal:Journal,site:string,sha256:string):Promise<ImageUploadReceipt> {
  const receipt=await journal.imageUpload(site,sha256);
  if(!receipt?.url||receipt.status==='resolved-not-uploaded'||!api.verifyImage)throw new Error('Chưa có URL ảnh để đối chiếu; giữ trạng thái chưa rõ kết quả.');
  await api.verifyImage(receipt.url,receipt.image.sha256,receipt.image.size);
  receipt.status='verified';receipt.updatedAt=new Date().toISOString();receipt.message='Ảnh công khai khớp size và SHA-256 nguồn; không upload lại.';
  await journal.writeImageUpload(receipt);return receipt;
}
