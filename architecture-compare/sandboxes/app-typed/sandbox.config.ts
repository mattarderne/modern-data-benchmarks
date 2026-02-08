import type { SandboxConfig, Task, ValidationResult } from '../types';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const config: SandboxConfig = {
  id: 'app-typed',
  name: 'App + Stripe (TypeScript)',

  contextFiles: [
    'src/types/internal.ts',
    'src/types/stripe.ts',
    'src/analytics/derived.ts',
    'src/analytics/queries.ts',
  ],

  targetFile: 'src/analytics/queries.ts',

  systemPrompt: `You are modifying a TypeScript analytics codebase that combines app data and Stripe data.

Available tools:
<tool>read_file</tool><path>relative/path</path>
<tool>write_file</tool><path>relative/path</path><content>...</content>
<tool>list_files</tool><path>optional/dir</path>
<tool>done</tool>

CONSTRAINT: Your function will be imported and called directly:
  import { YOUR_FUNCTION } from './src/analytics/queries.ts'

REQUIREMENTS:
- Function MUST be exported (use "export function")
- Function MUST have correct TypeScript types
- Function MUST return a number
- Do NOT import external libraries (no date-fns, lodash, etc.). Use built-in Date only.

WORKFLOW:
1. Read src/analytics/queries.ts to see patterns
2. Read src/types/internal.ts and src/types/stripe.ts for type definitions
3. Optional helpers live in src/analytics/derived.ts
4. Add your function to queries.ts (keep existing code!)
5. Use <tool>done</tool> when complete`,

  taskPrompt: (task: Task) => `
TASK: Add function "${task.functionName}" to src/analytics/queries.ts

Signature: export function ${task.signature}

${task.description}

Start by reading the existing code.
`,

  validate: async (sandboxDir: string, task: Task): Promise<ValidationResult> => {
    const queriesPath = path.join(sandboxDir, 'src/analytics/queries.ts');

    if (!fs.existsSync(queriesPath)) {
      return { valid: false, error: 'queries.ts not found' };
    }

    const code = fs.readFileSync(queriesPath, 'utf8');

    // Flexible function name matching
    // e.g., calculateARPU, calculateArpu, getARPU, arpu, computeARPU
    const baseName = task.functionName.replace(/^calculate/, '').toLowerCase(); // arpu, churnrate, averageltv
    const variations = [
      task.functionName,                                    // exact: calculateARPU
      task.functionName.toLowerCase(),                       // lowercase: calculatearpu
      `calculate${baseName.charAt(0).toUpperCase() + baseName.slice(1)}`, // calculateArpu
      `get${baseName.charAt(0).toUpperCase() + baseName.slice(1)}`,       // getArpu
      `compute${baseName.charAt(0).toUpperCase() + baseName.slice(1)}`,   // computeArpu
      baseName,                                              // just: arpu
    ];

    // Find the actual function name used
    let actualFunctionName: string | null = null;
    for (const name of variations) {
      const pattern = new RegExp(`export\\s+function\\s+(${name})\\s*\\(`, 'i');
      const match = code.match(pattern);
      if (match) {
        actualFunctionName = match[1];
        break;
      }
    }

    if (!actualFunctionName) {
      return { valid: false, error: `No function matching ${task.functionName} found. Tried: ${variations.slice(0, 3).join(', ')}...` };
    }

    const dataFiles = (task.dataFiles && task.dataFiles.length > 0)
      ? task.dataFiles
      : [task.dataFile];
    const dataLoads = dataFiles
      .map((file, index) => `const data${index} = JSON.parse(fs.readFileSync('./data/${file}.json', 'utf8'));`)
      .join('\n');
    const argList = dataFiles.map((_, index) => `data${index}`).join(', ');

    // Create validation script with the actual function name
    const validateScript = `
import { ${actualFunctionName} } from './src/analytics/queries.ts';
import fs from 'node:fs';

${dataLoads}
const result = ${actualFunctionName}(${argList});
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
      return { valid: false, error: `TypeScript error: ${msg.slice(0, 300)}` };
    }
  },

  lint: async (sandboxDir: string): Promise<ValidationResult> => {
    const queriesPath = path.join(sandboxDir, 'src/analytics/queries.ts');
    if (!fs.existsSync(queriesPath)) {
      return { valid: false, error: 'queries.ts not found for linting' };
    }
    try {
      execSync('node --experimental-strip-types --check src/analytics/queries.ts 2>&1', {
        cwd: sandboxDir,
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      });
      return { valid: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { valid: false, error: `TypeScript syntax check failed: ${message}` };
    }
  },
};
