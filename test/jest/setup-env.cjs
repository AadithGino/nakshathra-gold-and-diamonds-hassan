const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.WEB_ORIGINS = 'http://localhost:5173';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-at-least-32-chars!!';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-at-least-32-chars!';
process.env.PHONEPE_ENABLED = 'false';
process.env.PHONEPE_REDIRECT_URL = 'http://localhost:5173/customer/payments/return';
process.env.PHONEPE_DEV_AUTO_SUCCESS = 'false';
process.env.BOOTSTRAP_DEMO = 'false';
process.env.COOKIE_SECURE = 'false';
process.env.LOG_LEVEL = 'silent';

const uriFile = path.join(__dirname, '.mongo-uri');
if (fs.existsSync(uriFile)) {
  process.env.MONGODB_URI = fs.readFileSync(uriFile, 'utf8').trim();
} else {
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/kairali-test';
}
