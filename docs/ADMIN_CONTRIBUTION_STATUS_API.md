# Admin contribution status API reference

> **Shipped:** September 2026  
> **Base path:** `/api/v1/admin`  
> **Auth:** Admin session (`access_token` cookie) — same as other admin routes  
> **Envelope:** `{ "success": true, "data": … }` — list endpoints also include `"meta": { … }`

These endpoints expose Nakshathra CASH contribution rules (flexible months 1–6, capped months 7–11, redemption month 12) to the admin panel — the same engine staff already uses. Use them for **Mark as paid**, enrollment/customer detail cards, and dashboard phase counts.

**Related docs:** [ADMIN_PANEL_API.md](./ADMIN_PANEL_API.md) §8 (business rules), §26 (original plan)

---

## Shared types

### `contribution` (full object)

Present on enrollment detail, customer detail, manual-payment response, and most list rows when the enrollment is **ACTIVE** and in a payable phase. `null` when there is no active enrollment or status is not payable.

| Field | Type | Notes |
| --- | --- | --- |
| `schemeMonth` | `number \| null` | Calendar scheme month (1–11 contribution; 12 = redemption) |
| `phase` | `string` | `FLEXIBLE` \| `CAPPED` \| `REDEMPTION` \| `NOT_PAYABLE` \| `FIXED` |
| `phaseLabel` | `string` | Human-readable label from server |
| `minimumPaymentPaise` | `number` | Plan minimum per payment |
| `monthlyCapPaise` | `number \| null` | Monthly cap (capped months only) |
| `capPaise` | `number \| null` | Same as `monthlyCapPaise` (staff parity) |
| `paidThisMonthPaise` | `number` | SUCCESS payments in current scheme month |
| `remainingCapPaise` | `number \| null` | **How much can still be paid this month.** `null` in flexible months |
| `remainingPaise` | `number \| null` | Alias of `remainingCapPaise` |
| `capApplies` | `boolean` | `true` only in capped months 7–11 |
| `capStrategy` | `string \| null` | e.g. `AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6` |
| `firstPeriodEmpty` | `boolean` | `true` → month 7+ blocked until months 1–6 have payments |
| `computedAverageCapPaise` | `number \| null` | Average cap from months 1–6 (useful before month 7) |
| `installmentAlreadyPaid` | `boolean` | Capped month fully paid |
| `totalContributedPaise` | `number` | Optional — lifetime contributed on enrollment |
| `calculatedAt` | `string` | ISO timestamp when status was computed |

**Flexible month example** (month 1, no upper cap):

```json
{
  "schemeMonth": 1,
  "phase": "FLEXIBLE",
  "phaseLabel": "Flexible contribution month",
  "minimumPaymentPaise": 100000,
  "monthlyCapPaise": null,
  "capPaise": null,
  "paidThisMonthPaise": 0,
  "remainingCapPaise": null,
  "remainingPaise": null,
  "capApplies": false,
  "capStrategy": "AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6",
  "firstPeriodEmpty": false,
  "computedAverageCapPaise": null,
  "installmentAlreadyPaid": false,
  "totalContributedPaise": 0,
  "calculatedAt": "2026-09-12T06:30:00.000Z"
}
```

**Capped month example** (month 7, cap = average of first 6 payments at ₹1,000 each):

```json
{
  "schemeMonth": 7,
  "phase": "CAPPED",
  "phaseLabel": "Capped contribution month",
  "minimumPaymentPaise": 100000,
  "monthlyCapPaise": 100000,
  "capPaise": 100000,
  "paidThisMonthPaise": 0,
  "remainingCapPaise": 100000,
  "remainingPaise": 100000,
  "capApplies": true,
  "capStrategy": "AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6",
  "firstPeriodEmpty": false,
  "computedAverageCapPaise": 100000,
  "installmentAlreadyPaid": false,
  "totalContributedPaise": 600000,
  "calculatedAt": "2026-07-05T06:30:00.000Z"
}
```

### `contributionListFields` (summary fields)

Flattened subset used on **due queue** rows and **dashboard `upcomingInstallments[]`**:

| Field | Type |
| --- | --- |
| `phase` | `string` |
| `phaseLabel` | `string` |
| `schemeMonth` | `number \| null` |
| `monthlyCapPaise` | `number \| null` |
| `remainingCapPaise` | `number \| null` |
| `paidThisMonthPaise` | `number` |
| `capApplies` | `boolean` |

### `schemeSummary`

On `GET /admin/customers/:id` when the customer has an active enrollment:

```json
{
  "enrollmentId": "67a1b2c3d4e5f6789012345e",
  "enrollmentNumber": "NKS-2026-000042",
  "schemeName": "Nakshathra Cash 11M",
  "schemeType": "CASH",
  "status": "ACTIVE",
  "startDate": "2026-01-01T00:00:00.000Z",
  "maturityDate": "2026-12-01T00:00:00.000Z",
  "monthlyInstallmentPaise": 100000,
  "totalContributedPaise": 600000,
  "durationMonths": 11,
  "flexibleMonths": 6,
  "capMonths": 5
}
```

### `contributionPhaseCounts`

On `GET /admin/dashboard`:

```json
{
  "flexible": 42,
  "capped": 18,
  "redemption": 3
}
```

Counts **active enrollments only**, based on current calendar scheme month vs policy.

---

## New endpoint

### `GET /admin/enrollments/:id/payment-preview`

Live payment validation while the owner types an amount on **Mark as paid**. Same engine as `GET /staff/schemes/:id/payment-preview`.

**Path params**

| Param | Description |
| --- | --- |
| `id` | Enrollment (scheme) ID |

**Query params**

| Param | Required | Type | Description |
| --- | --- | --- | --- |
| `amountPaise` | yes | positive int | Amount being considered |
| `paymentDate` | no | ISO datetime | Defaults to now (IST scheme month) |
| `schemeMonth` | no | int 1–11 | **Omit in UI** — server derives from `paymentDate` |

**Example request**

```http
GET /api/v1/admin/enrollments/67a1b2c3d4e5f6789012345e/payment-preview?amountPaise=100000&paymentDate=2026-07-05T06:30:00.000Z
Cookie: access_token=…
```

**Response `200` — flexible month, allowed**

```json
{
  "success": true,
  "data": {
    "enrollmentId": "67a1b2c3d4e5f6789012345e",
    "schemeId": "67a1b2c3d4e5f6789012345e",
    "schemeMonth": 1,
    "phase": "FLEXIBLE",
    "phaseLabel": "Flexible contribution month",
    "requestedAmountPaise": 100000,
    "minimumPaymentPaise": 100000,
    "monthlyCapPaise": null,
    "paidThisMonthPaise": 0,
    "remainingCapPaise": null,
    "remainingPaise": null,
    "capApplies": false,
    "capStrategy": "AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6",
    "allowed": true,
    "paymentAllowed": true,
    "reasonCode": null,
    "reasonMessage": null,
    "calculatedAt": "2026-09-12T06:30:00.000Z",
    "quoteExpiresAt": "2026-09-12T06:35:00.000Z"
  }
}
```

**Response `200` — capped month, allowed**

```json
{
  "success": true,
  "data": {
    "enrollmentId": "67a1b2c3d4e5f6789012345e",
    "schemeId": "67a1b2c3d4e5f6789012345e",
    "schemeMonth": 7,
    "phase": "CAPPED",
    "phaseLabel": "Capped contribution month",
    "requestedAmountPaise": 100000,
    "minimumPaymentPaise": 100000,
    "monthlyCapPaise": 100000,
    "paidThisMonthPaise": 0,
    "remainingCapPaise": 100000,
    "remainingPaise": 100000,
    "capApplies": true,
    "capStrategy": "AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6",
    "allowed": true,
    "paymentAllowed": true,
    "reasonCode": null,
    "reasonMessage": null,
    "calculatedAt": "2026-07-05T06:30:00.000Z",
    "quoteExpiresAt": "2026-07-05T06:35:00.000Z"
  }
}
```

**Response `200` — capped month, over limit (still returns cap fields for UI)**

```json
{
  "success": true,
  "data": {
    "enrollmentId": "67a1b2c3d4e5f6789012345e",
    "schemeId": "67a1b2c3d4e5f6789012345e",
    "schemeMonth": 7,
    "phase": "CAPPED",
    "phaseLabel": "Capped contribution month",
    "requestedAmountPaise": 150000,
    "minimumPaymentPaise": 100000,
    "monthlyCapPaise": 100000,
    "paidThisMonthPaise": 0,
    "remainingCapPaise": 100000,
    "remainingPaise": 100000,
    "capApplies": true,
    "capStrategy": "AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6",
    "allowed": false,
    "paymentAllowed": false,
    "reasonCode": "PAYMENT_LIMIT_EXCEEDED",
    "reasonMessage": "Payment amount exceeds the remaining limit for this scheme month",
    "calculatedAt": "2026-07-05T06:30:00.000Z",
    "quoteExpiresAt": "2026-07-05T06:35:00.000Z"
  }
}
```

**Frontend:** debounce this call on amount / payment-date change. Disable submit when `allowed === false`.

---

## Updated endpoints

### `GET /admin/enrollments/:id`

**Change:** top-level **`contribution`** object added (full shape above).

**Response `200` — `data` (new fields only; existing `enrollment`, `payments`, `installmentSchedule`, etc. unchanged)**

```json
{
  "success": true,
  "data": {
    "enrollment": { "…": "…" },
    "contribution": {
      "schemeMonth": 1,
      "phase": "FLEXIBLE",
      "phaseLabel": "Flexible contribution month",
      "minimumPaymentPaise": 100000,
      "monthlyCapPaise": null,
      "remainingCapPaise": null,
      "capApplies": false,
      "calculatedAt": "2026-09-12T06:30:00.000Z"
    },
    "payments": [],
    "payouts": [],
    "installmentSchedule": [],
    "installmentSummary": {}
  }
}
```

---

### `GET /admin/customers/:id/enrollment`

**Change:** response is full enrollment detail (same as `GET /admin/enrollments/:id`) including **`contribution`**.

**Response `200` — `data`**

```json
{
  "success": true,
  "data": {
    "enrollment": { "…": "…" },
    "contribution": {
      "schemeMonth": 1,
      "phase": "FLEXIBLE",
      "remainingCapPaise": null
    },
    "payments": [],
    "payouts": [],
    "installmentSchedule": [],
    "installmentSummary": {}
  }
}
```

**Errors:** `404 ACTIVE_ENROLLMENT_NOT_FOUND` when customer has no active enrollment.

---

### `GET /admin/customers/:id`

**Change:** three new top-level fields on `data`:

| Field | Description |
| --- | --- |
| `contribution` | Full `contribution` for active enrollment, or `null` |
| `schemeSummary` | Compact active-scheme summary (see above), or `null` |
| `activeEnrollment` | Full active enrollment document (unchanged shape), or `null` |

**Response `200` — `data` (new fields only)**

```json
{
  "success": true,
  "data": {
    "customer": { "…": "…" },
    "schemes": [],
    "activeEnrollment": { "…": "…" },
    "schemeSummary": {
      "enrollmentId": "67a1b2c3d4e5f6789012345e",
      "enrollmentNumber": "NKS-2026-000042",
      "schemeName": "Nakshathra Cash 11M",
      "schemeType": "CASH",
      "status": "ACTIVE",
      "totalContributedPaise": 0
    },
    "contribution": {
      "phase": "FLEXIBLE",
      "schemeMonth": 1,
      "remainingCapPaise": null
    },
    "payments": [],
    "payouts": [],
    "paymentIntents": []
  }
}
```

---

### `POST /admin/payments/manual`

**Request body** (unchanged):

```json
{
  "customerId": "67a1b2c3d4e5f6789012345a",
  "schemeId": "67a1b2c3d4e5f6789012345e",
  "amountPaise": 100000,
  "method": "CASH",
  "paymentDate": "2026-09-05T06:30:00.000Z",
  "referenceNumber": "optional",
  "notes": "optional",
  "idempotencyKey": "unique-key-min-8-chars"
}
```

| Field | Notes |
| --- | --- |
| `schemeMonth` | Optional — **omit in UI**; server assigns from `paymentDate` |

**Response `201` — `data` (new field: `contribution` = state **after** payment)**

```json
{
  "success": true,
  "data": {
    "paymentId": "67a1b2c3d4e5f6789012345f",
    "receiptNumber": "NKS-2026-0000012",
    "amountPaise": 100000,
    "method": "CASH",
    "paymentDate": "2026-09-05T06:30:00.000Z",
    "status": "SUCCESS",
    "schemeMonth": 1,
    "contribution": {
      "schemeMonth": 1,
      "phase": "FLEXIBLE",
      "paidThisMonthPaise": 100000,
      "remainingCapPaise": null,
      "minimumPaymentPaise": 100000,
      "calculatedAt": "2026-09-05T06:30:00.000Z"
    }
  }
}
```

After a partial capped-month payment, `contribution.remainingCapPaise` shows what is still payable in that month.

---

### `GET /admin/enrollments`

**Change:** each item in `data` includes nested **`contribution`** (full object) for active enrollments.

**Response `200` — `data.items[]` row (contribution excerpt)**

```json
{
  "success": true,
  "data": [
    {
      "_id": "67a1b2c3d4e5f6789012345e",
      "enrollmentNumber": "NKS-2026-000042",
      "status": "ACTIVE",
      "installmentSchedule": [],
      "installmentSummary": {},
      "contribution": {
        "phase": "CAPPED",
        "schemeMonth": 7,
        "remainingCapPaise": 100000,
        "monthlyCapPaise": 100000
      }
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1 }
}
```

---

### `GET /admin/enrollments/overdue`

**Change:** each item includes nested **`contribution`** (full object).

**Response `200` — `data.items[]` row (new field)**

```json
{
  "enrollmentId": "67a1b2c3d4e5f6789012345e",
  "enrollmentNumber": "NKS-2026-000042",
  "customer": { "…": "…" },
  "schemePlan": { "…": "…" },
  "overdueCount": 2,
  "overdueInstallments": [],
  "contribution": {
    "phase": "CAPPED",
    "schemeMonth": 8,
    "remainingCapPaise": 50000,
    "monthlyCapPaise": 100000,
    "paidThisMonthPaise": 50000
  }
}
```

---

### `GET /admin/enrollments/due`

**Change:** contribution summary fields are **spread at the top level** of each due row (not nested under `contribution`).

**Response `200` — `data.items[]` row**

```json
{
  "enrollmentId": "67a1b2c3d4e5f6789012345e",
  "enrollmentNumber": "NKS-2026-000042",
  "customer": { "…": "…" },
  "schemePlan": { "…": "…" },
  "schemeMonth": 7,
  "amountPaise": 100000,
  "dueDate": "2026-07-05T00:00:00.000Z",
  "phase": "CAPPED",
  "phaseLabel": "Capped contribution month",
  "monthlyCapPaise": 100000,
  "remainingCapPaise": 100000,
  "paidThisMonthPaise": 0,
  "capApplies": true
}
```

---

### `GET /admin/enrollments/redemption-ready`

**Change:** each item includes nested **`contribution`**. For redemption-ready enrollments, phase is typically **`REDEMPTION`** with `schemeMonth` 12.

**Response `200` — `data.items[]` row (new field)**

```json
{
  "enrollmentId": "67a1b2c3d4e5f6789012345e",
  "enrollmentNumber": "NKS-2026-000042",
  "paymentsCompleted": 11,
  "availablePaise": 1100000,
  "contribution": {
    "phase": "REDEMPTION",
    "schemeMonth": 12,
    "phaseLabel": "Redemption month",
    "remainingCapPaise": null,
    "installmentAlreadyPaid": true
  }
}
```

---

### `GET /admin/dashboard`

**Change:**

1. Top-level **`contributionPhaseCounts`** (see shared type above).
2. Each **`upcomingInstallments[]`** entry enriched with `contributionListFields` (`phase`, `remainingCapPaise`, etc.).

**Response `200` — `data` (new / updated fields only)**

```json
{
  "success": true,
  "data": {
    "contributionPhaseCounts": {
      "flexible": 42,
      "capped": 18,
      "redemption": 3
    },
    "upcomingInstallments": [
      {
        "enrollmentId": "67a1b2c3d4e5f6789012345e",
        "enrollmentNumber": "NKS-2026-000042",
        "schemeMonth": 7,
        "dueDate": "2026-07-05T00:00:00.000Z",
        "status": "DUE",
        "amountPaise": 100000,
        "phase": "CAPPED",
        "phaseLabel": "Capped contribution month",
        "monthlyCapPaise": 100000,
        "remainingCapPaise": 100000,
        "paidThisMonthPaise": 0,
        "capApplies": true
      }
    ],
    "activeSchemes": 63,
    "redemptionReadySchemes": 5
  }
}
```

All other dashboard fields (`monthlyCollections`, `recentPayments`, etc.) are unchanged.

---

## Mark as paid — recommended call sequence

```
1. GET /admin/customers?search=…
2. GET /admin/customers/:id/enrollment     → show contribution card (phase, caps)
3. [User enters amount and payment date]
4. GET /admin/enrollments/:id/payment-preview?amountPaise=&paymentDate=
5. POST /admin/payments/manual             → receipt + contribution after pay
```

**UI blocks before submit**

| Condition | Action |
| --- | --- |
| `contribution.firstPeriodEmpty === true` | Banner — cannot pay month 7+ until months 1–6 have payments |
| `contribution.phase === "CAPPED"` && `remainingCapPaise === 0` | Disable pay — month fully paid |
| Preview `allowed === false` | Show `reasonMessage`; disable submit |
| `kycStatus !== "VERIFIED"` (when `KYC_REQUIRED`) | Existing 409 — verify KYC first |

---

## Not shipped (P2 — future)

| Item | Notes |
| --- | --- |
| `GET /admin/enrollments?contributionPhase=FLEXIBLE\|CAPPED\|REDEMPTION` | Filter not implemented |
| Customer list phase badge | No new field on `GET /admin/customers` list |

---

## Error codes (payment preview / manual pay)

Same as existing payment engine — common codes when caps apply:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `PAYMENT_LIMIT_EXCEEDED` | 409 / preview `allowed: false` | Amount over `remainingCapPaise` in capped month |
| `FIRST_PERIOD_EMPTY` | 409 | No payments in months 1–6 — cap cannot be computed |
| `SCHEME_MATURED` | 409 | Outside 11-month contribution window |
| `KYC_VERIFICATION_REQUIRED` | 409 | Customer KYC not verified |
| `SCHEME_NOT_FOUND` | 404 | Invalid enrollment ID |
