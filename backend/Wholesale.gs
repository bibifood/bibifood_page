/**
 * bibifood - mua sỉ: đăng nhập và yêu cầu cấp tài khoản.
 * Dùng cho một Google Sheet RIÊNG (khác Sheet khách mua lẻ).
 *
 * Tab "Yêu cầu cấp tài khoản": mọi đơn yêu cầu, có cột Trạng thái để quản lý.
 * Tab "Tài khoản": tài khoản đã duyệt. Mật khẩu chỉ lưu dạng mã hóa (SHA-256 + salt).
 *
 * Cách cài: xem backend/HUONG_DAN_MUA_SI.md
 */

var TIMEZONE = 'Asia/Seoul';
var REQ_SHEET = 'Yêu cầu cấp tài khoản';
var ACC_SHEET = 'Tài khoản';

var REQ_HEADERS = ['Mã yêu cầu', 'Thời gian', 'Họ và tên', 'Số điện thoại', 'Địa chỉ', 'Tên cửa hàng',
                   'Mã số giấy phép kinh doanh', 'Trạng thái', 'Tên đăng nhập', 'Ghi chú'];
var ACC_HEADERS = ['Tên đăng nhập', 'Mật khẩu (đã mã hóa)', 'Salt', 'Họ và tên', 'Tên cửa hàng',
                   'Số điện thoại', 'Trạng thái', 'Ngày tạo', 'Mã yêu cầu'];

var ST_PENDING = 'Chờ duyệt';
var ST_APPROVED = 'Đã duyệt';
var ST_REJECTED = 'Từ chối';
var ST_ACTIVE = 'Hoạt động';
var ST_LOCKED = 'Đã khóa';

var MAX_LEN = 300;
var MAX_FAILS = 5;
var LOCK_SECONDS = 15 * 60;

// ---------------------------------------------------------------- web app

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (data.action === 'login') return json_(login_(data));
    if (data.action === 'request_account') return json_(requestAccount_(data));
    return json_({ ok: false, error: 'bad_action' });
  } catch (err) {
    return json_({ ok: false, error: 'server' });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

// Mở link web app bằng trình duyệt để kiểm tra script đã chạy
function doGet() {
  return json_({ ok: true, service: 'bibifood-wholesale' });
}

function requestAccount_(data) {
  // Ô ẩn chống spam: người thật không điền
  if (data.website) return { ok: true };

  var fullName = clean_(data.fullName);
  var phone = clean_(data.phone);
  var address = clean_(data.address);
  var store = clean_(data.store);
  var license = clean_(data.license);

  if (!fullName || !phone || !address || !store || !license) {
    return { ok: false, error: 'required' };
  }

  var sheet = getReqSheet_();

  // Mỗi số điện thoại chỉ có một yêu cầu đang chờ duyệt
  var rows = sheet.getDataRange().getValues();
  var phoneKey = digits_(phone);
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][7] === ST_PENDING && digits_(rows[i][3]) === phoneKey) {
      return { ok: false, error: 'duplicate' };
    }
  }

  var id = 'YC-' + Utilities.formatDate(new Date(), TIMEZONE, 'yyMMdd') + '-' +
           Utilities.getUuid().substring(0, 4).toUpperCase();
  sheet.appendRow([
    id,
    Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss'),
    fullName, phone, address, store, license,
    ST_PENDING, '', ''
  ]);
  return { ok: true };
}

function login_(data) {
  var username = String(data.username || '').trim().toLowerCase();
  var password = String(data.password || '');
  if (!username || !password) return { ok: false, error: 'invalid' };

  var cache = CacheService.getScriptCache();
  var failKey = 'fail_' + username;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_FAILS) return { ok: false, error: 'locked' };

  var sheet = getAccSheet_();
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).toLowerCase() !== username) continue;
    if (hash_(rows[i][2], password) !== rows[i][1]) break;
    if (rows[i][6] !== ST_ACTIVE) return { ok: false, error: 'inactive' };
    cache.remove(failKey);
    return { ok: true, name: rows[i][4] || rows[i][3] };
  }

  cache.put(failKey, String(fails + 1), LOCK_SECONDS);
  return { ok: false, error: 'invalid' };
}

// ---------------------------------------------------------------- menu quản lý

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Bibi food')
    .addItem('Duyệt các yêu cầu đang chọn', 'approveSelected')
    .addItem('Đặt lại mật khẩu cho tài khoản đang chọn', 'resetSelectedPassword')
    .addToUi();
}

/**
 * Chọn các dòng trong tab "Yêu cầu cấp tài khoản" rồi chạy menu này.
 * Tạo tài khoản (tên đăng nhập = số điện thoại), mật khẩu ngẫu nhiên.
 * Mật khẩu chỉ hiện MỘT LẦN trong hộp thoại để bạn gửi cho khách.
 */
function approveSelected() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== REQ_SHEET) {
    ui.alert('Hãy mở tab "' + REQ_SHEET + '" và chọn các dòng cần duyệt.');
    return;
  }

  var range = sheet.getActiveRange();
  var first = Math.max(range.getRow(), 2);
  var last = range.getLastRow();
  var acc = getAccSheet_();
  var created = [];

  for (var r = first; r <= last; r++) {
    var row = sheet.getRange(r, 1, 1, REQ_HEADERS.length).getValues()[0];
    if (row[7] !== ST_PENDING) continue;

    var username = uniqueUsername_(acc, digits_(row[3]) || ('shop' + r));
    var password = randomPassword_();
    var salt = Utilities.getUuid();

    acc.appendRow([
      username, hash_(salt, password), salt, row[2], row[5], row[3],
      ST_ACTIVE, Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss'), row[0]
    ]);
    sheet.getRange(r, 8).setValue(ST_APPROVED);
    sheet.getRange(r, 9).setValue(username);
    created.push(row[5] + ' (' + row[2] + ')\n   Tên đăng nhập: ' + username + '\n   Mật khẩu: ' + password);
  }

  if (!created.length) {
    ui.alert('Không có dòng nào ở trạng thái "' + ST_PENDING + '" trong vùng đã chọn.');
    return;
  }
  ui.alert('Đã tạo ' + created.length + ' tài khoản.\nHãy gửi thông tin này cho khách, mật khẩu sẽ không hiển thị lại:\n\n' +
           created.join('\n\n'));
}

/** Chọn một dòng trong tab "Tài khoản" rồi chạy menu này để cấp mật khẩu mới. */
function resetSelectedPassword() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== ACC_SHEET) {
    ui.alert('Hãy mở tab "' + ACC_SHEET + '" và chọn tài khoản cần đặt lại mật khẩu.');
    return;
  }
  var r = sheet.getActiveRange().getRow();
  if (r < 2) return;

  var username = sheet.getRange(r, 1).getValue();
  var password = randomPassword_();
  var salt = Utilities.getUuid();
  sheet.getRange(r, 2, 1, 2).setValues([[hash_(salt, password), salt]]);
  ui.alert('Mật khẩu mới của "' + username + '":\n\n' + password + '\n\nHãy gửi cho khách, mật khẩu sẽ không hiển thị lại.');
}

// ---------------------------------------------------------------- sheet helpers

function getReqSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(REQ_SHEET);
  if (sheet) return sheet;

  sheet = ss.insertSheet(REQ_SHEET);
  styleHeader_(sheet, REQ_HEADERS);
  // Giữ số 0 đầu của số điện thoại và mã giấy phép
  sheet.getRange('D:D').setNumberFormat('@');
  sheet.getRange('G:G').setNumberFormat('@');
  sheet.getRange(2, 8, 998, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList([ST_PENDING, ST_APPROVED, ST_REJECTED], true).build());

  var statusRange = sheet.getRange(2, 1, 998, REQ_HEADERS.length);
  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$H2="' + ST_PENDING + '"')
      .setBackground('#FFF4D6').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$H2="' + ST_APPROVED + '"')
      .setBackground('#E3F3E5').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$H2="' + ST_REJECTED + '"')
      .setBackground('#FCE9E7').setRanges([statusRange]).build()
  ]);

  var widths = [110, 150, 160, 130, 280, 180, 190, 100, 140, 220];
  widths.forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });
  return sheet;
}

function getAccSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ACC_SHEET);
  if (sheet) return sheet;

  sheet = ss.insertSheet(ACC_SHEET);
  styleHeader_(sheet, ACC_HEADERS);
  sheet.getRange('A:A').setNumberFormat('@');
  sheet.getRange('F:F').setNumberFormat('@');
  sheet.getRange(2, 7, 998, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList([ST_ACTIVE, ST_LOCKED], true).build());
  sheet.hideColumns(2, 2); // ẩn cột mật khẩu mã hóa và salt
  return sheet;
}

function styleHeader_(sheet, headers) {
  sheet.appendRow(headers);
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold').setBackground('#7A2333').setFontColor('#FFFFFF');
  sheet.setFrozenRows(1);
}

function uniqueUsername_(accSheet, base) {
  var existing = {};
  accSheet.getDataRange().getValues().forEach(function (r) { existing[String(r[0]).toLowerCase()] = true; });
  var name = base, n = 2;
  while (existing[name.toLowerCase()]) { name = base + '-' + n++; }
  return name;
}

// ---------------------------------------------------------------- utils

function hash_(salt, password) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + password, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function randomPassword_() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  var out = '';
  for (var i = 0; i < 10; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function digits_(value) {
  return String(value == null ? '' : value).replace(/\D+/g, '');
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
