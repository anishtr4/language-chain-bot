import express from 'express';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import multer from 'multer';
import { parse as csvParse } from 'csv-parse';
import { stringify as csvStringify } from 'csv-stringify';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';
import cheerio from 'cheerio';
import { initGeminiRetriever } from './retriever.js';
import { initLangChainRetriever } from './retriever.langchain.js';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { nanoid } from 'nanoid';
import * as nlp from './nlp/intent.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const FAQ_PATH = path.join(DATA_DIR, 'faq.json');
const UNANSWERED_LOG = path.join(DATA_DIR, 'unanswered.log');
const FEEDBACK_LOG = path.join(DATA_DIR, 'feedback.log');
const ADVERSE_LOG = path.join(DATA_DIR, 'adverse.log');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(FAQ_PATH)) fs.writeFileSync(FAQ_PATH, JSON.stringify([], null, 2));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Logger setup (structured logs)
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie'],
    remove: true,
  },
});
app.use(pinoHttp({
  logger,
  genReqId: (req, res) => req.headers['x-request-id'] || nanoid(12),
}));

// Basic timing helper
function msSince(t0) {
  try {
    return Number((process.hrtime.bigint() - t0) / 1000000n);
  } catch (e) {
    logger.error({ err: e }, 'Error in msSince function');
    return Date.now() - Number(t0);
  }
}

// Remove any inline "Related topics" or "You might also ask" text from an answer
function sanitizeAnswerText(text) {
  try {
    let t = String(text || '');
    // Remove lines that start with Related topics / You might also ask
    t = t.split(/\n\n+/).filter(p => !/^\s*(related topics|you might also ask)/i.test(p.trim())).join('\n\n');
    // Remove sentences that contain Related topics / You might also ask anywhere in the paragraph
    t = t.replace(/(^|\n)\s*(related topics|you might also ask)[^.\n]*(\.|\n)/gim, '$1');
    // Remove common suggestion phrases like 'Perhaps ... might be helpful/might help'
    t = t.replace(/(^|\n)[^\n]*\b(perhaps|maybe)\b[^\n]*\bmight be helpful\b[^\n]*(\.|\n)/gim, '$1');
    t = t.replace(/(^|\n)[^\n]*\b(perhaps|maybe)?\b[^\n]*\bmight help\b[^\n]*(\.|\n)/gim, '$1');
    // Remove FAQ #n mentions
    t = t.replace(/\(\s*faq\s*#?\d+\s*\)/gi, '').replace(/faq\s*#?\d+/gi, '');
    // Remove bracket citations like [#2] or [2], optionally wrapped in parentheses
    t = t.replace(/\(\s*\[\s*#?\d+\s*\]\s*\)/g, '');
    t = t.replace(/\[\s*#?\d+\s*\]/g, '');
    // Remove any sentence containing such bracket citations
    t = t.replace(/(^|\n)[^\n]*\[\s*#?\d+\s*\][^\n]*(\.|\n)/g, '$1');
    // Remove sentences like: 'see FAQ #n' or 'see [#n]'
    t = t.replace(/(^|\n)[^\n]*\bsee\b[^\n]*\bfaq\s*#?\d+[^\n]*(\.|\n)/gim, '$1');
    t = t.replace(/(^|\n)[^\n]*\bsee\b[^\n]*\[\s*#?\d+\s*\][^\n]*(\.|\n)/gim, '$1');
    // Remove sentences: 'Related topics include ...' or '... topics might help'
    t = t.replace(/(^|\n)\s*related topics\s+include[^\n]*(\.|\n)/gim, '$1');
    t = t.replace(/(^|\n)[^\n]*\btopics\b[^\n]*\bmight help\b[^\n]*(\.|\n)/gim, '$1');
    // Tidy multiple blank lines
    t = t.replace(/\n{3,}/g, '\n\n').trim();
    // Collapse stray double spaces
    t = t.replace(/\s{3,}/g, ' ');
    return t;
  } catch { return text; }
}

// Lightweight sanitizer for streaming tokens so unwanted phrases don't appear mid-stream
function sanitizeToken(tok) {
  try {
    let s = String(tok || '');
    // Strip immediate suggestion cues and citations inline
    s = s.replace(/\(\s*\[\s*#?\d+\s*\]\s*\)/g, '');
    s = s.replace(/\[\s*#?\d+\s*\]/g, '');
    s = s.replace(/\b(faq\s*#?\d+)\b/gi, '');
    s = s.replace(/\b(related topics|you might also ask)\b[^\n]*/gi, '');
    s = s.replace(/\b(perhaps|maybe)\b[^\n]*(you\s+(meant\s+to\s+ask|might\s+mean|may\s+mean)|might\s+be\s+helpful|might\s+help)[^\n]*/gi, '');
    s = s.replace(/\btopics\b[^\n]*\bmight\s+help\b[^\n]*/gi, '');
    if (/\b(perhaps|maybe|related topics|faq|might\s+help)\b/i.test(s)) {
      return '';
    }
    return s;
  } catch { return tok; }
}

// Heuristic: synthesize a clear policy answer from KB when user asks about lost/recover/delete
function policyAnswer(query, candidates) {
  const q = (query || '').toLowerCase();
  const intent = /(lost|lose|recover|restore|deleted?|missing|find my (file|document))/i.test(q);
  if (!intent) return null;
  const text = candidates.map(c => `${c.faq.question}\n${c.faq.answer}`).join('\n\n').toLowerCase();
  const mentionsRetention = /(retain|kept|store|stored|save|saved).*\b(hour|day|week|month)s?/i.test(text);
  const mentionsDeletion = /(delete|deleted|removed|purge|destroy)/i.test(text);
  if (!mentionsRetention && !mentionsDeletion) return null;

  // Try to extract a time window like "2 hours", "24 hours", "7 days"
  const m = text.match(/(\b\d+\s*(minute|hour|day|week|month)s?\b)/i);
  const windowStr = m ? m[1] : null;

  let lines = [];
  if (windowStr) {
    lines.push(`Files are retained for up to ${windowStr} for download.`);
  } else {
    lines.push('Files are retained for a limited time for download.');
  }
  if (mentionsDeletion) {
    lines.push('After the retention period or if you delete a file, it is removed from our systems.');
    lines.push('Once deleted, files cannot be recovered.');
  }
  lines.push('If you still have the original file, please re-upload it.');
  return lines.join(' ');
}

const upload = multer({ storage: multer.memoryStorage() });

// In-memory cache
let FAQ = loadFAQ();
let TFIDF = buildTfIdfIndex(FAQ);
let RETRIEVER = null; // Gemini embeddings retriever (optional)

// Init NLP
(async () => {
  try { await nlp.init(); logger.info('NLP intents loaded'); }
  catch (e) { logger.warn({ err: e }, 'NLP init failed; falling back to regex only'); }
})();

// Merge embeddings + TF-IDF results
async function getHybridCandidates(query, k = 8) {
  const out = new Map();
  // Embeddings first
  if (RETRIEVER) {
    try {
      const r = await RETRIEVER.retrieve(query, k);
      for (const { item, score } of r) {
        const prev = out.get(item.id);
        const s = typeof score === 'number' ? score : 0;
        if (!prev || s > prev.score) out.set(item.id, { faq: item, score: s, mode: 'embed' });
      }
    } catch (e) {
      // ignore, we'll rely on TF-IDF
    }
  }
  // TF-IDF always available
  const tf = topKSimilar(query, k);
  for (const c of tf) {
    const prev = out.get(c.faq.id);
    // light boost so TF-IDF can surface if embeddings weak
    const s = Math.min(1, c.score * 0.9);
    if (!prev || s > prev.score) out.set(c.faq.id, { faq: c.faq, score: s, mode: 'tfidf' });
  }
  const arr = Array.from(out.values());
  arr.sort((a, b) => b.score - a.score);
  return arr.slice(0, k);
}

function loadFAQ() {
  try {
    const raw = fs.readFileSync(FAQ_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data.map((d, i) => ({
      id: d.id ?? String(i + 1),
      title: d.title ?? d.question?.slice(0, 60) ?? `FAQ ${i + 1}`,
      question: d.question ?? '',
      answer: d.answer ?? '',
      tags: d.tags ?? []
    })) : [];
  } catch (e) {
    logger.error({ err: e }, 'Failed to load FAQ');
    return [];
  }

// Optional lightweight NLP (natural) - lazy loaded
let _natural = null;
let _bayes = null;
let _bayesReady = false;
async function getNaturalBayes() {
  if (_bayesReady) return _bayes;
  try {
    if (!_natural) {
      // dynamic import so app runs even if module isn't installed
      const mod = await import('natural');
      _natural = mod.default || mod;
    }
    const { BayesClassifier } = _natural;
    _bayes = new BayesClassifier();
    // Seed minimal training data
    const adv = [
      'I had an adverse reaction with swelling and dizziness',
      'This is an emergency, I am injured',
      'Severe allergic reaction and rash',
      'I lost my document and cannot find the file',
      'Data loss: deleted my document by accident'
    ];
    const ok = [
      'How do I upload a file',
      'Can I work from the cloud',
      'What are the system requirements',
      'Where is the pricing page',
      'No side effects, everything is fine'
    ];
    adv.forEach(t => _bayes.addDocument(t.toLowerCase(), 'adverse'));
    ok.forEach(t => _bayes.addDocument(t.toLowerCase(), 'neutral'));
    _bayes.train();
    _bayesReady = true;
  } catch (e) {
    // Module not installed or failed — remain optional
    _bayesReady = false;
    _bayes = null;
  }
  return _bayes;
}

// Lightweight adverse-event detector: heuristics + optional NLP + optional LLM confirmation
async function detectAdverse(message) {
  const text = String(message || '').toLowerCase();
  // Heuristic features with simple scoring and negation handling
  const positives = [
    'adverse', 'side effect', 'side-effect', 'allergy', 'allergic', 'injury', 'injuries', 'harm', 'unsafe', 'danger', 'dangerous',
    'emergency', 'accident', 'medical issue', 'reaction', 'rash', 'swelling', 'bleeding', 'pain', 'dizzy', 'nausea', 'vomit', 'faint', 'burn', 'shock',
    // data loss / missing docs
    'lost document', 'lost file', 'missing document', 'missing file', 'data loss', 'deleted file', 'deleted document', 'cannot find document', 'cannot find file',
    // mental health / crisis cues
    'lost my mind', 'suicide', 'suicidal', 'self harm', 'self-harm', 'harm myself', 'kill myself', 'want to die', 'end my life', 'panic attack', 'anxiety attack'
  ];
  const severe = ['emergency', 'severe', 'anaphylaxis', 'unconscious', 'bleeding', 'chest pain', 'stroke'];
  const negations = ['no ', "didn't", 'not ', "hasn't", "haven't", 'without', 'never'];

  let score = 0;
  for (const p of positives) if (text.includes(p)) score += 1;
  for (const s of severe) if (text.includes(s)) score += 2;
  for (const n of negations) if (text.includes(n)) score -= 0.8;
  score = Math.max(0, score);
  // Explicit pattern for lost/missing documents/files
  const lostPattern = /(lost|missing|deleted|removed)[^\n]{0,40}\b(document|file|files|doc|docs|data)\b/;
  const cannotFindPattern = /(can\s*not|cannot|can['’]t)\s+find[^\n]{0,40}\b(document|file|files|doc|docs|data)\b/;
  if (lostPattern.test(text) || cannotFindPattern.test(text)) score += 2.5;
  // Mental-health crisis explicit patterns
  const mentalPattern = /(lost\s+my\s+mind|suicid(e|al)|self[-\s]?harm|harm\s+myself|kill\s+myself|want\s+to\s+die|end\s+my\s+life|panic\s+attack|anxiety\s+attack)/i;
  if (mentalPattern.test(text)) score += 3.0;
  let heuristic = score >= 1.0; // slightly lower threshold

  // Optional Natural Bayes contribution
  try {
    const bayes = await getNaturalBayes();
    if (bayes) {
      const label = bayes.classify(text);
      const probs = bayes.getClassifications(text) || [];
      const advProb = probs.find(p => p.label === 'adverse')?.value || 0;
      // blend: bump score with classifier belief
      score += advProb * 1.5;
      if (!heuristic && advProb >= 0.65) heuristic = true;
    }
  } catch {}

  // Optional LLM confirmation to reduce false positives
  if (gemini || openai) {
    try {
      const instruction = 'Classify if the message reports a potential adverse medical/safety event (including mental-health crisis or self-harm risk) that requires human follow-up.' +
        ' Consider context and negations. Respond with STRICT JSON: {"adverse": true|false, "confidence": 0..1} only.';
      let raw = '';
      if (gemini) {
        const model = gemini.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-1.5-flash' });
        const r = await model.generateContent(`${instruction}\n\nMessage: ${message}`);
        raw = r?.response?.text?.() || '';
      } else if (openai) {
        const r = await openai.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          messages: [ { role: 'system', content: instruction }, { role: 'user', content: `Message: ${message}` } ],
          temperature: 0
        });
        raw = r.choices?.[0]?.message?.content || '';
      }
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        const j = JSON.parse(m[0]);
        if (typeof j.adverse === 'boolean' && typeof j.confidence === 'number') {
          const combined = heuristic || j.adverse; // LLM cannot veto a positive heuristic
          const conf = Math.max(0.2, Math.min(1, Math.max(j.confidence, score / 4)));
          return { isAdverse: combined, confidence: conf, reason: 'llm+heuristic' };
        }
      }
    } catch {}
  }
  // Fallback to heuristic decision
  const conf = Math.max(0.2, Math.min(1, score / 4));
  return { isAdverse: heuristic, confidence: conf, reason: 'heuristic' };
}
}

function saveFAQ(faq) {
  fs.writeFileSync(FAQ_PATH, JSON.stringify(faq, null, 2));
}

// Simple tokenizer
function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function buildTfIdfIndex(faq) {
  const docs = faq.map(f => `${f.title} \n ${f.question} \n ${f.answer} \n ${(f.tags||[]).join(' ')}`);
  const tokenized = docs.map(tokenize);
  const df = new Map();
  const tf = tokenized.map(tokens => {
    const counts = new Map();
    tokens.forEach(t => counts.set(t, (counts.get(t) || 0) + 1));
    for (const t of new Set(tokens)) {
      df.set(t, (df.get(t) || 0) + 1);
    }
    return counts;
  });
  const N = docs.length || 1;
  const idf = new Map();
  for (const [t, dfi] of df.entries()) {
    idf.set(t, Math.log((N + 1) / (dfi + 1)) + 1);
  }
  const docVectors = tf.map(counts => {
    const vec = new Map();
    let norm2 = 0;
    for (const [t, c] of counts.entries()) {
      const w = (c) * (idf.get(t) || 0);
      vec.set(t, w);
      norm2 += w * w;
    }
    return { vec, norm: Math.sqrt(norm2) };
  });
  return { idf, docVectors };
}

function vectorizeQuery(query, idf) {
  const tokens = tokenize(query);
  const counts = new Map();
  tokens.forEach(t => counts.set(t, (counts.get(t) || 0) + 1));
  const vec = new Map();
  let norm2 = 0;
  for (const [t, c] of counts.entries()) {
    const w = c * (idf.get(t) || 0);
    if (w !== 0) {
      vec.set(t, w);
      norm2 += w * w;
    }
  }
  return { vec, norm: Math.sqrt(norm2) };
}

function cosineSim(a, b) {
  if (!a.norm || !b.norm) return 0;
  let dot = 0;
  const [small, large] = a.vec.size < b.vec.size ? [a.vec, b.vec] : [b.vec, a.vec];
  for (const [t, w] of small.entries()) {
    const v = large.get(t);
    if (v) dot += w * v;
  }
  return dot / (a.norm * b.norm);
}

function topKSimilar(query, k = 5) {
  const qvec = vectorizeQuery(query, TFIDF.idf);
  const scored = FAQ.map((faq, i) => ({
    faq,
    score: cosineSim(qvec, TFIDF.docVectors[i] || { vec: new Map(), norm: 0 })
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

function reloadIndex() {
  FAQ = loadFAQ();
  TFIDF = buildTfIdfIndex(FAQ);
}

// Optional OpenAI
let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// Optional Gemini
let gemini = null;
if (process.env.GEMINI_API_KEY) {
  try {
    gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  } catch (e) {
    logger.error({ err: e }, 'Failed to init Gemini');
  }
}

// Initialize embeddings retriever if Gemini is configured (prefer LangChain)
(async () => {
  try {
    if (process.env.GEMINI_API_KEY) {
      // Prefer LangChain retriever
      RETRIEVER = await initLangChainRetriever({ items: FAQ });
      if (!RETRIEVER) {
        // Fallback to custom JSON-based retriever
        RETRIEVER = await initGeminiRetriever({ dataDir: DATA_DIR, items: FAQ });
      }
    }
  } catch (e) {
    logger.warn({ err: e }, 'Retriever init failed');
  }
})();

async function answerWithLLM(query, candidates) {
  const context = candidates.map((c, idx) => `[#${idx + 1}] Title: ${c.faq.title}\nQ: ${c.faq.question}\nA: ${c.faq.answer}`).join('\n\n');
  const instruction = `You are a helpful, friendly FAQ assistant. Answer ONLY using the provided knowledge base. Be concise and human-like.

Format your answer with:
- A one-line summary
- 2-5 bullet points of key details
- A short tip or next step when relevant

If the answer is not present, say you don't find it and propose the closest relevant FAQs. Cite source numbers like [#1]. Keep it under 120 words.`;
  const prompt = `User question: ${query}\n\nKnowledge Base:\n${context}`;

  // Prefer Gemini if available
  if (gemini) {
    try {
      const model = gemini.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-1.5-flash' });
      const result = await model.generateContent(`${instruction}\n\n${prompt}`);
      const text = result?.response?.text?.() || result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (text?.trim()) return text.trim();
    } catch (e) {
      console.error('Gemini error:', e?.message || e);
    }
  }

  // Fallback to OpenAI if available
  if (openai) {
    try {
      const resp = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: instruction },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 300
      });
      const text = resp.choices?.[0]?.message?.content?.trim() || '';
      if (text) return text;
    } catch (e) {
      console.error('OpenAI error:', e?.message || e);
    }
  }
  return null;
}

async function extractFaqsWithGemini(rawText) {
  if (!gemini) return null;
  const instruction = `Extract FAQs from the given content. Return STRICT JSON array of objects with keys: question, answer, optional title, optional tags (array of strings). Do not include any extra text.`;
  const model = gemini.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-1.5-flash' });
  const result = await model.generateContent(`${instruction}\n\nCONTENT:\n${rawText.slice(0, 120000)}`);
  const text = result?.response?.text?.() || '';
  try {
    const jsonStart = text.indexOf('[');
    const jsonEnd = text.lastIndexOf(']');
    const slice = jsonStart >= 0 ? text.slice(jsonStart, jsonEnd + 1) : text;
    const arr = JSON.parse(slice);
    if (Array.isArray(arr)) return arr;
  } catch (e) {
    console.error('Gemini JSON parse error:', e?.message || e);
  }
  return null;
}

// Routes
app.get('/api/faq', (req, res) => {
  res.json({ items: FAQ });
});

app.post('/api/faq', (req, res) => {
  const items = req.body.items;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
  const normalized = items.map((d, i) => ({
    id: d.id ?? String(i + 1),
    title: d.title ?? d.question?.slice(0, 60) ?? `FAQ ${i + 1}`,
    question: d.question ?? '',
    answer: d.answer ?? '',
    tags: d.tags ?? []
  }));
  saveFAQ(normalized);
  reloadIndex();
  res.json({ ok: true, count: normalized.length });
});

app.post('/api/faq/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const append = String(req.query.append || 'false') === 'true';
  const buf = req.file.buffer;
  let imported = [];

  const tryJSON = () => {
    try {
      const data = JSON.parse(buf.toString('utf-8'));
      if (Array.isArray(data)) return data;
      if (Array.isArray(data.items)) return data.items;
      return null;
    } catch { return null; }
  };

  const tryCSV = () => new Promise((resolve) => {
    csvParse(buf.toString('utf-8'), { columns: true, trim: true }, (err, records) => {
      if (err) return resolve(null);
      resolve(records?.map(r => ({
        id: r.id || undefined,
        title: r.title || undefined,
        question: r.question || r.q || '',
        answer: r.answer || r.a || '',
        tags: r.tags ? String(r.tags).split('|').map(s => s.trim()).filter(Boolean) : []
      })) || null);
    });
  });

  imported = tryJSON();
  if (!imported) imported = await tryCSV();
  if (!imported) return res.status(400).json({ error: 'Unsupported file format. Provide JSON array or CSV with columns: question,answer[,title,tags]' });

  const normalized = imported.map((d, i) => ({
    id: d.id ?? String(Date.now()) + '-' + i,
    title: d.title ?? d.question?.slice(0, 60) ?? `FAQ ${i + 1}`,
    question: d.question ?? '',
    answer: d.answer ?? '',
    tags: d.tags ?? []
  }));

  const finalList = append ? [...FAQ, ...normalized] : normalized;
  saveFAQ(finalList);
  reloadIndex();
  // refresh retriever asynchronously
  (async () => { if (RETRIEVER) await RETRIEVER.upsert(FAQ); })();
  res.json({ ok: true, count: finalList.length });
});

// Feedback: { message, answer, vote: 'up'|'down' }
app.post('/api/feedback', (req, res) => {
  try {
    const vote = String(req.body?.vote || '').toLowerCase();
    const message = String(req.body?.message || '').slice(0, 2000);
    const answer = String(req.body?.answer || '').slice(0, 4000);
    if (!['up','down'].includes(vote)) return res.status(400).json({ error: 'invalid vote' });
    const line = `${new Date().toISOString()}\t${vote}\t${message.replace(/\n/g,' ')}\t${answer.replace(/\n/g,' ')}\n`;
    fs.appendFileSync(FEEDBACK_LOG, line);
    return res.json({ ok: true });
  } catch (e) {
    console.error('feedback error:', e?.message || e);
    return res.status(500).json({ error: 'failed to record feedback' });
  }
});

// Import FAQs from a PDF file
app.post('/api/faq/import/pdf', upload.single('file'), async (req, res) => {
  try {
    if (!gemini) return res.status(400).json({ error: 'Gemini not configured. Set GEMINI_API_KEY.' });
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
    const append = String(req.query.append || 'false') === 'true';
    let parsed;
    try {
      const mod = await import('pdf-parse');
      const pdfParse = mod.default || mod;
      parsed = await pdfParse(req.file.buffer);
    } catch (e) {
      console.error('Failed to load/use pdf-parse:', e?.message || e);
      return res.status(500).json({ error: 'PDF parser not available on this environment' });
    }
    const text = parsed?.text || '';
    if (!text.trim()) return res.status(400).json({ error: 'Could not extract text from PDF' });
    const faqs = await extractFaqsWithGemini(text);
    if (!Array.isArray(faqs)) return res.status(400).json({ error: 'Gemini failed to extract FAQs' });

    const normalized = faqs.map((d, i) => ({
      id: d.id ?? String(Date.now()) + '-pdf-' + i,
      title: d.title ?? d.question?.slice(0, 60) ?? `FAQ ${i + 1}`,
      question: d.question ?? '',
      answer: d.answer ?? '',
      tags: Array.isArray(d.tags) ? d.tags : []
    }));
    const finalList = append ? [...FAQ, ...normalized] : normalized;
    saveFAQ(finalList);
    reloadIndex();
    // refresh retriever asynchronously
    (async () => { if (RETRIEVER) await RETRIEVER.upsert(FAQ); })();
    res.json({ ok: true, count: finalList.length });
  } catch (e) {
    console.error('PDF import error:', e?.message || e);
    res.status(500).json({ error: 'PDF import failed' });
  }
});

// Import FAQs from a web URL
app.post('/api/faq/import/url', async (req, res) => {
  try {
    if (!gemini) return res.status(400).json({ error: 'Gemini not configured. Set GEMINI_API_KEY.' });
    const url = String(req.body?.url || '').trim();
    const append = String(req.query.append || 'false') === 'true';
    if (!url) return res.status(400).json({ error: 'url is required' });
    const r = await fetch(url);
    const html = await r.text();
    const $ = cheerio.load(html);
    const text = $('body').text();
    if (!text?.trim()) return res.status(400).json({ error: 'No readable text at URL' });
    const faqs = await extractFaqsWithGemini(text);
    if (!Array.isArray(faqs)) return res.status(400).json({ error: 'Gemini failed to extract FAQs' });

    const normalized = faqs.map((d, i) => ({
      id: d.id ?? String(Date.now()) + '-url-' + i,
      title: d.title ?? d.question?.slice(0, 60) ?? `FAQ ${i + 1}`,
      question: d.question ?? '',
      answer: d.answer ?? '',
      tags: Array.isArray(d.tags) ? d.tags : []
    }));
    const finalList = append ? [...FAQ, ...normalized] : normalized;
    saveFAQ(finalList);
    reloadIndex();
    res.json({ ok: true, count: finalList.length });
  } catch (e) {
    console.error('URL import error:', e?.message || e);
    res.status(500).json({ error: 'URL import failed' });
  }
});

app.post('/api/chat', async (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message is required' });

  // Small-talk / greeting handler
  const low = message.toLowerCase();
  const isGreeting = /^(hi|hello|hey|yo|hola|h?eyy?\b|good\s*(morning|afternoon|evening)|\bhelp\b|\bstart\b)[!.\s]*$/i.test(low) || tokenize(message).length <= 2;
  if (isGreeting) {
    const suggestions = (FAQ || []).map(f => f.title).filter(Boolean).slice(0, 3);
    const bullets = suggestions.length
      ? suggestions.map(t => `- ${t}`).join('\n')
      : '- Billing\n- Account\n- Files & Security';
    const reply = `Hi! I'm your FAQ assistant. What would you like to know?\n\nHere are some topics you can ask about:\n${bullets}`;
    return res.json({ answer: reply, confidence: 0, sources: [], suggestions });
  }

  // Adverse event detection: heuristic + optional LLM confirmation
  try {
    const product = nlp.getProduct(req);
    let isAdverse = false;
    let cls = null;
    try {
      const res = await nlp.classify(message, product);
      if (['self_harm', 'medical_emergency'].includes(res.intent) && res.score >= 0.5) {
        isAdverse = true;
        cls = { isAdverse: true, confidence: res.score, reason: res.intent };
      }
    } catch {}
    if (!isAdverse) {
      // keep existing regex adverse as fallback
      cls = await detectAdverse(message);
      isAdverse = Boolean(cls?.isAdverse);
    }
    if (isAdverse) {
      const logLine = [
        new Date().toISOString(),
        req.ip,
        (req.headers['user-agent'] || '').replace(/\s+/g, ' ').slice(0, 200),
        JSON.stringify({ message, confidence: cls.confidence, reason: cls.reason })
      ].join('\t') + '\n';
      fs.appendFileSync(ADVERSE_LOG, logLine);
      req.log.warn({ cls }, 'Adverse event detected');
      const urgent = 'This may be an adverse event. Please contact 947657485745872 immediately. We have logged your report for review. If safe, include details like what happened, when, and any symptoms.';
      return res.json({ answer: urgent, confidence: Math.max(0.8, cls.confidence || 0.8), sources: [] });
    }
  } catch {}

  const k = Number(req.body.k || 8);
  const tRetrieval = process.hrtime.bigint();
  const candidates = await getHybridCandidates(message, k);
  req.log.info({ ms: msSince(tRetrieval), k, got: candidates.length }, 'retrieval.done');
  const best = candidates[0];
  const confidence = best ? Number(best.score.toFixed(3)) : 0;

  let answer = '';
  if (best && best.score > 0.05) {
    // Prefer dynamic paraphrase via LLM when available
    if (gemini || openai) {
      const tLLM = process.hrtime.bigint();
      const llm = await answerWithLLM(message, candidates.slice(0, 8));
      answer = llm || best.faq.answer;
      req.log.info({ ms: msSince(tLLM), used: Boolean(llm), confidence }, 'llm.answer');
    } else {
      answer = best.faq.answer;
    }
  } else {
    if (gemini || openai) {
      const tLLM = process.hrtime.bigint();
      const llm = await answerWithLLM(message, candidates.slice(0, 5));
      answer = llm || '';
      req.log.info({ ms: msSince(tLLM), used: Boolean(llm), coldStart: true }, 'llm.answer');
    }
    if (!answer) {
      answer = "I couldn't find this in the knowledge base. Here are related topics you can check.";
      fs.appendFileSync(UNANSWERED_LOG, `${new Date().toISOString()}\t${message}\n`);
    }
  }

  res.json({
    answer,
    confidence,
    sources: candidates.slice(0, 3).map(c => ({ id: c.faq.id, title: c.faq.title, score: Number(c.score.toFixed(3)) }))
  });
});

// --- SSE utilities ---
function sseInit(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}
function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Build a single-line related topics sentence from top sources
function relatedLineFromSources(sources) {
  try {
    const titles = (sources || []).map(s => s.title).filter(Boolean).slice(0, 2);
    if (!titles.length) return '';
    if (titles.length === 1) return `Related topics might include "${titles[0]}".`;
    return `Related topics might include "${titles[0]}" and "${titles[1]}".`;
  } catch {
    return '';
  }
}

function relatedLineFromMeta(meta) {
  try {
    const srcTitles = Array.isArray(meta?.sources) ? meta.sources.map(s => s.title).filter(Boolean) : [];
    let titles = srcTitles.slice(0, 2);
    if (!titles.length && Array.isArray(meta?.suggestions)) {
      titles = meta.suggestions.slice(0, 2);
    }
    if (!titles.length) return '';
    if (titles.length === 1) return `Related topics might include "${titles[0]}".`;
    return `Related topics might include "${titles[0]}" and "${titles[1]}".`;
  } catch {
    return '';
  }
}

async function streamWithGemini(query, candidates, res, metaPayload = null) {
  const context = candidates.map((c, idx) => `[#${idx + 1}] Title: ${c.faq.title}\nQ: ${c.faq.question}\nA: ${c.faq.answer}`).join('\n\n');
  const instruction = `You are a helpful, friendly FAQ assistant. Answer ONLY using the provided knowledge base. Be concise and human-like.
If the answer is not present or unclear in the knowledge base, say you're not sure.
Do NOT include a 'Related topics' or 'You might also ask' section in your text; the UI will surface suggestions separately.
Do NOT include references like 'FAQ #1' or numbered FAQ references, and do NOT include bracket citations like [#1] or [1] in the answer text.
However, if the knowledge base contains file retention or deletion policies (e.g., files are kept for a limited time, can be deleted by users, or cannot be recovered after deletion), state those policies clearly and DO NOT say you're unsure.\n\n`;
  const prompt = `${instruction}Knowledge Base:\n${context}\n\nUser question: ${query}\n\nFinal helpful answer:`;
  try {
    const model = gemini.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-1.5-pro' });
    const result = await model.generateContentStream({ contents: [{ role: 'user', parts: [{ text: prompt }] }] });
    let full = '';
    for await (const part of result.stream) {
      const chunk = part?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!chunk) continue;
      const sanitized = (typeof sanitizeToken === 'function' ? sanitizeToken(chunk) : chunk);
      full += sanitized;
      const t = sanitized.replace(/```/g, '\u0060\u0060\u0060');
      sseSend(res, 'token', { token: t });
    }
    // Do not append related topics into answer text; UI shows chips from meta
    if (metaPayload) sseSend(res, 'meta', metaPayload);
    const clean = sanitizeAnswerText(full);
    sseSend(res, 'done', { text: clean });
  } catch (e) {
    const errStr = String(e?.message || e || '');
    const isQuota = /429|quota|Too\s+Many\s+Requests/i.test(errStr);
    if (isQuota) {
      try {
        const top = candidates && candidates[0] ? candidates[0] : null;
        let fallback = top?.faq?.answer || '';
        if (!fallback) fallback = "I'm not sure based on the knowledge base.";
        const clean = typeof sanitizeAnswerText === 'function' ? sanitizeAnswerText(fallback) : fallback;
        if (metaPayload) sseSend(res, 'meta', metaPayload);
        sseSend(res, 'token', { token: clean });
        sseSend(res, 'done', { text: clean });
        return;
      } catch (e2) {
        // fall through to error if something goes wrong
      }
    }
    sseSend(res, 'error', { message: 'streaming failed', detail: String(e?.message || e) });
  }
}

// Streaming chat via SSE
app.post('/api/chat/stream', async (req, res) => {
  sseInit(res);
  const message = String(req.body.message || '').trim();
  if (!message) {
    sseSend(res, 'error', { message: 'message is required' });
    return res.end();
  }

  // Greeting shortcut: send immediate canned answer then done
  const low = message.toLowerCase();
  const isGreeting = /^(hi|hello|hey|yo|hola|h?eyy?\b|good\s*(morning|afternoon|evening)|\bhelp\b|\bstart\b)[!.\s]*$/i.test(low) || tokenize(message).length <= 2;
  if (isGreeting) {
    const suggestions = (FAQ || []).map(f => f.title).filter(Boolean).slice(0, 3);
    const bullets = suggestions.length ? suggestions.map(t => `- ${t}`).join('\n') : '- Billing\n- Account\n- Files & Security';
    const reply = `Hi! I'm your FAQ assistant. What would you like to know?\n\nHere are some topics you can ask about:\n${bullets}`;
    sseSend(res, 'token', { token: reply });
    sseSend(res, 'meta', { confidence: 0, sources: [], suggestions });
    sseSend(res, 'done', { text: reply });
    return res.end();
  }

  // Adverse event detection (NLP first, regex fallback)
  try {
    const product = nlp.getProduct(req);
    let isAdverse = false;
    let cls = null;
    let detectedIntent = null;
    try {
      const resIntent = await nlp.classify(message, product);
      detectedIntent = resIntent;
      if (['self_harm', 'medical_emergency'].includes(resIntent.intent) && resIntent.score >= 0.5) {
        isAdverse = true;
        cls = { isAdverse: true, confidence: resIntent.score, reason: resIntent.intent };
      }
    } catch {}
    if (!isAdverse) {
      cls = await detectAdverse(message);
      isAdverse = Boolean(cls?.isAdverse);
    }
    if (detectedIntent) {
      sseSend(res, 'meta', { intent: detectedIntent.intent, intentScore: detectedIntent.score, intentSource: detectedIntent.source || 'rule', product });
    }
    if (isAdverse) {
      const logLine = [
        new Date().toISOString(),
        req.ip,
        (req.headers['user-agent'] || '').replace(/\s+/g, ' ').slice(0, 200),
        JSON.stringify({ message, confidence: cls.confidence, reason: cls.reason })
      ].join('\t') + '\n';
      fs.appendFileSync(ADVERSE_LOG, logLine);
      req.log?.warn({ cls }, 'Adverse event detected');
      const urgent = 'This may be an adverse event. Please contact 947657485745872 immediately. We have logged your report for review. If safe, include details like what happened, when, and any symptoms.';
      sseSend(res, 'token', { token: urgent });
      sseSend(res, 'meta', { confidence: Math.max(0.8, cls.confidence || 0.8), sources: [] });
      sseSend(res, 'done', { text: urgent });
      return res.end();
    }
  } catch {}

  // Retrieval
  const k = Number(req.body.k || 8);
  const tRetrieval = process.hrtime.bigint();
  const candidates = await getHybridCandidates(message, k);
  req.log?.info({ ms: msSince(tRetrieval), k, got: candidates.length }, 'retrieval.done');
  const best = candidates[0];
  const confidence = best ? Number(best.score.toFixed(3)) : 0;
  const metaPayload = {
    confidence,
    sources: candidates.slice(0, 3).map(c => ({ id: c.faq.id, title: c.faq.title, score: Number(c.score.toFixed(3)) }))
  };
  // If no sources, provide suggestions fallback based on common file keywords
  if (!metaPayload.sources.length) {
    const keywords = /\b(delete|deletion|retain|retention|upload|file|files|document)\b/i;
    const sugg = (FAQ || []).map(f => f.title).filter(t => t && keywords.test(t)).slice(0, 3);
    if (sugg.length) metaPayload.suggestions = sugg;
  }

  // Deterministic policy answer via NLP intents
  let policy = null;
  try {
    const product = nlp.getProduct(req);
    const intent = await nlp.classify(message, product);
    // Log and emit meta for observability
    req.log?.info({ intent: intent.intent, score: intent.score, source: intent.source || 'rule', product }, 'intent.detected');
    sseSend(res, 'meta', { intent: intent.intent, intentScore: intent.score, intentSource: intent.source || 'rule', product });
    if (intent.intent === 'file_recovery' && intent.score >= 0.5) {
      policy = policyAnswer(message, candidates);
    } else if (/(\blost\b|\brecover\b|\bdeleted?\b)/i.test(message)) {
      // Regex fallback to ensure deterministic policy answer even if NLP score is low
      policy = policyAnswer(message, candidates);
    }
  } catch {}
  if (policy) {
    const clean = sanitizeAnswerText(policy);
    sseSend(res, 'token', { token: clean });
    sseSend(res, 'meta', metaPayload);
    sseSend(res, 'done', { text: clean });
    return res.end();
  }

  // Streaming with Gemini if available
  if (gemini && best && best.score > 0.05) {
    return await streamWithGemini(message, candidates.slice(0, 8), res, metaPayload);
  }

  // Fallback: non-stream single answer via existing LLM or KB
  try {
    let text = '';
    if (gemini || openai) {
      const llm = await answerWithLLM(message, candidates.slice(0, 5));
      text = llm || (best ? best.faq.answer : '');
    } else if (best) {
      text = best.faq.answer;
    } else {
      text = "I couldn't find this in the knowledge base.";
    }
    const clean = sanitizeAnswerText(text);
    sseSend(res, 'token', { token: clean });
    sseSend(res, 'meta', metaPayload);
    sseSend(res, 'done', { text: clean });
  } catch (e) {
    sseSend(res, 'error', { message: 'failed to answer', detail: String(e?.message || e) });
  } finally {
    res.end();
  }
});

app.get('/health', (req, res) => res.json({
  ok: true,
  hasGemini: Boolean(gemini),
  hasOpenAI: Boolean(openai),
  faqCount: Array.isArray(FAQ) ? FAQ.length : 0
}));

// Hot-reload intents
app.post('/admin/reload-intents', async (req, res) => {
  try { await nlp.reload(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, `Bubble FAQ Bot running at http://localhost:${PORT}`);
});
