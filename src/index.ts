import { createAnswerChain, type Env } from "./chain";
import { retrieveDocument } from "./retrieval";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const json = (body: unknown, status = 200, headers = {}) =>
      Response.json(body, {
        status,
        headers: { "Cache-Control": "no-store", ...headers },
      });

    if (new URL(request.url).pathname !== "/api/ask") {
      return json({ error: "Not found." }, 404);
    }
    if (request.method !== "POST") {
      return json({ error: "Use POST /api/ask." }, 405, { Allow: "POST" });
    }
    if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") {
      return json({ error: "Send an application/json request." }, 415);
    }

    // Enforce a byte limit while reading, including requests without Content-Length.
    let body: unknown;
    try {
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 128_000) {
            await reader.cancel();
            return json({ error: "Request is too large (128 KB maximum)." }, 413);
          }
          chunks.push(value);
        }
      }
      body = JSON.parse(await new Blob(chunks).text());
    } catch {
      return json({ error: "Send valid JSON." }, 400);
    }

    const { document, question } = (body ?? {}) as Record<string, unknown>;
    if (
      typeof document !== "string" ||
      typeof question !== "string" ||
      !document.trim() ||
      !question.trim()
    ) {
      return json({ error: "Add both a document and a question." }, 400);
    }
    if (document.length > 20_000 || question.length > 1_000) {
      return json({ error: "Use at most 20,000 characters for the document and 1,000 for the question." }, 400);
    }
    if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
      return json({ error: "Workers AI is not configured. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (see README)." }, 503);
    }
    if (!env.AI || !env.VECTORIZE) {
      return json({ error: "RAG is not configured. Set the AI and VECTORIZE bindings and create the Vectorize index (see README)." }, 503);
    }

    try {
      const context = await retrieveDocument(env, document.trim(), question.trim(), ctx);
      if (context === null) {
        return json({ error: "Document indexing is taking longer than expected. Please submit again shortly." }, 503, { "Retry-After": "5" });
      }
      const chain = createAnswerChain(env);
      const answer = await chain.invoke(
        { document: context, question: question.trim() },
        { signal: AbortSignal.timeout(30_000) },
      );
      if (!answer.trim()) throw new Error("Empty model response");
      return json({ answer });
    } catch {
      // Do not expose provider errors, tokens, or document contents in logs/responses.
      return json({ error: "RAG could not answer. Check Workers AI credentials, quota and the Vectorize index, or try again shortly." }, 502);
    }
  },
} satisfies ExportedHandler<Env>;
