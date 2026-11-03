'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const {
  asyncHandler, bad, notFound, conflict, HttpError, text, int, flag, newId, nowIso,
  paging, pageOut, likeArg, slugify, randomPassword, localDate, sqlOffset, digits,
} = require('../util');
const input = require('../userInput');
const {
  userOut, categoryOut, productOut, orderOut, wholesaleOut, auditOut, parse,
} = require('../serializers');
const { getSite, saveSite } = require('../settings');

const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'SHIPPING', 'DELIVERED', 'CANCELLED'];
const ORDER_FLOW = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['SHIPPING', 'CANCELLED'],
  SHIPPING: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};
const LANGS = ['vi', 'ko', 'en', 'zh'];
const ROLES = ['USER', 'WHOLESALE', 'ADMIN'];
const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

/** Đọc vài byte đầu của file để chắc chắn đúng là ảnh (không tin Content-Type do trình duyệt gửi). */
function sniffImage(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(12);
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return '.gif';
  return null;
}

module.exports = function adminRoutes({ db, auth, config }) {
  const router = express.Router();
  router.use(auth.required, auth.admin);

  const audit = (req, action, entity, entityId, entityLabel, meta) =>
    db.run(
      `INSERT INTO audit_logs (id, admin_id, admin_username, action, entity, entity_id, entity_label, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId(), req.user.id, req.user.username, action, entity, String(entityId || ''), String(entityLabel || ''),
      meta ? JSON.stringify(meta) : null, nowIso(),
    );

  // -------------------------------------------------------------- dashboard
  router.get('/dashboard/overview', (req, res) => {
    const off = sqlOffset(config.tzOffsetHours);
    const today = localDate(Date.now(), config.tzOffsetHours);
    const todayRow = db.get(
      `SELECT COUNT(*) AS c, COALESCE(SUM(total), 0) AS s FROM orders
       WHERE status != 'CANCELLED' AND date(created_at, ?) = ?`, off, today,
    );
    const ordersTotal = db.get('SELECT COUNT(*) AS c FROM orders').c;
    const pending = db.get("SELECT COUNT(*) AS c FROM orders WHERE status = 'PENDING'").c;
    const revenueAll = db.get("SELECT COALESCE(SUM(total), 0) AS s FROM orders WHERE status = 'DELIVERED'").s;
    const users = db.get(
      `SELECT COUNT(*) AS total, COALESCE(SUM(role = 'ADMIN'), 0) AS admins, COALESCE(SUM(banned), 0) AS banned,
              COALESCE(SUM(role = 'WHOLESALE'), 0) AS wholesale FROM users`,
    );
    res.json({
      revenue: { today: todayRow.s, delivered: revenueAll },
      orders: { today: { count: todayRow.c }, total: ordersTotal, pending },
      catalog: {
        productsActive: db.get('SELECT COUNT(*) AS c FROM products WHERE active = 1 AND deleted_at IS NULL').c,
        categories: db.get('SELECT COUNT(*) AS c FROM categories WHERE active = 1').c,
      },
      users: { total: users.total, admins: users.admins, banned: users.banned, wholesale: users.wholesale },
      wholesale: { pending: db.get("SELECT COUNT(*) AS c FROM wholesale_requests WHERE status = 'PENDING'").c },
    });
  });

  router.get('/dashboard/revenue', (req, res) => {
    const m = /^(\d{1,3})(d)?$/.exec(String(req.query.range || '7'));
    const days = Math.min(365, Math.max(1, m ? parseInt(m[1], 10) : 7));
    const off = sqlOffset(config.tzOffsetHours);
    const first = localDate(Date.now() - (days - 1) * 86400e3, config.tzOffsetHours);
    const rows = db.all(
      `SELECT date(created_at, ?) AS d, COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
       FROM orders WHERE status != 'CANCELLED' AND date(created_at, ?) >= ? GROUP BY d`, off, off, first,
    );
    const byDay = new Map(rows.map((r) => [r.d, r]));
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = localDate(Date.now() - i * 86400e3, config.tzOffsetHours);
      const r = byDay.get(d);
      out.push({ date: d, revenue: r ? r.revenue : 0, orders: r ? r.orders : 0 });
    }
    res.json(out);
  });

  router.get('/dashboard/top-products', (req, res) => {
    const limit = int(req.query.limit, { min: 1, max: 50, def: 10 });
    const rows = db.all(
      `SELECT oi.product_id AS id, COALESCE(p.slug, '') AS slug, COALESCE(p.image, '') AS image, MIN(oi.name) AS name,
              MAX(oi.price) AS price, SUM(oi.qty) AS sold, SUM(oi.qty * oi.price) AS revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN products p ON p.id = oi.product_id
       WHERE o.status != 'CANCELLED' GROUP BY oi.product_id ORDER BY sold DESC LIMIT ?`, limit,
    );
    res.json(rows);
  });

  router.get('/dashboard/audit', (req, res) => {
    const size = int(req.query.pageSize, { min: 1, max: 100, def: 10 });
    res.json(db.all('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?', size).map(auditOut));
  });

  // -------------------------------------------------------------- orders
  router.get('/orders/stats', (req, res) => {
    const out = { total: 0, byStatus: {} };
    for (const s of ORDER_STATUSES) out.byStatus[s] = 0;
    for (const r of db.all('SELECT status, COUNT(*) AS c FROM orders GROUP BY status')) {
      out.byStatus[r.status] = r.c;
      out.total += r.c;
    }
    res.json(out);
  });

  router.get('/orders', (req, res) => {
    const pg = paging(req.query);
    const where = [];
    const args = [];
    if (req.query.status && ORDER_STATUSES.includes(req.query.status)) { where.push('o.status = ?'); args.push(req.query.status); }
    if (req.query.search) {
      where.push("(o.code LIKE ? ESCAPE '\\' OR o.customer_name LIKE ? ESCAPE '\\' OR o.phone LIKE ? ESCAPE '\\')");
      const l = likeArg(String(req.query.search).slice(0, 100));
      args.push(l, l, l);
    }
    const off = sqlOffset(config.tzOffsetHours);
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.dateFrom || '')) { where.push('date(o.created_at, ?) >= ?'); args.push(off, req.query.dateFrom); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.dateTo || '')) { where.push('date(o.created_at, ?) <= ?'); args.push(off, req.query.dateTo); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.get(`SELECT COUNT(*) AS c FROM orders o ${w}`, ...args).c;
    const rows = db.all(
      `SELECT o.*, (SELECT COALESCE(SUM(qty), 0) FROM order_items WHERE order_id = o.id) AS item_count
       FROM orders o ${w} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`, ...args, pg.pageSize, pg.offset,
    );
    res.json(pageOut(rows.map((r) => orderOut(r)), total, pg));
  });

  router.get('/orders/:id', (req, res) => {
    const o = db.get('SELECT * FROM orders WHERE id = ? OR code = ?', req.params.id, req.params.id);
    if (!o) throw notFound('Không tìm thấy đơn hàng');
    res.json(orderOut(o, {
      items: db.all('SELECT * FROM order_items WHERE order_id = ?', o.id),
      events: db.all('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at', o.id),
    }));
  });

  router.patch('/orders/:id/status', (req, res) => {
    const status = String((req.body || {}).status || '');
    const note = text((req.body || {}).note, { max: 300, label: 'Ghi chú', multiline: true });
    if (!ORDER_STATUSES.includes(status)) throw bad('Trạng thái không hợp lệ');
    db.tx(() => {
      const o = db.get('SELECT * FROM orders WHERE id = ?', req.params.id);
      if (!o) throw notFound('Không tìm thấy đơn hàng');
      if (!ORDER_FLOW[o.status].includes(status)) throw bad(`Không thể chuyển từ ${o.status} sang ${status}`);
      const now = nowIso();
      db.run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', status, now, o.id);
      db.run(
        'INSERT INTO order_events (id, order_id, from_status, to_status, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        newId(), o.id, o.status, status, note, req.user.username, now,
      );
      audit(req, 'ORDER_STATUS', 'Order', o.id, o.code, { from: o.status, to: status });
    });
    const o = db.get('SELECT * FROM orders WHERE id = ?', req.params.id);
    res.json(orderOut(o, {
      items: db.all('SELECT * FROM order_items WHERE order_id = ?', o.id),
      events: db.all('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at', o.id),
    }));
  });

  // -------------------------------------------------------------- categories
  const categoryRow = (id) => db.get(
    `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.deleted_at IS NULL) AS product_count
     FROM categories c WHERE c.id = ?`, id,
  );

  function categoryInput(b, current) {
    const cur = current ? parse(current.labels, {}) : {};
    const labels = { ...cur };
    const src = b.labels && typeof b.labels === 'object' ? b.labels : {};
    for (const l of LANGS) if (src[l] !== undefined) labels[l] = text(src[l], { max: 80, label: `Tên danh mục (${l})` });
    if (b.label !== undefined) labels.vi = text(b.label, { max: 80, label: 'Tên danh mục' });
    if (!labels.vi) throw bad('Tên danh mục tiếng Việt là bắt buộc');
    return labels;
  }

  router.get('/categories', (req, res) => {
    res.json(db.all(
      `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.deleted_at IS NULL) AS product_count
       FROM categories c ORDER BY c.sort_order, c.slug`,
    ).map(categoryOut));
  });

  router.get('/categories/:id', (req, res) => {
    const r = categoryRow(req.params.id);
    if (!r) throw notFound('Không tìm thấy danh mục');
    res.json(categoryOut(r));
  });

  router.post('/categories', (req, res) => {
    const b = req.body || {};
    const labels = categoryInput(b);
    const slug = text(b.slug, { max: 60, label: 'Slug' }) ? slugify(b.slug) : slugify(labels.vi);
    if (!slug) throw bad('Slug không hợp lệ');
    if (db.get('SELECT 1 AS x FROM categories WHERE slug = ?', slug)) throw conflict('Slug đã tồn tại');
    const id = newId();
    const now = nowIso();
    db.run(
      'INSERT INTO categories (id, slug, labels, sort_order, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, slug, JSON.stringify(labels), int(b.sortOrder, { min: 0, max: 100000, label: 'Thứ tự' }), flag(b.active, true), now, now,
    );
    audit(req, 'CREATE', 'Category', id, labels.vi);
    res.status(201).json(categoryOut(categoryRow(id)));
  });

  router.patch('/categories/:id', (req, res) => {
    const cur = db.get('SELECT * FROM categories WHERE id = ?', req.params.id);
    if (!cur) throw notFound('Không tìm thấy danh mục');
    const b = req.body || {};
    const labels = categoryInput(b, cur);
    let slug = cur.slug;
    if (b.slug !== undefined) {
      slug = slugify(text(b.slug, { required: true, max: 60, label: 'Slug' }));
      if (!slug) throw bad('Slug không hợp lệ');
      if (db.get('SELECT 1 AS x FROM categories WHERE slug = ? AND id != ?', slug, cur.id)) throw conflict('Slug đã tồn tại');
    }
    db.run(
      'UPDATE categories SET slug = ?, labels = ?, sort_order = ?, active = ?, updated_at = ? WHERE id = ?',
      slug, JSON.stringify(labels), b.sortOrder === undefined ? cur.sort_order : int(b.sortOrder, { min: 0, max: 100000, label: 'Thứ tự' }),
      flag(b.active, !!cur.active), nowIso(), cur.id,
    );
    audit(req, 'UPDATE', 'Category', cur.id, labels.vi);
    res.json(categoryOut(categoryRow(cur.id)));
  });

  router.delete('/categories/:id', (req, res) => {
    const cur = categoryRow(req.params.id);
    if (!cur) throw notFound('Không tìm thấy danh mục');
    if (cur.product_count > 0) throw conflict(`Danh mục còn ${cur.product_count} sản phẩm, hãy chuyển sản phẩm sang danh mục khác trước`);
    db.run('DELETE FROM categories WHERE id = ?', cur.id);
    audit(req, 'HARD_DELETE', 'Category', cur.id, parse(cur.labels, {}).vi);
    res.json({ ok: true });
  });

  // -------------------------------------------------------------- products
  const productRow = (id) => db.get(
    `SELECT p.*, c.slug AS category_slug FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`, id,
  );

  function namesInput(b, current) {
    const names = current ? parse(current.names, {}) : {};
    const src = b.names && typeof b.names === 'object' ? b.names : {};
    for (const l of LANGS) if (src[l] !== undefined) names[l] = text(src[l], { max: 150, label: `Tên sản phẩm (${l})` });
    if (b.name !== undefined) names.vi = text(b.name, { max: 150, label: 'Tên sản phẩm' });
    if (!names.vi) throw bad('Tên sản phẩm tiếng Việt là bắt buộc');
    return names;
  }

  function detailsInput(b, current) {
    const details = current ? parse(current.details, {}) : {};
    if (b.details === undefined) return details;
    if (!b.details || typeof b.details !== 'object') throw bad('Chi tiết sản phẩm không hợp lệ');
    for (const l of LANGS) {
      const d = b.details[l];
      if (d === undefined) continue;
      if (!d || typeof d !== 'object') throw bad('Chi tiết sản phẩm không hợp lệ');
      details[l] = {};
      for (const f of ['ingredients', 'serving', 'storage']) {
        const arr = d[f] === undefined ? [] : d[f];
        if (!Array.isArray(arr) || arr.length > 30) throw bad('Chi tiết sản phẩm không hợp lệ');
        details[l][f] = arr.map((x) => text(x, { max: 600, label: 'Chi tiết', multiline: true })).filter(Boolean);
      }
    }
    return details;
  }

  function categoryIdFrom(v) {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const c = db.get('SELECT id FROM categories WHERE id = ? OR slug = ?', String(v), String(v));
    if (!c) throw bad('Danh mục không tồn tại');
    return c.id;
  }

  router.get('/products', (req, res) => {
    const pg = paging(req.query);
    const where = [];
    const args = [];
    const status = req.query.status || 'active';
    if (status === 'active') where.push('p.deleted_at IS NULL');
    else if (status === 'deleted') where.push('p.deleted_at IS NOT NULL');
    else if (status !== 'all') throw bad('Bộ lọc trạng thái không hợp lệ');
    if (req.query.category) { where.push('(c.slug = ? OR c.id = ?)'); args.push(String(req.query.category), String(req.query.category)); }
    if (req.query.search) {
      where.push("(p.names LIKE ? ESCAPE '\\' OR p.slug LIKE ? ESCAPE '\\' OR p.i18n_key LIKE ? ESCAPE '\\')");
      const l = likeArg(String(req.query.search).slice(0, 100));
      args.push(l, l, l);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.get(`SELECT COUNT(*) AS c FROM products p LEFT JOIN categories c ON c.id = p.category_id ${w}`, ...args).c;
    const rows = db.all(
      `SELECT p.*, c.slug AS category_slug FROM products p LEFT JOIN categories c ON c.id = p.category_id
       ${w} ORDER BY p.sort_order, p.created_at LIMIT ? OFFSET ?`, ...args, pg.pageSize, pg.offset,
    );
    res.json(pageOut(rows.map((r) => productOut(r)), total, pg));
  });

  router.get('/products/:id', (req, res) => {
    const r = productRow(req.params.id);
    if (!r) throw notFound('Không tìm thấy sản phẩm');
    res.json(productOut(r, { full: true }));
  });

  router.post('/products', (req, res) => {
    const b = req.body || {};
    const names = namesInput(b);
    const slug = b.slug ? slugify(text(b.slug, { max: 100, label: 'Slug' })) : slugify(names.vi);
    if (!slug) throw bad('Slug không hợp lệ');
    const key = b.key ? text(b.key, { max: 80, label: 'Mã i18n' }) : `product_${slug.replace(/-/g, '_')}`;
    if (!/^[a-z0-9_]+$/.test(key)) throw bad('Mã sản phẩm chỉ gồm chữ thường, số và gạch dưới');
    if (db.get('SELECT 1 AS x FROM products WHERE slug = ? OR i18n_key = ?', slug, key)) throw conflict('Slug hoặc mã sản phẩm đã tồn tại');
    const id = newId();
    const now = nowIso();
    db.run(
      `INSERT INTO products (id, i18n_key, slug, category_id, names, price, image, details, active, in_stock, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, key, slug, categoryIdFrom(b.categoryId ?? b.category) ?? null, JSON.stringify(names),
      int(b.price, { min: 0, max: 1_000_000_000, label: 'Giá' }), text(b.image, { max: 300, label: 'Ảnh' }),
      JSON.stringify(detailsInput(b)), flag(b.active, true), flag(b.inStock, true),
      int(b.sortOrder, { min: 0, max: 100000, label: 'Thứ tự' }), now, now,
    );
    audit(req, 'CREATE', 'Product', id, names.vi);
    res.status(201).json(productOut(productRow(id), { full: true }));
  });

  router.patch('/products/:id', (req, res) => {
    const cur = db.get('SELECT * FROM products WHERE id = ?', req.params.id);
    if (!cur) throw notFound('Không tìm thấy sản phẩm');
    const b = req.body || {};
    const names = namesInput(b, cur);
    let slug = cur.slug;
    if (b.slug !== undefined) {
      slug = slugify(text(b.slug, { required: true, max: 100, label: 'Slug' }));
      if (!slug) throw bad('Slug không hợp lệ');
      if (db.get('SELECT 1 AS x FROM products WHERE slug = ? AND id != ?', slug, cur.id)) throw conflict('Slug đã tồn tại');
    }
    const cat = categoryIdFrom(b.categoryId ?? b.category);
    db.run(
      `UPDATE products SET slug = ?, category_id = ?, names = ?, price = ?, image = ?, details = ?, active = ?, in_stock = ?,
         sort_order = ?, updated_at = ? WHERE id = ?`,
      slug, cat === undefined ? cur.category_id : cat, JSON.stringify(names),
      b.price === undefined ? cur.price : int(b.price, { min: 0, max: 1_000_000_000, label: 'Giá' }),
      b.image === undefined ? cur.image : text(b.image, { max: 300, label: 'Ảnh' }),
      JSON.stringify(detailsInput(b, cur)), flag(b.active, !!cur.active), flag(b.inStock, !!cur.in_stock),
      b.sortOrder === undefined ? cur.sort_order : int(b.sortOrder, { min: 0, max: 100000, label: 'Thứ tự' }),
      nowIso(), cur.id,
    );
    audit(req, 'UPDATE', 'Product', cur.id, names.vi);
    res.json(productOut(productRow(cur.id), { full: true }));
  });

  router.delete('/products/:id', (req, res) => {
    const cur = db.get('SELECT * FROM products WHERE id = ?', req.params.id);
    if (!cur) throw notFound('Không tìm thấy sản phẩm');
    db.run('UPDATE products SET deleted_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), cur.id);
    audit(req, 'SOFT_DELETE', 'Product', cur.id, parse(cur.names, {}).vi);
    res.json({ ok: true });
  });

  router.post('/products/:id/restore', (req, res) => {
    const cur = db.get('SELECT * FROM products WHERE id = ?', req.params.id);
    if (!cur) throw notFound('Không tìm thấy sản phẩm');
    db.run('UPDATE products SET deleted_at = NULL, updated_at = ? WHERE id = ?', nowIso(), cur.id);
    audit(req, 'RESTORE', 'Product', cur.id, parse(cur.names, {}).vi);
    res.json(productOut(productRow(cur.id), { full: true }));
  });

  router.delete('/products/:id/hard', (req, res) => {
    const cur = db.get('SELECT * FROM products WHERE id = ?', req.params.id);
    if (!cur) throw notFound('Không tìm thấy sản phẩm');
    if (!cur.deleted_at) throw conflict('Hãy xóa mềm sản phẩm trước khi xóa vĩnh viễn');
    db.run('DELETE FROM products WHERE id = ?', cur.id);
    audit(req, 'HARD_DELETE', 'Product', cur.id, parse(cur.names, {}).vi);
    res.json({ ok: true });
  });

  // -------------------------------------------------------------- upload
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(config.uploadDir, 'tmp');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, `${Date.now()}-${newId()}`),
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => (IMAGE_TYPES[file.mimetype] ? cb(null, true) : cb(new HttpError(400, 'Chỉ chấp nhận ảnh JPG, PNG, WEBP hoặc GIF'))),
  });

  /** Lưu ảnh vào uploads/<folder>/ với tên và đuôi do máy chủ tự đặt. */
  function storeImage(file, folder) {
    const ext = sniffImage(file.path);
    if (!ext) {
      fs.rmSync(file.path, { force: true });
      throw new HttpError(400, 'File không phải ảnh hợp lệ');
    }
    const dir = path.join(config.uploadDir, folder);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${newId()}${ext}`;
    fs.renameSync(file.path, path.join(dir, name));
    return `/uploads/${folder}/${name}`;
  }

  router.post('/products/:id/upload-image', upload.single('file'), (req, res) => {
    if (!req.file) throw bad('Chưa chọn file ảnh');
    const cur = db.get('SELECT * FROM products WHERE id = ?', req.params.id);
    if (!cur) { fs.rmSync(req.file.path, { force: true }); throw notFound('Không tìm thấy sản phẩm'); }
    const url = storeImage(req.file, 'products');
    db.run('UPDATE products SET image = ?, updated_at = ? WHERE id = ?', url, nowIso(), cur.id);
    audit(req, 'UPLOAD', 'Product', cur.id, parse(cur.names, {}).vi);
    res.json({ url, product: productOut(productRow(cur.id), { full: true }) });
  });

  router.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) throw bad('Chưa chọn file ảnh');
    const folder = ['site', 'misc'].includes(req.query.folder) ? req.query.folder : 'misc';
    const url = storeImage(req.file, folder);
    audit(req, 'UPLOAD', 'File', url, url);
    res.json({ url });
  });

  // -------------------------------------------------------------- users
  router.get('/users/stats', (req, res) => {
    const r = db.get(
      `SELECT COUNT(*) AS total, COALESCE(SUM(role = 'ADMIN'), 0) AS admins, COALESCE(SUM(role = 'WHOLESALE'), 0) AS wholesale,
              COALESCE(SUM(role = 'USER'), 0) AS users, COALESCE(SUM(banned), 0) AS banned FROM users`,
    );
    res.json(r);
  });

  router.get('/users', (req, res) => {
    const pg = paging(req.query);
    const where = [];
    const args = [];
    if (req.query.role && ROLES.includes(req.query.role)) { where.push('role = ?'); args.push(req.query.role); }
    if (req.query.status === 'banned') where.push('banned = 1');
    else if (req.query.status === 'active') where.push('banned = 0');
    if (req.query.search) {
      where.push("(username LIKE ? ESCAPE '\\' OR full_name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR store_name LIKE ? ESCAPE '\\')");
      const l = likeArg(String(req.query.search).slice(0, 100));
      args.push(l, l, l, l, l);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.get(`SELECT COUNT(*) AS c FROM users ${w}`, ...args).c;
    const rows = db.all(`SELECT * FROM users ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...args, pg.pageSize, pg.offset);
    res.json(pageOut(rows.map(userOut), total, pg));
  });

  const userById = (id) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', id);
    if (!u) throw notFound('Không tìm thấy người dùng');
    return u;
  };

  /** Không cho hạ quyền / khóa / xóa quản trị viên cuối cùng (tránh tự khóa cửa). */
  const otherActiveAdmins = (excludeId) =>
    db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'ADMIN' AND banned = 0 AND id != ?", excludeId).c;

  router.get('/users/:id', (req, res) => res.json(userOut(userById(req.params.id))));

  router.patch('/users/:id', (req, res) => {
    const u = userById(req.params.id);
    const b = req.body || {};
    const email = b.email === undefined ? u.email : input.email(b.email);
    if (email && email.toLowerCase() !== (u.email || '').toLowerCase()
        && db.get('SELECT 1 AS x FROM users WHERE email = ? AND id != ?', email, u.id)) throw conflict('Email đã được sử dụng');
    db.run(
      'UPDATE users SET full_name = ?, phone = ?, email = ?, store_name = ?, updated_at = ? WHERE id = ?',
      b.fullName === undefined ? u.full_name : text(b.fullName, { max: 80, label: 'Họ và tên' }),
      b.phone === undefined ? u.phone : input.phone(b.phone), email,
      b.storeName === undefined ? u.store_name : text(b.storeName, { max: 120, label: 'Tên cửa hàng' }),
      nowIso(), u.id,
    );
    audit(req, 'UPDATE', 'User', u.id, u.username);
    res.json(userOut(userById(u.id)));
  });

  router.patch('/users/:id/role', (req, res) => {
    const u = userById(req.params.id);
    const role = String((req.body || {}).role || '');
    if (!ROLES.includes(role)) throw bad('Quyền không hợp lệ');
    if (u.role === 'ADMIN' && role !== 'ADMIN' && otherActiveAdmins(u.id) === 0) throw conflict('Không thể hạ quyền quản trị viên cuối cùng');
    db.run('UPDATE users SET role = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?', role, nowIso(), u.id);
    audit(req, 'USER_ROLE', 'User', u.id, u.username, { from: u.role, to: role });
    res.json(userOut(userById(u.id)));
  });

  router.patch('/users/:id/ban', (req, res) => {
    const u = userById(req.params.id);
    const banned = flag((req.body || {}).banned, true);
    const reason = text((req.body || {}).reason, { max: 200, label: 'Lý do' });
    if (banned && u.id === req.user.id) throw conflict('Bạn không thể tự khóa tài khoản của mình');
    if (banned && u.role === 'ADMIN' && otherActiveAdmins(u.id) === 0) throw conflict('Không thể khóa quản trị viên cuối cùng');
    db.run(
      'UPDATE users SET banned = ?, ban_reason = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?',
      banned, banned ? reason : '', nowIso(), u.id,
    );
    audit(req, banned ? 'USER_BAN' : 'USER_UNBAN', 'User', u.id, u.username, banned ? { reason } : null);
    res.json(userOut(userById(u.id)));
  });

  router.post('/users/:id/reset-password', asyncHandler(async (req, res) => {
    const u = userById(req.params.id);
    const given = (req.body || {}).newPassword;
    const password = given ? input.password(given) : randomPassword();
    db.run('UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?',
      await auth.hash(password), nowIso(), u.id);
    audit(req, 'USER_RESET_PASSWORD', 'User', u.id, u.username);
    // Mật khẩu chỉ trả về đúng một lần này để admin gửi cho khách
    res.json({ ok: true, username: u.username, password });
  }));

  // -------------------------------------------------------------- wholesale requests
  router.get('/wholesale-requests', (req, res) => {
    const pg = paging(req.query);
    const where = [];
    const args = [];
    if (['PENDING', 'APPROVED', 'REJECTED'].includes(req.query.status)) { where.push('status = ?'); args.push(req.query.status); }
    if (req.query.search) {
      where.push("(full_name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR store_name LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')");
      const l = likeArg(String(req.query.search).slice(0, 100));
      args.push(l, l, l, l, l);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.get(`SELECT COUNT(*) AS c FROM wholesale_requests ${w}`, ...args).c;
    const rows = db.all(`SELECT * FROM wholesale_requests ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...args, pg.pageSize, pg.offset);
    res.json(pageOut(rows.map(wholesaleOut), total, pg));
  });

  router.get('/wholesale-requests/stats', (req, res) => {
    const out = { PENDING: 0, APPROVED: 0, REJECTED: 0, total: 0 };
    for (const r of db.all('SELECT status, COUNT(*) AS c FROM wholesale_requests GROUP BY status')) { out[r.status] = r.c; out.total += r.c; }
    res.json(out);
  });

  const wsById = (id) => {
    const r = db.get('SELECT * FROM wholesale_requests WHERE id = ? OR code = ?', id, id);
    if (!r) throw notFound('Không tìm thấy yêu cầu');
    return r;
  };

  router.get('/wholesale-requests/:id', (req, res) => res.json(wholesaleOut(wsById(req.params.id))));

  // Duyệt: tạo tài khoản (tên đăng nhập = số điện thoại) với mật khẩu ngẫu nhiên, trả về một lần duy nhất.
  router.post('/wholesale-requests/:id/approve', asyncHandler(async (req, res) => {
    const r = wsById(req.params.id);
    if (r.status !== 'PENDING') throw conflict('Yêu cầu này đã được xử lý');
    const base = digits(r.phone) || `shop${r.code.slice(-4).toLowerCase()}`;
    let username = base;
    for (let n = 2; db.get('SELECT 1 AS x FROM users WHERE username = ?', username); n++) username = `${base}-${n}`;
    const password = randomPassword();
    const hash = await auth.hash(password);
    const userId = newId();
    const now = nowIso();
    db.tx(() => {
      // Kiểm tra lại trong transaction: tránh hai admin duyệt cùng lúc tạo hai tài khoản
      const fresh = db.get('SELECT status FROM wholesale_requests WHERE id = ?', r.id);
      if (fresh.status !== 'PENDING') throw conflict('Yêu cầu này đã được xử lý');
      const email = r.email || null;
      if (email && db.get('SELECT 1 AS x FROM users WHERE email = ?', email)) {
        throw conflict('Email này đã được dùng cho một tài khoản khác. Hãy từ chối yêu cầu hoặc liên hệ khách để đổi email');
      }
      db.run(
        `INSERT INTO users (id, username, password_hash, full_name, email, phone, store_name, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'WHOLESALE', ?, ?)`,
        userId, username, hash, r.full_name, email, r.phone, r.store_name, now, now,
      );
      db.run(
        "UPDATE wholesale_requests SET status = 'APPROVED', user_id = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?",
        userId, now, req.user.username, r.id,
      );
      audit(req, 'WS_APPROVE', 'WholesaleRequest', r.id, `${r.store_name} (${r.code})`);
    });
    res.json({ ok: true, username, password, request: wholesaleOut(wsById(r.id)) });
  }));

  router.post('/wholesale-requests/:id/reject', (req, res) => {
    const r = wsById(req.params.id);
    if (r.status !== 'PENDING') throw conflict('Yêu cầu này đã được xử lý');
    const note = text((req.body || {}).note, { max: 300, label: 'Lý do', multiline: true });
    db.run(
      "UPDATE wholesale_requests SET status = 'REJECTED', note = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?",
      note, nowIso(), req.user.username, r.id,
    );
    audit(req, 'WS_REJECT', 'WholesaleRequest', r.id, `${r.store_name} (${r.code})`, note ? { note } : null);
    res.json(wholesaleOut(wsById(r.id)));
  });

  // -------------------------------------------------------------- site config
  router.get('/site-config', (req, res) => res.json(getSite(db)));

  router.put('/site-config', (req, res) => {
    const b = req.body || {};
    const cur = getSite(db);
    const next = {
      siteName: b.siteName === undefined ? cur.siteName : text(b.siteName, { required: true, max: 80, label: 'Tên website' }),
      hotline: b.hotline === undefined ? cur.hotline : text(b.hotline, { max: 40, label: 'Hotline' }),
      email: b.email === undefined ? cur.email : text(b.email, { max: 120, label: 'Email' }),
      website: b.website === undefined ? cur.website : text(b.website, { max: 200, label: 'Website' }),
      address: b.address === undefined ? cur.address : text(b.address, { max: 300, label: 'Địa chỉ' }),
      workingHours: b.workingHours === undefined ? cur.workingHours : text(b.workingHours, { max: 120, label: 'Giờ làm việc' }),
      social: { ...cur.social },
    };
    if (b.social && typeof b.social === 'object') {
      for (const k of Object.keys(cur.social)) {
        if (b.social[k] === undefined) continue;
        const v = text(b.social[k], { max: 300, label: `Liên kết ${k}` });
        if (v && !/^https?:\/\//i.test(v)) throw bad(`Liên kết ${k} phải bắt đầu bằng http:// hoặc https://`);
        next.social[k] = v;
      }
    }
    saveSite(db, next);
    audit(req, 'CONFIG_UPDATE', 'SiteConfig', 'site', next.siteName);
    res.json(next);
  });

  return router;
};
