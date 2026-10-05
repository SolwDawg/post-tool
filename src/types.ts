export interface Seo {
  seo_title: string;
  meta_description: string;
  focus_keyword: string;
  secondary_keywords: string[];
  categories: string[];
  tags: string[];
}
export interface Chapter {
  order: number;
  title: string;
  slug: string;
  file: string;
  text: string;
  html: string;
  seo: Partial<Seo>;
}
export interface Story {
  folder: string;
  title: string;
  slug: string;
  sourceUrl: string;
  sourceId?: string;
  intro: string;
  seo: Seo;
  chapters: Chapter[];
  fingerprint: string;
}
export interface Issue { level: 'error' | 'warning'; code: string; message: string }
export interface Validation { folder: string; story?: Story; issues: Issue[]; ready: boolean }
export type ContentFormat = 'source' | 'reader';
export interface PublishOptions {
  bodyImage?: boolean;
  imageFile?: string;
  noImage?: boolean;
  seriesTitle?: string;
  formatting?: ContentFormat;
  visibility: 'draft' | 'public';
  imageUrl: string;
  categories?: string[];
  tags?: string[];
  mapping: { categories?: Record<string, string[]>; tags?: Record<string, string[]> };
  showHome: boolean;
  topNews: boolean;
}
export interface Taxonomy { id: number; title: string; slug?: string }
export interface Post {
  id: number; title: string; slug: string; description?: string;
  is_active: boolean; is_home?: boolean; is_top?: boolean;
  image?: string | null; series_id?: number | null;
  series?: { id: number; title: string; slug: string } | null;
  selected_categories?: number[]; selected_tags?: number[];
  prev_chapter?: string | null; next_chapter?: string | null;
  seo_title?: string | null; seo_description?: string | null; seo_keywords?: string | null;
}
export type CreatedPost = Pick<Post, 'id' | 'title' | 'slug'>;
export interface Payload {
  title: string; slug: string; image: string; description: string;
  seo_title: string; seo_description: string; seo_keywords: string;
  selected_categories: number[]; selected_tags: number[];
  is_active: boolean; is_home: boolean; is_top: boolean;
  series_id: null; prev_chapter: null; next_chapter: null;
  skip_intro?: boolean;
  chapters?: { title: string; slug: string; description: string; image: string }[];
}
export interface Receipt {
  featuredImage?: { sha256: string; file: string; url: string };
  seriesTitle?: string;
  formatting?: ContentFormat;
  id: string; site: string; storyKey: string; sourceUrl: string;
  sourceId?: string;
  folder: string; title: string; fingerprint: string;
  payload: Payload; endpoint: string; createdAt: string; updatedAt: string;
  status: 'dispatched' | 'outcome-unknown' | 'verified' | 'resolved-not-created';
  posts: { id: number; slug: string; url: string }[];
  message?: string;
  creationResponseShape?: { keys: string[]; isActiveType: string }[];
}
export interface LocalImage {
  file: string; name: string; mime: 'image/jpeg' | 'image/png' | 'image/webp'; size: number; sha256: string;
}
export interface ImageUploadReceipt {
  network?: ImageNetworkRequest[];
  site: string; image: LocalImage; createdAt: string; updatedAt: string;
  status: 'dispatched' | 'outcome-unknown' | 'verified' | 'resolved-not-uploaded';
  url?: string; message?: string;
}
/** Safe network evidence: no cookies, session headers or signed URL query strings. */
export interface ImageNetworkRequest {
  stage: 'presign' | 'storage' | 'public-image';
  method: string; url: string; status?: number;
  responseKeys?: string[]; dataKeys?: string[]; fileUrl?: string;
  bytes?: number; sha256?: string;
  fileName?: string; contentType?: string;
  storage?: {disk?:string;bucket?:string;objectKey?:string};
}
