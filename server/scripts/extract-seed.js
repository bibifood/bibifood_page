'use strict';
// Trích dữ liệu sản phẩm + bản dịch từ index.html của trang bán hàng thành src/seed-data.json.
// Chạy: node scripts/extract-seed.js   (chỉ cần chạy lại khi index.html đổi danh sách sản phẩm)
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlPath = path.resolve(__dirname, '..', '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

function grabObject(startMarker) {
  const i = html.indexOf(startMarker);
  if (i < 0) throw new Error(`Không tìm thấy "${startMarker}" trong index.html`);
  const j = html.indexOf('{', i);
  let depth = 0;
  let inStr = null;
  for (let k = j; k < html.length; k++) {
    const c = html[k];
    if (inStr) {
      if (c === '\\') k++;
      else if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return html.slice(j, k + 1);
  }
  throw new Error('Dấu ngoặc không cân bằng');
}

const ev = (src) => vm.runInNewContext(`(${src})`);
const translations = ev(grabObject('var translations = '));
const details = ev(grabObject('var productDetails = '));
const extra = ev(grabObject('var productDetailsExtra = '));
for (const k of Object.keys(extra)) if (details[k]) Object.assign(details[k], extra[k]);

const LANGS = ['vi', 'ko', 'en', 'zh'];
const re = /<div class="product-card" data-category="(\w+)">[\s\S]*?<img src="([^"]+)"[\s\S]*?data-i18n="(product_\w+)"/g;
const seen = new Set();
const products = [];
let m;
while ((m = re.exec(html))) {
  const [, category, image, key] = m;
  if (seen.has(key)) continue;
  seen.add(key);
  const names = {};
  for (const l of LANGS) names[l] = translations[l][key];
  products.push({ key, category, image, names, details: details[key] || {} });
}

const categories = {};
for (const c of ['gio', 'xucxich', 'nem', 'kho', 'banhtrung', 'khac', 'vien']) {
  categories[c] = {};
  for (const l of LANGS) categories[c][l] = translations[l]['filter_' + c];
}

const out = path.resolve(__dirname, '..', 'src', 'seed-data.json');
fs.writeFileSync(out, JSON.stringify({ categories, products }, null, 2));
console.log(`Đã trích ${products.length} sản phẩm, ${Object.keys(categories).length} danh mục -> ${out}`);
