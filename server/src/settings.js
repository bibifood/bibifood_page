'use strict';

const DEFAULT_SITE = {
  siteName: 'Bibi food',
  hotline: '010-2616-2689',
  email: 'bibifood2026@gmail.com',
  website: 'https://bibifood.com',
  address: '',
  workingHours: '',
  social: {
    facebook: 'https://m.me/bibifood',
    kakao: '',
    zalo: '',
    instagram: '',
    youtube: '',
    tiktok: '',
  },
};

function getSite(db) {
  const row = db.get('SELECT value FROM settings WHERE key = ?', 'site');
  let saved = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { /* dữ liệu hỏng thì dùng mặc định */ }
  return { ...DEFAULT_SITE, ...saved, social: { ...DEFAULT_SITE.social, ...(saved.social || {}) } };
}

function saveSite(db, value) {
  db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    'site',
    JSON.stringify(value),
  );
}

module.exports = { DEFAULT_SITE, getSite, saveSite };
