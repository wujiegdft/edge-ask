import { env, exports } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env as WorkerEnv } from "../src/chain";
import worker from "../src/index";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
    interface GlobalProps {
      mainModule: typeof import("../src/index");
    }
  }
}

const ask = (body: unknown) =>
  exports.default.fetch("https://edge-ask.test/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

let stored: Map<string, VectorizeVector>;
const queryVector = [1, ...Array<number>(1023).fill(0)];

beforeEach(() => {
  // Real splitter, LangChain embeddings and LCEL; only external services are fake.
  stored = new Map();
  vi.spyOn(env.AI, "run").mockImplementation(async (model, input) => {
    if (model !== "@cf/baai/bge-m3") throw new Error("Unexpected embedding model");
    const { text } = input as { text: string[] };
    return { shape: [text.length, 1024], data: text.map(() => queryVector) };
  });
  vi.spyOn(env.VECTORIZE, "upsert").mockImplementation(async (vectors) => {
    for (const vector of vectors) stored.set(vector.id, vector);
    return { mutationId: crypto.randomUUID() };
  });
  vi.spyOn(env.VECTORIZE, "getByIds").mockImplementation(async (ids) =>
    ids.flatMap((id) => stored.has(id) ? [stored.get(id)!] : []),
  );
  vi.spyOn(env.VECTORIZE, "query").mockImplementation(async (_vector, options) => {
    const matches = [...stored.values()]
      .filter((vector) => vector.namespace === options?.namespace)
      .reverse()
      .slice(0, options?.topK)
      .map((vector) => ({ ...vector, score: 0.9 }));
    return { matches, count: matches.length };
  });
  vi.spyOn(env.VECTORIZE, "deleteByIds").mockImplementation(async (ids) => {
    for (const id of ids) stored.delete(id);
    return { mutationId: crypto.randomUUID() };
  });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected outbound request"))));
});

describe("POST /api/ask", () => {
  it("retrieves a short document through Vectorize and runs the real LCEL chain", async () => {
    const document = "The {orchid} team ships on Friday.\n紫罗兰团队周二发布。";
    const question = "紫罗兰团队什么时候发布？";
    const answer = "紫罗兰团队周二发布。";
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const prompt = body.messages?.[0]?.content;
      if (
        url !== "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/meta/llama-3.1-8b-instruct" ||
        new Headers(init.headers).get("Authorization") !== "Bearer test-token-not-a-secret" ||
        typeof prompt !== "string" ||
        !prompt.includes(document) ||
        !prompt.includes(question) ||
        body.messages[0].role !== "user"
      ) return new Response("Bad provider request", { status: 400 });
      return Response.json({ success: true, result: { response: answer } });
    });

    const response = await ask({ document, question });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ answer });
  });

  it("sends only Vectorize's top four chunks to LCEL, with an embedded question", async () => {
    const paragraphs = Array.from({ length: 7 }, (_, i) =>
      `Topic ${i}: {fact-${i}} ${String(i).repeat(730)}`,
    );
    const question = "Which facts are relevant?";
    const questionEmbedding = [0, 1, ...Array<number>(1022).fill(0)];
    vi.mocked(env.AI.run).mockImplementation(async (_model, input) => {
      const { text } = input as { text: string[] };
      return { data: text.map((value) => value === question ? questionEmbedding : queryVector) };
    });
    const query = vi.mocked(env.VECTORIZE.query).getMockImplementation()!;
    vi.mocked(env.VECTORIZE.query).mockImplementation(async (vector, options) => {
      if (
        JSON.stringify(vector) !== JSON.stringify(questionEmbedding) ||
        options?.topK !== 4 || options.returnMetadata !== "all" || !options.namespace
      ) throw new Error("Invalid retrieval request");
      return query(vector, options);
    });
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const prompt = JSON.parse(init.body as string).messages[0].content as string;
      expect(prompt).toContain(paragraphs.slice(3).reverse().join("\n\n"));
      for (const paragraph of paragraphs.slice(0, 3)) expect(prompt).not.toContain(paragraph);
      expect(prompt).toContain(question);
      return Response.json({ result: { response: "Only retrieved facts." } });
    });

    const response = await ask({ document: paragraphs.join("\n\n"), question });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answer: "Only retrieved facts." });
  });

  it("isolates concurrent pastes, ignores client namespace choices, and removes their vectors", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const prompt = JSON.parse(init.body as string).messages[0].content as string;
      const question = prompt.includes("Question: Alpha?") ? "Alpha" : "Beta";
      const other = question === "Alpha" ? "Beta" : "Alpha";
      expect(prompt).toContain(`${question} private document`);
      expect(prompt).not.toContain(`${other} private document`);
      return Response.json({ result: { response: `${question} only.` } });
    });
    const contexts = [createExecutionContext(), createExecutionContext()];
    const responses = await Promise.all(["Alpha", "Beta"].map((name, i) =>
      worker.fetch(new Request("https://edge-ask.test/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document: `${name} private document`, question: `${name}?`, namespace: "shared" }),
      }), env, contexts[i]),
    ));
    expect(await Promise.all(responses.map((response) => response.json())))
      .toEqual([{ answer: "Alpha only." }, { answer: "Beta only." }]);
    await Promise.all(contexts.map(waitOnExecutionContext));
    expect(stored.size).toBe(0);
  });

  it("preserves overlap when splitting unbroken text", async () => {
    const document = "A".repeat(680) + "boundary-fact" + "B".repeat(900);
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const prompt = JSON.parse(init.body as string).messages[0].content as string;
      expect(prompt.match(/boundary-fact/g)).toHaveLength(2);
      return Response.json({ result: { response: "The boundary fact survives." } });
    });
    const response = await ask({ document, question: "What is the boundary fact?" });
    expect(await response.json()).toEqual({ answer: "The boundary fact survives." });
  });

  it("waits for indexing and query visibility instead of treating an empty query as no answer", async () => {
    vi.mocked(env.VECTORIZE.getByIds).mockResolvedValueOnce([]);
    vi.mocked(env.VECTORIZE.query).mockResolvedValueOnce({ matches: [], count: 0 });
    vi.stubGlobal("fetch", async () => Response.json({ result: { response: "Indexed answer." } }));
    const response = await ask({ document: "Delayed facts", question: "What?" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answer: "Indexed answer." });
  });

  it("returns a retryable error and cleans up if vectors never become searchable", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(env.VECTORIZE.query).mockImplementation(async () => {
      now = 20_001;
      return { matches: [], count: 0 };
    });
    const response = await ask({ document: "Never visible", question: "What?" });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.json()).toEqual({ error: expect.stringContaining("indexing") });
    expect(stored.size).toBe(0);
  });

  it.each(["embedding", "upsert", "query"])("returns a safe error and cleans up after %s failure", async (stage) => {
    const failure = new Error("sensitive provider details");
    if (stage === "embedding") vi.mocked(env.AI.run).mockRejectedValue(failure);
    if (stage === "query") vi.mocked(env.VECTORIZE.query).mockRejectedValue(failure);
    if (stage === "upsert") {
      const upsert = vi.mocked(env.VECTORIZE.upsert).getMockImplementation()!;
      vi.mocked(env.VECTORIZE.upsert).mockImplementation(async (vectors) => {
        await upsert(vectors);
        throw failure; // The write succeeded, but the response was lost.
      });
    }
    const response = await ask({ document: "Private notes", question: "Why?" });
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("sensitive provider details");
    expect(stored.size).toBe(0);
  });

  it("still returns the retrieved answer if best-effort deletion fails", async () => {
    vi.mocked(env.VECTORIZE.deleteByIds).mockRejectedValue(new Error("sensitive provider details"));
    vi.stubGlobal("fetch", async () => Response.json({ result: { response: "Retrieved answer." } }));
    const response = await ask({ document: "Private notes", question: "Why?" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answer: "Retrieved answer." });
  });

  it.each([
    null,
    { document: " ", question: "Why?" },
    { document: "Notes", question: "\n " },
    { document: 123, question: "Why?" },
    { document: "Notes", question: ["Why?"] },
    { document: "x".repeat(20_001), question: "Why?" },
    { document: "Notes", question: "x".repeat(1_001) },
  ])("rejects invalid input without a model call (case %#)", async (body) => {
    const response = await ask(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
  });

  it("accepts both character limits, including multibyte text", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ result: { response: "Within limits." } }));
    const response = await ask({ document: "文".repeat(20_000), question: "问".repeat(1_000) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answer: "Within limits." });
  });

  it("rejects malformed JSON and oversized bodies", async () => {
    for (const [body, status] of [["{", 400], [" ".repeat(128_001), 413]] as const) {
      const response = await exports.default.fetch("https://edge-ask.test/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toHaveProperty("error");
    }
  });

  it.each(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "AI", "VECTORIZE"] as const)("reports missing %s configuration", async (binding) => {
    const response = await worker.fetch(
      new Request("https://edge-ask.test/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document: "Notes", question: "Why?" }),
      }),
      { ...env, [binding]: undefined } as unknown as WorkerEnv,
      createExecutionContext(),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: expect.stringContaining("not configured") });
  });

  it.each([401, 429, 500, 200])("returns a safe error for failed/empty provider responses (%i)", async (status) => {
    vi.stubGlobal("fetch", async () => Response.json({ result: { response: "" }, error: "sensitive provider details" }, { status }));
    const response = await ask({ document: "Private notes", question: "Why?" });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "RAG could not answer. Check Workers AI credentials, quota and the Vectorize index, or try again shortly." });
    expect(stored.size).toBe(0);
  });

  it("enforces the route, method and content type", async () => {
    const unknown = await exports.default.fetch("https://edge-ask.test/api/missing");
    expect(unknown.status).toBe(404);
    const wrongMethod = await exports.default.fetch("https://edge-ask.test/api/ask");
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("Allow")).toBe("POST");
    const wrongType = await exports.default.fetch("https://edge-ask.test/api/ask", { method: "POST", body: "notes" });
    expect(wrongType.status).toBe(415);
  });
});
