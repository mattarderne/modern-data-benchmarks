import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.join(__dirname, '..', 'data');
const SEED = Number(process.env.SEED || 42);
const SCALE = Number(process.env.SCALE || 1);

const COUNTS = {
  customers: 1000,
  subscriptions: 2000,
  invoices: 10000,
  paymentIntents: 5000,
  products: 6,
  prices: 12,
  users: 1200,
  organizations: 220,
  apiUsage: 100000,
  chatSessions: 15000,
  features: 12,
};

function seededRandom(seed) {
  let value = seed % 2147483647;
  if (value <= 0) value += 2147483646;
  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}

const random = seededRandom(SEED);

function pick(list) {
  return list[Math.floor(random() * list.length)];
}

function chance(probability) {
  return random() < probability;
}

function range(count, fn) {
  return Array.from({ length: count }, (_, index) => fn(index));
}

const adjectives = ['Bright', 'Silent', 'Curious', 'Golden', 'Swift', 'Nova', 'Urban', 'Nimbus', 'Lunar', 'Crimson'];
const nouns = ['Labs', 'Systems', 'Works', 'Cloud', 'Analytics', 'Studio', 'Dynamics', 'Logic', 'Signal', 'Ventures'];
const plans = ['starter', 'growth', 'team', 'enterprise'];
const models = ['gpt-4o', 'claude-sonnet', 'deepseek-v3', 'qwen-32b', 'llama-3.1-8b'];
const features = ['export', 'rate-limit', 'priority-support', 'sso', 'team-workspaces', 'audit-logs', 'vision', 'tool-calling', 'batch', 'fine-tuning', 'assistant-api', 'custom-metrics'];

function makeId(prefix, index) {
  return `${prefix}_${index}_${Math.floor(random() * 100000)}`;
}

function makeName() {
  return `${pick(adjectives)} ${pick(nouns)}`;
}

function makeEmail(name) {
  const slug = name.toLowerCase().replace(/[^a-z]/g, '');
  return `${slug}${Math.floor(random() * 100)}@example.com`;
}

function makeTimestamp(offsetDays) {
  const now = Date.now();
  const millis = offsetDays * 24 * 60 * 60 * 1000;
  return new Date(now - millis).toISOString();
}

function scaleCount(count) {
  return Math.max(1, Math.floor(count * SCALE));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeJson(name, payload) {
  const filePath = path.join(OUTPUT_DIR, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

ensureDir(OUTPUT_DIR);

const products = range(scaleCount(COUNTS.products), (index) => ({
  id: makeId('prod', index),
  name: `${pick(adjectives)} ${pick(['API', 'Chat', 'Enterprise'])} ${index + 1}`,
  active: true,
  created_at: makeTimestamp(360 - index),
}));

const prices = range(scaleCount(COUNTS.prices), (index) => ({
  id: makeId('price', index),
  product_id: pick(products).id,
  nickname: pick(plans),
  unit_amount: [2000, 5000, 15000, 50000][index % 4],
  currency: 'usd',
  billing_interval: 'month',
  created_at: makeTimestamp(300 - index),
}));

const customers = range(scaleCount(COUNTS.customers), (index) => {
  const name = `${pick(adjectives)} ${pick(nouns)} ${index + 1}`;
  return {
    id: makeId('cus', index),
    name,
    email: makeEmail(name),
    metadata: {
      source: pick(['self-serve', 'sales-led', 'partner']),
      segment: pick(['startup', 'mid-market', 'enterprise']),
    },
    created_at: makeTimestamp(500 - index),
  };
});

const organizations = range(scaleCount(COUNTS.organizations), (index) => ({
  id: makeId('org', index),
  name: `${makeName()} Org ${index + 1}`,
  created_at: makeTimestamp(450 - index),
}));

const users = range(scaleCount(COUNTS.users), (index) => {
  const name = `${pick(adjectives)} User ${index + 1}`;
  return {
    id: makeId('user', index),
    organization_id: pick(organizations).id,
    stripe_customer_id: pick(customers).id,
    email: makeEmail(name),
    role: pick(['admin', 'member', 'viewer']),
    created_at: makeTimestamp(400 - index),
    last_login_at: makeTimestamp(Math.floor(random() * 60)),
  };
});

const subscriptions = range(scaleCount(COUNTS.subscriptions), (index) => ({
  id: makeId('sub', index),
  customer_id: pick(customers).id,
  price_id: pick(prices).id,
  status: pick(['active', 'trialing', 'canceled', 'past_due']),
  current_period_start: makeTimestamp(90 - index % 90),
  current_period_end: makeTimestamp(60 - index % 60),
  cancel_at_period_end: chance(0.2),
  created_at: makeTimestamp(480 - index),
}));

const invoices = range(scaleCount(COUNTS.invoices), (index) => {
  // Pick subscription first, then use its customer_id for referential integrity
  const subscription = pick(subscriptions);
  const amount = [2000, 5000, 15000, 50000][index % 4];
  return {
    id: makeId('inv', index),
    customer_id: subscription.customer_id,
    subscription_id: subscription.id,
    amount_due: amount,
    amount_paid: chance(0.92) ? amount : 0,
    status: chance(0.9) ? 'paid' : 'open',
    created_at: makeTimestamp(365 - index % 365),
  };
});

const paymentIntents = range(scaleCount(COUNTS.paymentIntents), (index) => ({
  id: makeId('pi', index),
  customer_id: pick(customers).id,
  amount: [2000, 5000, 15000, 50000][index % 4],
  currency: 'usd',
  status: pick(['succeeded', 'requires_payment_method', 'processing', 'canceled']),
  created_at: makeTimestamp(200 - index % 200),
}));

const featureFlags = range(scaleCount(COUNTS.features), (index) => ({
  id: makeId('feat', index),
  key: features[index % features.length],
  enabled: chance(0.7),
  created_at: makeTimestamp(120 - index),
}));

const apiUsage = range(scaleCount(COUNTS.apiUsage), (index) => ({
  id: makeId('usage', index),
  user_id: pick(users).id,
  model: pick(models),
  tokens: 100 + Math.floor(random() * 4000),
  latency_ms: 100 + Math.floor(random() * 3000),
  created_at: makeTimestamp(30 - index % 30),
}));

const chatSessions = range(scaleCount(COUNTS.chatSessions), (index) => ({
  id: makeId('chat', index),
  user_id: pick(users).id,
  model: pick(models),
  message_count: 2 + Math.floor(random() * 30),
  duration_seconds: 30 + Math.floor(random() * 3600),
  created_at: makeTimestamp(90 - index % 90),
}));

const outputs = [
  ['products', products],
  ['prices', prices],
  ['customers', customers],
  ['organizations', organizations],
  ['users', users],
  ['subscriptions', subscriptions],
  ['invoices', invoices],
  ['payment_intents', paymentIntents],
  ['features', featureFlags],
  ['api_usage', apiUsage],
  ['chat_sessions', chatSessions],
];

const summary = outputs.map(([name, items]) => ({ name, count: items.length }));
summary.push({ name: 'seed', count: SEED }, { name: 'scale', count: SCALE });

outputs.forEach(([name, items]) => writeJson(name, items));
writeJson('_summary', summary);

console.log('[data-architecture-comparison] Generated datasets:');
summary.forEach(({ name, count }) => {
  console.log(`- ${name}: ${count}`);
});
