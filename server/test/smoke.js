'use strict';
// Kiểm thử toàn bộ luồng chính trên DB trong bộ nhớ. Chạy: npm test
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { createAuth } = require('../src/auth');
const { seedCatalog, ensureAdmin } = require('../src/seed');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bibi-test-'));
const config = createConfig({
  dataDir: tmp, dbPath: ':memory:', uploadDir: path.join(tmp, 'uploads'),
  jwtSecret: 'test-secret-test-secret', port: 0, disableRateLimit: true,
});
const db = openDb(':memory:');
const auth = createAuth({ db, config });

const KR = { address: '서울특별시 강남구 테헤란로 152', zipcode: '06236', addressDetail: '2층 201호' };

let passed = 0;
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

let base;
async function call(method, url, { body, token, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (raw) payload = raw;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + url, { method, headers, body: payload });
  let data = null;
  try { data = await res.json(); } catch { /* không phải JSON */ }
  return { status: res.status, data };
}

// PNG 1x1 hợp lệ
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

(async () => {
  seedCatalog(db);
  await ensureAdmin(db, auth, { username: 'admin', password: 'Admin#12345' });
  const app = createApp({ db, config });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}/api`;

  let adminToken, userToken, userId, wsToken, orderId, reqId;

  test('health + dữ liệu mẫu', async () => {
    assert.equal((await call('GET', '/health')).status, 200);
    const p = await call('GET', '/products');
    assert.equal(p.data.total, 22);
    const c = await call('GET', '/catalog/categories');
    assert.equal(c.data.length, 7);
    assert.ok(c.data.find((x) => x.slug === 'vien'));
  });

  test('không còn đăng ký tự do (đường dẫn đã bị gỡ)', async () => {
    for (const body of [
      { username: 'khach1', password: 'matkhau1' },
      { username: 'hacker1', password: 'abcdef', role: 'ADMIN' },
    ]) {
      const r = await call('POST', '/auth/register', { body });
      assert.equal(r.status, 404, JSON.stringify(body));
    }
    assert.equal(db.get("SELECT COUNT(*) AS c FROM users WHERE username IN ('khach1','hacker1')").c, 0);
  });

  test('tài khoản quyền USER cũ không đăng nhập được, token cũ mất hiệu lực', async () => {
    // tạo trực tiếp một USER (như dữ liệu cũ trước khi siết quyền)
    const now = new Date().toISOString();
    userId = 'legacyuser000001';
    db.run(
      "INSERT INTO users (id, username, password_hash, full_name, email, phone, role, created_at, updated_at) VALUES (?, 'khach1', ?, 'Nguyễn Văn A', 'a@example.com', '0912345678', 'USER', ?, ?)",
      userId, await auth.hash('matkhau1'), now, now,
    );
    const r = await call('POST', '/auth/login', { body: { username: 'khach1', password: 'matkhau1' } });
    assert.equal(r.status, 403);
    assert.equal(r.data.code, 'NOT_ALLOWED');
    userToken = require('jsonwebtoken').sign({ sub: userId, role: 'USER', tv: 0 }, config.jwtSecret);
    assert.equal((await call('GET', '/auth/me', { token: userToken })).status, 401, 'token của USER không dùng được');
  });

  test('đăng nhập: đúng / sai / bị khóa', async () => {
    assert.equal((await call('POST', '/auth/login', { body: { username: 'admin', password: 'sai' } })).status, 401);
    assert.equal((await call('POST', '/auth/login', { body: { username: 'khong-ton-tai', password: 'abcdef' } })).status, 401);
    assert.equal((await call('POST', '/auth/login', { body: { username: 'khach1' } })).status, 400);
    const a = await call('POST', '/auth/login', { body: { username: 'admin', password: 'Admin#12345' } });
    assert.equal(a.status, 200);
    assert.equal(a.data.user.role, 'ADMIN');
    adminToken = a.data.accessToken;
  });

  test('token: thiếu / sai / giả mạo bị từ chối', async () => {
    assert.equal((await call('GET', '/auth/me')).status, 401);
    assert.equal((await call('GET', '/auth/me', { token: 'abc.def.ghi' })).status, 401);
    const me = await call('GET', '/auth/me', { token: adminToken });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.username, 'admin');
    // token ký bằng khóa khác
    const forged = require('jsonwebtoken').sign({ sub: userId, role: 'ADMIN', tv: 0 }, 'khoa-gia-mao-khoa-gia-mao');
    assert.equal((await call('GET', '/admin/dashboard/overview', { token: forged })).status, 401);
  });

  test('phân quyền: người không phải admin không vào được API admin', async () => {
    assert.equal((await call('GET', '/admin/dashboard/overview')).status, 401);
    // USER cũ: token không còn hiệu lực
    assert.equal((await call('GET', '/admin/dashboard/overview', { token: userToken })).status, 401);
    assert.equal((await call('GET', '/admin/users', { token: userToken })).status, 401);
  });

  test('đặt hàng: giá lấy từ máy chủ, kiểm tra dữ liệu', async () => {
    const r = await call('POST', '/orders', {
      body: { name: 'Nguyễn Văn A', phone: '010-1234-5678', ...KR, facebook: 'fb.com/a', consent: true, lang: 'vi',
        items: [{ key: 'product_pate', qty: 3, price: 1 }, { key: 'product_kho_bo', qty: 2 }, { key: 'product_pate', qty: 1 }] },
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.order.total, 6 * 10000, 'phải bỏ qua price do client gửi, gộp dòng trùng');
    orderId = r.data.order.id;
    const ok = { name: 'A', phone: '010-1234-5678', ...KR };
    const bad = [
      { body: { ...ok, items: [{ key: 'khong-co', qty: 1 }] } },
      { body: { ...ok, items: [{ key: 'product_pate', qty: 0 }] } },
      { body: { ...ok, items: [{ key: 'product_pate', qty: -5 }] } },
      { body: { ...ok, items: [{ key: 'product_pate', qty: 1.5 }] } },
      { body: { ...ok, items: [] } },
      { body: { name: 'A', items: [{ key: 'product_pate', qty: 1 }] } },
    ];
    for (const b of bad) assert.equal((await call('POST', '/orders', b)).status, 400, JSON.stringify(b));
    // Mua lẻ: tên, SĐT, địa chỉ (từ công cụ tìm địa chỉ) và địa chỉ chi tiết đều bắt buộc; Facebook thì không
    const item = [{ key: 'product_pate', qty: 1 }];
    for (const k of ['name', 'phone', 'address', 'zipcode', 'addressDetail']) {
      const b = { ...ok, items: item }; delete b[k];
      assert.equal((await call('POST', '/orders', { body: b })).status, 400, `thiếu ${k}`);
    }
    for (const patch of [{ address: 'Seoul' }, { zipcode: '1234' }, { zipcode: 'abcde' }, { phone: 'abc' }, { addressDetail: '   ' }]) {
      assert.equal((await call('POST', '/orders', { body: { ...ok, ...patch, items: item } })).status, 400, JSON.stringify(patch));
    }
    const guest = await call('POST', '/orders', { body: { ...ok, name: 'Khách lạ', items: item } });
    assert.equal(guest.status, 201, 'khách không đăng nhập, không có Facebook vẫn đặt được');
    assert.equal(guest.data.order.zipcode, '06236');
    assert.equal(guest.data.order.addressDetail, '2층 201호');
    assert.equal((await call('GET', '/orders/mine')).status, 401);
  });

  test('admin: dashboard, đơn hàng, đổi trạng thái đúng quy trình', async () => {
    const ov = await call('GET', '/admin/dashboard/overview', { token: adminToken });
    assert.equal(ov.status, 200);
    assert.equal(ov.data.orders.total, 2);
    assert.equal(ov.data.orders.pending, 2);
    assert.equal(ov.data.orders.today.count, 2);
    assert.equal(ov.data.revenue.today, 70000);
    assert.equal(ov.data.catalog.productsActive, 22);
    const rev = await call('GET', '/admin/dashboard/revenue?range=7', { token: adminToken });
    assert.equal(rev.data.length, 7);
    assert.equal(rev.data.reduce((s, d) => s + d.revenue, 0), 70000);
    const top = await call('GET', '/admin/dashboard/top-products?limit=5', { token: adminToken });
    assert.equal(top.data[0].name.length > 0, true);

    const list = await call('GET', '/admin/orders?status=PENDING&search=A', { token: adminToken });
    assert.equal(list.status, 200);
    assert.equal(list.data.items.length >= 1, true);
    const det = await call('GET', `/admin/orders/${orderId}`, { token: adminToken });
    assert.equal(det.data.items.length, 2);

    assert.equal((await call('PATCH', `/admin/orders/${orderId}/status`, { token: adminToken, body: { status: 'DELIVERED' } })).status, 400, 'không nhảy cóc trạng thái');
    assert.equal((await call('PATCH', `/admin/orders/${orderId}/status`, { token: adminToken, body: { status: 'XYZ' } })).status, 400);
    for (const s of ['CONFIRMED', 'SHIPPING', 'DELIVERED']) {
      const r = await call('PATCH', `/admin/orders/${orderId}/status`, { token: adminToken, body: { status: s, note: 'ok' } });
      assert.equal(r.status, 200, s);
    }
    assert.equal((await call('PATCH', `/admin/orders/${orderId}/status`, { token: adminToken, body: { status: 'CANCELLED' } })).status, 400, 'đơn đã giao không đổi được');
    const st = await call('GET', '/admin/orders/stats', { token: adminToken });
    assert.equal(st.data.byStatus.DELIVERED, 1);
    const audit = await call('GET', '/admin/dashboard/audit?pageSize=5', { token: adminToken });
    assert.ok(audit.data.find((a) => a.action === 'ORDER_STATUS'));
  });

  test('tìm kiếm: ký tự đặc biệt không phá câu truy vấn', async () => {
    for (const q of ["%", "_", "a'; DROP TABLE users;--", '\\']) {
      const r = await call('GET', `/admin/orders?search=${encodeURIComponent(q)}`, { token: adminToken });
      assert.equal(r.status, 200, q);
    }
    assert.equal((await call('GET', '/admin/users', { token: adminToken })).status, 200, 'bảng users còn nguyên');
  });

  test('admin: quản lý sản phẩm (tạo, sửa, xóa mềm, khôi phục, xóa cứng)', async () => {
    const list = await call('GET', '/admin/products?pageSize=5', { token: adminToken });
    assert.equal(list.data.total, 22);
    const created = await call('POST', '/admin/products', {
      token: adminToken,
      body: { names: { vi: 'Chả quế', ko: '짜 꿰', en: 'Cinnamon pâté', zh: '肉桂肉饼' }, price: 12000, category: 'gio',
        details: { vi: { ingredients: ['Thịt heo'], serving: ['Chiên'], storage: ['Ngăn đá'] } } },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.id;
    assert.equal(created.data.slug, 'cha-que');
    assert.equal((await call('POST', '/admin/products', { token: adminToken, body: { names: { vi: 'Chả quế' } } })).status, 409, 'trùng slug');
    assert.equal((await call('POST', '/admin/products', { token: adminToken, body: { names: { vi: 'X' }, price: -1 } })).status, 400);
    assert.equal((await call('POST', '/admin/products', { token: adminToken, body: { names: { vi: 'Y' }, category: 'khong-co' } })).status, 400);
    const upd = await call('PATCH', `/admin/products/${id}`, { token: adminToken, body: { price: 15000, inStock: false } });
    assert.equal(upd.data.price, 15000);
    assert.equal(upd.data.inStock, false);
    assert.equal((await call('POST', '/orders', { body: { name: 'A', items: [{ key: id, qty: 1 }] } })).status, 400, 'hết hàng thì không đặt được');
    assert.equal((await call('DELETE', `/admin/products/${id}/hard`, { token: adminToken })).status, 409, 'phải xóa mềm trước');
    assert.equal((await call('DELETE', `/admin/products/${id}`, { token: adminToken })).status, 200);
    assert.equal((await call('GET', `/products/${id}`)).status, 404, 'sản phẩm đã xóa ẩn khỏi trang bán hàng');
    const del = await call('GET', '/admin/products?status=deleted', { token: adminToken });
    assert.equal(del.data.total, 1);
    assert.equal((await call('POST', `/admin/products/${id}/restore`, { token: adminToken })).status, 200);
    await call('DELETE', `/admin/products/${id}`, { token: adminToken });
    assert.equal((await call('DELETE', `/admin/products/${id}/hard`, { token: adminToken })).status, 200);
  });

  test('admin: danh mục (không xóa được khi còn sản phẩm)', async () => {
    const c = await call('POST', '/admin/categories', { token: adminToken, body: { label: 'Đồ uống', labels: { en: 'Drinks' } } });
    assert.equal(c.status, 201);
    assert.equal(c.data.slug, 'do-uong');
    assert.equal((await call('POST', '/admin/categories', { token: adminToken, body: { label: 'Đồ uống' } })).status, 409);
    const gio = (await call('GET', '/admin/categories', { token: adminToken })).data.find((x) => x.slug === 'gio');
    assert.equal((await call('DELETE', `/admin/categories/${gio.id}`, { token: adminToken })).status, 409);
    assert.equal((await call('DELETE', `/admin/categories/${c.data.id}`, { token: adminToken })).status, 200);
  });

  test('mua sỉ: gửi yêu cầu → duyệt → đăng nhập bằng tài khoản được cấp', async () => {
    const full = {
      fullName: 'Trần Thị B', phone: '010-9999-8888', email: 'b@example.com',
      address: '부산광역시 해운대구 센텀중앙로 79', zipcode: '48058', addressDetail: '3층 301호',
      store: 'Cửa hàng B', license: '123-45-67890',
    };
    for (const k of ['fullName', 'phone', 'email', 'address', 'zipcode', 'store', 'license']) {
      const b = { ...full }; delete b[k];
      assert.equal((await call('POST', '/wholesale/requests', { body: b })).status, 400, `thiếu ${k}`);
    }
    // địa chỉ phải chọn từ công cụ tìm kiếm của Hàn Quốc: có mã bưu điện 5 số + chữ Hàn; email phải hợp lệ
    for (const patch of [
      { address: 'Busan' }, { address: '123456' }, { zipcode: '4805' }, { zipcode: '480588' }, { zipcode: 'abcde' },
      { email: 'khong-hop-le' }, { email: '' },
    ]) {
      const r = await call('POST', '/wholesale/requests', { body: { ...full, ...patch } });
      assert.equal(r.status, 400, JSON.stringify(patch));
    }
    assert.equal(db.get('SELECT COUNT(*) AS c FROM wholesale_requests').c, 0, 'yêu cầu sai không được lưu');
    const ok = await call('POST', '/wholesale/requests', { body: full });
    assert.equal(ok.status, 201);
    assert.equal((await call('POST', '/wholesale/requests', { body: { ...full, phone: '01099998888' } })).status, 409, 'trùng SĐT đang chờ');
    const list = await call('GET', '/admin/wholesale-requests?status=PENDING', { token: adminToken });
    assert.equal(list.data.total, 1);
    reqId = list.data.items[0].id;
    assert.equal((await call('GET', '/admin/wholesale-requests', { token: userToken })).status, 401, 'USER cũ không còn token hợp lệ');

    const ap = await call('POST', `/admin/wholesale-requests/${reqId}/approve`, { token: adminToken });
    assert.equal(ap.status, 200, JSON.stringify(ap.data));
    assert.equal(ap.data.username, '01099998888');
    assert.ok(ap.data.password.length >= 8);
    assert.equal((await call('POST', `/admin/wholesale-requests/${reqId}/approve`, { token: adminToken })).status, 409, 'không duyệt hai lần');

    const login = await call('POST', '/auth/login', { body: { username: ap.data.username, password: ap.data.password } });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.role, 'WHOLESALE');
    assert.equal(login.data.user.storeName, 'Cửa hàng B');
    assert.equal(login.data.user.email, 'b@example.com', 'email được chép sang tài khoản khi duyệt');
    wsToken = login.data.accessToken;
    assert.equal((await call('GET', '/admin/orders', { token: wsToken })).status, 403, 'tài khoản sỉ không phải admin');
    assert.equal((await call('GET', '/admin/wholesale-requests', { token: wsToken })).status, 403, 'tài khoản sỉ không duyệt được yêu cầu');
    const wsOrder = await call('POST', '/orders', { token: wsToken, body: { name: 'Cửa hàng B', phone: '010-9999-8888', ...KR, items: [{ key: 'product_pate', qty: 1 }] } });
    assert.equal(wsOrder.status, 201);
    const mine = await call('GET', '/orders/mine', { token: wsToken });
    assert.equal(mine.data.length, 1, 'tài khoản sỉ xem được đơn của mình');
    assert.equal((await call('GET', '/auth/me', { token: wsToken })).data.user.role, 'WHOLESALE');

    await call('POST', '/wholesale/requests', { body: { ...full, phone: '010-1111-2222', store: 'Shop C' } });
    const pend = (await call('GET', '/admin/wholesale-requests?status=PENDING', { token: adminToken })).data.items[0];
    assert.equal(pend.email, 'b@example.com');
    assert.equal(pend.zipcode, '48058');
    assert.equal(pend.addressDetail, '3층 301호');
    assert.equal((await call('POST', `/admin/wholesale-requests/${pend.id}/approve`, { token: adminToken })).status, 409, 'email đã dùng cho tài khoản khác');
    assert.equal((await call('GET', `/admin/wholesale-requests/${pend.id}`, { token: adminToken })).data.status, 'PENDING', 'duyệt lỗi thì yêu cầu vẫn chờ duyệt');
    const rj = await call('POST', `/admin/wholesale-requests/${pend.id}/reject`, { token: adminToken, body: { note: 'Thiếu giấy phép' } });
    assert.equal(rj.data.status, 'REJECTED');
    const stats = await call('GET', '/admin/wholesale-requests/stats', { token: adminToken });
    assert.equal(stats.data.APPROVED, 1);
    assert.equal(stats.data.REJECTED, 1);
  });

  test('admin: khóa / đổi quyền / đặt lại mật khẩu có hiệu lực ngay với token cũ', async () => {
    const wsUser = (await call('GET', '/auth/me', { token: wsToken })).data.user;
    const wsName = wsUser.username;
    const ban = await call('PATCH', `/admin/users/${wsUser.id}/ban`, { token: adminToken, body: { banned: true, reason: 'Spam' } });
    assert.equal(ban.data.banned, true);
    assert.equal((await call('GET', '/auth/me', { token: wsToken })).status, 401, 'token cũ mất hiệu lực');
    await call('PATCH', `/admin/users/${wsUser.id}/ban`, { token: adminToken, body: { banned: false } });
    const rp = await call('POST', `/admin/users/${wsUser.id}/reset-password`, { token: adminToken, body: {} });
    assert.equal(rp.status, 200);
    const again = await call('POST', '/auth/login', { body: { username: wsName, password: rp.data.password } });
    assert.equal(again.status, 200);
    assert.equal(again.data.user.role, 'WHOLESALE');
    wsToken = again.data.accessToken;
    // hạ xuống USER => không đăng nhập được nữa, token cũ vô hiệu
    assert.equal((await call('PATCH', `/admin/users/${wsUser.id}/role`, { token: adminToken, body: { role: 'USER' } })).data.role, 'USER');
    assert.equal((await call('GET', '/auth/me', { token: wsToken })).status, 401);
    const denied = await call('POST', '/auth/login', { body: { username: wsName, password: rp.data.password } });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.code, 'NOT_ALLOWED');
    await call('PATCH', `/admin/users/${wsUser.id}/role`, { token: adminToken, body: { role: 'WHOLESALE' } });
    const back = await call('POST', '/auth/login', { body: { username: wsName, password: rp.data.password } });
    assert.equal(back.status, 200);
    wsToken = back.data.accessToken;
  });

  test('admin: không thể tự khóa mình / hạ quyền admin cuối cùng', async () => {
    const me = (await call('GET', '/auth/me', { token: adminToken })).data.user;
    assert.equal((await call('PATCH', `/admin/users/${me.id}/ban`, { token: adminToken, body: { banned: true } })).status, 409);
    assert.equal((await call('PATCH', `/admin/users/${me.id}/role`, { token: adminToken, body: { role: 'USER' } })).status, 409);
    assert.equal((await call('PATCH', `/admin/users/${me.id}/role`, { token: adminToken, body: { role: 'SUPER' } })).status, 400);
    const stats = await call('GET', '/admin/users/stats', { token: adminToken });
    assert.equal(stats.data.admins, 1);
  });

  test('đổi mật khẩu cá nhân + cập nhật hồ sơ', async () => {
    const me = (await call('GET', '/auth/me', { token: wsToken })).data.user;
    assert.equal((await call('POST', '/auth/change-password', { token: wsToken, body: { currentPassword: 'sai', newPassword: 'moi12345' } })).status, 400);
    const cur = (await call('POST', `/admin/users/${me.id}/reset-password`, { token: adminToken, body: { newPassword: 'cu123456' } })).data;
    const t2 = (await call('POST', '/auth/login', { body: { username: me.username, password: cur.password } })).data.accessToken;
    const ch = await call('POST', '/auth/change-password', { token: t2, body: { currentPassword: 'cu123456', newPassword: 'moi12345' } });
    assert.equal(ch.status, 200);
    assert.equal((await call('GET', '/auth/me', { token: t2 })).status, 401, 'token cũ hết hiệu lực');
    assert.equal((await call('GET', '/auth/me', { token: ch.data.accessToken })).status, 200);
    const pr = await call('PATCH', '/auth/me', { token: ch.data.accessToken, body: { fullName: 'Tên mới', phone: '0900000000' } });
    assert.equal(pr.data.user.fullName, 'Tên mới');
  });

  test('cấu hình site + tải ảnh', async () => {
    const cfg = await call('PUT', '/admin/site-config', { token: adminToken, body: { hotline: '010-0000-0000', social: { facebook: 'https://m.me/x' } } });
    assert.equal(cfg.status, 200);
    assert.equal((await call('GET', '/site-config')).data.hotline, '010-0000-0000');
    assert.equal((await call('PUT', '/admin/site-config', { token: adminToken, body: { social: { facebook: 'javascript:alert(1)' } } })).status, 400);

    const pid = (await call('GET', '/admin/products?pageSize=1', { token: adminToken })).data.items[0].id;
    const form = (buf, type, name) => { const f = new FormData(); f.append('file', new Blob([buf], { type }), name); return f; };
    const up = await call('POST', `/admin/products/${pid}/upload-image`, { token: adminToken, raw: form(PNG, 'image/png', 'a.png') });
    assert.equal(up.status, 200, JSON.stringify(up.data));
    assert.match(up.data.url, /^\/uploads\/products\/[\w.-]+\.png$/);
    const file = await fetch(base.replace('/api', '') + up.data.url);
    assert.equal(file.status, 200);
    const fake = await call('POST', `/admin/products/${pid}/upload-image`, { token: adminToken, raw: form(Buffer.from('<?php echo 1; ?>'), 'image/png', 'x.png') });
    assert.equal(fake.status, 400, 'file giả dạng ảnh bị chặn');
    const wrongType = await call('POST', `/admin/products/${pid}/upload-image`, { token: adminToken, raw: form(PNG, 'text/html', 'x.html') });
    assert.equal(wrongType.status, 400);
    assert.equal((await call('POST', `/admin/products/${pid}/upload-image`, { raw: form(PNG, 'image/png', 'a.png') })).status, 401);
    const traversal = await fetch(base.replace('/api', '') + '/uploads/..%2f..%2fpackage.json');
    assert.notEqual(traversal.status, 200, 'không đọc được file ngoài thư mục uploads');
  });

  test('lỗi: JSON hỏng, đường dẫn không có, không lộ chi tiết', async () => {
    const r = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    assert.equal(r.status, 400);
    assert.equal((await call('GET', '/khong-co-duong-dan')).status, 404);
    const big = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a'.repeat(300000) }) });
    assert.equal(big.status, 413);
  });

  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}`); }
  }
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} đạt, ${failed} lỗi`);
  process.exit(failed ? 1 : 0);
})();
