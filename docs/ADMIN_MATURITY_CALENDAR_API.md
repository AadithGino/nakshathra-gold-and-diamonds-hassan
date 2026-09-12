# Admin maturity calendar API reference

> **Shipped:** September 2026  
> **Base path:** `/api/v1/admin`  
> **Auth:** Admin session (`access_token` cookie) — same as other admin routes  
> **Envelope:** `{ "success": true, "data": …, "meta": … }`

Use this endpoint to power the **admin maturity calendar** screen — a date-range view of enrollments sorted by `maturityDate`, with customer and scheme details ready for calendar cells, list rows, or month grids.

**Related docs:** [ADMIN_PANEL_API.md](./ADMIN_PANEL_API.md) §9 (enrollments), §11 (payouts), §16 (reports)

---

## Endpoint

### `GET /admin/maturity-calendar`

Returns enrollments whose **`maturityDate`** falls within the requested range. Results are sorted **oldest maturity first** (`maturityDate` asc).

By default only **`ACTIVE`** and **`MATURED`** enrollments are included (same as the legacy `GET /admin/reports/maturity` report filter).

---

## Request

### Headers

| Header | Value |
| --- | --- |
| `Cookie` | `access_token=<admin session token>` |

No request body.

### Query parameters

| Param | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `from` | no | string | `now` | Range start. Accepts `YYYY-MM-DD` (Asia/Kolkata start-of-day) or full ISO datetime |
| `to` | no | string | `from + 366 days` | Range end. Accepts `YYYY-MM-DD` (Asia/Kolkata end-of-day) or full ISO datetime |
| `status` | no | enum | `ACTIVE` + `MATURED` | Filter to a single status: `ACTIVE`, `MATURED`, `REDEEMED`, `CLOSED` |
| `schemeType` | no | enum | all types | `CASH` or `GOLD_WEIGHT` |

**Date parsing notes**

- `from=2026-12-01` → start of 1 Dec 2026 in **Asia/Kolkata** (`00:00:00.000 IST`)
- `to=2026-12-31` → end of 31 Dec 2026 in **Asia/Kolkata** (`23:59:59.999 IST`)
- If `from` is omitted, the server uses the current instant
- If `to` is omitted, the server uses `from + 366 days`
- `from` must be **≤** `to` or the API returns `422 VALIDATION_ERROR`

### Example requests

**December 2026 calendar month**

```http
GET /api/v1/admin/maturity-calendar?from=2026-12-01&to=2026-12-31
Cookie: access_token=…
```

**Next 90 days from today (ISO datetimes)**

```http
GET /api/v1/admin/maturity-calendar?from=2026-09-12T00:00:00.000Z&to=2026-12-11T23:59:59.999Z
Cookie: access_token=…
```

**Only matured CASH schemes**

```http
GET /api/v1/admin/maturity-calendar?from=2026-01-01&to=2026-12-31&status=MATURED&schemeType=CASH
Cookie: access_token=…
```

**Default range (no query params)**

```http
GET /api/v1/admin/maturity-calendar
Cookie: access_token=…
```

Uses `from = now`, `to = now + 366 days`, statuses `ACTIVE` + `MATURED`.

---

## Response

### Success `200`

```json
{
  "success": true,
  "data": [
    {
      "enrollmentId": "67a1b2c3d4e5f6789012345e",
      "enrollmentNumber": "NKS-2026-000042",
      "customer": {
        "id": "67a1b2c3d4e5f6789012345a",
        "name": "Meera Nair",
        "phone": "+919876543210"
      },
      "schemePlan": {
        "id": "67a1b2c3d4e5f6789012345b",
        "name": "Nakshathra Cash 11M",
        "type": "CASH"
      },
      "schemeType": "CASH",
      "status": "ACTIVE",
      "startDate": "2026-01-01T00:00:00.000Z",
      "maturityDate": "2026-12-01T00:00:00.000Z",
      "redemptionStartDate": "2026-12-01T00:00:00.000Z",
      "redemptionEndDate": "2027-01-31T00:00:00.000Z",
      "totalPaidPaise": 1100000,
      "monthlyInstallmentPaise": 100000,
      "durationMonths": 11
    },
    {
      "enrollmentId": "67a1b2c3d4e5f6789012345f",
      "enrollmentNumber": "NKS-2026-000088",
      "customer": {
        "id": "67a1b2c3d4e5f6789012345c",
        "name": "Rajesh Kumar",
        "phone": "+919988776655"
      },
      "schemePlan": {
        "id": "67a1b2c3d4e5f6789012345b",
        "name": "Nakshathra Cash 11M",
        "type": "CASH"
      },
      "schemeType": "CASH",
      "status": "MATURED",
      "startDate": "2025-12-01T00:00:00.000Z",
      "maturityDate": "2026-12-15T00:00:00.000Z",
      "redemptionStartDate": "2026-12-15T00:00:00.000Z",
      "redemptionEndDate": "2027-02-14T00:00:00.000Z",
      "totalPaidPaise": 1100000,
      "monthlyInstallmentPaise": 100000,
      "durationMonths": 11
    }
  ],
  "meta": {
    "from": "2026-12-01T18:30:00.000Z",
    "to": "2026-12-31T18:29:59.999Z",
    "total": 2
  }
}
```

### Empty range `200`

```json
{
  "success": true,
  "data": [],
  "meta": {
    "from": "2027-01-01T18:30:00.000Z",
    "to": "2027-01-31T18:29:59.999Z",
    "total": 0
  }
}
```

---

## Response fields

### `meta`

| Field | Type | Description |
| --- | --- | --- |
| `from` | string | Resolved range start (ISO UTC) |
| `to` | string | Resolved range end (ISO UTC) |
| `total` | number | Count of items in `data` |

### `data[]` — calendar entry

| Field | Type | UI use |
| --- | --- | --- |
| `enrollmentId` | string | Link to enrollment detail / redemption flow |
| `enrollmentNumber` | string | Display ref (e.g. `NKS-2026-000042`) |
| `customer.id` | string \| null | Link to customer detail |
| `customer.name` | string \| null | Calendar cell label |
| `customer.phone` | string \| null | Search / contact |
| `schemePlan.id` | string | Plan reference |
| `schemePlan.name` | string \| null | Subtitle on calendar row |
| `schemePlan.type` | string \| null | `CASH` \| `GOLD_WEIGHT` |
| `schemeType` | string | Enrollment scheme type |
| `status` | string | Badge: `ACTIVE`, `MATURED`, `REDEEMED`, `CLOSED`, etc. |
| `startDate` | string (ISO) | Scheme start |
| `maturityDate` | string (ISO) | **Calendar grouping key** — month 12 start for Nakshathra CASH |
| `redemptionStartDate` | string \| null | When redemption window opens |
| `redemptionEndDate` | string \| null | When redemption window closes |
| `totalPaidPaise` | number | Total contributed so far (paise) |
| `monthlyInstallmentPaise` | number | Nominal monthly installment |
| `durationMonths` | number | Plan duration (11 for live CASH) |

**Money display:** divide paise by 100 for rupees (e.g. `1100000` → ₹11,000).

---

## Errors

### Invalid date range `422`

```http
GET /api/v1/admin/maturity-calendar?from=2026-12-31&to=2026-01-01
```

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Maturity calendar start date must be before or equal to end date",
    "statusCode": 422
  },
  "requestId": "…"
}
```

### Invalid date string `422`

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Report date is invalid",
    "statusCode": 422
  },
  "requestId": "…"
}
```

### Unauthorized `401`

Missing or expired admin session.

---

## Nakshathra CASH maturity context

For live CASH schemes:

| Concept | Value |
| --- | --- |
| Contribution months | 1–11 |
| Redemption month | 12 (`maturityDate` marks start of redemption window) |
| Payout action | `POST /admin/payouts` after enrollment is redemption-ready |

`maturityDate` on each row is what the calendar should plot. Use `status` to distinguish schemes still collecting (`ACTIVE`) vs already matured (`MATURED`) vs already paid out (`REDEEMED`).

---

## Related admin APIs

Use the right endpoint for each screen:

| Screen / need | API | Notes |
| --- | --- | --- |
| **Maturity calendar (month grid / list)** | **`GET /admin/maturity-calendar`** | **Use this doc** — calendar-shaped rows |
| Payout queue (“ready to redeem”) | `GET /admin/enrollments/redemption-ready` | Operational queue, not date-sorted calendar |
| Dashboard widget (next 30 days) | `GET /admin/dashboard` → `upcomingMaturities[]` | Max **8** items, ACTIVE only |
| Export / legacy report | `GET /admin/reports/maturity?from=&to=` | Raw enrollment documents for reporting |
| Filter enrollments by maturity | `GET /admin/enrollments?maturityFrom=&maturityTo=` | Paginated enrollment list |
| Preview settlement amount | `GET /admin/enrollments/:id/redemption-preview` | Before recording payout |
| Record maturity payout | `POST /admin/payouts` | CASH or JEWELLERY settlement |

---

## Recommended frontend flow

### Calendar month view

```
1. User selects month (e.g. December 2026)
2. GET /admin/maturity-calendar?from=2026-12-01&to=2026-12-31
3. Group data[] by maturityDate (local IST day)
4. Render cells; click row → enrollment detail or redemption flow
```

### Calendar row → payout

```
1. GET /admin/maturity-calendar          → pick enrollment
2. GET /admin/enrollments/:id/redemption-preview   → show settlement options
3. POST /admin/payouts                   → record maturity payout
```

Or use **`GET /admin/enrollments/redemption-ready`** when the screen is a “pay out now” queue rather than a date calendar.

---

## Comparison: calendar API vs report slug

| | `GET /admin/maturity-calendar` | `GET /admin/reports/maturity` |
| --- | --- | --- |
| Purpose | Admin panel UI | Reports / export |
| Response shape | Flat calendar entries (`enrollmentId`, `customer`, …) | Raw Mongo enrollment documents |
| Pagination | No — full range in one response | No |
| Filters | `status`, `schemeType` | Same date range only |
| Prefer for frontend | **Yes** | No |

---

## Changelog

| Date | Change |
| --- | --- |
| 2026-09 | Initial dedicated `GET /admin/maturity-calendar` endpoint |
