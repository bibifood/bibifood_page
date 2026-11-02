# Cài đặt backend mua sỉ (đăng nhập và yêu cầu cấp tài khoản)

Dùng một Google Sheet **riêng**, tách khỏi Sheet khách mua lẻ. Làm tương tự `HUONG_DAN.md`, nhưng dùng file `backend/Wholesale.gs`.

## Các bước

1. Tạo Google Sheet mới, đặt tên ví dụ "bibifood - mua sỉ".
2. **Tiện ích mở rộng → Apps Script**, xóa code mẫu, dán toàn bộ `backend/Wholesale.gs`, bấm **Lưu**.
3. **Triển khai → Triển khai mới → Ứng dụng web**: thực thi dưới tên **Tôi**, quyền truy cập **Bất kỳ ai**. Cấp quyền khi Google hỏi.
4. Sao chép URL `.../exec`, mở `index.html`, dán vào dòng `var WHOLESALE_ENDPOINT = '';`.
5. Mở URL trên trình duyệt, thấy `{"ok":true,"service":"bibifood-wholesale"}` là chạy được.
6. Tải lại Google Sheet để thấy menu **Bibi food** ở thanh menu.

Hai tab `Yêu cầu cấp tài khoản` và `Tài khoản` được tạo tự động khi có dữ liệu đầu tiên.

## Quy trình quản lý

1. Khách gửi yêu cầu, một dòng mới xuất hiện ở tab **Yêu cầu cấp tài khoản** với trạng thái **Chờ duyệt** (nền vàng).
2. Bạn kiểm tra họ tên, địa chỉ, tên cửa hàng, mã số giấy phép kinh doanh.
3. Nếu đồng ý: chọn dòng đó, menu **Bibi food → Duyệt các yêu cầu đang chọn**. Có thể chọn nhiều dòng cùng lúc.
   - Hệ thống tạo tài khoản với tên đăng nhập là số điện thoại của khách, mật khẩu ngẫu nhiên.
   - Hộp thoại hiện tên đăng nhập và mật khẩu **một lần duy nhất**, bạn gửi cho khách qua điện thoại/KakaoTalk.
   - Dòng yêu cầu chuyển thành **Đã duyệt** (nền xanh).
4. Nếu từ chối: đổi cột Trạng thái thành **Từ chối** (nền đỏ). Có thể ghi lý do ở cột Ghi chú.
5. Khóa tài khoản: ở tab **Tài khoản**, đổi Trạng thái thành **Đã khóa**.
6. Khách quên mật khẩu: chọn dòng tài khoản, menu **Bibi food → Đặt lại mật khẩu cho tài khoản đang chọn**.

## Bảo mật

- Mật khẩu không được lưu nguyên văn, chỉ lưu bản mã hóa SHA-256 kèm salt (cột B, C bị ẩn ở tab Tài khoản).
- Nhập sai mật khẩu 5 lần thì tài khoản bị tạm chặn 15 phút.
- Trang web chỉ gửi được yêu cầu và đăng nhập, không đọc được danh sách trong Sheet.
- Mỗi số điện thoại chỉ có một yêu cầu "Chờ duyệt" tại một thời điểm.
- Sau mỗi lần sửa `Wholesale.gs`: **Triển khai → Quản lý bản triển khai → Chỉnh sửa → Phiên bản mới**. URL giữ nguyên.
