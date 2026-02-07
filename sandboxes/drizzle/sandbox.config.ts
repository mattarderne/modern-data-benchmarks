import type { SandboxConfig, Task, ValidationResult } from '../types';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const config: SandboxConfig = {
  id: 'drizzle',
  name: 'Drizzle ORM',

  contextFiles: [
    'src/schema.ts',
    'src/queries.ts',
    'src/db.ts',
  ],

  targetFile: 'src/queries.ts',

  systemPrompt: `You are modifying a Drizzle ORM analytics codebase.

Available tools:
<tool>read_file</tool><path>relative/path</path>
<tool>write_file</tool><path>relative/path</path><content>...</content>
<tool>list_files</tool><path>optional/dir</path>
<tool>done</tool>

CONSTRAINT: Your function will be imported and executed against a SQLite database.
The database is pre-loaded with data from JSON files.

REQUIREMENTS:
- Function MUST be exported (use "export async function")
- Function MUST use Drizzle query builder (db.select(), etc.)
- Function MUST return Promise<number>
- Use the schema imports: invoices, subscriptions, customers, etc.
- Use drizzle-orm operators: eq, sum, count, countDistinct, and, avg

CRITICAL - When writing to queries.ts:
- You MUST keep ALL existing imports and code intact
- The imports use .ts extensions (e.g., './db.ts', './schema.ts') - DO NOT REMOVE THESE
- Only APPEND your new function at the end of the file
- If you overwrite the imports, the code will fail to run

WORKFLOW:
1. Read src/schema.ts to see table definitions
2. Read src/queries.ts - note the EXACT imports at the top
3. Write the COMPLETE file back with your function APPENDED at the end
4. Use <tool>done</tool> when complete`,

  taskPrompt: (task: Task) => `
TASK: Add function "${task.functionName}" to src/queries.ts

Signature: export async function ${task.functionName}(): Promise<number>

${task.description}

Start by reading the schema and existing queries.
`,

  setup: async (sandboxDir: string) => {
    // Ensure drizzle dependencies are available (will be handled by parent project)
  },

  validate: async (sandboxDir: string, task: Task): Promise<ValidationResult> => {
    const queriesPath = path.join(sandboxDir, 'src/queries.ts');

    if (!fs.existsSync(queriesPath)) {
      return { valid: false, error: 'queries.ts not found' };
    }

    let code = fs.readFileSync(queriesPath, 'utf8');

    // Fix common model mistakes: missing .ts extensions in imports
    // Models often write './db' instead of './db.ts'
    code = code.replace(/from ['"]\.\/db['"]/g, "from './db.ts'");
    code = code.replace(/from ['"]\.\/schema['"]/g, "from './schema.ts'");
    fs.writeFileSync(queriesPath, code);

    // Flexible function name matching
    const baseName = task.functionName.replace(/^calculate/, '').toLowerCase();
    const variations = [
      task.functionName,
      task.functionName.toLowerCase(),
      `calculate${baseName.charAt(0).toUpperCase() + baseName.slice(1)}`,
      `get${baseName.charAt(0).toUpperCase() + baseName.slice(1)}`,
      `compute${baseName.charAt(0).toUpperCase() + baseName.slice(1)}`,
      baseName,
    ];

    // Find the actual function name (async or sync)
    let actualFunctionName: string | null = null;
    for (const name of variations) {
      const asyncPattern = new RegExp(`export\\s+async\\s+function\\s+(${name})\\s*\\(`, 'i');
      const syncPattern = new RegExp(`export\\s+function\\s+(${name})\\s*\\(`, 'i');
      let match = code.match(asyncPattern) || code.match(syncPattern);
      if (match) {
        actualFunctionName = match[1];
        break;
      }
    }

    if (!actualFunctionName) {
      return { valid: false, error: `No function matching ${task.functionName} found` };
    }

    // Create validation script that loads data and runs query
    const validateScript = `
import { db, loadData } from './src/db.ts';
import { ${actualFunctionName} } from './src/queries.ts';

// Load test data
loadData('./data');

// Run the query
const result = await ${actualFunctionName}();
console.log(JSON.stringify({ result: typeof result === 'number' ? result : null }));
`;

    const validatePath = path.join(sandboxDir, 'validate.mts');
    fs.writeFileSync(validatePath, validateScript);

    try {
      const output = execSync(
        'node --experimental-strip-types validate.mts 2>&1',
        {
          cwd: sandboxDir,
          encoding: 'utf8',
          timeout: 30000,
          env: { ...process.env, NODE_NO_WARNINGS: '1' },
        }
      );

      const match = output.match(/\{"result":([\d.]+|null)\}/);
      if (match && match[1] !== 'null') {
        return { valid: true, actual: parseFloat(match[1]) };
      }
      return { valid: false, error: `Function returned non-number: ${output.slice(0, 200)}` };
    } catch (error: any) {
      const msg = error.stdout?.toString() || error.stderr?.toString() || error.message;
      return { valid: false, error: `Drizzle error: ${msg.slice(0, 300)}` };
    }
  },
};
