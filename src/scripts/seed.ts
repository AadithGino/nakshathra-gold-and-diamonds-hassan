import { env } from "../config/env.js";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import {
  ADMIN_PHONE,
  CUSTOMER_PHONE,
  DEMO_PASSWORD,
  resetAndSeedDemoData,
} from "../services/demo-seed.service.js";

if (env.NODE_ENV === "production") {
  throw new Error("Seed is forbidden in production");
}

await connectDatabase();
process.stdout.write("Clearing database and seeding fresh demo data…\n");
await resetAndSeedDemoData();
process.stdout.write(
  [
    "Seed complete.",
    `  Admin login:    9999999901 / ${DEMO_PASSWORD}`,
    `  Customer login: 9999999903 / ${DEMO_PASSWORD}`,
    `  Stored phones:  ${ADMIN_PHONE}, ${CUSTOMER_PHONE}`,
    "",
  ].join("\n"),
);
await disconnectDatabase();
