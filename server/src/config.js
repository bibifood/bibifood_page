'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // .env là tùy chọn
}

function readOrCreateSecret(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function createConfig(overrides = {}) {
  const env = process.env;
  const dataDir = path.resolve(overrides.dataDir || env.DATA_DIR || path.join(ROOT, 'data'));

  const cfg = {
    root: ROOT,
    // Mặc định chỉ nghe trên máy này (127.0.0.1) để server offline không lộ ra mạng LAN.
    host: overrides.host || env.HOST || '127.0.0.1',
    port: Number(overrides.port ?? env.PORT ?? 4000),
    dataDir,
    dbPath: overrides.dbPath || env.DB_PATH || path.join(dataDir, 'app.db'),
    uploadDir: path.resolve(overrides.uploadDir || env.UPLOAD_DIR || path.join(ROOT, 'uploads')),
    jwtExpiresIn: env.JWT_EXPIRES_IN || '7d',
    tzOffsetHours: Number(overrides.tzOffsetHours ?? env.TZ_OFFSET_HOURS ?? 9), // Hàn Quốc UTC+9
    corsOrigins: String(overrides.corsOrigins ?? env.CORS_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    disableRateLimit: !!overrides.disableRateLimit,
  };

  const secret = overrides.jwtSecret || env.JWT_SECRET || readOrCreateSecret(path.join(dataDir, 'jwt.secret'));
  if (secret.length < 16) throw new Error('JWT_SECRET phải dài ít nhất 16 ký tự');
  cfg.jwtSecret = secret;
  return cfg;
}

module.exports = { createConfig };
