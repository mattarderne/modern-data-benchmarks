#!/usr/bin/env npx ts-node
/**
 * Smoke Test: DBT with Enhanced Schema
 * Tests Trinity model (67% on DBT vs 100% on TS) with enhanced YAML
 * to see if information parity improves performance
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.join(__dirname, '..');

// Read the enhanced schema to include in system prompt
const enhancedSchema = fs.readFileSync(
  path.join(PROJECT_DIR, 'warehouse/models/schema_enhanced.yml'),
  'utf8'
);

const DBT_ENHANCED_SYSTEM_PROMPT = `You are a coding agent that creates DBT SQL models.

SCHEMA DOCUMENTATION (enhanced with type information):
${enhancedSchema}

TOOLS:
1. READ FILE: <tool>read_file</tool><path>path</path>
2. WRITE FILE: <tool>write_file</tool><path>path</path><content>content</content>
3. RUN COMMAND: <tool>run</tool><command>command</command>
4. LIST FILES: <tool>list_files</tool><path>optional/path</path>
5. DONE: <tool>done</tool><answer>ONLY the numeric value</answer>

CRITICAL: The <answer> must contain ONLY the number. No text, no explanation.

SANDBOX STRUCTURE:
- warehouse/models/staging/*.sql - Existing DBT models
- warehouse/models/schema_enhanced.yml - Enhanced schema with types and valid values
- data/*.json - Invoice, subscription, customer data
- test.js - Ready-to-use test file

IMPORTANT SCHEMA INFORMATION:
From the enhanced schema, you can see:
- Valid values for enum fields (e.g., status: ['paid', 'open', 'void', 'uncollectible'])
- Data types for each column
- Nullability constraints
- Foreign key relationships
- Units (amounts are in CENTS, not dollars)
- Business logic rules for calculations

HOW TO TEST:
1. Read schema_enhanced.yml to understand data structure
2. Create your SQL model in warehouse/models/staging/
3. Edit test.js to implement the SAME logic in JavaScript
4. Run: node test.js
5. The output is your answer

EXAMPLE test.js for ARPU:
\`\`\`javascript
const fs = require('fs');
const invoices = JSON.parse(fs.readFileSync('./data/invoices.json', 'utf8'));
// Schema tells us: status valid values are ['paid', 'open', 'void', 'uncollectible']
// Schema tells us: only 'paid' invoices count toward revenue
const paid = invoices.filter(i => i.status === 'paid');
const total = paid.reduce((sum, i) => sum + i.amount_paid, 0);
const customers = new Set(paid.map(i => i.customer_id)).size;
console.log(Math.round(total / customers));
\`\`\``;

console.log('Enhanced DBT System Prompt Created');
console.log('Length:', DBT_ENHANCED_SYSTEM_PROMPT.length, 'characters');
console.log('\nIncludes enhanced schema with:');
console.log('- Data types');
console.log('- Valid values (enum equivalents)');
console.log('- Constraints');
console.log('- Business logic rules');
console.log('- Units and currency information');
console.log('\nReady for benchmark run with Trinity model');
