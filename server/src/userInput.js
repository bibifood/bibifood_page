'use strict';
const { bad, text } = require('./util');

function password(v) {
  if (typeof v !== 'string' || v.length < 6) throw bad('Mật khẩu tối thiểu 6 ký tự');
  if (Buffer.byteLength(v) > 72) throw bad('Mật khẩu quá dài (tối đa 72 byte)');
  return v;
}

/** Trả về null nếu để trống (cột email là NULL khi không có, để không vi phạm ràng buộc duy nhất). */
function email(v) {
  const s = text(v, { max: 120, label: 'Email' });
  if (!s) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad('Email không hợp lệ');
  return s;
}

function phone(v) {
  const s = text(v, { max: 20, label: 'Số điện thoại' });
  if (s && !/^[0-9+\-\s().]{6,20}$/.test(s)) throw bad('Số điện thoại không hợp lệ');
  return s;
}

module.exports = { password, email, phone };
