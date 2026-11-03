'use strict';
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { HttpError } = require('./util');

const DUMMY_HASH = bcrypt.hashSync('khong-ai-dung-mat-khau-nay', 10);

// Chỉ khách mua sỉ và admin được đăng nhập. Tài khoản quyền khác (USER) bị chặn cả ở bước đăng nhập lẫn khi dùng token.
const LOGIN_ROLES = ['WHOLESALE', 'ADMIN'];

function createAuth({ db, config }) {
  const sign = (u) =>
    jwt.sign({ sub: u.id, role: u.role, tv: u.token_version }, config.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: config.jwtExpiresIn,
    });

  const hash = (password) => bcrypt.hash(password, 10);
  // Luôn so sánh với một hash (kể cả khi user không tồn tại) để thời gian phản hồi không lộ tài khoản có tồn tại hay không.
  const compare = (password, hashed) => bcrypt.compare(password, hashed || DUMMY_HASH);

  function load(req, required) {
    const m = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
    if (!m) {
      if (required) throw new HttpError(401, 'Bạn chưa đăng nhập');
      return;
    }
    let payload;
    try {
      payload = jwt.verify(m[1], config.jwtSecret, { algorithms: ['HS256'] });
    } catch {
      throw new HttpError(401, 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại');
    }
    const user = db.get('SELECT * FROM users WHERE id = ?', payload.sub);
    // token_version đổi khi đặt lại mật khẩu, đổi quyền hoặc khóa tài khoản => token cũ mất hiệu lực ngay
    if (!user || user.banned || user.token_version !== payload.tv || !LOGIN_ROLES.includes(user.role)) {
      throw new HttpError(401, 'Phiên đăng nhập không còn hiệu lực, vui lòng đăng nhập lại');
    }
    req.user = user;
  }

  return {
    loginRoles: LOGIN_ROLES,
    sign,
    hash,
    compare,
    required(req, res, next) {
      try { load(req, true); next(); } catch (e) { next(e); }
    },
    optional(req, res, next) {
      try { load(req, false); } catch { /* token sai thì coi như khách */ }
      next();
    },
    admin(req, res, next) {
      if (req.user && req.user.role === 'ADMIN') return next();
      next(new HttpError(403, 'Bạn không có quyền truy cập'));
    },
  };
}

module.exports = { createAuth };
