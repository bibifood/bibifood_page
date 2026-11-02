# Cài đặt backend lưu thông tin khách hàng vào Google Sheet

Trang web chạy tĩnh (GitHub Pages) nên dùng Google Apps Script làm backend miễn phí.
Mỗi ngày script tự tạo một tab mới, tên theo ngày (ví dụ `2026-11-02`).

## Các bước

1. Vào https://sheets.google.com, tạo một Google Sheet mới (ví dụ tên "bibifood - khách hàng").
2. Menu **Tiện ích mở rộng → Apps Script**.
3. Xóa code mẫu, dán toàn bộ nội dung file `backend/Code.gs` vào, bấm **Lưu**.
4. Bấm **Triển khai → Triển khai mới**:
   - Loại: **Ứng dụng web**
   - Thực thi dưới tên: **Tôi**
   - Ai có quyền truy cập: **Bất kỳ ai**
5. Bấm **Triển khai**, cấp quyền khi Google hỏi, rồi sao chép **URL ứng dụng web** (dạng `https://script.google.com/macros/s/.../exec`).
6. Mở `index.html`, tìm dòng `var CUSTOMER_FORM_ENDPOINT = '';` và dán URL vào giữa hai dấu nháy.
7. Mở URL đó trên trình duyệt: thấy `{"ok":true,...}` là script đang chạy.

## Lưu ý

- Mỗi lần sửa `Code.gs` phải chọn **Triển khai → Quản lý bản triển khai → Chỉnh sửa → Phiên bản mới** thì thay đổi mới có hiệu lực. URL giữ nguyên.
- Trang web chỉ ghi được dữ liệu vào Sheet, không đọc được. Chỉ chủ Sheet mới xem được danh sách khách.
- Số điện thoại được lưu dạng văn bản để không mất số 0 ở đầu.
- Đổi múi giờ ở biến `TIMEZONE` đầu file nếu cần (mặc định `Asia/Seoul`).
