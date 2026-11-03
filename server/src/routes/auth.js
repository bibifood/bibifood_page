'use strict';
const express = require('express');
const { asyncHandler, bad, conflict, HttpError, text, nowIso, rateLimit } = require('../util');
const input = require('../userInput');
const { userOut } = require('../serializers');

module.exports = function authRoutes({ db, auth, config }) {
  const router = express.Router();
  // Chống dò mật khẩu: 20 lần mỗi 15 phút cho mỗi IP.
  // Không có đăng ký tự do: tài khoản mua sỉ do admin duyệt từ yêu cầu (POST /api/wholesale/requests), admin tạo lúc cài đặt.
  const limiter = rateLimit({
    windowMs: 15 * 60_000,
    max: 20,
    message: 'Bạn thử quá nhiều lần, vui lòng đợi 15 phút rồi thử lại',
    disabled: config.disableRateLimit,
  });

  router.post('/login', limiter, asyncHandler(async (req, res) => {
    const b = req.body || {};
    const username = typeof b.username === 'string' ? b.username.trim() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    if (!username || !password) throw bad('Vui lòng nhập tên đăng nhập và mật khẩu');

    const user = db.get('SELECT * FROM users WHERE username = ?', username);
    const ok = await auth.compare(password, user && user.password_hash);
    if (!user || !ok) throw new HttpError(401, 'Sai tên đăng nhập hoặc mật khẩu');
    if (user.banned) throw new HttpError(403, 'Tài khoản đã bị khóa. Vui lòng liên hệ quản trị viên', 'BANNED');
    if (!auth.loginRoles.includes(user.role)) {
      throw new HttpError(403, 'Tài khoản này không có quyền đăng nhập. Chỉ khách mua sỉ và quản trị viên được đăng nhập', 'NOT_ALLOWED');
    }

    db.run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), user.id);
    res.json({ user: userOut(user), accessToken: auth.sign(user) });
  }));

  router.get('/me', auth.required, (req, res) => res.json({ user: userOut(req.user) }));

  router.patch('/me', auth.required, asyncHandler(async (req, res) => {
    const b = req.body || {};
    const fullName = b.fullName === undefined ? req.user.full_name : text(b.fullName, { max: 80, label: 'Họ và tên' });
    const phone = b.phone === undefined ? req.user.phone : input.phone(b.phone);
    const email = b.email === undefined ? req.user.email : input.email(b.email);
    if (email && email.toLowerCase() !== (req.user.email || '').toLowerCase()
        && db.get('SELECT 1 AS x FROM users WHERE email = ? AND id != ?', email, req.user.id)) {
      throw conflict('Email đã được sử dụng');
    }
    db.run('UPDATE users SET full_name = ?, phone = ?, email = ?, updated_at = ? WHERE id = ?',
      fullName, phone, email, nowIso(), req.user.id);
    res.json({ user: userOut(db.get('SELECT * FROM users WHERE id = ?', req.user.id)) });
  }));

  router.post('/change-password', auth.required, limiter, asyncHandler(async (req, res) => {
    const b = req.body || {};
    const next = input.password(b.newPassword);
    if (!(await auth.compare(String(b.currentPassword || ''), req.user.password_hash))) {
      throw bad('Mật khẩu hiện tại không đúng');
    }
    // Tăng token_version để mọi phiên đăng nhập cũ hết hiệu lực
    db.run('UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?',
      await auth.hash(next), nowIso(), req.user.id);
    const user = db.get('SELECT * FROM users WHERE id = ?', req.user.id);
    res.json({ user: userOut(user), accessToken: auth.sign(user) });
  }));

  return router;
};
