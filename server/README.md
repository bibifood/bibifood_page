# Bibi food - Server local

Backend chạy offline trên máy bạn (Node.js + SQLite), dùng để quản lý dữ liệu của trang bán hàng.
Đăng nhập dùng JWT Bearer token (`POST /api/auth/login`), các API `/api/admin/*` chỉ dành cho ADMIN.

**Ai được đăng nhập:** chỉ khách mua sỉ (`WHOLESALE`) và quản trị viên (`ADMIN`). **Không có đăng ký tự do**: khách mua sỉ gửi yêu cầu cấp tài khoản, admin duyệt thì hệ thống mới tạo tài khoản.

## Chạy

Cần Node.js 22.13 trở lên (máy bạn đang dùng Node 24).

```
cd server
npm install        # lần đầu
npm start          # hoặc bấm đúp start.bat
```

Lần chạy đầu tiên server tự:
- tạo cơ sở dữ liệu `data/app.db`,
- nạp 7 danh mục và 22 sản phẩm lấy từ `index.html` (đủ 4 ngôn ngữ),
- tạo tài khoản admin `admin` với **mật khẩu ngẫu nhiên**, in ra màn hình và lưu ở `data/ADMIN_ACCOUNT.txt`.

Địa chỉ API: `http://127.0.0.1:4000/api`. Chỉ máy này truy cập được (đổi `HOST=0.0.0.0` trong `.env` nếu muốn dùng chung trong mạng LAN).

Cấu hình tùy chọn: sao chép `.env.example` thành `.env`.

## Kiểm thử

```
npm test
```
Chạy 18 nhóm kiểm thử tự động trên database tạm (đăng ký, đăng nhập, phân quyền, đặt hàng, duyệt tài khoản sỉ, quản trị...).

## API chính

Công khai:
| | |
|---|---|
| `POST /api/auth/login` | `username`, `password` -> `{ user, accessToken }`. Chỉ WHOLESALE và ADMIN; quyền khác nhận lỗi 403 (`code: NOT_ALLOWED`) |
| `GET/PATCH /api/auth/me`, `POST /api/auth/change-password` | cần đăng nhập |
| `GET /api/products?lang=vi&category=gio`, `GET /api/products/:id` | |
| `GET /api/catalog/categories`, `GET /api/site-config` | |
| `POST /api/orders` | đơn mua lẻ; giá luôn tính từ máy chủ |
| `POST /api/wholesale/requests` | yêu cầu cấp tài khoản sỉ (5 mục bắt buộc) |

Quản trị (header `Authorization: Bearer <token>`, quyền ADMIN):
`/api/admin/dashboard/{overview,revenue,top-products,audit}`, `/orders`, `/products`, `/categories`, `/users`, `/wholesale-requests`, `/site-config`, `/upload`.

## Quy trình tài khoản sỉ

1. Khách gửi yêu cầu: `POST /api/wholesale/requests`.
2. Admin xem `GET /api/admin/wholesale-requests?status=PENDING`.
3. Duyệt: `POST /api/admin/wholesale-requests/:id/approve` -> tạo tài khoản quyền `WHOLESALE` (tên đăng nhập = số điện thoại), trả về mật khẩu ngẫu nhiên **một lần duy nhất** để gửi cho khách.
4. Từ chối: `POST .../reject` kèm `note`.

## Bảo mật đã áp dụng

- Mật khẩu băm bcrypt; thông báo lỗi đăng nhập không cho biết tài khoản có tồn tại hay không.
- Giới hạn 20 lần đăng nhập mỗi 15 phút cho mỗi IP.
- Token mất hiệu lực ngay khi khóa tài khoản, đổi quyền, đổi hoặc đặt lại mật khẩu.
- Chặn tự khóa mình và chặn hạ quyền/khóa quản trị viên cuối cùng.
- Câu lệnh SQL luôn dùng tham số; ký tự đặc biệt khi tìm kiếm được escape.
- Ảnh tải lên: chỉ JPG/PNG/WEBP/GIF, tối đa 5MB, kiểm tra nội dung thật của file, tên file do máy chủ đặt.
- CORS chỉ cho phép localhost (thêm miền khác qua `CORS_ORIGINS`).
- Mọi thao tác quản trị đều ghi vào nhật ký (`audit_logs`).

## Dữ liệu

Nằm trong thư mục `data/` (database, khóa đăng nhập) và `uploads/` (ảnh). **Hãy sao lưu hai thư mục này.** Không đưa lên GitHub (đã nằm trong `.gitignore`).

Nếu sau này đổi danh sách sản phẩm trong `index.html` và muốn nạp lại từ đầu: xóa thư mục `data/` rồi chạy `node scripts/extract-seed.js` và `npm start`.
