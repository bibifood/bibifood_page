'use strict';
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.errorCode = code;
  }
}

const bad = (m) => new HttpError(400, m);
const notFound = (m = 'Không tìm thấy dữ liệu') => new HttpError(404, m);
const conflict = (m) => new HttpError(409, m);

const newId = () => crypto.randomBytes(8).toString('hex');
const nowIso = () => new Date().toISOString();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Làm sạch chuỗi người dùng nhập: bỏ ký tự điều khiển, cắt khoảng trắng, giới hạn độ dài. */
function text(value, { max = 200, required = false, label = 'Dữ liệu', multiline = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw bad(`${label} là bắt buộc`);
    return '';
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw bad(`${label} không hợp lệ`);
  const control = multiline
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
    : /[\u0000-\u001F\u007F]+/g;
  const s = String(value).replace(control, ' ').trim();
  if (required && !s) throw bad(`${label} là bắt buộc`);
  if (s.length > max) throw bad(`${label} quá dài (tối đa ${max} ký tự)`);
  return s;
}

function int(value, { min = 0, max = 2_000_000_000, label = 'Giá trị', required = false, def = 0 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad(`${label} là bắt buộc`);
    return def;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label} không hợp lệ`);
  return n;
}

function flag(value, def) {
  if (value === undefined || value === null) return def;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  throw bad('Giá trị đúng/sai không hợp lệ');
}

function paging(query, { size = 20, max = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(max, Math.max(1, parseInt(query.pageSize, 10) || size));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

const pageOut = (items, total, { page, pageSize }) => ({
  items,
  total,
  page,
  pageSize,
  totalPages: Math.ceil(total / pageSize),
});

/** Tham số cho LIKE ... ESCAPE '\' (chặn ký tự đại diện do người dùng nhập). */
const likeArg = (s) => `%${String(s).replace(/[\\%_]/g, (m) => '\\' + m)}%`;
const digits = (s) => String(s || '').replace(/\D+/g, '');

function slugify(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function randomPassword(len = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}

const localDate = (ms, offsetHours) => new Date(ms + offsetHours * 3600e3).toISOString().slice(0, 10);
const sqlOffset = (h) => `${h >= 0 ? '+' : '-'}${Math.abs(h)} hours`;

/** Giới hạn số lần gọi theo IP (trong bộ nhớ). */
function rateLimit({ windowMs, max, message = 'Bạn thao tác quá nhanh, vui lòng thử lại sau', disabled = false }) {
  const hits = new Map();
  return (req, res, next) => {
    if (disabled) return next();
    const now = Date.now();
    const key = req.socket.remoteAddress || 'unknown';
    const rec = hits.get(key);
    if (!rec || rec.reset <= now) {
      hits.set(key, { count: 1, reset: now + windowMs });
    } else if (++rec.count > max) {
      res.setHeader('Retry-After', Math.ceil((rec.reset - now) / 1000));
      return next(new HttpError(429, message));
    }
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    next();
  };
}

module.exports = {
  HttpError, bad, notFound, conflict, newId, nowIso, asyncHandler, text, int, flag,
  paging, pageOut, likeArg, digits, slugify, randomPassword, localDate, sqlOffset, rateLimit,
};
