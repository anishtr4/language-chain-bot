import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { Document } from "langchain/document";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const EMB_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "text-embedding-004";

async function toChunkedDocs(items) {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 700,
    chunkOverlap: 120,
  });
  const docs = [];
  for (const it of items || []) {
    const content = [it.title || "", it.question || "", it.answer || ""].join("\n");
    const chunks = await splitter.createDocuments([content]);
    chunks.forEach((c, idx) =>
      docs.push(
        new Document({
          pageContent: c.pageContent,
          metadata: {
            id: it.id,
            title: it.title || it.question || "",
            tags: Array.isArray(it.tags) ? it.tags : [],
            chunk: idx,
          },
        })
      )
    );
  }
  return docs;
}

export class LangChainRetriever {
  constructor({ items }) {
    this.items = Array.isArray(items) ? items : [];
    this.embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey: process.env.GEMINI_API_KEY,
      model: EMB_MODEL,
    });
    this.store = null; // MemoryVectorStore
  }

  async build() {
    const docs = await toChunkedDocs(this.items);
    this.store = await MemoryVectorStore.fromDocuments(docs, this.embeddings);
  }

  async upsert(items) {
    this.items = Array.isArray(items) ? items : [];
    await this.build();
  }

  async retrieve(query, k = 5) {
    if (!this.store) await this.build();
    const results = await this.store.similaritySearchWithScore(query, Math.max(k * 3, 8));
    // MemoryVectorStore returns cosine similarity (higher is better)
    const agg = new Map();
    for (const [doc, rawScore] of results) {
      const id = doc.metadata?.id;
      if (!id) continue;
      const item = this.items.find((x) => x.id === id);
      if (!item) continue;
      const sim = typeof rawScore === 'number' ? rawScore : 0;
      const prev = agg.get(id);
      if (!prev || sim > prev.score) agg.set(id, { item, score: sim });
    }
    const scored = Array.from(agg.values());
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }
}

export async function initLangChainRetriever({ items }) {
  if (!process.env.GEMINI_API_KEY) return null;
  const r = new LangChainRetriever({ items });
  await r.build();
  return r;
}
