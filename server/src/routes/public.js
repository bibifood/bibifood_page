'use strict';
const express = require('express');
const {
  asyncHandler, bad, HttpError, text, int, flag, newId, nowIso, digits, rateLimit,
} = require('../util');
const input = require('../userInput');
const { categoryOut, productOut, orderOut, wholesaleOut } = require('../serializers');
const { getSite } = require('../settings');

const LANGS = ['vi', 'ko', 'en', 'zh'];

/**
 * Địa chỉ phải được chọn từ công cụ tìm địa chỉ Hàn Quốc (Kakao/Daum Postcode): có mã bưu điện 5 số và địa chỉ chữ Hàn.
 * Máy chủ offline không tra cứu được dữ liệu bưu điện, nên kiểm tra dạng dữ liệu để chặn địa chỉ tự gõ sai.
 */
function koreanAddress(b, { detailRequired }) {
  const address = text(b.address, { required: true, max: 300, label: 'Địa chỉ' });
  const zipcode = text(b.zipcode, { required: true, max: 5, label: 'Mã bưu điện' });
  if (!/^\d{5}$/.test(zipcode)) throw bad('Mã bưu điện Hàn Quốc gồm 5 chữ số. Vui lòng chọn địa chỉ bằng công cụ tìm kiếm');
  if (!/[\uAC00-\uD7A3]/.test(address)) throw bad('Địa chỉ phải được chọn từ công cụ tìm địa chỉ Hàn Quốc, không tự gõ');
  const addressDetail = text(b.addressDetail, { required: detailRequired, max: 150, label: 'Địa chỉ chi tiết' });
  return { address, zipcode, addressDetail };
}

module.exports = function publicRoutes({ db, auth, config }) {
  const router = express.Router();
  const submitLimiter = rateLimit({
    windowMs: 10 * 60_000,
    max: 30,
    message: 'Bạn gửi quá nhiều lần, vui lòng thử lại sau',
    disabled: config.disableRateLimit,
  });

  router.get('/health', (req, res) => res.json({ ok: true, name: 'Bibi food API', version: '1.0.0' }));

  router.get('/site-config', (req, res) => res.json(getSite(db)));

  router.get('/catalog/categories', (req, res) => {
    const rows = db.all(
      `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1 AND p.deleted_at IS NULL) AS product_count
       FROM categories c WHERE c.active = 1 ORDER BY c.sort_order, c.slug`,
    );
    res.json(rows.map(categoryOut));
  });

  router.get('/products', (req, res) => {
    const lang = LANGS.includes(req.query.lang) ? req.query.lang : 'vi';
    const where = ['p.active = 1', 'p.deleted_at IS NULL'];
    const args = [];
    if (req.query.category) { where.push('c.slug = ?'); args.push(String(req.query.category)); }
    const rows = db.all(
      `SELECT p.*, c.slug AS category_slug FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${where.join(' AND ')} ORDER BY p.sort_order, p.created_at`,
      ...args,
    );
    res.json({ items: rows.map((r) => productOut(r, { lang })), total: rows.length });
  });

  router.get('/products/:idOrSlug', (req, res) => {
    const lang = LANGS.includes(req.query.lang) ? req.query.lang : 'vi';
    const r = db.get(
      `SELECT p.*, c.slug AS category_slug FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE (p.id = ? OR p.slug = ? OR p.i18n_key = ?) AND p.active = 1 AND p.deleted_at IS NULL`,
      req.params.idOrSlug, req.params.idOrSlug, req.params.idOrSlug,
    );
    if (!r) throw new HttpError(404, 'Không tìm thấy sản phẩm');
    res.json(productOut(r, { full: true, lang }));
  });

  // Đặt hàng (mua lẻ). Đăng nhập là tùy chọn; giá luôn lấy từ máy chủ, không tin giá từ trình duyệt.
  router.post('/orders', submitLimiter, auth.optional, asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (b.website) return res.status(201).json({ ok: true }); // ô ẩn chống spam

    // Mua lẻ: tên, số điện thoại, địa chỉ (chọn bằng công cụ tìm địa chỉ) và địa chỉ chi tiết đều bắt buộc; chỉ Facebook là tùy chọn
    const customerName = text(b.name ?? b.customerName, { required: true, max: 100, label: 'Tên người mua' });
    const phoneRaw = text(b.phone, { required: true, max: 20, label: 'Số điện thoại' });
    const phone = input.phone(phoneRaw);
    const { address, zipcode, addressDetail } = koreanAddress(b, { detailRequired: true });
    const facebook = text(b.facebook, { max: 200, label: 'Facebook' });
    const note = text(b.note, { max: 500, label: 'Ghi chú', multiline: true });
    const consent = flag(b.consent, false);
    const lang = LANGS.includes(b.lang) ? b.lang : 'vi';


    const raw = Array.isArray(b.items) ? b.items : [];
    if (raw.length === 0) throw bad('Giỏ hàng đang trống');
    if (raw.length > 100) throw bad('Giỏ hàng quá lớn');
    const merged = new Map();
    for (const it of raw) {
      const key = typeof it.key === 'string' ? it.key : typeof it.productId === 'string' ? it.productId : '';
      const qty = int(it.qty, { min: 1, max: 999, label: 'Số lượng', required: true });
      if (!key) throw bad('Sản phẩm không hợp lệ');
      merged.set(key, (merged.get(key) || 0) + qty);
    }

    const id = newId();
    const now = nowIso();
    const code = `BB${now.slice(2, 10).replace(/-/g, '')}${newId().slice(0, 4).toUpperCase()}`;

    db.tx(() => {
      let total = 0;
      const lines = [];
      for (const [key, qty] of merged) {
        const p = db.get(
          'SELECT * FROM products WHERE (id = ? OR i18n_key = ?) AND active = 1 AND deleted_at IS NULL', key, key,
        );
        if (!p) throw bad(`Sản phẩm "${key}" không tồn tại hoặc đã ngừng bán`);
        if (!p.in_stock) throw bad('Có sản phẩm đã hết hàng');
        const names = JSON.parse(p.names);
        lines.push({ p, qty, name: names[lang] || names.vi });
        total += p.price * qty;
      }
      db.run(
        `INSERT INTO orders (id, code, user_id, customer_name, phone, address, zipcode, address_detail, facebook, consent, lang, status, note, total, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`,
        id, code, req.user ? req.user.id : null, customerName, phone, address, zipcode, addressDetail, facebook, consent, lang, note, total, now, now,
      );
      for (const l of lines) {
        db.run('INSERT INTO order_items (id, order_id, product_id, name, price, qty) VALUES (?, ?, ?, ?, ?, ?)',
          newId(), id, l.p.id, l.name, l.p.price, l.qty);
      }
      db.run(
        "INSERT INTO order_events (id, order_id, from_status, to_status, note, actor, created_at) VALUES (?, ?, NULL, 'PENDING', 'Khách đặt hàng', ?, ?)",
        newId(), id, customerName, now,
      );
    });
    const order = db.get('SELECT * FROM orders WHERE id = ?', id);
    res.status(201).json({ ok: true, order: orderOut(order) });
  }));

  // Đơn của chính tôi (cần đăng nhập)
  router.get('/orders/mine', auth.required, (req, res) => {
    const rows = db.all('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', req.user.id);
    res.json(rows.map((r) => orderOut(r, { items: db.all('SELECT * FROM order_items WHERE order_id = ?', r.id) })));
  });

  // Yêu cầu cấp tài khoản mua sỉ: 5 mục bắt buộc
  router.post('/wholesale/requests', submitLimiter, asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (b.website) return res.status(201).json({ ok: true }); // ô ẩn chống spam
    const fullName = text(b.fullName, { required: true, max: 100, label: 'Họ và tên' });
    const phone = text(b.phone, { required: true, max: 20, label: 'Số điện thoại' });
    input.phone(phone);
    const email = input.email(b.email);
    if (!email) throw bad('Email là bắt buộc');

    const { address, zipcode, addressDetail } = koreanAddress(b, { detailRequired: false });
    const storeName = text(b.store ?? b.storeName, { required: true, max: 120, label: 'Tên cửa hàng' });
    const licenseNo = text(b.license ?? b.licenseNo, { required: true, max: 40, label: 'Mã số giấy phép kinh doanh' });

    const key = digits(phone);
    const dup = db.all("SELECT phone FROM wholesale_requests WHERE status = 'PENDING'").some((r) => digits(r.phone) === key);
    if (dup) throw new HttpError(409, 'Số điện thoại này đã có yêu cầu đang chờ duyệt. Chúng tôi sẽ sớm liên hệ với bạn.');

    const now = nowIso();
    const code = `YC-${now.slice(2, 10).replace(/-/g, '')}-${newId().slice(0, 4).toUpperCase()}`;
    db.run(
      `INSERT INTO wholesale_requests (id, code, full_name, phone, email, address, zipcode, address_detail, store_name, license_no, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      newId(), code, fullName, phone, email, address, zipcode, addressDetail, storeName, licenseNo, now,
    );
    res.status(201).json({ ok: true, code });
  }));

  return router;
};

module.exports.wholesaleOut = wholesaleOut;
