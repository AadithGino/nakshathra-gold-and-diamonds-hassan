import { env } from "../config/env.js";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { seedPaginationCustomers } from "../services/pagination-seed.service.js";

if (env.NODE_ENV === "production") {
  throw new Error("Pagination seed is forbidden in production");
}

await connectDatabase();
process.stdout.write("Seeding pagination test customers (additive; clears prior +91970000* only)…\n");

const result = await seedPaginationCustomers({ clearExisting: true });

process.stdout.write(
  [
    "Pagination seed complete.",
    `  Customers:        ${result.customers} (${result.inactive} inactive)`,
    `  Enrollments:      ${result.enrolled}`,
    `  Payments:         ${result.paymentsCreated}`,
    `  Payment intents:  ${result.intentsCreated}`,
    `  Payouts:          ${result.payoutsCreated}`,
    `  Admin login:      ${result.adminPhone.replace("+91", "")} / ${result.password}`,
    `  Mobile test cust: ${result.sampleCustomerPhone.replace("+91", "")} / ${result.password}`,
    `    → ${result.mobileTestPayments} SUCCESS payments (3 schemes: 11+11+5)`,
    `    → active scheme next unpaid month ${result.mobileTestNextMonth}`,
    `  Expected pages:   ~${result.expectedCustomerPages} at page size ${result.pageSizeHint}`,
    "",
  ].join("\n"),
);

await disconnectDatabase();
