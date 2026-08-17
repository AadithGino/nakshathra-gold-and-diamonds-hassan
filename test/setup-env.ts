process.env.NODE_ENV = "test";
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/kairali-test";
process.env.WEB_ORIGINS = "http://localhost:5173";
process.env.JWT_ACCESS_SECRET = "test-access-secret-at-least-32-chars!!";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-at-least-32-chars!";
process.env.PHONEPE_ENABLED = "false";
process.env.PHONEPE_REDIRECT_URL =
  "http://localhost:5173/customer/payments/return";
process.env.BOOTSTRAP_DEMO = "false";
process.env.COOKIE_SECURE = "false";
process.env.KYC_REQUIRED = "true";
process.env.JEWELLERY_ID = "nakshathra";
process.env.JEWELLERY_SLUG = "jewellery";
process.env.JEWELLERY_NAME = "Nakshathra";
