'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createConfig } = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { createAuth } = require('./auth');
const { seedCatalog, ensureAdmin } = require('./seed');
const { randomPassword } = require('./util');

async function main() {
  const config = createConfig();
  const db = openDb(config.dbPath);

  const seeded = seedCatalog(db);
  if (seeded.products) console.log(`Đã nạp dữ liệu mẫu: ${seeded.categories} danh mục, ${seeded.products} sản phẩm.`);

  // Admin đầu tiên: dùng ADMIN_USERNAME / ADMIN_PASSWORD trong .env, nếu không có thì tạo mật khẩu ngẫu nhiên
  const wantPassword = process.env.ADMIN_PASSWORD || randomPassword(12);
  const created = await ensureAdmin(db, createAuth({ db, config }), {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: wantPassword,
  });
  if (created) {
    const note = [
      'TÀI KHOẢN QUẢN TRỊ ĐẦU TIÊN',
      `Tên đăng nhập: ${created.username}`,
      `Mật khẩu:      ${created.password}`,
      '',
      'Hãy đăng nhập rồi đổi mật khẩu. File này chỉ để bạn xem lại, có thể xóa sau khi đã lưu mật khẩu.',
    ].join('\n');
    const file = path.join(config.dataDir, 'ADMIN_ACCOUNT.txt');
    fs.writeFileSync(file, note + '\n', { mode: 0o600 });
    console.log('\n' + '='.repeat(56));
    console.log(note);
    console.log('(đã lưu vào ' + file + ')');
    console.log('='.repeat(56) + '\n');
  }

  fs.mkdirSync(config.uploadDir, { recursive: true });
  const app = createApp({ db, config });
  const server = app.listen(config.port, config.host, () => {
    console.log(`Bibi food server đang chạy: http://${config.host}:${config.port}/api`);
    console.log(`Cơ sở dữ liệu: ${config.dbPath}`);
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('Không khởi động được server:', e);
  process.exit(1);
});
