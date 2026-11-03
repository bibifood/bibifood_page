'use strict';
const express = require('express');
const cors = require('cors');
const { HttpError } = require('./util');
const { createAuth } = require('./auth');

function createApp({ db, config }) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // Mặc định cho phép mọi cổng trên localhost / 127.0.0.1 (để mở index.html hoặc trang admin ở cổng bất kỳ).
  // Có thể thêm miền khác bằng CORS_ORIGINS trong .env. Bearer token (không dùng cookie) nên không cần credentials.
  const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  app.use(cors({
    origin(origin, cb) {
      // origin === 'null' là khi mở trực tiếp file index.html bằng trình duyệt (file://).
      // Server chỉ nghe trên 127.0.0.1 và dùng Bearer token (không cookie) nên an toàn cho môi trường offline.
      if (!origin || origin === 'null' || localOrigin.test(origin) || config.corsOrigins.includes(origin)) return cb(null, true);
      cb(null, false);
    },
    maxAge: 600,
  }));

  app.use(express.json({ limit: '200kb' }));

  // Ảnh tải lên: chỉ phục vụ file tĩnh, không cho thực thi và không liệt kê thư mục.
  app.use('/uploads', express.static(config.uploadDir, {
    index: false,
    dotfiles: 'ignore',
    maxAge: '7d',
    setHeaders: (res) => res.setHeader('Content-Disposition', 'inline'),
  }));

  const auth = createAuth({ db, config });
  const ctx = { db, auth, config };

  const api = express.Router();
  api.use('/auth', require('./routes/auth')(ctx));
  api.use('/admin', require('./routes/admin')(ctx));
  api.use('/', require('./routes/public')(ctx));
  app.use('/api', api);

  app.get('/', (req, res) => res.json({ name: 'Bibi food API', status: 'ok', docs: '/api/health' }));

  app.use((req, res, next) => next(new HttpError(404, 'Không tìm thấy đường dẫn')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || 500;
    let message = err.message;
    if (err.type === 'entity.parse.failed') { status = 400; message = 'Dữ liệu gửi lên không đúng định dạng JSON'; }
    else if (err.type === 'entity.too.large') { status = 413; message = 'Dữ liệu gửi lên quá lớn'; }
    else if (err.code === 'LIMIT_FILE_SIZE') { status = 400; message = 'Ảnh quá lớn (tối đa 5MB)'; }
    else if (err.name === 'MulterError') { status = 400; message = 'Tải file không hợp lệ'; }
    if (status >= 500) {
      console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
      message = 'Lỗi máy chủ, vui lòng thử lại sau';
    }
    const body = { statusCode: status, message };
    if (err instanceof HttpError && err.errorCode) body.code = err.errorCode;
    res.status(status).json(body);
  });

  return app;
}

module.exports = { createApp };
