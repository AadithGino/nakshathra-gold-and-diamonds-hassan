# Nakshathra Admin Panel — Detailed UI Wireframes (Backend-Complete)

**For Cursor / frontend developers.** Every screen lists **all API fields** from validators, services, and models.

Pair with:
- [ADMIN_PANEL_API.md](./ADMIN_PANEL_API.md) — Appendix A JSON examples
- [ADMIN_PANEL_FRONTEND_GUIDE.md](./ADMIN_PANEL_FRONTEND_GUIDE.md) — JSX + Redux structure

---

## How to read this doc

| Notation | Meaning |
| --- | --- |
| `{fieldName}` | API JSON field (send on POST/PATCH or display from GET) |
| `*` | Required on submit |
| `[ Btn ]` | Button / action |
| `RO` | Read-only (from API response) |
| `HI` | Hidden (auto-generated, e.g. `idempotencyKey`) |
| `₹→paise` | UI shows rupees; API sends integer paise |

**Global list query (every paginated screen):**

| Query param | Type | Default | Notes |
| --- | --- | --- | --- |
| `{cursor}` | string | — | Cursor pagination (preferred) |
| `{limit}` | int | 50 | Max 100 |
| `{page}` | int | — | Legacy offset mode if no cursor |
| `{search}` | string | — | Where supported |

**Response envelope:** `{ success, data, meta? }` · **Money:** paise · **TZ:** Asia/Kolkata

---

## 0. App shell

```
┌ TOP BAR ─────────────────────────────────────────────────────────────────────┐
│ RO: settings.businessName (or static) · branch label                         │
│ RO: auth/me → user name from login cache                                     │
│ [ Logout ] → POST /auth/logout                                               │
├ SIDEBAR ────────┬ MAIN ────────────────────────────────────────────────────┤
│ Nav + badges    │ <Outlet />                                                   │
│ RO badges from  │                                                              │
│ GET /dashboard: │                                                              │
│  overdueInstallmentCount                                                       │
│  dueInstallmentCount                                                         │
│  redemptionReadySchemes                                                      │
└─────────────────┴────────────────────────────────────────────────────────────┘
```

**Boot:** `GET /auth/me` → `{ userId, role, permissions[], sessionVersion }` — require `role === "ADMIN"`

---

## 1. Login — `/login`

```
┌─────────────────────────────────────────┐
│         Nakshathra Admin                │
│  Phone *     ( {phone} )                │
│  Password *  ( {password} )             │
│  [ Sign in ]                            │
│  Error: error.code · error.message      │
│  Wrong portal if role ≠ ADMIN           │
└─────────────────────────────────────────┘
```

| Submit field | API | Validation |
| --- | --- | --- |
| Phone * | `phone` | Indian mobile → E.164 |
| Password * | `password` | min 8, max 128 |

**API:** `POST /auth/login`  
**Response display:** `data.user.{id,name,phone,role,permissions}`, `data.redirectTo`  
**Sets cookies:** `access_token`, `refresh_token`

---

## 2. Dashboard — `/dashboard`

**API:** `GET /admin/dashboard` (no query)

```
┌ House overview ──────────────────────────────────────────────────────────────┐
│ [ Add customer ] → /customers/new    [ + Record payment ] → /payments/manual │
├ ROW 1 — Collection ──────────────────────────────────────────────────────────┤
│ ┌ TODAY ─────────────┐ ┌ THIS MONTH ────────┐ ┌ LIFETIME ─────────┐ ┌ 916 ──┐│
│ │ RO: todayCollection│ │ RO: monthCollection│ │ RO: totalCollection│ │ RO:   ││
│ │     Paise          │ │     Paise          │ │     Paise          │ │ current││
│ │ RO: todayPayment   │ │ RO: monthPayment   │ │                    │ │ GoldRate│
│ │     Count          │ │     Count          │ │                    │ │ or null││
│ └────────────────────┘ └────────────────────┘ └────────────────────┘ └───────┘│
├ ROW 2 — Queues (click → list) ─────────────────────────────────────────────┤
│ OVERDUE          DUE NOW           REDEMPTION READY    CASH W/ STAFF         │
│ RO: overdue      RO: due           RO: redemption       RO: cashWithStaff     │
│ InstallmentCount InstallmentCount  ReadySchemes         Paise                │
│ → /enrollments/  → /enrollments/   → /enrollments/     → /cash-held          │
│   overdue          due               redemption-ready                          │
│ CASH SUBMITTED   CASH IN VAULT     ACTIVE SCHEMES      MATURED SCHEMES       │
│ RO: cashSubmitted RO: cashInVault  RO: activeSchemes   RO: maturedSchemes    │
│     Paise            Paise         RO: activeCashSchemes                       │
│ → /cash-submissions                  RO: activeGoldWeightSchemes (dim)         │
├ ROW 3 — Method breakdown (optional strip) ───────────────────────────────────┤
│ RO: cashCollectionPaise · phonepeCollectionPaise · upiCollectionPaise ·      │
│     bankCollectionPaise · cardCollectionPaise                                │
│ RO: cashPayoutPaise · goldPayoutWeightMg · totalGivenToCustomersPaise        │
│ RO: goldLiabilityMg (dim if CASH-only)                                       │
├ ROW 4 — Chart ───────────────────────────────────────────────────────────────┤
│ RO: monthlyCollections[] → {_id.year, _id.month, _id.schemeType, totalPaise} │
├ TABLE: upcomingInstallments[] (max 12) ────────────────────────────────────┤
│ Cols: customerId.userId.name · enrollmentNumber · schemeMonth · status       │
│       amountPaise · dueDate · daysOverdue · paymentWindowStart/EndDate       │
│       canRecord · [ Collect ] → /payments/manual?customerId&schemeId         │
├ TABLE: recentPayments[] (max 8) ─────────────────────────────────────────────┤
│ Cols: receiptNumber · customerId.userId · schemeId.enrollmentNumber · method │
│       amountPaise · paymentDate · schemeMonth · status · [ View ]            │
├ TABLE: recentCustomers[] (max 8) ────────────────────────────────────────────┤
│ Cols: customerCode · kycStatus · status · createdAt · [ Open ]               │
├ TABLE: upcomingMaturities[] (max 8, 30-day window) ─────────────────────────┤
│ Cols: enrollmentNumber · customerId · maturityDate · schemePlanId.name       │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Walk-in customer — Mark as paid (PRIMARY FLOW)

**Route:** `/payments/manual`  
**API submit:** `POST /admin/payments/manual`  
**Also labeled:** Record payment · Mark as paid · Collect now

### 3.1 Entry points

| From | Prefill query params |
| --- | --- |
| Dashboard `[ + Record payment ]` | — |
| Customer detail `[ Mark as paid ]` | `?customerId=` |
| Enrollment detail / schedule row | `?customerId=&schemeId=&amountPaise=` |
| Due / Overdue row `[ Collect now ]` | `?customerId=&schemeId=&amountPaise=` |
| Upcoming installments widget | same |

### 3.2 Wireframe (all fields)

```
┌ Record payment / Mark as paid ───────────────────────────────────────────────┐
│ API load: GET /admin/customers?search=                                       │
│           GET /admin/customers/:id/enrollment (after customer pick)          │
│           GET /admin/enrollments/:id (optional — show installmentSummary)      │
├ STEP 1 — Customer * ─────────────────────────────────────────────────────────┤
│ ( search ) → filters list                                                    │
│ PICK displays RO: customer.userId.name · customer.userId.phone               │
│                   customer.customerCode · customer.kycStatus                 │
│  If kycStatus ≠ VERIFIED → banner + link to customer KYC (409 if submit)     │
├ STEP 2 — Enrollment * ───────────────────────────────────────────────────────┤
│ RO from GET .../enrollment:                                                  │
│   enrollment._id → submit as schemeId                                        │
│   enrollment.enrollmentNumber · enrollment.schemePlanId.name                 │
│   enrollment.monthlyInstallmentPaise · enrollment.paymentsCompleted            │
│   enrollment.totalPaidPaise · enrollment.status                              │
│   enrollment.startDate · enrollment.maturityDate                             │
│ RO from installmentSummary (if loaded): due · overdue · nextInstallment      │
├ STEP 3 — Payment (submit body) ──────────────────────────────────────────────┤
│ Amount (₹) *        → {amountPaise}        int paise · min ₹100 (10000 paise)│
│ Method *            → {method}             CASH | UPI | BANK | CARD          │
│ Payment date/time * → {paymentDate}        ISO · default now IST             │
│ Reference           → {referenceNumber}    max 120 · UPI ref / cheque no     │
│ Notes               → {notes}              max 500                           │
│ HI                  → {idempotencyKey}     UUID 8–120 chars · new per attempt│
│ HI                  → {customerId}         from step 1                       │
│ HI                  → {schemeId}           enrollment._id from step 2        │
│ DO NOT SEND         → {schemeMonth}        server assigns · show in success  │
│ [ Cancel ]                                          [ Record payment / Mark ]│
└──────────────────────────────────────────────────────────────────────────────┘
         │ POST /admin/payments/manual
         ▼
┌ Success receipt modal ───────────────────────────────────────────────────────┐
│ RO: data.paymentId · data.receiptNumber · data.amountPaise · data.method     │
│ RO: data.paymentDate · data.status · data.schemeMonth  ← SHOW THIS           │
│ [ Print ] [ View payment → /payments/:id ] [ Record another ]              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Submit field spec

| UI label | API field | Req | Validation | Notes |
| --- | --- | --- | --- | --- |
| Customer | `customerId` | * | ObjectId string | From picker |
| Enrollment | `schemeId` | * | ObjectId string | Enrollment `_id` |
| Amount | `amountPaise` | * | positive int paise | Min plan floor ₹100 |
| Method | `method` | * | enum | Not PHONEPE |
| Payment date | `paymentDate` | * | ISO date | |
| Reference | `referenceNumber` | | max 120 | |
| Notes | `notes` | | max 500 | |
| Idempotency | `idempotencyKey` | * | 8–120 chars | UUID |
| Scheme month | `schemeMonth` | | 1–11 | **Omit in UI** — server resolves |

### 3.4 Response fields to display

| Field | Show where |
| --- | --- |
| `paymentId` | Link to detail |
| `receiptNumber` | Receipt header |
| `amountPaise` | ₹ formatted |
| `method` | Badge |
| `paymentDate` | IST formatted |
| `status` | SUCCESS badge |
| `schemeMonth` | **Prominent** — assigned month |

### 3.5 Errors

| `error.code` | UI |
| --- | --- |
| `KYC_VERIFICATION_REQUIRED` | Link verify KYC |
| `INSTALLMENT_ALREADY_PAID` | Show paid month |
| `VALIDATION_ERROR` | `error.details[].path` → field |
| `IDEMPOTENCY_KEY_REUSED` | New UUID if inputs changed |
| `CUSTOMER_NOT_FOUND` / `SCHEME_NOT_FOUND` | Reset picker |

### 3.6 Full walk-in path (new customer)

```
/login → /customers/new (§5.2) → upload Aadhaar (§5.4)
  → POST /admin/customers → /customers/:id
  → POST .../kyc/verify → POST /admin/enrollments (§8.6)
  → /payments/manual (§3.2)
```

---

## 4. Staff

### 4.1 List — `/staff`

**API:** `GET /admin/staff?search=&cursor=&limit=`

```
[ + Add staff ] → /staff/new
( search ) → {search}
┌ TABLE data[] ────────────────────────────────────────────────────────────────┐
│ userId.name · userId.phone · employeeCode · permissions[] (chips)              │
│ userId.status · createdAt · [ Open → /staff/:id ]                            │
└──────────────────────────────────────────────────────────────────────────────┘
Cursor: meta.{mode,limit,nextCursor,hasMore}
```

**List columns → API paths:**

| Column | Field |
| --- | --- |
| Name | `_id` (profile), `userId.name` |
| Phone | `userId.phone` |
| Employee code | `employeeCode` |
| Permissions | `permissions[]` |
| User status | `userId.status` |
| Created | `createdAt` |

### 4.2 Create — `/staff/new`

**API:** `POST /admin/staff`

```
name *              → {name}              min 2 max 120
phone *             → {phone}             Indian mobile
password *          → {password}          min 10 max 128
employeeCode *      → {employeeCode}      min 2 max 30
notes               → {notes}             max 500
☐ canViewCustomers  → {permissions[]}
☐ canCreateCustomer
☐ canEnrollScheme
☐ canCollectPayment
☐ canSubmitCorrectionRequest
[ Create staff ]
```

**Response:** `{ userId, profileId }` → redirect `/staff/:profileId`

### 4.3 Detail — `/staff/:id`

**API:** `GET /admin/staff/:id?from=&to=` · `PATCH /admin/staff/:id` · `PATCH /admin/users/:id/status` · `POST /admin/users/:id/reset-password`

```
Date range: ( from ) ( to ) → reload report

PROFILE (RO + editable):
  userId.name · userId.phone · userId.status · userId.lastLoginAt
  employeeCode · permissions[] · notes · createdAt · updatedAt

REPORT (RO) — data.report:
  collectionPaise · paymentCount · cashCollectedPaise · cashSubmittedPaise
  otherCollectedPaise · byMethod[] · cashWithStaffPaise
  lifetimeCashWithStaffPaise · daily[] → {date, totalPaise, count}

TABLE payments[] (max 200, filtered):
  receiptNumber · amountPaise · method · paymentDate · schemeMonth · status

TABLE submissions[]:
  amountPaise · submissionDate · notes · status · receivedBy

TABLE corrections[]:
  correctionType · status · reason · createdAt

[ Save profile ] PATCH  [ Disable/Enable ] PATCH status
[ Reset password modal: newPassword * min 10 ]
```

**PATCH staff body (≥1 field):** `name`, `phone`, `employeeCode`, `permissions[]`, `notes`

**PATCH status body:** `{ status: ACTIVE | INACTIVE }`

**Reset password:** `{ newPassword }` min 10 max 128

---

## 5. Customers

### 5.1 List — `/customers`

**API:** `GET /admin/customers?search=&cursor=&limit=`

| Column | API field |
| --- | --- |
| Passbook ID | `customerCode` |
| Name | `userId.name` |
| Phone | `userId.phone` |
| KYC | `kycStatus` |
| Status | `status` |
| Nominee | `nomineeId.name` (if populated) |
| Created | `createdAt` |

### 5.2 Create — `/customers/new`

**API:** `POST /admin/customers` (+ uploads §5.4)

```
── Account ──
name *                 → {name}
phone *                → {phone}
password *             → {password}

── address (optional) ──
line1                  → {address.line1}      max 200 on PATCH-style
city, district, state  → {address.*}
postalCode             → {address.postalCode}

── aadhaar (optional) ──
front upload           → {aadhaar.frontKey}     via presign
back upload            → {aadhaar.backKey}

── nominee (optional) ──
name                   → {nominee.name}
relationship           → {nominee.relationship}
phone                  → {nominee.phone}

── Enroll now (optional) ──
☐ Enroll on scheme
schemePlanId *         → {enrollment.schemePlanId}
startDate *            → {enrollment.startDate}
monthlyInstallment ₹ * → {enrollment.monthlyInstallmentPaise}  min 10000 paise

[ Create customer ]
```

**Response:** `{ customer, enrollment }` — enrollment null if omitted

### 5.3 Detail — `/customers/:id`

**API:** `GET /admin/customers/:id` · `PATCH` · KYC · reset password · enrollment

```
HEADER RO:
  customer.userId.name · customer.userId.phone · customer.customerCode
  customer.kycStatus · customer.status · customer.kycRejectionReason
  customer.kycSubmittedAt · customer.kycReviewedAt

[ Edit profile ] [ Verify KYC ] [ Reject KYC ] [ Reset password ]
[ Mark as paid ] [ Enroll ] — if VERIFIED + no active enrollment

TAB Profile — RO + edit via PATCH:
  address.{line1,line2,city,district,state,postalCode}
  aadhaar.frontUrl · aadhaar.backUrl (signed URLs)
  nomineeId.{name,relationship,phone,dateOfBirth}

TAB Schemes — data.schemes[]:
  _id · enrollmentNumber · schemeType · status · schemeName
  monthlyInstallmentPaise · totalPaidPaise · paymentsCompleted
  schemeContract phase labels · [ Open enrollment ]

TAB Payments — data.payments[] (max 250):
  receiptNumber · amountPaise · method · paymentDate · schemeMonth
  status · referenceNumber · refundStatus

TAB Payouts — data.payouts[]:
  amountPaise · payoutType · method · payoutDate · status · referenceNumber

TAB PhonePe intents — data.paymentIntents[] (max 100):
  merchantTransactionId · amountPaise · status · checkoutChannel
  schemeMonth · createdAt · expiresAt

Reject modal: reason * → POST .../kyc/reject { reason } min 3 max 500
```

**KYC verify:** `POST .../kyc/verify` (no body) — requires both aadhaar keys + PENDING

### 5.4 Aadhaar upload (modal component)

**API:** `POST /uploads/presign` then PUT to `uploadUrl`

| Submit | Field | Values |
| --- | --- | --- |
| Kind * | `kind` | `aadhaar-front` \| `aadhaar-back` |
| Content type * | `contentType` | jpeg, png, webp, pdf |
| File name | `fileName` | max 180 |

**Response use:** `key` → customer `aadhaar.frontKey/backKey` · `maxBytes` · `expiresIn`

---

## 6. Scheme plans

### 6.1 List — `/scheme-plans`

**API:** `GET /admin/scheme-plans`

| Column | Field |
| --- | --- |
| Name | `name` |
| Type | `type` (CASH) |
| Min payment | `minimumPaymentPaise` |
| Duration | `durationMonths` (11) |
| Flexible/cap | `flexibleMonths` / `capMonths` |
| Status | `status` |
| Version | `version` |

### 6.2 Create / Edit — `/scheme-plans/new`, `/scheme-plans/:id`

**API:** `POST /admin/scheme-plans` · `PATCH /admin/scheme-plans/:id`

```
name *                          → {name}
type                            → {type} default CASH (RO on live)
durationMonths                  → {durationMonths} literal 11
minimumPaymentPaise * (₹)       → {minimumPaymentPaise} min 10000
termsText *                     → {termsText} min 5 max 10000
benefitText                     → {benefitText} max 2000
makingChargeBenefit             → {makingChargeBenefit} max 500
wastageBenefit                  → {wastageBenefit} max 500

Payment window:
  paymentWindowType             → FIXED_DAY | DATE_RANGE
  fixedPaymentDay               → 1–31
  paymentWindowStartDay         → 1–31
  paymentWindowEndDay           → 1–31

Premature closure:
  prematureClosureEnabled       → boolean
  prematureClosureMinPaidInstallments → 1–11
  prematureClosureMinElapsedMonths    → 1–11 (CASH: 6 elapsed months)
  prematureClosureSettlementAssets[]  → CASH (live)
  prematureClosureCashBasis     → CONTRIBUTION_VALUE | CURRENT_GOLD_VALUE

Maturity:
  maturitySettlementAssets[]    → CASH, JEWELLERY (live)
  maturityCashBasis             → enum

Edit only: status               → ACTIVE | INACTIVE

RO on detail: redemptionMonth (12) · capStrategy · contributionPolicyVersion
  makingChargeWaiverPercent (100) · gstRateBasisPoints (300)
  createdBy · updatedBy · createdAt · updatedAt · deletedAt
```

---

## 7. Gold rates — `/gold-rates` (dormant unless GOLD enabled)

**API:** `GET/POST/PATCH /admin/gold-rates`

| Field | Create | Edit |
| --- | --- | --- |
| `ratePerGramPaise` | * positive int | optional |
| `purity` | default `916` | optional |
| `effectiveFrom` | * date | optional |
| `notes` | max 500 | optional |
| `status` | — | ACTIVE \| INACTIVE |

**RO:** `usageCount` — if > 0, lock rate edits (`409 GOLD_RATE_LOCKED`)

---

## 8. Enrollments

### 8.1 Shared list filters (all enrollment list endpoints)

| Query param | Values |
| --- | --- |
| `status` | ACTIVE, MATURED, REDEEMED, CLOSED, WITHDRAWN, CANCELLED |
| `schemePlanId` | ObjectId |
| `customerId` | ObjectId |
| `schemeType` | CASH, GOLD_WEIGHT |
| `search` | name, phone, enrollment number |
| `startDateFrom`, `startDateTo` | ISO date |
| `maturityFrom`, `maturityTo` | ISO date |
| `installmentStatus` | PAID, DUE, OVERDUE, UPCOMING |
| `redemptionReady` | true / false |
| `prematureClosureEligible` | true / false |
| `paymentsCompletedMin`, `paymentsCompletedMax` | 0–11 |
| + pagination | |

**Overdue only:** `sort` oldest\|newest\|highestAmount · `minDaysOverdue` · `maxDaysOverdue`

### 8.2 All enrollments — `/enrollments`

**API:** `GET /admin/enrollments`

| Column | Source |
| --- | --- |
| Enrollment # | `enrollmentNumber` |
| Customer | `customerId.userId` |
| Plan | `schemePlanId.name` / `schemeName` |
| Status | `status` |
| Type | `schemeType` |
| Monthly | `monthlyInstallmentPaise` |
| Paid | `totalPaidPaise` / `paymentsCompleted` |
| Phase | from `schemeContract` |
| Start / Maturity | `startDate`, `maturityDate` |
| Summary | `installmentSummary.{paid,due,overdue,upcoming}` |

### 8.3 Due — `/enrollments/due`

**API:** `GET /admin/enrollments/due`

**One row per due installment:**

| Column | API field |
| --- | --- |
| Enrollment | `enrollmentNumber`, `enrollmentId` |
| Customer | `customer.{id,name,phone}` |
| Plan | `schemePlan.name` |
| Month | `schemeMonth` |
| Amount | `amountPaise` |
| Due date | `dueDate` |
| Window | `paymentWindowStartDate` – `paymentWindowEndDate` |
| Older overdue? | `hasOlderOverdue`, `overdueCount` |
| Pay month | `nextPayableSchemeMonth` |
| Action | `[ Collect now ]` |

### 8.4 Overdue — `/enrollments/overdue`

**API:** `GET /admin/enrollments/overdue`

| Column | API field |
| --- | --- |
| Customer / enrollment | `customer`, `enrollmentNumber`, `enrollmentId` |
| Monthly amount | `monthlyInstallmentPaise` |
| Overdue count | `overdueCount` |
| Total overdue ₹ | `totalOverduePaise` |
| Oldest | `oldestOverdueDate`, `oldestDaysOverdue` |
| Next payable | `nextPayableSchemeMonth` |
| Expand | `overdueInstallments[]` → schemeMonth, amountPaise, dueDate, daysOverdue |

### 8.5 Redemption ready — `/enrollments/redemption-ready`

**API:** `GET /admin/enrollments/redemption-ready`

| Column | API field |
| --- | --- |
| Enrollment | `enrollmentNumber`, `enrollmentId` |
| Customer | `customer` |
| Plan | `schemePlan.name` |
| Paid | `paymentsCompleted` |
| Available | `availablePaise`, `availableGoldWeightMg` |
| Window | `redemptionStartDate`, `redemptionEndDate` |
| Assets | `allowedSettlementAssets[]` |
| Action | `[ Start payout ]` |

### 8.6 Detail — `/enrollments/:id`

**API:** `GET /admin/enrollments/:id`

```
HEADER RO — data.enrollment:
  enrollmentNumber · schemeType · status
  customerId.{customerCode, userId.name, userId.phone}
  schemePlanId.name · monthlyInstallmentPaise · totalPaidPaise
  paymentsCompleted · durationMonths · flexibleMonths
  startDate · maturityDate · redemptionStartDate · redemptionEndDate
  flexiblePeriodEndDate · makingChargeWaiverPercent · gstRateBasisPoints
  schemeContract · planSnapshot · statusHistory[]
  createdBy · updatedBy · createdAt

SUMMARY RO — installmentSummary:
  paid · due · overdue · upcoming · total · remaining · nextInstallment

SCHEDULE TABLE — installmentSchedule[]:
  schemeMonth · status · amountPaise · dueDate
  periodStartDate · periodEndDate
  paymentWindowStartDate · paymentWindowEndDate
  daysOverdue · canRecord
  payment.paymentId · payment.receiptNumber · payment.method
  payment.paymentDate · payment.amountPaise
  Row action: [ Mark month N paid ] if canRecord → /payments/manual

PAYMENTS TABLE — payments[]
PAYOUTS TABLE — payouts[]

[ Record payment ] [ Premature close ] [ Maturity payout ] [ Cancel ]
[ Change status ] — advanced PATCH with reason
```

### 8.7 Create enrollment (modal/page)

**API:** `POST /admin/enrollments`

| Field | API | Validation |
| --- | --- | --- |
| Customer | `customerId` | * |
| Plan | `schemePlanId` | * |
| Start date | `startDate` | * |
| Monthly ₹ | `monthlyInstallmentPaise` | * min 10000 paise |
| Enrollment # | `enrollmentNumber` | optional auto |

### 8.8 Cancel enrollment

**API:** `POST /admin/enrollments/:id/cancel`

| Field | API |
| --- | --- |
| Reason * | `reason` min 3 max 500 |

Only unused enrollments (no payments/activity).

### 8.9 Change status (advanced)

**API:** `PATCH /admin/enrollments/:id/status`

| Field | API |
| --- | --- |
| Status * | `status` — use dedicated flows for CANCELLED/REDEEMED/CLOSED |
| Reason * | `reason` min 3 max 500 |

### 8.10 Premature close wizard

**Preview API:** `GET /admin/enrollments/:id/premature-closure-preview?settlementAsset=`

**Preview RO fields:** `eligible`, `blockingReasons[]`, `paymentsCompleted`, `totalPaidPaise`, `availablePrincipalPaise`, `cashAmountPaise`, `allowedSettlementModes[]`, `settlementPrincipalPaise`, `cashBasis`, `prematureClosureEligibleAt`, `policy.*`, `currentGoldRate`, `valuation`

**Submit API:** `POST /admin/enrollments/:id/premature-close`

| Field | API |
| --- | --- |
| Settlement asset * | `settlementAsset` GOLD\|CASH\|JEWELLERY |
| Payout date * | `payoutDate` |
| Reason * | `reason` min 3 max 500 |
| Method | `method` CASH\|BANK\|UPI |
| Reference | `referenceNumber` max 120 |
| Notes | `notes` max 500 |
| Idempotency * | `idempotencyKey` |

### 8.11 Maturity payout wizard

**Preview API:** `GET /admin/enrollments/:id/redemption-preview?settlementAsset=`

Same preview shape as §8.10 + `redemptionType: MATURITY`

**Submit API:** `POST /admin/payouts` (see §10)

---

## 9. Payments

### 9.1 Ledger — `/payments`

**API:** `GET /admin/payments?cursor=&limit=`

| Column | Payment model field |
| --- | --- |
| Receipt | `receiptNumber` |
| Customer | `customerId.userId.name`, `phone` |
| Enrollment | `schemeId.enrollmentNumber` |
| Month | `schemeMonth` |
| Method | `method` |
| Amount | `amountPaise` |
| Date | `paymentDate`, `accountingDate` |
| Collector | `collectorRole`, `collectedBy.name` |
| Reference | `referenceNumber` |
| Status | `status` |
| Refund | `refundStatus`, `refundId` |
| Gateway | `merchantTransactionId`, `providerTransactionId` |
| Gold (dormant) | `goldWeightMg`, `goldRatePerGramPaise` |
| Reversed | `reversedAt`, `reversalReason` |

### 9.2 Detail — `/payments/:id`

**API:** `GET /admin/payments/:id`

```
SECTION payment (all Payment fields):
  _id · amountPaise · method · status · paymentDate · accountingDate
  schemeMonth · receiptNumber · referenceNumber · notes
  collectorRole · collectedBy.{name,phone}
  customerId.{customerCode,userId}
  schemeId.{enrollmentNumber,schemeType}
  merchantTransactionId · providerTransactionId
  goldRateId · goldWeightMg · goldPurity
  refundStatus · refundRequestedAt · refundedAt
  reversedAt · reversedBy · reversalReason
  recognizedAt · providerCompletedAt · createdAt

SECTION refund (linked Refund or null)
SECTION corrections[] (PaymentCorrection requests)

Actions:
  [ Reverse ] — if manual (no merchantTransactionId)
    POST .../reverse { reason * min 5 max 500 }
  [ Refund PhonePe ] — if gateway payment
    POST .../refund { reason *, idempotencyKey *, amountPaise? full only }
```

---

## 10. Payouts — `/payouts`

**API:** `GET /admin/payouts` · `POST /admin/payouts`

### List columns

| Field |
| --- |
| `_id`, `payoutDate`, `payoutType`, `method`, `settlementMode` |
| `amountPaise`, `settlementPrincipalPaise`, `goldWeightMg` |
| `customerId`, `schemeId`, `referenceNumber`, `status` |
| `billNumber`, `billAmountPaise` (jewellery) |
| `extraPaidPaise`, `extraPaymentMethod`, `extraPaymentReference` |
| `reversedAt`, `createdBy` |

### Create payout form (maturity)

| Field | API | Required |
| --- | --- | --- |
| Customer | `customerId` | * |
| Enrollment | `schemeId` | * |
| Payout type | `payoutType` | * PAYOUT (CASH) |
| Settlement asset | `settlementAsset` | CASH \| JEWELLERY |
| Method | `method` | CASH \| BANK \| UPI |
| Payout date | `payoutDate` | * |
| Reference | `referenceNumber` | max 120 |
| Notes | `notes` | max 500 |
| Idempotency | `idempotencyKey` | 8–120 |
| Bill number | `billNumber` | * if JEWELLERY |
| Bill amount | `billAmountPaise` | * if JEWELLERY |
| Extra method | `extraPaymentMethod` | CASH\|UPI\|CARD\|BANK |
| Extra reference | `extraPaymentReference` | min 1 max 120 |

**RO on success:** `payoutId`, `amountPaise`, `settlementPrincipalPaise`, `status`, `referenceNumber`

---

## 11. Cash held — `/cash-held`

**API:** `GET /admin/cash-held`

| Column | Field |
| --- | --- |
| Staff name | `name` |
| Phone | `phone` |
| Employee code | `employeeCode` |
| Status | `status` |
| Cash held | `cashHeldPaise` |
| IDs | `staffId`, `staffProfileId` |
| Action | `[ Record handover ]` → modal §12 |

---

## 12. Cash submissions — `/cash-submissions`

**API:** `GET /admin/cash-submissions` · `POST /admin/cash-submissions`

### Handover form (modal)

| Field | API | Validation |
| --- | --- | --- |
| Staff * | `staffId` | User ObjectId |
| Amount ₹ * | `amountPaise` | ≤ staff cashHeldPaise |
| Submission date * | `submissionDate` | ISO |
| Notes | `notes` | max 500 |

### History list

| Column | CashSubmission field |
| --- | --- |
| Staff | `staffId.name`, `employeeCode` |
| Amount | `amountPaise` |
| Date | `submissionDate` |
| Received by | `receivedBy.name` |
| Notes | `notes` |
| Status | `status` |
| Reversed | `reversedAt` |

---

## 13. Corrections — `/corrections`

**API:** `GET /admin/corrections` · `PATCH /admin/corrections/:id`

### Inbox columns

| Field | Notes |
| --- | --- |
| `_id` | |
| `paymentId` | link |
| `requestedBy` | staff name |
| `correctionType` | CHANGE_AMOUNT, CHANGE_METHOD, CHANGE_REFERENCE, CHANGE_NOTES, REVERSE_PAYMENT |
| `originalSnapshot` | show diff |
| `requestedChanges` | show diff |
| `reason` | |
| `status` | PENDING, APPROVED, REJECTED, CANCELLED |
| `createdAt` | |

### Review modal

| Field | API |
| --- | --- |
| Decision * | `decision` APPROVED \| REJECTED |
| Review notes * | `reviewNotes` min 3 max 500 |

**RO after review:** `reviewedBy`, `reviewedAt`, `replacementPaymentId`

---

## 14. Refunds — `/refunds`, `/refunds/:id`

**API:** `GET /admin/refunds` · `GET /admin/refunds/:id` · `POST .../check-status` · `POST .../retry`

### List columns

| Field |
| --- |
| `_id`, `amountPaise`, `status`, `provider`, `reason` |
| `merchantRefundId`, `providerRefundId`, `originalMerchantOrderId` |
| `paymentId.receiptNumber`, `customerId`, `schemeId.enrollmentNumber` |
| `requestedAt`, `completedAt`, `failedAt`, `attemptNumber`, `active` |
| Provider errors: `providerErrorCode`, `providerErrorMessage` |

### Detail + actions

```
[ Check PhonePe status ] → POST .../check-status
[ Retry ] modal:
  idempotencyKey * → {idempotencyKey}
  reason           → {reason} min 3 max 500
  amountPaise      → full refund only
```

---

## 15. PhonePe transactions — `/phonepe-transactions`, `/:id`

**API:** `GET /admin/phonepe-transactions` · `GET .../:id`

### List columns (PaymentIntent + enrichment)

| Field |
| --- |
| `merchantTransactionId`, `amountPaise`, `status`, `checkoutChannel` |
| `customerId`, `schemeId`, `schemeMonth`, `requestedSchemeMonth` |
| `paymentId`, `receiptNumber`, `receiptStatus` |
| `providerOrderId`, `providerTransactionId`, `webhookStatus` |
| `collectedBy`, `collectorRole`, `expiresAt`, `createdAt` |
| `finalStatusSource`, `confirmationDelaySeconds`, `wasLateConfirmation` |

### Detail extras

| Section | Fields |
| --- | --- |
| Intent | all PaymentIntent fields |
| Linked payment | full Payment if `paymentId` set |
| Webhooks | `webhookEvents[]` → eventType, verified, processedAt, processingError |

---

## 16. Reports

### 16.1 Hub — `/reports`

Date filters: `{from}`, `{to}` (YYYY-MM-DD IST)

| Slug | Route | Key response fields |
| --- | --- | --- |
| collection | `/reports/collection` | `summary[{method,totalPaise,count}]`, `payments[]` |
| phonepe | `/reports/phonepe` | filtered collection |
| cash | `/reports/cash` | filtered collection |
| daily-collection | `/reports/daily-collection` | `timezone`, `days[{businessDate,totalPaise,count}]` |
| monthly-collection | `/reports/monthly-collection` | monthly buckets |
| scheme-collection | `/reports/scheme-collection` | per plan |
| attribution | `/reports/attribution` | self vs staff |
| staff-performance | `/reports/staff-performance` | `staff[]`, `totalCollectionPaise` |
| corrections | `/reports/corrections` | status breakdown |
| payout-totals | `/reports/payout-totals` | aggregates |
| maturity | `/reports/maturity` | calendar rows |
| cash-position | `/reports/cash-position` | dashboard cash fields |
| all-schemes | `/reports/all-schemes` | enrollment summary |
| gold-liability | `/reports/gold-liability` | dormant |
| customer-ledger | `/reports/customer-ledger?id=` | requires customer id |
| scheme-ledger | `/reports/scheme-ledger?id=` | requires enrollment id |

### 16.2 Operational reports (dedicated URLs)

| Page | API | Extra query | Display |
| --- | --- | --- | --- |
| Bank settlements | `GET /reports/bank-settlement-ledger` | from, to, status | `items[]`, `summary` |
| Gateway expenses | `GET /reports/gateway-expenses` | from, to | fees, GST, net |
| Refunds ops | `GET /reports/refunds` | — | byStatus, aging |
| Suspense | `GET /reports/suspense-ledger` | — | items, openPaise |
| Gold control | `GET /reports/gold-control` | from, to | liability + inventory movements |
| Exceptions aging | `GET /reports/financial-exceptions-aging` | — | buckets by type/severity |
| Financial period | `GET /reports/financial-periods/:periodKey` | — | period snapshot |

**Row drill-down:** `GET /admin/operation-records/:module/:id`  
Modules: `scheme-plans`, `enrollments`, `gold-rates`, `payments`, `cash-submissions`, `corrections`, `payouts`, `audit-logs`, `phonepe-transactions`

---

## 17. Finance ops

### 17.1 Exceptions — `/finance/exceptions`

**List query:** `status`, `severity`, `type`, `agingBucket` + pagination

| Display field | |
| --- | --- |
| `type`, `severity`, `status`, `title`, `description` |
| `amountPaise`, `agingBucket`, `firstSeenAt`, `lastSeenAt`, `occurrenceCount` |
| `sourceType`, `sourceId`, linked payment/refund/scheme ids |
| `acknowledgedAt`, `resolvedAt`, `resolutionNotes` |

**Acknowledge:** `POST .../acknowledge` `{ notes? }` max 1000  
**Resolve:** `POST .../resolve` `{ resolutionNotes * min 3 max 2000, status: RESOLVED|IGNORED }`

### 17.2 Suspense — `/finance/suspense`

**Create form fields:**

| Field | API |
| --- | --- |
| entryType * | UNMATCHED_CREDIT \| UNMATCHED_DEBIT |
| amountPaise * | positive |
| provider | max 80 |
| providerReference | max 200 |
| bankReference | max 200 |
| transactionDate | date |
| description * | min 3 max 1000 |
| source * | PHONEPE_DASHBOARD, BANK_STATEMENT, EMAIL, SUPPORT, MANUAL |

**Resolve:** `resolutionNotes *`, `status` RESOLVED\|WRITTEN_OFF, optional `resolvedPaymentId`, `resolvedRefundId`

### 17.3 Disputes — `/finance/disputes`

**Create:** `paymentId *`, `reason *`, `detectedVia *`, `providerCaseId`, `amountPaise`, `reasonCode`, `notifiedAt`, `responseDueAt`, `evidenceNotes`

**PATCH:** `status`, `providerCaseId`, `reasonCode`, `reason`, `evidenceNotes`, `resolutionReference`, dates

### 17.4 Gateway settlements — `/finance/gateway-settlements`

**Create (all fields):** `settlementId`, `periodFrom`, `periodTo`, `settlementDate`, `grossCollectionPaise`, `refundDeductionPaise`, `chargebackDeductionPaise`, `gatewayFeePaise`, `gatewayFeeGstPaise`, `otherAdjustmentPaise`, `netSettlementPaise`, `providerUtr`, `bankReferenceId`, `source`, `notes`

**Confirm bank credit:** `providerUtr` OR `bankReferenceId`, `bankCreditedAt *`, `notes`

**Close:** `{ notes? }`

**Status flow:** RECORDED → BANK_CONFIRMED → CLOSED

### 17.5 Accounting periods — `/finance/accounting-periods`

**Close:** `closeNotes?`, `overrideReason?` min 3  
**Reopen:** `reason *` min 3 max 2000

**Period summary RO:** `periodKey`, `status`, `startsAt`, `endsAt`, `snapshot.*` (collections, refunds, payouts, gateway fees, gold, suspense, openExceptionCount)

### 17.6 Gold inventory (dormant)

**Movement create:** `movementType`, `goldWeightMg`, `movementDate`, `purity`, `referenceNumber`, `reason`

---

## 18. Settings — `/settings`

**API:** `GET /admin/settings` · `PATCH /admin/settings` (all fields required on PATCH)

```
businessName *            → {businessName}
supportPhone *            → {supportPhone}
supportEmail *            → {supportEmail}      email or ""
businessAddress *         → {businessAddress}
receiptFooter *           → {receiptFooter}
customerPhonePeEnabled *  → {customerPhonePeEnabled}  toggle

RO: singletonKey (GLOBAL) · updatedBy · updatedAt
[ Save settings ]
```

---

## 19. Audit logs — `/audit-logs`

**API:** `GET /admin/audit-logs?cursor=&limit=`

| Column | AuditLog field |
| --- | --- |
| Time | `createdAt` |
| Actor | `actorId.name`, `actorId.phone`, `actorRole` |
| Action | `action` |
| Entity | `entityType`, `entityId` |
| Request | `requestId`, `ip`, `userAgent` |
| Diff | `before`, `after` (expand JSON) |

---

## 20. Scheme enrollment model — RO fields on detail screens

Show on enrollment/customer scheme cards:

| Field | UI label suggestion |
| --- | --- |
| `enrollmentNumber` | Passbook / enrollment ID |
| `schemeType` | CASH |
| `status` | Status badge |
| `startDate` | Scheme start |
| `flexiblePeriodEndDate` | End of flexible phase (month 6) |
| `maturityDate` | Maturity |
| `redemptionStartDate` | Redemption window opens |
| `redemptionEndDate` | Redemption window closes |
| `durationMonths` | 11 |
| `flexibleMonths` | 6 |
| `monthlyInstallmentPaise` | Monthly installment |
| `totalPaidPaise` | Total contributed |
| `paymentsCompleted` | Months paid |
| `totalGoldWeightMg` | Gold (dormant) |
| `makingChargeWaiverPercent` | 100% waiver |
| `gstRateBasisPoints` | GST basis |
| `paymentWindowType` | Fixed day / range |
| `fixedPaymentDay` | Payment day of month |
| `prematureClosureEnabled` | Early close allowed |
| `maturitySettlementAssets[]` | Cash / Jewellery |
| `statusHistory[]` | Timeline: status, at, actorId, reason |

**Phase labels (CASH 6+5):**

| Calendar month | Label |
| --- | --- |
| 1–6 | Flexible contribution |
| 7–11 | Capped contribution |
| 12 | Redemption only (no new contribution) |

---

## 21. Global error codes → UI

| Code | HTTP | Action |
| --- | --- | --- |
| `AUTHENTICATION_REQUIRED` | 401 | → login |
| `SESSION_EXPIRED` | 401 | refresh → login |
| `PERMISSION_DENIED` | 403 | wrong portal |
| `VALIDATION_ERROR` | 422 | field errors |
| `CUSTOMER_ALREADY_ENROLLED` | 409 | link enrollment |
| `KYC_VERIFICATION_REQUIRED` | 409 | verify KYC |
| `INSUFFICIENT_CASH_HELD` | 409 | reduce handover |
| `INSUFFICIENT_STAFF_CASH` | 409 | same |
| `INSTALLMENT_ALREADY_PAID` | 409 | show paid badge |
| `DUPLICATE_RECORD` | 409 | conflict msg |
| `ENROLLMENT_CANCELLATION_REQUIRES_SETTLEMENT` | 409 | use payout flow |
| `GOLD_RATE_LOCKED` | 409 | rate in use |
| `REPORT_NOT_FOUND` | 404 | invalid slug |
| `ACTIVE_ENROLLMENT_NOT_FOUND` | 404 | enroll first |
| `IDEMPOTENCY_KEY_REUSED` | 409 | new UUID |

---

## 22. Cursor build checklist (missing fields audit)

Use this when reviewing generated UI against backend:

### Must-have for walk-in / mark as paid
- [ ] Full manual payment form (§3) — all 7 submit fields + idempotency
- [ ] Show `schemeMonth` from **response** only
- [ ] Customer search picker with KYC badge
- [ ] Enrollment context (paid count, next due, overdue flags)
- [ ] Receipt success modal with `receiptNumber`
- [ ] Entry from dashboard, customer, enrollment, due, overdue

### Customers
- [ ] Full address 6 fields · nominee 3 fields · Aadhaar upload presign flow
- [ ] Optional enroll-on-create block
- [ ] KYC verify/reject with `reason`
- [ ] Tabs: schemes, payments, payouts, paymentIntents
- [ ] `kycRejectionReason`, signed `frontUrl`/`backUrl`

### Enrollments
- [ ] Full `installmentSchedule[]` table with `canRecord` actions
- [ ] All list filters (§8.1)
- [ ] Premature close + redemption preview with `blockingReasons[]`
- [ ] Cancel with reason

### Payments
- [ ] Full payment detail (§9.2) including gateway + refund fields
- [ ] Reverse (manual) vs Refund (PhonePe) branching

### Payouts
- [ ] Jewellery fields `billNumber`, `billAmountPaise`, extra payment fields

### Cash / corrections / refunds / PhonePe
- [ ] Cash submission validates against `cashHeldPaise`
- [ ] Correction diff view + `reviewNotes`
- [ ] Refund retry with idempotency
- [ ] PhonePe webhook events on detail

### Settings / dashboard
- [ ] All 6 settings fields on PATCH
- [ ] All dashboard KPI fields (§2) linked to list pages
- [ ] `monthlyCollections` chart data

---

## 23. Suggested Cursor prompt

```
Build the Nakshathra admin panel page-by-page using docs/ADMIN_PANEL_WIREFRAMES.md.
For each screen implement EVERY field in the wireframe field tables.
Use JSX + Redux RTK Query per ADMIN_PANEL_FRONTEND_GUIDE.md.
Start with §3 Mark as paid (/payments/manual) then §2 Dashboard then §5 Customers.
API base: VITE_API_BASE_URL with credentials: 'include'.
Format money paise→₹ at UI boundary only.
```

---

## 24. Related docs

- [ADMIN_PANEL_API.md](./ADMIN_PANEL_API.md) — Appendix A.1–A.47 JSON
- [ADMIN_PANEL_FRONTEND_GUIDE.md](./ADMIN_PANEL_FRONTEND_GUIDE.md)
- [FLUTTER_APP_FLOWS.md](./FLUTTER_APP_FLOWS.md) — staff app collects on floor; admin records owner cash + approvals
