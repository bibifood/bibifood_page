'use strict';

const parse = (s, fallback) => {
  try { return JSON.parse(s); } catch { return fallback; }
};

function userOut(r) {
  return {
    id: r.id,
    username: r.username,
    fullName: r.full_name,
    email: r.email || '',
    phone: r.phone,
    storeName: r.store_name,
    role: r.role,
    banned: !!r.banned,
    banReason: r.ban_reason,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  };
}

function categoryOut(r) {
  const labels = parse(r.labels, {});
  return {
    id: r.id,
    slug: r.slug,
    label: labels.vi || r.slug,
    labels,
    sortOrder: r.sort_order,
    active: !!r.active,
    productCount: r.product_count ?? 0,
  };
}

function productOut(r, { full = false, lang = 'vi' } = {}) {
  const names = parse(r.names, {});
  const out = {
    id: r.id,
    key: r.i18n_key,
    slug: r.slug,
    name: names[lang] || names.vi || '',
    names,
    categoryId: r.category_id,
    categorySlug: r.category_slug || null,
    price: r.price,
    image: r.image,
    inStock: !!r.in_stock,
    active: !!r.active,
    sortOrder: r.sort_order,
    deletedAt: r.deleted_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (full) out.details = parse(r.details, {});
  return out;
}

const itemOut = (i) => ({
  id: i.id,
  productId: i.product_id,
  name: i.name,
  price: i.price,
  qty: i.qty,
  subtotal: i.price * i.qty,
});

const eventOut = (e) => ({
  id: e.id,
  fromStatus: e.from_status,
  toStatus: e.to_status,
  note: e.note,
  actor: e.actor,
  createdAt: e.created_at,
});

function orderOut(r, { items, events } = {}) {
  const out = {
    id: r.id,
    code: r.code,
    userId: r.user_id,
    customerName: r.customer_name,
    phone: r.phone,
    address: r.address,
    zipcode: r.zipcode || '',
    addressDetail: r.address_detail || '',
    facebook: r.facebook,
    consent: !!r.consent,
    lang: r.lang,
    status: r.status,
    note: r.note,
    total: r.total,
    itemCount: r.item_count ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (items) out.items = items.map(itemOut);
  if (events) out.events = events.map(eventOut);
  return out;
}

function wholesaleOut(r) {
  return {
    id: r.id,
    code: r.code,
    fullName: r.full_name,
    phone: r.phone,
    email: r.email || '',
    address: r.address,
    zipcode: r.zipcode || '',
    addressDetail: r.address_detail || '',
    storeName: r.store_name,
    licenseNo: r.license_no,
    status: r.status,
    note: r.note,
    userId: r.user_id,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    reviewedBy: r.reviewed_by,
  };
}

const ACTION_LABELS = {
  CREATE: 'Tạo mới',
  UPDATE: 'Cập nhật',
  SOFT_DELETE: 'Xóa mềm',
  RESTORE: 'Khôi phục',
  HARD_DELETE: 'Xóa cứng',
  ORDER_STATUS: 'Đổi trạng thái đơn',
  USER_ROLE: 'Đổi quyền',
  USER_BAN: 'Khóa tài khoản',
  USER_UNBAN: 'Mở khóa tài khoản',
  USER_RESET_PASSWORD: 'Đặt lại mật khẩu',
  WS_APPROVE: 'Duyệt tài khoản sỉ',
  WS_REJECT: 'Từ chối yêu cầu sỉ',
  CONFIG_UPDATE: 'Cập nhật cấu hình',
  UPLOAD: 'Tải ảnh lên',
};

const auditOut = (r) => ({
  id: r.id,
  action: r.action,
  actionLabel: ACTION_LABELS[r.action] || r.action,
  adminId: r.admin_id,
  adminUsername: r.admin_username,
  entity: r.entity,
  entityId: r.entity_id,
  entityLabel: r.entity_label,
  meta: r.meta ? parse(r.meta, null) : null,
  createdAt: r.created_at,
});

module.exports = {
  userOut, categoryOut, productOut, orderOut, itemOut, wholesaleOut, auditOut, parse,
};
