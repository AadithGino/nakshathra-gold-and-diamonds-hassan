# Nakshathra Jewellers — Flutter App Flows

Visual flow guide for the **Customer** and **Staff** Flutter apps. Pair this with [FLUTTER_API_HANDOFF.md](./FLUTTER_API_HANDOFF.md) for endpoint details and JSON examples.

**Live product:** CASH schemes only (11 contribution months, redemption in month 12).  
**Auth:** cookie-based (`access_token` + `refresh_token`). No self-signup.

---

## 1. Who does what

```mermaid
flowchart LR
  subgraph Admin["Owner / Admin (web — not Flutter)"]
    A1[Create staff accounts]
    A2[Verify / reject KYC]
    A3[Payouts & premature close]
    A4[Approve corrections]
    A5[Record cash handover]
  end

  subgraph Staff["Staff Flutter app"]
    S1[Create customer]
    S2[Upload Aadhaar]
    S3[Enroll on scheme plan]
    S4[Collect payments at counter]
    S5[Request payment corrections]
  end

  subgraph Customer["Customer Flutter app"]
    C1[View scheme & schedule]
    C2[Pay via PhonePe SDK]
    C3[View receipts & payouts]
  end

  S1 --> S2
  S2 --> A2
  A2 --> S3
  S3 --> C1
  C1 --> C2
  S4 --> C3
  S5 --> A4
  S3 --> S4
  S4 --> A5
  A3 --> C3
```

| Action | Customer app | Staff app | Admin web |
|---|---|---|---|
| Login | Yes | Yes | Yes |
| Self-register | **No** | **No** | — |
| Create customer | No | Yes (permission) | Yes |
| Upload Aadhaar | No | Yes (permission) | Yes |
| KYC verify | No | No | Yes |
| Enroll on scheme | No | Yes (permission) | Yes |
| Pay (PhonePe) | Yes (own scheme) | Yes (for customer) | — |
| Pay (cash/UPI at counter) | No | Yes (permission) | Yes |
| View own receipts | Yes | Own collections only | All |
| Request correction | No | Yes (own payments) | — |
| Approve correction | No | No | Yes |
| Maturity / payout | View only | No | Yes |

---

## 2. Shared session flow (both apps)

Use the **same Dio + cookie jar pattern** in both apps. Only the post-login route differs by `role`.

```mermaid
flowchart TD
  Start([App launch]) --> Jar{Persisted cookies?}
  Jar -->|yes| Me[GET /auth/me]
  Jar -->|no| LoginScreen[Login screen]
  Me -->|200| Role{user.role}
  Me -->|401| Refresh[POST /auth/refresh]
  Refresh -->|200| Role
  Refresh -->|401 / TOKEN_REUSE| Clear[Clear cookie jar]
  Clear --> LoginScreen
  Refresh -->|409 REFRESH_RACE| Wait[Wait ~300ms, retry once]
  Wait --> Refresh

  LoginScreen --> Login[POST /auth/login]
  Login -->|200| Role
  Login -->|401 INVALID_CREDENTIALS| LoginScreen
  Login -->|429 ACCOUNT_LOCKED| LoginScreen
  Login -->|403 ACCOUNT_INACTIVE| Blocked[Show contact shop]

  Role -->|CUSTOMER| CustHome[Customer home]
  Role -->|STAFF| StaffHome[Staff dashboard]
  Role -->|ADMIN| WrongApp[Wrong app — show error]

  CustHome --> API[Authenticated API calls]
  StaffHome --> API
  API -->|401 SESSION_EXPIRED| Refresh
  Logout[User taps logout] --> LogoutAPI[POST /auth/logout]
  LogoutAPI --> ClearJar[Delete cookie jar]
  ClearJar --> LoginScreen
```

**Rules for Flutter:**

- One shared `Dio` instance per app.
- Single-flight refresh (never two parallel `/auth/refresh` calls).
- On `TOKEN_REUSE_DETECTED`, wipe cookies and force login.
- Route by `role` immediately after login — do not show customer UI to staff or vice versa.

---

## 3. Customer app — screen map

```mermaid
flowchart TD
  subgraph Auth
    CL[Login]
  end

  subgraph Main
    CH[Home]
    CP[Profile]
    CS[Schemes list]
    CD[Scheme detail]
    PH[Payment history]
    PR[Receipt]
    PO[Payouts]
    NT[Notifications]
  end

  subgraph Pay
    PV[Payment preview]
    PO2[PhonePe SDK checkout]
    PI[Poll payment status]
  end

  CL --> CH
  CH --> CP
  CH --> CS
  CH --> PH
  CH --> NT
  CS --> CD
  CD --> PV
  PV --> PO2
  PO2 --> PI
  PI -->|SUCCESS| PR
  PH --> PR
  CH --> PO
```

**Screens the customer app needs:**

| Screen | Primary API |
|---|---|
| Login | `POST /auth/login` |
| Home | `GET /customer/home` |
| Profile | `GET /customer/profile` |
| Schemes | `GET /customer/schemes` |
| Scheme detail | `GET /customer/schemes/:id` |
| Pay (amount entry) | `GET /customer/schemes/:id/payment-preview` |
| PhonePe checkout | `POST /customer/payments/phonepe/create-order` + SDK |
| Payment status | `GET /customer/payment-intents/:merchantOrderId` |
| Receipt | `GET /customer/payments/:id/receipt` |
| Payment history | `GET /customer/payments` |
| Payouts | `GET /customer/payouts` |
| Notifications | `GET /customer/notifications` |

**Do not build:** signup, gold rates, web PhonePe checkout (native uses SDK only).

---

## 4. Customer app — end-to-end journey

```mermaid
flowchart TD
  A([Customer opens app]) --> B{Already logged in?}
  B -->|no| C[Login screen]
  C --> D[POST /auth/login]
  D --> E{role == CUSTOMER?}
  E -->|no| F[Error: use staff app / contact shop]
  E -->|yes| G[GET /customer/home]
  B -->|yes| G

  G --> H{activeScheme?}
  H -->|no| I[Show: no active scheme — contact shop]
  H -->|yes| J[Dashboard: schedule, caps, recent payments]

  J --> K{User action}
  K -->|View scheme| L[GET /customer/schemes/:id]
  K -->|Pay| M[Enter amount]
  K -->|History| N[GET /customer/payments]
  K -->|Payouts| O[GET /customer/payouts]
  K -->|Notifications| P[GET /customer/notifications]
  K -->|Profile| Q[GET /customer/profile]

  L --> M
  M --> R["GET payment-preview?amountPaise="]
  R --> S{paymentAllowed?}
  S -->|no| T[Show reasonMessage — stay on screen]
  S -->|yes| U[POST /payments/phonepe/create-order]
  U --> V[Launch PhonePe SDK with token + orderId]
  V --> W{SDK result}
  W -->|cancelled| T
  W -->|completed / unknown| X[Poll GET /payment-intents/:merchantOrderId]
  X --> Y{status}
  Y -->|PENDING / INITIATED| X
  Y -->|SUCCESS| Z[GET /payments/:id/receipt — show success]
  Y -->|FAILED / EXPIRED / CANCELLED| AA[Show failure — new idempotencyKey to retry]
  Z --> J
```

**Customer cannot:**

- Create their own account
- Enroll themselves
- Pay with cash in the app (counter only)
- Close a scheme or request payout (owner/admin only)

---

## 5. Customer payment flow (detailed)

```mermaid
sequenceDiagram
  participant App as Customer Flutter app
  participant API as Nakshathra API
  participant PP as PhonePe SDK

  App->>API: GET /customer/schemes/:id/payment-preview?amountPaise=100000
  API-->>App: paymentAllowed, caps, schemeMonth, quoteExpiresAt

  alt paymentAllowed == false
    App->>App: Show reasonMessage, block Pay button
  else paymentAllowed == true
    App->>API: POST /customer/payments/phonepe/create-order
    Note over App,API: idempotencyKey = UUID per user tap
    API-->>App: merchantOrderId, orderId, token

    App->>PP: Open checkout (token, orderId)
    PP-->>App: User completes or cancels

    loop Every 2–3s until terminal status
      App->>API: GET /customer/payment-intents/{merchantOrderId}
      API-->>App: status PENDING / SUCCESS / FAILED / ...
    end

    alt status == SUCCESS
      App->>API: GET /customer/payments/{payment._id}/receipt
      API-->>App: receiptNumber, payment details
      App->>App: Show receipt screen
    else status failed / expired
      App->>App: Show error, allow retry with new idempotencyKey
    end
  end
```

**Idempotency:** reuse the same `idempotencyKey` only when retrying the **same** payment attempt after a network error. If the user changes the amount or starts a new attempt, generate a new UUID.

**Polling stop conditions:** `SUCCESS`, `FAILED`, `EXPIRED`, `CANCELLED`, `REFUNDED`, `REVERSED`, `REVIEW_REQUIRED`.

---

## 6. Customer lifecycle (what the customer sees)

```mermaid
flowchart LR
  subgraph OffApp["Happens at shop / admin — not in customer app"]
    O1[Staff creates account]
    O2[Staff uploads Aadhaar]
    O3[Admin verifies KYC]
    O4[Staff enrolls on plan]
  end

  subgraph InApp["Customer app"]
    I1[Login]
    I2[View scheme & schedule]
    I3[Pay monthly via PhonePe]
    I4[View receipts]
    I5[View payout when matured]
  end

  O1 --> O2 --> O3 --> O4 --> I1
  I1 --> I2
  I2 --> I3
  I3 --> I4
  I3 --> I2
  I2 --> I5
```

**Scheme months (CASH):**

```mermaid
flowchart LR
  M1["Months 1–6<br/>Flexible"] --> M2["Months 7–11<br/>Capped"]
  M2 --> M3["Month 12<br/>Redemption"]
  M3 --> M4["Payout / jewellery<br/>(admin — customer views in payouts)"]
```

During months 1–11 the customer app shows **Pay** when `paymentWindowOpen` and preview `paymentAllowed` are true. Month 12 is redemption — no contribution; customer may see payout in `GET /customer/payouts` after admin processes it.

---

## 7. Staff app — permission gating

Staff UI must hide actions the user cannot perform. The server returns `403 PERMISSION_DENIED` if they try anyway.

```mermaid
flowchart TD
  Login[POST /auth/login] --> Dash[GET /staff/dashboard]
  Dash --> Perm{Check permissions[]}

  Perm -->|canViewCustomers| V1[Search / view customers]
  Perm -->|canCreateCustomer| V2[Create customer + upload Aadhaar]
  Perm -->|canEnrollScheme| V3[Enroll customer on plan]
  Perm -->|canCollectPayment| V4[Preview + collect payment]
  Perm -->|canSubmitCorrectionRequest| V5[Request correction on own payment]

  Dash --> Always[Always available]
  Always --> A1[Profile]
  Always --> A2[Own payments & receipts]
  Always --> A3[Cash held]
  Always --> A4[Cash submission history]
  Always --> A5[Collection report]
  Always --> A6[Scheme plans list]
```

| Permission | UI to show |
|---|---|
| `canViewCustomers` | Customer search, customer detail, enrollment detail |
| `canCreateCustomer` | New customer form, Aadhaar camera/upload |
| `canEnrollScheme` | Enroll button + plan picker |
| `canCollectPayment` | Collect payment, PhonePe for customer |
| `canSubmitCorrectionRequest` | Correction form on own receipts |

---

## 8. Staff app — screen map

```mermaid
flowchart TD
  subgraph Auth
    SL[Login]
  end

  subgraph Main
    SD[Dashboard]
    SP[Profile]
    SR[Collection report]
    SPL[Scheme plans]
  end

  subgraph Customers
    SC[Search customers]
    SD2[Customer detail]
    SE[Enrollment detail]
    NC[New customer]
  end

  subgraph Collect
    PV2[Payment preview]
    MC[Manual collect]
    PP2[PhonePe SDK for customer]
    PI2[Poll intent]
    RC[Receipt]
  end

  subgraph Ops
    CH2[Cash held]
    CS2[Cash submissions history]
    CR[Corrections list]
    COR[Request correction]
  end

  SL --> SD
  SD --> SP
  SD --> SR
  SD --> SC
  SD --> CH2
  SD --> CS2
  SC --> SD2
  SD2 --> SE
  SD2 --> PV2
  NC --> SC
  SPL --> NC
  PV2 --> MC
  PV2 --> PP2
  MC --> RC
  PP2 --> PI2
  PI2 --> RC
  RC --> COR
  COR --> CR
```

---

## 9. Staff app — onboarding a new customer

Requires: `canCreateCustomer`, optionally `canEnrollScheme`, and admin KYC before payments.

```mermaid
flowchart TD
  A([Staff: new customer]) --> B{canCreateCustomer?}
  B -->|no| X[Hide — 403 if forced]
  B -->|yes| C[Capture name, phone, password, address, nominee]

  C --> D[Upload Aadhaar front]
  D --> E[POST /uploads/presign or POST /uploads]
  E --> F[Upload Aadhaar back]
  F --> G{Enroll now?}

  G -->|yes + canEnrollScheme| H[Pick plan + installment + startDate]
  G -->|no| I[POST /staff/customers without enrollment]
  H --> J[POST /staff/customers with enrollment block]

  I --> K[Customer created — KYC PENDING]
  J --> K

  K --> L[Admin verifies KYC on web]
  L -->|VERIFIED| M[Customer can pay / staff can collect]
  L -->|REJECTED| N[Staff re-uploads Aadhaar]

  M --> O{Enrolled at create?}
  O -->|no + canEnrollScheme| P[POST /staff/enrollments]
  O -->|yes| Q[Ready for collections]
  P --> Q
```

**API sequence (create + enroll at counter):**

1. `POST /uploads/presign` → PUT file to S3 URL (×2 for front/back)
2. `POST /staff/customers` (with `aadhaar` keys + optional `enrollment`)
3. Wait for admin `KYC VERIFIED` (customer/staff cannot skip if `KYC_REQUIRED=true`)
4. If not enrolled at step 2: `GET /staff/scheme-plans` → `POST /staff/enrollments`

---

## 10. Staff app — collection at counter (main daily flow)

```mermaid
flowchart TD
  A([Staff opens app]) --> B[GET /staff/dashboard]
  B --> C[Search customer]
  C --> D["GET /staff/customers?search="]
  D --> E[Select customer]
  E --> F[GET /staff/customers/:id]
  F --> G[GET /staff/customers/:id/enrollment]

  G --> H{Active enrollment?}
  H -->|404| I[Show: not enrolled — enroll if permitted]
  H -->|200| J[Show scheme summary + contribution rules]

  J --> K[Staff enters amount]
  K --> L["GET /staff/schemes/:id/payment-preview?amountPaise="]
  L --> M{allowed?}
  M -->|no| N[Show reasonMessage]
  M -->|yes| O{Payment method}

  O -->|CASH / UPI / BANK / CARD| P[POST /staff/payments]
  O -->|PhonePe| Q[POST /staff/payments/phonepe/create-order]
  Q --> R[PhonePe SDK on staff device or customer device]
  R --> S[Poll GET /staff/payment-intents/:merchantOrderId]

  P --> T[201 — receiptNumber]
  S --> U{status}
  U -->|SUCCESS| T
  U -->|PENDING| S
  U -->|FAILED| N

  T --> V[GET /staff/payments/:id/receipt]
  V --> W[Print / show receipt]
  W --> X{method == CASH?}
  X -->|yes| Y[GET /staff/cash-held — balance increased]
  X -->|no| Z[Done]
  Y --> Z
```

**Cash held:** every successful **CASH** collection increases `cashHeldPaise`. Owner records handover on admin web (`POST /admin/cash-submissions`). Staff sees history via `GET /staff/cash-submissions`.

---

## 11. Staff collection flow (sequence)

```mermaid
sequenceDiagram
  participant Staff as Staff Flutter app
  participant API as Nakshathra API
  participant PP as PhonePe SDK

  Staff->>API: GET /staff/customers?search=9876
  API-->>Staff: customer list

  Staff->>API: GET /staff/customers/:id/enrollment
  API-->>Staff: enrollment, schedule, payments

  Staff->>API: GET /staff/schemes/:id/payment-preview?amountPaise=100000
  API-->>Staff: allowed, schemeMonth, caps

  alt Manual collect (CASH / UPI / BANK / CARD)
    Staff->>API: POST /staff/payments
    Note over Staff,API: customerId, schemeId, method, idempotencyKey
    API-->>Staff: paymentId, receiptNumber, schemeMonth
    Staff->>API: GET /staff/payments/:id/receipt
    Staff->>API: GET /staff/cash-held (if CASH)
  else PhonePe SDK
    Staff->>API: POST /staff/payments/phonepe/create-order
    Note over Staff,API: includes customerId
    API-->>Staff: merchantOrderId, orderId, token
    Staff->>PP: SDK checkout
    loop Poll
      Staff->>API: GET /staff/payment-intents/{merchantOrderId}
    end
    Staff->>API: GET /staff/payments/:id/receipt
  end
```

---

## 12. Staff correction flow

Staff can only correct **their own** successful collections. Admin approves or rejects on web.

```mermaid
flowchart TD
  A[Staff views own payment] --> B{canSubmitCorrectionRequest?}
  B -->|no| C[Hide correction action]
  B -->|yes| D[Open correction form]
  D --> E[Pick type: CHANGE_AMOUNT / CHANGE_METHOD / CHANGE_REFERENCE / CHANGE_NOTES / REVERSE_PAYMENT]
  E --> F[POST /staff/payments/:id/corrections]
  F --> G[Status PENDING]
  G --> H[GET /staff/corrections — track status]
  H --> I{Admin decision}
  I -->|APPROVED| J[Payment updated / reversed per type]
  I -->|REJECTED| K[Show reviewNotes to staff]

  L[CHANGE_DATE] -.->|not allowed| M[422 CORRECTION_TYPE_DISABLED]
```

**Correction types staff may request:**

| Type | Use when |
|---|---|
| `CHANGE_AMOUNT` | Wrong amount recorded |
| `CHANGE_METHOD` | Wrong method (e.g. recorded CASH but was UPI) |
| `CHANGE_REFERENCE` | Wrong reference number |
| `CHANGE_NOTES` | Notes fix only |
| `REVERSE_PAYMENT` | Void the collection entirely |

Staff **cannot** approve their own correction. Poll `GET /staff/corrections` or refresh payment detail after admin acts.

---

## 13. Staff reporting & cash handover

```mermaid
flowchart LR
  subgraph Daily
    D1[GET /staff/dashboard<br/>today totals]
    D2[GET /staff/reports/collection?from=&to=<br/>period breakdown]
  end

  subgraph Cash
    C1[POST /staff/payments method=CASH]
    C2[cashHeldPaise increases]
    C3[Owner: POST /admin/cash-submissions]
    C4[GET /staff/cash-submissions<br/>handover history]
    C2 --> C3 --> C4
  end

  D1 --> D2
  C1 --> C2
```

---

## 14. Error paths both apps should handle

```mermaid
flowchart TD
  API[Any API call] --> E{HTTP / error.code}

  E -->|401 SESSION_EXPIRED| R[Refresh session]
  E -->|403 PERMISSION_DENIED| P[Hide action / show message]
  E -->|409 KYC_VERIFICATION_REQUIRED| K[Staff: wait for admin KYC]
  E -->|409 SCHEME_NOT_ACTIVE| S[Cannot pay this scheme]
  E -->|409 IDEMPOTENCY_KEY_REUSED| I[New key if user changed amount]
  E -->|503 CUSTOMER_PAYMENTS_DISABLED| D[Customer PhonePe off — retry later]
  E -->|422 VALIDATION_ERROR| V[Show field errors from details[]]
  E -->|429 ACCOUNT_LOCKED| L[Login locked — wait]
```

---

## 15. Quick reference — happy paths

### Customer happy path

```
Login → Home → Scheme detail → Enter amount → Preview → Create SDK order → PhonePe → Poll → Receipt
```

### Staff happy path (new customer + first payment)

```
Login → Create customer (+ Aadhaar) → [Admin KYC] → Enroll → Search customer → Preview → Collect (cash or PhonePe) → Receipt
```

### Staff happy path (returning customer)

```
Login → Dashboard → Search → Enrollment → Preview → Collect → Receipt → (optional) Correction request
```

---

## Related docs

- [FLUTTER_API_HANDOFF.md](./FLUTTER_API_HANDOFF.md) — auth setup, all endpoints, Appendix A JSON examples
- OpenAPI (runtime): `GET /api/v1/openapi.json`
