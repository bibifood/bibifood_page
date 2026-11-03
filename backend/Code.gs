/**
 * bibifood - nhận thông tin khách hàng và ghi vào Google Sheet.
 * Mỗi ngày một tab riêng, tên tab theo định dạng yyyy-MM-dd (giờ Hàn Quốc).
 *
 * Cách cài: xem backend/HUONG_DAN.md
 */

var TIMEZONE = 'Asia/Seoul';
var HEADERS = ['Thời gian', 'Tên người mua', 'Số điện thoại', 'Mã bưu điện', 'Địa chỉ', 'Địa chỉ chi tiết', 'Facebook', 'Giỏ hàng', 'Ngôn ngữ', 'Đồng ý nhận ưu đãi'];
var MAX_LEN = 500;

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);

    var data = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    // Trường ẩn chống spam: người thật không điền
    if (data.website) {
      return json_({ ok: true });
    }

    var name = clean_(data.name);
    var phone = clean_(data.phone);
    var zipcode = clean_(data.zipcode);
    var address = clean_(data.address);
    var addressDetail = clean_(data.addressDetail);
    var facebook = clean_(data.facebook);

    // Tên, số điện thoại, địa chỉ (chọn từ công cụ tìm địa chỉ Hàn Quốc) và địa chỉ chi tiết là bắt buộc; Facebook thì không
    if (!name || !phone || !address || !addressDetail || !/^\d{5}$/.test(zipcode) || !/[가-힣]/.test(address)) {
      return json_({ ok: false, error: 'required' });
    }

    var sheet = getTodaySheet_();
    var now = new Date();
    sheet.appendRow([
      Utilities.formatDate(now, TIMEZONE, 'yyyy-MM-dd HH:mm:ss'),
      name,
      phone,
      zipcode,
      address,
      addressDetail,
      facebook,
      clean_(data.cart),
      clean_(data.lang),
      data.consent ? 'Có' : 'Không'
    ]);

    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

// Mở link web app bằng trình duyệt để kiểm tra script đã chạy
function doGet() {
  return json_({ ok: true, service: 'bibifood-customer-form' });
}

function getTodaySheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tabName = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setFontWeight('bold')
      .setBackground('#7A2333')
      .setFontColor('#FFFFFF');
    sheet.setFrozenRows(1);
    // Giữ nguyên số 0 đầu của số điện thoại
    sheet.getRange('C:D').setNumberFormat('@'); // số điện thoại + mã bưu điện (giữ số 0 đầu)
    sheet.setColumnWidth(1, 150);
    sheet.setColumnWidths(2, 3, 150);
    sheet.setColumnWidth(5, 320);
    sheet.setColumnWidth(6, 180);
    sheet.setColumnWidth(7, 200);
    sheet.setColumnWidth(8, 320);
  }
  return sheet;
}

// Cắt độ dài và chặn công thức (=, +, -, @) để tránh chèn công thức vào Sheet
function clean_(value) {
  var text = String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim();
  if (text.length > MAX_LEN) text = text.substring(0, MAX_LEN);
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return text;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
