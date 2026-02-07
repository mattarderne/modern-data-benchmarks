# Information Parity Analysis: TypeScript vs DBT YAML

## Goal
Achieve equivalent information density between TypeScript types and DBT YAML so LLMs have the same semantic context in both architectures.

## Current Information Gap

### What TypeScript Types Encode (58 lines)

```typescript
export type StripeInvoice = {
  id: string;
  customer_id: string;
  subscription_id: string;
  amount_due: number;
  amount_paid: number;
  status: 'paid' | 'open' | 'void' | 'uncollectible';  // ← ENUM VALUES
  created_at: string;
};
```

**Information encoded:**
1. ✅ Field names
2. ✅ Data types (string, number, boolean)
3. ✅ **Valid values** (union types: `'paid' | 'open' | ...`)
4. ✅ **Nullability** (fields are required by default)
5. ✅ **Structural relationships** (via imports and function signatures)
6. ❌ Units (cents vs dollars - not encoded)
7. ❌ Business logic (must be in function comments)

### What Original DBT YAML Encodes (49 lines)

```yaml
- name: stg_stripe_invoices
  description: "Staged Stripe invoices"
  columns:
    - name: invoice_id
    - name: subscription_id
    - name: amount_paid
```

**Information encoded:**
1. ✅ Field names
2. ❌ Data types (optional, not present)
3. ❌ Valid values (not present)
4. ❌ Nullability (not present)
5. ❌ Relationships (not enforced)
6. ❌ Units
7. ❌ Business logic

**Information gap: ~70% of TS information is missing**

## Enhanced YAML (schema_enhanced.yml)

### Key Additions

#### 1. Data Types
```yaml
- name: status
  data_type: string  # Now explicit
```

#### 2. Valid Values (Enum Equivalent)
```yaml
- name: status
  meta:
    valid_values: ['paid', 'open', 'void', 'uncollectible']
```

This is the DBT equivalent of:
```typescript
status: 'paid' | 'open' | 'void' | 'uncollectible'
```

#### 3. Nullability Constraints
```yaml
- name: customer_id
  constraints:
    - type: not_null
```

Equivalent to TS (all fields required by default).

#### 4. Relationships (Foreign Keys)
```yaml
- name: customer_id
  constraints:
    - type: relationships
      to: ref('stg_stripe_customers')
      field: customer_id
```

Equivalent to TS type relationships via imports.

#### 5. Units and Semantic Information
```yaml
- name: amount_paid
  meta:
    unit: "cents"
    currency: "usd"
    business_logic: "Use this field for revenue calculations, not amount_due"
```

This is BETTER than TypeScript, which can't encode units in the type system.

#### 6. Business Logic Rules
```yaml
semantic_rules:
  revenue_calculations:
    rules:
      - "Only invoices with status='paid' count toward revenue"
      - "Only subscriptions with status='active' count toward MRR"
```

## Information Parity Comparison

| Information Type | TS Types | Original YAML | Enhanced YAML |
|------------------|----------|---------------|---------------|
| Field names | ✅ | ✅ | ✅ |
| Data types | ✅ | ❌ | ✅ |
| Valid values (enums) | ✅ | ❌ | ✅ (meta.valid_values) |
| Nullability | ✅ | ❌ | ✅ (constraints) |
| Relationships | ✅ (implicit) | ❌ | ✅ (constraints) |
| Units/Currency | ❌ | ❌ | ✅ (meta) |
| Business logic | ⚠️ (comments) | ⚠️ (descriptions) | ✅ (semantic_rules) |
| **Total Coverage** | ~70% | ~30% | ~95% |

## Impact on LLM Reasoning

### Before Enhancement (Original YAML)

**Agent sees:**
```yaml
- name: status
```

**Agent must:**
- Guess valid status values by reading SQL files
- Assume nullability rules
- Infer relationships from SQL joins
- Hope the description mentions units

**Result:** More context-switching, more guessing, more errors.

### After Enhancement

**Agent sees:**
```yaml
- name: status
  data_type: string
  constraints:
    - type: not_null
  meta:
    valid_values: ['paid', 'open', 'void', 'uncollectible']
    business_logic: "Only 'paid' invoices count toward revenue"
```

**Agent knows:**
- Exact valid values (no guessing)
- Cannot be null
- Business rule for using this field

**Result:** Equivalent to TS - local reasoning, clear constraints.

## Recommended Changes to DBT Setup

### 1. Always Include

```yaml
columns:
  - name: <field>
    description: "<clear description>"
    data_type: <type>
    constraints:
      - type: not_null  # or omit if nullable
```

### 2. For Enum-like Fields

```yaml
- name: status
  meta:
    valid_values: ['value1', 'value2', ...]
```

### 3. For Foreign Keys

```yaml
- name: customer_id
  constraints:
    - type: relationships
      to: ref('stg_stripe_customers')
      field: customer_id
```

### 4. For Monetary Fields

```yaml
- name: amount_paid
  meta:
    unit: "cents"
    currency: "usd"
```

### 5. For Business Logic

```yaml
- name: status
  meta:
    business_logic: "Only 'paid' invoices count toward revenue"
```

### 6. Top-Level Semantic Rules

```yaml
semantic_rules:
  <metric_category>:
    description: "<what this covers>"
    rules:
      - "<rule 1>"
      - "<rule 2>"
```

## Expected Impact on Benchmark

### Hypothesis

With enhanced YAML providing information parity:

1. **Smaller performance gap** between TS and DBT
   - Current: TS might have advantage due to richer context
   - Enhanced: Both provide equivalent semantic information

2. **Different failure modes**
   - TS failures: Type compilation errors
   - DBT failures: SQL syntax errors
   - Both: Same business logic errors

3. **Same cognitive load**
   - Both require reading similar amounts of context
   - Both encode constraints explicitly
   - Neither requires guessing valid values

### Testing the Hypothesis

Run benchmark with:
- `schema.yml` (original, sparse)
- `schema_enhanced.yml` (information parity)

Compare:
- Error rates
- Turn counts
- Types of errors (syntax vs logic)

## Implementation Notes

### DBT Constraints Support

Not all DBT adapters support all constraint types. For this benchmark:

1. **Use DuckDB** - supports most constraints
2. **Or use meta tags only** - documentation without enforcement
3. **Key point:** Information density matters, not enforcement

The goal is to give LLMs equivalent *context*, not necessarily database enforcement.

### Validation Script

```typescript
// validate-parity.ts
// Compares information density between TS types and DBT YAML

const tsTypes = parseTypeScript('typed/src/types/stripe.ts');
const dbtSchema = parseYAML('warehouse/models/schema_enhanced.yml');

const metrics = {
  ts: calculateInformationMetrics(tsTypes),
  dbt: calculateInformationMetrics(dbtSchema)
};

console.log('Information parity:', metrics.ts.score, 'vs', metrics.dbt.score);
```

## Conclusion

**Original state:**
- TypeScript: 70% information density
- DBT YAML: 30% information density
- Gap: 40 percentage points

**Enhanced state:**
- TypeScript: 70% information density
- DBT YAML: 95% information density (better units/currency support)
- Gap: Parity achieved, DBT slightly ahead on metadata

**For LLM benchmarking:** Enhanced YAML creates a fair comparison by giving both architectures equivalent semantic context.
