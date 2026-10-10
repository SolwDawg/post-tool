# Content Publisher CLI

CLI độc lập để kiểm tra và đăng nội dung truyện có sẵn lên Bio Blog. Dùng HTTP trực tiếp, không phụ thuộc Playwright; Chrome/Edge chỉ cần khi đăng nhập hoặc đồng bộ phiên.

## Cài đặt

Yêu cầu Node.js >=22. Windows có Chrome hoặc Edge cho bước đăng nhập.

```powershell
git clone https://github.com/SolwDawg/post-tool.git
cd post-tool
npm.cmd ci
npm.cmd run build
```

`publisher.cmd` chạy bản build trong `dist`. Chạy `publisher.cmd --help` để xem toàn bộ lệnh.

## Đăng nhập

```powershell
.\publisher.cmd login
```

Đăng nhập thủ công trong Chrome của tool rồi nhấn Enter tại terminal. Tool đóng Chrome, kiểm tra phiên HTTP và lưu cookie jar. Có thể dùng `--browser msedge`.

Nếu đã đăng nhập trong profile riêng của phiên bản cũ:

```powershell
.\publisher.cmd session-sync --headless
```

Website mặc định: `https://aftertheuniform.cfx.bz`. Dùng `--site URL` cho website Bio Blog có cùng API contract. Các lệnh HTTP không mở browser. Phiên hết hạn cần chạy lại login/session-sync; tool không tự đăng nhập hoặc gửi lại mutation.

State mặc định trong `.publisher` cạnh tool; đổi bằng `--state PATH`. Trên Windows, cookie jar được mã hóa bằng DPAPI CurrentUser, ràng buộc website. Trên hệ khác lưu file owner-only mode 0600. Profile/state chứa phiên đăng nhập và không được chia sẻ hoặc commit.

## Chuẩn bị và đăng bài

Tool nhận folder content; không cào nguồn, đọc Excel, tạo caption hoặc đăng Facebook.

```powershell
.\publisher.cmd scan "D:\Stories"
.\publisher.cmd validate "D:\Stories\1\content" --json
.\publisher.cmd preview "D:\Stories\1\content" --format reader
.\publisher.cmd catalog
.\publisher.cmd check "D:\Stories\1\content" --public
.\publisher.cmd publish "D:\Stories\1\content"
```

`publish` thiếu `--execute` chỉ in kế hoạch offline.

Thêm cờ `--fast` để tăng tốc độ publish từ ~3 phút xuống dưới 3 giây/bài (tự động bỏ qua khâu tải ngược ảnh từ CDN, kiểm tra trùng nhanh qua search API và tự động ghi `published_links.txt` & `pinned_comment.txt` vào thư mục truyện):

```powershell
.\publisher.cmd publish "D:\Stories\1\content" --execute --public --format reader --tag "Drama" --fast

Chạy song song nhiều luồng (Concurrency) khi đăng một thư mục chứa nhiều bộ truyện để tăng tốc tối đa (khuyên dùng từ 3 đến 5 luồng):

```powershell
.\publisher.cmd publish "D:\Stories" --execute --public --format reader --fast --concurrency 3
```
```

Chỉ lệnh sau mới tạo bài công khai (chế độ tiêu chuẩn):

```powershell
.\publisher.cmd publish "D:\Stories\1\content" --execute --public --format reader --body-image --category "Biker Stories" --tag "Drama"
```

Mặc định tạo draft khi có `--execute`; chọn `--public` để công khai. Một chapter tạo normal post; nhiều chapter tạo series bằng chapter-batch. `--show-home` và `--top-news` mặc định tắt.

Danh mục/tags phải có sẵn trên website; tool không tự tạo taxonomy. Dùng `--category`, `--tag` (có thể lặp) hoặc `--mapping mapping.example.json` để ánh xạ. Metadata SEO toàn truyện được áp dụng cho các chapter; chưa áp dụng SEO riêng từng chapter.

Kiểm tra trùng dùng title/slug/series từ những trang API phiên hiện tại có quyền đọc, cùng journal nguồn cục bộ. Không ghi đè bài cũ. `--series-title "Tên edition riêng"` tạo namespace riêng cho truyện nhiều chương, vẫn kiểm tra trùng. API chapter-batch hiện tại khi skip_intro=true đặt series theo title/slug chapter đầu.

## Featured image và HTML

```text
video-folder/
  Thumbnail.jpg
  content/
    metadata.json
    article_seo_ready.html
    chapter_1.txt ... chapter_n.txt
```

Tự tìm Thumbnail.jpg trong content hoặc ngay cạnh content; nếu cả hai nơi đều có ảnh phải chọn `--image-file`. JPEG/PNG/WebP tối đa 20 MB, kiểm tra magic/extension và SHA-256.

- `--image-file PATH`: chọn file khác.
- `--image-url URL`: dùng ảnh công khai có sẵn.
- `--no-image`: bỏ tìm ảnh tự động.
- `--body-image`: chèn cùng ảnh featured vào đầu nội dung mỗi chapter.
- `--format reader`: bố cục đọc bằng CSS inline; mặc định source giữ HTML đã kiểm tra.

Ba tùy chọn image-file/image-url/no-image loại trừ nhau. Body-image cần ảnh. Một ảnh upload được gán cho toàn bộ chapter, tương đương Apply image to all; ảnh đã xác minh được dùng lại theo site+hash.

```powershell
.\publisher.cmd upload-image "D:\Stories\1\Thumbnail.jpg" --execute
```

Lệnh chỉ upload ảnh, trả URL công khai và HTML figure/img để dán vào Source Code. Không có --execute thì chỉ kiểm tra offline.

Upload dùng POST `/admin/api/v1/uploads/presigned-image-url`, chuyển binary theo `data.upload.url`, rồi GET/hash kiểm tra `data.fileUrl`. HTML dùng **fileUrl**, không dùng signed upload URL có thời hạn. Storage/public GET dùng client riêng không có cookie/CSRF phiên website.

Preview xuất HTML fragment từng chapter trong `source_html`. Preview tổng vô hiệu URL ngoài; các fragment dùng để dán vào editor. Ảnh local chưa upload thì fragment offline chưa có URL. Có thể preview ảnh đã upload bằng `--image-url URL --body-image`.

## Hợp đồng content

```json
{
  "story_title": "A Family Story",
  "source_url": "https://source.example/story",
  "intro": null,
  "status": "ready",
  "issues": [],
  "seo": {
    "seo_title": "A Family Story",
    "meta_description": "A family story description.",
    "focus_keyword": "family",
    "secondary_keywords": ["story"],
    "categories": ["Drama"],
    "tags": ["family"]
  },
  "chapters": [{
    "order": 1,
    "chapter_title": "Chapter 1 - The Arrival",
    "content_file": "chapter_1.txt"
  }]
}
```

TXT chỉ chứa narrative, không lặp heading. HTML tùy chọn có section `id="chapter-N"`; heading phải khớp metadata và body khớp TXT sau chuẩn hóa khoảng trắng. Chặn script/iframe/event handler, traversal/junction/symlink, chapter chỉ có title, chương trùng/mất thứ tự và file chưa khai báo. Không loại chương chỉ vì ngắn. Không sửa nguồn.

Hỗ trợ alias Antigravity: original_source_url/source_url, review_status/status, review_issues/issues, seo.title/seo_title, chapter title/chapter_title, filename/content_file. Hai tên mâu thuẫn thì dừng. Readiness của file không chứng minh nguồn đã được cào đủ.

Legacy info.txt + HTML/TXT có thể import vào folder riêng:

```powershell
.\publisher.cmd import "D:\Stories\legacy" --out "D:\Prepared\legacy"
```

Đích phải trống và nằm ngoài cây nguồn. Metadata đọc từ fields khai báo; không tự viết nội dung hoặc đoán chapter. Một số noise crawler đã biết được loại có audit; lỗi cấu trúc khác báo needs_review. Khi thiếu URL, bản import giữ source_id local-sha256 thay vì bịa URL. Thumbnail được sao chép, nguồn giữ nguyên.

## Journal, request chưa rõ kết quả và network

```powershell
.\publisher.cmd status
.\publisher.cmd reconcile RECEIPT_ID
.\publisher.cmd reconcile-image SHA256
.\publisher.cmd network POST_ID
```

Journal intent được lưu trước mutation. Timeout, crash, HTTP lỗi hoặc dữ liệu lệch sau tạo giữ trạng thái chưa rõ và chặn replay. Không redirect hoặc tự retry POST. Reconcile chỉ GET đối chiếu, không đăng lại. Chỉ sau khi người vận hành xác nhận không tạo bài/ảnh mới có thể dùng:

```powershell
.\publisher.cmd resolve RECEIPT_ID --not-created --note "Đã kiểm tra không tạo bài."
.\publisher.cmd resolve-image SHA256 --not-created --note "Đã kiểm tra không upload ảnh."
```

Sau tạo, GET detail đối chiếu text, SEO, taxonomy, ảnh/src/alt, visibility, series và liên kết chapter; reader còn kiểm tra CSS. Meta description được so sánh sau chuẩn hóa khoảng trắng vì website tự gộp khoảng trắng khi lưu; mất hoặc đổi từ vẫn bị từ chối. Ảnh công khai đối chiếu size/hash. Lock theo website chặn hai CLI writers đồng thời.

`network [POST_ID]` chỉ đọc API, trả path/method/status/tên header/schema keys, không lộ giá trị cookie/token. State không được đặt trong folder content. Exit code: 0 thành công, 2 content needs_review, 1 lỗi vận hành.

## Kiểm chứng phát triển

```powershell
npm.cmd run typecheck
npm.cmd test
```

51 tests dùng HTTP server mock, không đăng production. Có test CDP thật trên Chrome với profile tạm riêng, cookie persistence/DPAPI, POST/batch/storage, timeout/abort/redirect, journal/replay/reconcile, source safety và HTML/image verification. Chrome cần có để chạy bộ kiểm thử CDP.
