import type { SandboxConfig, Task, ValidationResult } from '../types';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const config: SandboxConfig = {
  id: 'cube',
  name: 'Drizzle Cube (Semantic Layer)',

  contextFiles: [
    'src/schema.ts',
    'src/cubes.ts',
  ],

  targetFile: 'src/cubes.ts',

  systemPrompt: `You are modifying a Drizzle Cube semantic layer.

Available tools:
<tool>read_file</tool><path>relative/path</path>
<tool>write_file</tool><path>relative/path</path><content>...</content>
<tool>list_files</tool><path>optional/dir</path>
<tool>done</tool>

CONSTRAINT: You are defining measures in a semantic layer.
Measures are pre-computed aggregations that can be queried via the Cube API.

ABOUT DRIZZLE CUBE:
- Cubes have "measures" (aggregations) and "dimensions" (attributes)
- Measure types: 'sum', 'count', 'countDistinct', 'avg', 'min', 'max', 'number'
- The 'number' type allows custom SQL expressions

REQUIREMENTS:
- Add your measure to the appropriate cube (invoicesCube, subscriptionsCube, etc.)
- Use the correct measure type for your calculation
- For complex calculations, use type: 'number' with a raw SQL expression

EXAMPLE MEASURES:
\`\`\`typescript
measures: {
  // Simple sum
  totalRevenue: { type: 'sum', sql: invoices.amount_paid },

  // Distinct count
  uniqueCustomers: { type: 'countDistinct', sql: invoices.customer_id },

  // Complex calculation with 'number' type
  arpu: {
    type: 'number',
    sql: \`CAST(SUM(\${invoices.amount_paid}) AS REAL) / COUNT(DISTINCT \${invoices.customer_id})\`,
  },
}
\`\`\`

WORKFLOW:
1. Read src/cubes.ts to see existing cube definitions
2. Read src/schema.ts to see available columns
3. Add your measure to the appropriate cube
4. Use <tool>done</tool> when complete`,

  taskPrompt: (task: Task) => `
TASK: Add measure "${task.measureName}" to the appropriate cube in src/cubes.ts

${task.description}

The measure should be queryable via: cube.load({ measures: ['${task.measureName}'] })

Start by reading the existing cube definitions.
`,

  validate: async (sandboxDir: string, task: Task): Promise<ValidationResult> => {
    const cubesPath = path.join(sandboxDir, 'src/cubes.ts');

    if (!fs.existsSync(cubesPath)) {
      return { valid: false, error: 'cubes.ts not found' };
    }

    const code = fs.readFileSync(cubesPath, 'utf8');

    // Flexible measure name matching - semantic layers allow different naming conventions
    // e.g., churn_rate, churnRate, subscriptionChurnRate are all valid
    const baseName = task.measureName.replace(/_/g, ''); // arpu, churnrate, avgltv
    const variations = [
      task.measureName,                              // exact: churn_rate
      baseName,                                      // no underscore: churnrate
      baseName.charAt(0).toUpperCase() + baseName.slice(1), // capitalized: Churnrate
      task.measureName.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), // camelCase: churnRate
    ];

    // Check if any variation of the measure was added
    const measureFound = variations.some(name => {
      const pattern = new RegExp(`${name}\\s*:\\s*\\{`, 'i');
      return pattern.test(code);
    });

    if (!measureFound) {
      // Check if they added ANY new measure with a type definition
      if (!code.includes("type: 'number'") && !code.includes("type: 'sum'") &&
          !code.includes("type: 'avg'") && !code.includes("type: 'count'")) {
        return { valid: false, error: `No measure found. Expected something like: ${task.measureName}` };
      }
    }

    // Extract the actual SQL from the model's measure definition
    // Look for patterns like: measureName: { type: '...', sql: `...` }
    // or: measureName: { type: 'sum', sql: table.column }

    // Find the measure definition in the code
    const measurePatterns = [
      // type: 'number' with template literal sql
      new RegExp(`(${variations.join('|')})\\s*:\\s*\\{[^}]*type:\\s*['"]number['"][^}]*sql:\\s*\`([^\`]+)\``, 'is'),
      // type: 'number' with regular string sql
      new RegExp(`(${variations.join('|')})\\s*:\\s*\\{[^}]*type:\\s*['"]number['"][^}]*sql:\\s*['"]([^'"]+)['"]`, 'is'),
      // type: 'sum'/'avg'/'count' with column reference
      new RegExp(`(${variations.join('|')})\\s*:\\s*\\{[^}]*type:\\s*['"]([^'"]+)['"][^}]*sql:\\s*([^,}]+)`, 'is'),
    ];

    let extractedSql: string | null = null;
    let measureType: string | null = null;

    for (const pattern of measurePatterns) {
      const match = code.match(pattern);
      if (match) {
        if (match[2] === 'sum' || match[2] === 'avg' || match[2] === 'count' || match[2] === 'countDistinct') {
          // Simple aggregation type - construct SQL from type and column
          measureType = match[2];
          const columnRef = match[3].trim();
          // Extract column name from patterns like: invoices.amount_paid or subscriptions.status
          const colMatch = columnRef.match(/(\w+)\.(\w+)/);
          if (colMatch) {
            const [, table, column] = colMatch;
            const aggFunc = measureType === 'countDistinct' ? 'COUNT(DISTINCT' : measureType.toUpperCase() + '(';
            extractedSql = `SELECT ${aggFunc}${column}) as value FROM ${table}`;
          }
        } else {
          // Custom SQL expression (type: 'number')
          extractedSql = match[2];
          measureType = 'number';
        }
        break;
      }
    }

    if (!extractedSql) {
      return { valid: false, error: `Could not extract SQL from measure definition` };
    }

    // Transform the SQL: replace ${table.column} patterns with just column names
    // and add appropriate FROM clause if missing
    let finalSql = extractedSql
      .replace(/\$\{(\w+)\.(\w+)\}/g, '$2')  // ${invoices.amount_paid} -> amount_paid
      .replace(/\$\{(\w+)\}/g, '$1')          // ${column} -> column
      .trim();

    // Determine which table to query based on task
    const tableMap: Record<string, string> = {
      arpu: 'invoices',
      churn_rate: 'subscriptions',
      avg_ltv: 'invoices',
    };
    const mainTable = tableMap[task.measureName] || 'invoices';

    // If the SQL doesn't have a FROM clause, wrap it
    if (!finalSql.toLowerCase().includes('from ')) {
      // Handle WHERE clause that might be in the measure
      if (!finalSql.toLowerCase().includes('select ')) {
        finalSql = `SELECT ${finalSql} as value FROM ${mainTable}`;
      }
    } else if (!finalSql.toLowerCase().includes('select ')) {
      finalSql = `SELECT ${finalSql}`;
    }

    // Ensure it returns a named column
    if (!finalSql.toLowerCase().includes(' as value') && !finalSql.toLowerCase().includes(' as ')) {
      finalSql = finalSql.replace(/^SELECT\s+/i, 'SELECT ').replace(/\s+FROM/i, ' as value FROM');
    }

    const validateScript = `
const fs = require('fs');
const Database = require('duckdb').Database;

const db = new Database(':memory:');

// Load JSON data
db.exec(\`
  CREATE TABLE invoices AS SELECT * FROM read_json_auto('./data/invoices.json');
  CREATE TABLE subscriptions AS SELECT * FROM read_json_auto('./data/subscriptions.json');
  CREATE TABLE customers AS SELECT * FROM read_json_auto('./data/customers.json');
\`);

// Execute the model's SQL (extracted from their measure definition)
const sql = \`${finalSql.replace(/`/g, '\\`')}\`;

db.all(sql, (err, rows) => {
  if (err) {
    console.log(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
  if (rows && rows.length > 0) {
    const value = Object.values(rows[0]).find(v => typeof v === 'number');
    console.log(JSON.stringify({ result: value }));
  } else {
    console.log(JSON.stringify({ error: 'No result' }));
  }
  db.close();
});
`;

    const scriptPath = path.join(sandboxDir, 'validate-cube.cjs');
    fs.writeFileSync(scriptPath, validateScript);

    try {
      const output = execSync('node validate-cube.cjs 2>&1', {
        cwd: sandboxDir,
        encoding: 'utf8',
        timeout: 30000,
      });

      const parsed = JSON.parse(output.trim());
      if (parsed.error) {
        return { valid: false, error: `Cube error: ${parsed.error}` };
      }
      if (typeof parsed.result === 'number') {
        return { valid: true, actual: parsed.result };
      }
      return { valid: false, error: 'Cube did not return a number' };
    } catch (error: any) {
      const msg = error.stdout?.toString() || error.message;
      return { valid: false, error: `Validation error: ${msg.slice(0, 300)}` };
    }
  },
};
