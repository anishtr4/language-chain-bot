import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';

const DEFAULT_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'text-embedding-004';

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class GeminiRetriever {
  constructor({ dataDir, items }) {
    this.dataDir = dataDir;
    this.indexPath = path.join(this.dataDir, 'embeddings.json');
    this.items = Array.isArray(items) ? items : [];
    this.gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.model = this.gemini.getGenerativeModel({ model: DEFAULT_MODEL });
    this.index = { vectors: [], dim: 0, updatedAt: null };
  }

  async loadIndex() {
    try {
      if (fs.existsSync(this.indexPath)) {
        const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
        this.index = raw;
      }
    } catch {}
  }

  async saveIndex() {
    try {
      fs.writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2));
    } catch {}
  }

  // Build or rebuild embeddings index for current items
  async build() {
    const texts = this.items.map(it => [it.title || '', it.question || '', it.answer || '', (it.tags || []).join(' ')].join('\n'));
    const vectors = await this.embedBatch(texts);
    this.index = {
      vectors: vectors.map((v, i) => ({ id: this.items[i].id, dim: v.length, values: v })),
      dim: vectors[0]?.length || 0,
      updatedAt: new Date().toISOString(),
    };
    await this.saveIndex();
  }

  async embedBatch(texts) {
    // Gemini Embeddings: call in batches
    const out = [];
    const B = 16;
    for (let i = 0; i < texts.length; i += B) {
      const chunk = texts.slice(i, i + B);
      const res = await this.model.embedContent({ content: chunk.map(t => ({ role: 'user', parts: [{ text: String(t || '') }] })) });
      // Fallback: if embedContent doesn't accept batch as above, do per-text
      if (!res || !res.embeddings || !Array.isArray(res.embeddings)) {
        for (const t of chunk) {
          const r = await this.model.embedContent(t);
          const v = r?.embedding?.values || r?.vector || r?.embedding || [];
          out.push(Array.isArray(v) ? v : []);
        }
      } else {
        for (const e of res.embeddings) {
          const v = e?.values || e?.embedding || [];
          out.push(Array.isArray(v) ? v : []);
        }
      }
    }
    return out;
  }

  async upsert(items) {
    this.items = Array.isArray(items) ? items : [];
    await this.build();
  }

  // Retrieve top-k items by cosine similarity
  async retrieve(query, k = 5) {
    const r = await this.model.embedContent(query);
    const qvec = r?.embedding?.values || r?.vector || r?.embedding || [];
    if (!Array.isArray(qvec) || qvec.length === 0 || !this.index?.vectors?.length) return [];
    const scored = this.index.vectors.map((v, i) => ({
      id: v.id,
      score: cosine(qvec, v.values),
      item: this.items.find(it => it.id === v.id) || null,
    })).filter(x => x.item);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }
}

export async function initGeminiRetriever({ dataDir, items }) {
  if (!process.env.GEMINI_API_KEY) return null;
  const retriever = new GeminiRetriever({ dataDir, items });
  await retriever.loadIndex();
  // Rebuild if mismatch or empty
  if (!retriever.index?.vectors?.length || (retriever.items?.length && retriever.index.vectors.length !== retriever.items.length)) {
    await retriever.build();
  }
  return retriever;
}
