# Architecture Diagrams

## 1a. Warehouse + dbt architecture

```mermaid
graph TB
    subgraph sources["Data Sources"]
        APP_DB["App Database<br/>(Postgres)<br/><em>users, orgs, usage,<br/>chat_sessions, features</em>"]
        STRIPE_API["Stripe API<br/><em>customers, invoices,<br/>subscriptions, prices,<br/>products, payment_intents</em>"]
    end

    subgraph replication["Replication Layer"]
        CDC["CDC / ETL<br/><em>Fivetran, Airbyte, etc.</em><br/>scheduled sync (15min+)"]
    end

    subgraph warehouse["Data Warehouse (DuckDB / Snowflake / BQ)"]
        subgraph raw["Raw Layer — 11 tables"]
            R_APP["raw_app_organizations<br/>raw_app_users<br/>raw_app_api_usage<br/>raw_app_chat_sessions<br/>raw_app_features"]
            R_STRIPE["raw_stripe_customers<br/>raw_stripe_invoices<br/>raw_stripe_subscriptions<br/>raw_stripe_prices<br/>raw_stripe_products<br/>raw_stripe_payment_intents"]
        end

        subgraph staging["Staging Layer — 9 SQL models"]
            S1["stg_app_users.sql<br/><code>id → user_id</code><br/><code>created_at → user_created_at</code>"]
            S2["stg_app_organizations.sql<br/><code>id → organization_id</code><br/><code>created_at → org_created_at</code>"]
            S3["stg_stripe_customers.sql<br/><code>id → customer_id</code>"]
            S4["stg_stripe_invoices.sql<br/><code>id → invoice_id</code><br/><code>created_at → invoice_created_at</code>"]
            S5["stg_stripe_subscriptions.sql<br/>stg_stripe_prices.sql<br/>stg_stripe_products.sql<br/>stg_app_api_usage.sql<br/>stg_internal_users.sql"]
        end

        subgraph marts["Marts Layer — SQL joins + aggregation"]
            M1["dim_orgs.sql<br/><em>SELECT FROM stg_app_organizations</em>"]
            M2["fct_org_revenue.sql<br/><em>JOIN stg_app_users<br/>+ stg_stripe_invoices<br/>+ stg_stripe_customers</em>"]
        end

        DOCS["schema.yml<br/><em>column docs, descriptions</em>"]
    end

    subgraph agent_task["Agent writes metric"]
        METRIC["models/marts/metric_arpu.sql<br/><em>Must: discover join keys across files,<br/>handle column renames,<br/>CAST VARCHAR timestamps,<br/>write valid SQL</em>"]
    end

    APP_DB --> CDC
    STRIPE_API --> CDC
    CDC -->|"lagging copy<br/>no types"| raw
    R_APP --> staging
    R_STRIPE --> staging
    staging --> marts
    marts --> METRIC
    DOCS -.->|"optional<br/>context"| METRIC

    style replication fill:#fff3cd,stroke:#856404
    style agent_task fill:#d4edda,stroke:#155724
```

## 1b. App + Drizzle ORM architecture

```mermaid
graph TB
    subgraph sources["Data Sources"]
        APP_DB["App Database<br/>(Postgres)<br/><em>users, orgs, usage,<br/>chat_sessions, features</em>"]
        STRIPE_API["Stripe API<br/><em>customers, invoices,<br/>subscriptions, prices,<br/>products, payment_intents</em>"]
    end

    subgraph loader["Data Loader (db.ts)"]
        LOAD["loadData()<br/><em>JSON → SQLite INSERT<br/>metadata flattening<br/>bool → int conversion<br/>deduplication</em>"]
    end

    subgraph app["Unified App Context (SQLite + Drizzle)"]
        subgraph schema["schema.ts — all 11 tables, one file"]
            T_APP["organizations: { id: text, name: text, ... }<br/>users: { id: text, organizationId: text,<br/>  stripeCustomerId: text, email: text, ... }<br/>apiUsage: { id: text, userId: text, tokens: integer, ... }<br/>chatSessions: { ... }<br/>features: { ... }"]
            T_STRIPE["customers: { id: text, name: text, email: text, ... }<br/>invoices: { id: text, customerId: text,<br/>  amountPaid: integer, status: text, ... }<br/>subscriptions: { id: text, customerId: text,<br/>  priceId: text, status: text, ... }<br/>prices: { id: text, productId: text,<br/>  unitAmount: integer, ... }<br/>products: { ... }<br/>paymentIntents: { ... }"]
        end

        QUERIES["queries.ts<br/><em>existing examples:<br/>calculateTotalRevenue()</em>"]
        DB["db.ts<br/><em>SQLite connection<br/>+ Drizzle instance</em>"]
    end

    subgraph agent_task["Agent writes metric"]
        METRIC["Append to src/queries.ts<br/><pre>export async function calculateARPU() {<br/>  const result = await db.select({<br/>    arpu: avg(invoices.amountPaid)<br/>  }).from(invoices)<br/>  .innerJoin(users,<br/>    eq(users.stripeCustomerId,<br/>       invoices.customerId))<br/>  ...<br/>  return result<br/>}</pre><br/><em>Types checked. Join keys<br/>visible in same file as schema.</em>"]
    end

    APP_DB --> LOAD
    STRIPE_API --> LOAD
    LOAD -->|"direct load<br/>typed columns"| schema
    schema --> METRIC
    QUERIES -.->|"pattern<br/>examples"| METRIC
    DB -.->|"connection"| METRIC

    style loader fill:#fff3cd,stroke:#856404
    style agent_task fill:#d4edda,stroke:#155724
```

## 1c. Side-by-side: what the agent navigates

```mermaid
graph LR
    subgraph dbt["warehouse-dbt"]
        direction TB
        D_LIST["list_files<br/>→ 12+ SQL files"]
        D_READ["read 4-5 staging files<br/><em>one table per file<br/>column renames only<br/>no type information</em>"]
        D_GUESS["infer join keys<br/><em>stripe_customer_id in stg_app_users<br/>customer_id in stg_stripe_invoices<br/>found in different files</em>"]
        D_CAST["handle type casting<br/><em>VARCHAR → TIMESTAMP<br/>string → number</em>"]
        D_WRITE["write SQL file<br/><em>correct filename required<br/>correct directory required</em>"]
        D_LIST --> D_READ --> D_GUESS --> D_CAST --> D_WRITE
    end

    subgraph orm["app-drizzle"]
        direction TB
        O_LIST["list_files<br/>→ 3 files"]
        O_READ["read schema.ts<br/><em>all 11 tables<br/>typed columns<br/>in one file</em>"]
        O_JOIN["write join<br/><em>eq(users.stripeCustomerId,<br/>   invoices.customerId)<br/>types guide you</em>"]
        O_WRITE["append function<br/><em>to existing queries.ts</em>"]
        O_LIST --> O_READ --> O_JOIN --> O_WRITE
    end

    style dbt fill:#fff5f5,stroke:#c53030
    style orm fill:#f0fff4,stroke:#276749
```

## 2. Side-by-side data flow (high level)

```mermaid
graph TB
    subgraph sources["Source Data"]
        APP_DB["App DB<br/><em>users, orgs, usage</em>"]
        STRIPE["Stripe API<br/><em>customers, invoices,<br/>subscriptions</em>"]
    end

    subgraph dbt["Warehouse + dbt"]
        direction TB
        RAW["Raw Tables<br/><code>raw_app_users</code><br/><code>raw_stripe_invoices</code><br/><code>raw_stripe_customers</code><br/>...11 tables"]
        STG["Staging Views<br/><code>stg_app_users</code><br/><code>stg_stripe_invoices</code><br/>Column renames, casts"]
        MARTS["Mart Models<br/><code>fct_org_revenue</code><br/><code>dim_orgs</code><br/>Joins + aggregation"]
        METRIC_SQL["Metric SQL<br/><em>agent writes this</em>"]
        RAW --> STG --> MARTS --> METRIC_SQL
    end

    subgraph orm["App + Drizzle ORM"]
        direction TB
        SQLITE["SQLite DB<br/>All tables in one schema<br/><em>typed via Drizzle</em>"]
        QUERY["Query Function<br/><code>async function calculateARPU()</code><br/><em>agent writes this</em>"]
        SQLITE --> QUERY
    end

    subgraph typed["App + TypeScript"]
        direction TB
        ARRAYS["Typed Arrays<br/><code>User[]</code>, <code>StripeInvoice[]</code><br/><em>no database</em>"]
        FN["Pure Function<br/><code>function calculateARPU(<br/>  users, invoices<br/>): number</code><br/><em>agent writes this</em>"]
        ARRAYS --> FN
    end

    APP_DB --> RAW
    STRIPE --> RAW
    APP_DB --> SQLITE
    STRIPE --> SQLITE
    APP_DB --> ARRAYS
    STRIPE --> ARRAYS
```

## 3. What the agent actually sees (context comparison)

```mermaid
graph LR
    subgraph dbt_ctx["warehouse-dbt: Agent Context"]
        direction TB
        D1["<code>models/staging/stg_app_users.sql</code>"]
        D2["<code>models/staging/stg_app_organizations.sql</code>"]
        D3["<code>models/staging/stg_stripe_customers.sql</code>"]
        D4["<code>models/staging/stg_stripe_invoices.sql</code>"]
        D5["<code>models/staging/stg_stripe_subscriptions.sql</code>"]
        D6["<code>models/staging/stg_stripe_prices.sql</code>"]
        D7["<code>models/staging/stg_stripe_products.sql</code>"]
        D8["<code>models/staging/stg_app_api_usage.sql</code>"]
        D9["<code>models/staging/stg_internal_users.sql</code>"]
        D10["<code>models/marts/dim_orgs.sql</code>"]
        D11["<code>models/marts/fct_org_revenue.sql</code>"]
        D12["<code>models/schema.yml</code>"]
    end

    subgraph orm_ctx["app-drizzle: Agent Context"]
        direction TB
        O1["<code>src/schema.ts</code>  ← types + tables"]
        O2["<code>src/db.ts</code>      ← loader"]
        O3["<code>src/queries.ts</code> ← examples"]
    end

    subgraph ts_ctx["app-typed: Agent Context"]
        direction TB
        T1["<code>src/types/internal.ts</code>  ← app types"]
        T2["<code>src/types/stripe.ts</code>    ← stripe types"]
        T3["<code>src/db/schema.ts</code>       ← foreign keys"]
        T4["<code>src/analytics/derived.ts</code> ← helpers"]
        T5["<code>src/analytics/queries.ts</code> ← examples"]
    end
```

## 4. The indirection problem (dbt detail)

```mermaid
graph TD
    AGENT["LLM Agent<br/><em>wants: ARPU for active users</em>"]

    subgraph discover["Step 1: Discover Schema"]
        LS["list_files → 12+ SQL files"]
        READ1["read stg_app_users.sql"]
        READ2["read stg_stripe_invoices.sql"]
        READ3["read stg_stripe_customers.sql"]
        READ4["read fct_org_revenue.sql"]
        READ5["read schema.yml"]
    end

    subgraph translate["Step 2: Translate Names"]
        COL1["<code>id</code> → <code>user_id</code>"]
        COL2["<code>created_at</code> → <code>user_created_at</code>"]
        COL3["<code>id</code> → <code>invoice_id</code>"]
        COL4["VARCHAR timestamps<br/>need CAST()"]
    end

    subgraph write["Step 3: Write SQL"]
        SQL["<code>SELECT ... FROM raw_stripe_invoices<br/>JOIN raw_app_users<br/>  ON ???<br/>WHERE status = 'paid'<br/>  AND created_at > ???</code>"]
    end

    subgraph fail["Common Failures"]
        F1["Wrong column name<br/><code>org_id</code> vs <code>organization_id</code>"]
        F2["Type error<br/>interval math on VARCHAR"]
        F3["Wrong join key<br/>missing the stripe_customer_id hop"]
        F4["Wrong filename<br/>metric not found by validator"]
    end

    AGENT --> discover
    discover --> translate
    translate --> write
    write --> fail

    style fail fill:#fee,stroke:#c00
```

## 5. The same task in each architecture

```mermaid
graph TD
    TASK["Task: Calculate ARPU<br/><em>revenue per active user</em>"]

    subgraph dbt_path["warehouse-dbt"]
        direction TB
        D_READ["Read 4-5 staging SQL files<br/>to learn column names"]
        D_MAP["Map: users.stripe_customer_id<br/>→ invoices.customer_id<br/>(discovered from stg_ files)"]
        D_CAST["Handle: CAST(created_at AS TIMESTAMP)<br/>for date filtering"]
        D_WRITE["Write SQL to models/marts/metric_arpu.sql"]
        D_READ --> D_MAP --> D_CAST --> D_WRITE
    end

    subgraph orm_path["app-drizzle"]
        direction TB
        O_READ["Read schema.ts<br/>all tables + types in one file"]
        O_JOIN["Join: eq(users.stripeCustomerId,<br/>invoices.customerId)"]
        O_WRITE["Append function to queries.ts"]
        O_READ --> O_JOIN --> O_WRITE
    end

    subgraph ts_path["app-typed"]
        direction TB
        T_READ["Read types/stripe.ts + types/internal.ts<br/>+ schema.ts foreignKeys"]
        T_FILTER["Filter + reduce on typed arrays<br/>users.filter(...).map(...)"]
        T_WRITE["Append function to queries.ts"]
        T_READ --> T_FILTER --> T_WRITE
    end

    TASK --> dbt_path
    TASK --> orm_path
    TASK --> ts_path
```

## 6. Information density per file read

```mermaid
graph LR
    subgraph dbt_read["warehouse-dbt: stg_app_users.sql"]
        D_INFO["<pre>SELECT<br/>  id AS user_id,<br/>  organization_id,<br/>  stripe_customer_id,<br/>  email,<br/>  role,<br/>  created_at AS user_created_at,<br/>  last_login_at<br/>FROM raw_app_users</pre><br/><em>One table. Column renames only.<br/>No types. No relationships.</em>"]
    end

    subgraph orm_read["app-drizzle: schema.ts"]
        O_INFO["<pre>export const users = sqliteTable('users', {<br/>  id: text('id').primaryKey(),<br/>  organizationId: text('organization_id'),<br/>  stripeCustomerId: text('stripe_customer_id'),<br/>  email: text('email'),<br/>  role: text('role'),<br/>  ...<br/>})<br/>export const invoices = sqliteTable('invoices', {<br/>  id: text('id').primaryKey(),<br/>  customerId: text('customer_id'),<br/>  amountPaid: integer('amount_paid'),<br/>  ...<br/>})<br/>// ... all 11 tables</pre><br/><em>All tables. Typed columns.<br/>Relationships implied by naming.</em>"]
    end
```

## 7. Layer count (simple)

```
warehouse-dbt          app-drizzle         app-typed
─────────────          ───────────         ─────────

  JSON files             JSON files          JSON files
      │                      │                   │
      ▼                      ▼                   ▼
  Raw Tables             SQLite DB           Typed Arrays
      │                      │                   │
      ▼                      │                   │
  Staging Views              │                   │
  (column renames,           │                   │
   type casts)               │                   │
      │                      │                   │
      ▼                      │                   │
  Mart Models                │                   │
  (joins, aggs)              │                   │
      │                      │                   │
      ▼                      ▼                   ▼
  ┌────────┐           ┌────────┐           ┌────────┐
  │ Metric │           │ Metric │           │ Metric │
  │  SQL   │           │Function│           │Function│
  └────────┘           └────────┘           └────────┘

  5 layers               2 layers            2 layers
  12+ files              3 files             5 files
  0 type info            full types          full types
```

## 8. The join key discovery problem

```
ARPU requires: revenue per active user
           ┌─────────────────────────────────────────────┐
           │  The join path is the same in all three:     │
           │                                              │
           │  users.stripe_customer_id                    │
           │       ↓                                      │
           │  invoices.customer_id                        │
           │       ↓                                      │
           │  SUM(amount_paid) WHERE status = 'paid'      │
           └─────────────────────────────────────────────┘

warehouse-dbt: agent must read stg_app_users.sql to find
               stripe_customer_id exists, then read
               stg_stripe_invoices.sql to find customer_id,
               then figure out the join. These are in
               separate files with renamed columns.

app-drizzle:   agent reads schema.ts, sees both tables
               with stripeCustomerId and customerId
               in the same file. One read.

app-typed:     agent reads types + schema.ts foreignKeys:
               { users: { stripe_customer_id: 'customers.id' } }
               Relationship is explicitly documented.
```
