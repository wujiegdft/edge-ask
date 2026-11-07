import { CloudflareWorkersAIEmbeddings } from "@langchain/cloudflare";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { Env } from "./chain";

export async function retrieveDocument(
  env: Env,
  document: string,
  question: string,
  ctx: ExecutionContext,
): Promise<string | null> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 800,
    chunkOverlap: 120,
    separators: ["\n\n", "\n", "。", "！", "？", ". ", " ", ""],
  });
  const chunks = await splitter.splitText(document);
  const embeddings = new CloudflareWorkersAIEmbeddings({
    binding: env.AI,
    model: "@cf/baai/bge-m3",
    stripNewLines: false,
    maxRetries: 0,
  });
  const [vectors, queryVector] = await Promise.all([
    embeddings.embedDocuments(chunks),
    embeddings.embedQuery(question),
  ]);

  // The server owns the namespace; clients cannot select another request's data.
  const namespace = crypto.randomUUID();
  const ids = chunks.map((_, i) => `${namespace}:${i}`);
  const ownIds = new Set(ids);
  const topK = Math.min(4, chunks.length);

  try {
    await env.VECTORIZE.upsert(chunks.map((text, i) => ({
      id: ids[i],
      namespace,
      values: vectors[i],
      metadata: { text },
    })));

    // Vectorize mutations are asynchronous. Wait for the entire paste, not just
    // an arbitrary early subset, then retrieve using the question embedding.
    const deadline = Date.now() + 20_000;
    do {
      const visible = await env.VECTORIZE.getByIds(ids);
      if (visible.length === ids.length) {
        const result = await env.VECTORIZE.query(queryVector, {
          namespace,
          topK,
          returnValues: false,
          returnMetadata: "all",
        });
        const matches = result.matches.filter((match) =>
          ownIds.has(match.id) && typeof match.metadata?.text === "string",
        );
        if (matches.length === topK) {
          return matches.map((match) => match.metadata!.text).join("\n\n");
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } while (Date.now() < deadline);

    // Never fall back to the original paste or an in-memory vector search.
    return null;
  } finally {
    // Also attempt cleanup when a write was accepted but its response was lost.
    // Deletes are asynchronous; failure must not mask a usable answer/error.
    ctx.waitUntil(env.VECTORIZE.deleteByIds(ids).catch(() => {
      console.warn("Temporary Vectorize cleanup failed; vectors may remain stored.");
    }));
  }
}
