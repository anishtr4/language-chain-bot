import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

let NlpManager; // resolved lazily in init()
let manager = null;
let intents = null;

function loadIntentsFromDisk() {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const raw = fs.readFileSync(path.join(__dirname, '..', 'config', 'intents.json'), 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return { default: { policy: [], adverse: [] } };
  }
}

async function buildManager() {
  if (!NlpManager) return null;
  const m = new NlpManager({ languages: ['en'], forceNER: true });
  for (const [product, cfg] of Object.entries(intents || {})) {
    for (const group of ['policy', 'adverse']) {
      for (const intent of cfg[group] || []) {
        const label = `${product}.${intent.label}`;
        for (const ex of intent.examples || []) {
          m.addDocument('en', ex, label);
        }
      }
    }
  }
  // Regex entity for windows like "2 hours", "7 days"
  m.addRegexEntity('window', 'en', /\b(\d+\s*(minute|hour|day|week|month)s?)\b/i);
  await m.train();
  return m;
}

export async function init() {
  // ensure intents loaded synchronously already; reload to pick up any changes
  intents = intents || loadIntentsFromDisk();
  try {
    // dynamic import to avoid hard dependency during startup
    const mod = await import('node-nlp');
    NlpManager = mod.NlpManager;
  } catch (e) {
    NlpManager = undefined;
  }
  if (NlpManager) {
    manager = await buildManager();
  }
}

export function getProduct(req) {
  return (req.headers['x-product'] || req.query?.product || 'default').toString();
}

export async function reload() {
  intents = loadIntentsFromDisk();
  if (NlpManager) manager = await buildManager();
}

export async function classify(text, product = 'default') {
  const res = { intent: 'none', score: 0, entities: [], source: 'rule' };
  if (!text || !text.trim()) return res;
  // Ensure intents are available even if init() hasn't run yet
  if (!intents) intents = loadIntentsFromDisk();
  // Stage 1: rule patterns
  const cfg = intents[product] || intents.default || { policy: [], adverse: [] };
  const rules = [...(cfg.policy || []), ...(cfg.adverse || [])];
  for (const it of rules) {
    for (const pat of it.patterns || []) {
      const re = new RegExp(pat, 'i');
      if (re.test(text)) {
        return { intent: it.label, score: 0.6, entities: [], source: 'rule' };
      }
    }
  }
  // Stage 2: node-nlp classifier
  if (manager) {
    const out = await manager.process('en', text);
    const top = (out.classifications || [])
      .filter(c => c.intent.startsWith(`${product}.`) || c.intent.startsWith('default.'))
      .sort((a,b) => b.score - a.score)[0];
    if (top && top.score >= 0.5) {
      return {
        intent: top.intent.split('.').slice(1).join('.'),
        score: top.score,
        entities: out.entities || [],
        source: 'node-nlp'
      };
    }
  }
  return res;
}
