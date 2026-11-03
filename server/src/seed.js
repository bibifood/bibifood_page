'use strict';
const { newId, nowIso, slugify } = require('./util');
const data = require('./seed-data.json');

const CATEGORY_ORDER = ['gio', 'xucxich', 'nem', 'kho', 'banhtrung', 'vien', 'khac'];
const DEFAULT_PRICE = 10000; // trang bán hàng đang để tạm 10,000 ₩ cho mọi sản phẩm

/** Nạp danh mục + sản phẩm mẫu nếu bảng còn trống (không ghi đè dữ liệu đã có). */
function seedCatalog(db) {
  if (db.get('SELECT COUNT(*) AS c FROM categories').c > 0 || db.get('SELECT COUNT(*) AS c FROM products').c > 0) {
    return { categories: 0, products: 0 };
  }
  const now = nowIso();
  const catIds = {};
  return db.tx(() => {
    CATEGORY_ORDER.forEach((slug, i) => {
      const id = newId();
      catIds[slug] = id;
      db.run(
        'INSERT INTO categories (id, slug, labels, sort_order, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
        id, slug, JSON.stringify(data.categories[slug]), i, now, now,
      );
    });
    data.products.forEach((p, i) => {
      db.run(
        `INSERT INTO products (id, i18n_key, slug, category_id, names, price, image, details, active, in_stock, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
        newId(), p.key, slugify(p.names.vi), catIds[p.category] || null, JSON.stringify(p.names),
        DEFAULT_PRICE, p.image, JSON.stringify(p.details), i, now, now,
      );
    });
    return { categories: CATEGORY_ORDER.length, products: data.products.length };
  });
}

/** Tạo tài khoản admin đầu tiên nếu chưa có admin nào. Trả về null nếu đã có. */
async function ensureAdmin(db, auth, { username, password, fullName = 'Quản trị viên' }) {
  if (db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'ADMIN'").c > 0) return null;
  const now = nowIso();
  db.run(
    `INSERT INTO users (id, username, password_hash, full_name, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ADMIN', ?, ?)`,
    newId(), username, await auth.hash(password), fullName, now, now,
  );
  return { username, password };
}

module.exports = { seedCatalog, ensureAdmin };

if (require.main === module) {
  const { createConfig } = require('./config');
  const { openDb } = require('./db');
  const { createAuth } = require('./auth');
  const config = createConfig();
  const db = openDb(config.dbPath);
  const r = seedCatalog(db);
  console.log(r.products ? `Đã nạp ${r.categories} danh mục, ${r.products} sản phẩm.` : 'Dữ liệu đã có sẵn, bỏ qua.');
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (username && password) {
    ensureAdmin(db, createAuth({ db, config }), { username, password }).then((a) => {
      console.log(a ? `Đã tạo admin "${a.username}".` : 'Đã có admin, bỏ qua.');
      db.close();
    });
  } else {
    db.close();
  }
}
