# Edge Ask

粘贴文档 → 输入问题 → 得到回答。一个用于学习、面试讲解的 **LangChain.js + TypeScript + Cloudflare Workers** 最小示例。

在 v1 的小网页上加入真正的检索增强生成（RAG）：**文档切块 → Workers AI embeddings → Cloudflare Vectorize → top-k 检索 → 原有 LCEL**。`PromptTemplate | ChatCloudflareWorkersAI | StringOutputParser` 保留，但 `{document}` 只包含检索片段，不再塞入整篇文档。**没有 Agent、工具调用、聊天历史或 LangGraph。** 静态页面与 API 仍部署为同一个 Worker，无前端框架、无单独构建步骤。

## 本地运行

要求：Node.js 22+、npm、可访问 Cloudflare API 的网络，以及可使用 Workers AI / Vectorize 的 Cloudflare 账号。

```sh
npm ci
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填写下表中的账号 ID 和 token
npx wrangler login
# 首次运行：按下一节创建 Vectorize index
npm run dev
```

打开 Wrangler 输出的本地地址。点击 **Try an example** 可填入示例文档和问题，但回答仍需真实 embeddings、Vectorize 和模型调用。生产代码没有 mock、整文回退或内存向量库。

### 首次创建 Vectorize index

`wrangler.jsonc` 已声明 `AI` binding 和 `VECTORIZE` binding，后者指向 `edge-ask-documents`。**声明 binding 不会创建远端 index**，首次运行/部署前需在配置中的账号下执行一次：

```sh
npx wrangler vectorize create edge-ask-documents --dimensions=1024 --metric=cosine
```

- 使用 Vectorize V2（不要加 `--deprecated-v1`）；维度必须是 **1024**，匹配 `@cf/baai/bge-m3`。维度、距离度量创建后不能修改。
- namespace 用于请求级隔离，无需创建 metadata index；chunk 文本直接存入向量 metadata，查询用 `returnMetadata: "all"` 取回。
- Wrangler 登录身份需能管理该账号的 Vectorize index 并使用远程开发 bindings；只有 **Workers AI: Read** 的运行时 token 不够。也可通过有相应权限的 shell `CLOUDFLARE_API_TOKEN` 授权 Wrangler。
- `AI`、`VECTORIZE` 均配置 `remote: true`，因为这两项没有本地模拟器。`wrangler dev` 只在本地执行 Worker，embeddings、向量读写和生成仍访问 Cloudflare，可能计费；无需 `--remote`，不要用 `--local` 验证 RAG。
- 开发时也会写入配置指定的真实 index；如需独立开发 index，另建同维度/度量的 index 并修改 `index_name`。不要将 `.dev.vars` 指向另一账号而保留原账号的 bindings。

### 环境变量与密钥

| 名称 | 本地 | Cloudflare 部署 | 用途 |
| --- | --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | `.dev.vars` | `wrangler.jsonc` 的 `vars` | Cloudflare 账号 ID，非密钥 |
| `CLOUDFLARE_API_TOKEN` | `.dev.vars` | `wrangler secret put` | 具有该账号 **Workers AI: Read** 权限的 API token，必须保密 |
| `AI` | Wrangler 远程 binding | `wrangler.jsonc` 的 `ai` | 新增：LangChain embeddings 使用的原生 Workers AI binding，无需新的 API secret |
| `VECTORIZE` | Wrangler 远程 binding | `wrangler.jsonc` 的 `vectorize` | 新增：`edge-ask-documents`，1024 维、cosine；需预先创建 |

1. 在 Cloudflare 控制台复制 **Account ID**。
2. 在 **My Profile → API Tokens → Create Custom Token** 创建 token，授予 **Account → Workers AI → Read**，资源仅选目标账号。
3. 将值填入 `.dev.vars`；此文件已被 Git 忽略。不要将 token 放到网页、`wrangler.jsonc`、Git 或截图里。

生成仍使用 v1 的 `@cf/meta/llama-3.1-8b-instruct`（`src/chain.ts`）；embeddings 使用支持中英文的 `@cf/baai/bge-m3`（`src/retrieval.ts`）。新增的只有 bindings，没有新增 secret。

为什么生成用 REST、embeddings 用 binding？官方 `@langchain/cloudflare` 的 `ChatCloudflareWorkersAI` 使用 REST，不接收原生 binding；同一包的 `CloudflareWorkersAIEmbeddings` 则要求 `AI` binding。分别遵循官方接口，复用现有账号、AI token 和生成链，不添加自定义模型适配器。`AI` binding 在部署后由平台授权，Vectorize 读写也通过 binding 授权，不把凭据发给浏览器。

## 部署

`wrangler.jsonc` 已配置部署账号、Workers AI 账号和自定义域名 `ask.wujie1123.shop`（zone：`wujie1123.shop`），并保留 `workers.dev` 地址。先按上节创建 Vectorize index。部署到其他账号时，同时修改 `account_id`、`vars.CLOUDFLARE_ACCOUNT_ID` 和域名路由，并在新账号中创建对应 index。

使用交互式登录部署：

```sh
npx wrangler login
npx wrangler secret put CLOUDFLARE_API_TOKEN
# 在交互式提示中输入 Workers AI token；首次使用时按提示创建 edge-ask Worker
npm run deploy
```

若部署环境已提供 `CLOUDFLARE_API_TOKEN`，则无需登录。该 token 必须同时具有 Worker 发布、目标 zone 的自定义域名/DNS 管理和 **Workers AI: Read** 权限；创建/管理 index 还需 **Vectorize: Edit**。可不输出密钥地写入 Worker：

```sh
printf '%s' "$CLOUDFLARE_API_TOKEN" | npx wrangler secret put CLOUDFLARE_API_TOKEN
npm run deploy
```

Wrangler 会创建自定义域名绑定并输出 `workers.dev` 地址；页面和 `/api/ask` 使用同一域名。首次绑定可能需要等待 DNS/HTTPS 证书生效。`.dev.vars` 不会随部署上传。

Worker 的 AI token 与 Wrangler 发布身份是两回事。只有 Workers AI 权限的 token 不能用作 shell 的 `CLOUDFLARE_API_TOKEN` 来发布 Worker；权限更小的独立 AI token 应通过上面的交互式 secret 命令写入。

## RAG 管道：面试时从这里讲

> “先把文档变成可搜索的小片段，再把问题变成向量，只检索同一次请求中最相关的四个片段，最后让原来的模型链根据这些证据回答。”

[`src/retrieval.ts`](src/retrieval.ts) 负责索引和检索：

1. **切块（split）**：LangChain `RecursiveCharacterTextSplitter`，`chunkSize: 800`、`chunkOverlap: 120`（字符/UTF-16 code units，不是 tokens），优先按段落、换行、中英文标点切分，再回退到空格/字符。overlap 减少边界丢失；按自然边界切分时实际重叠不一定正好 120。
2. **向量化（embed）**：LangChain `CloudflareWorkersAIEmbeddings` 通过 `env.AI` 调用 `@cf/baai/bge-m3`，将 chunks 和问题分别编码为 1024 维向量，使用相同模型才能比较语义相似度。
3. **入库（index）**：为每次 `/api/ask` 在服务端生成随机 UUID namespace 和全局唯一 vector IDs。通过 `env.VECTORIZE.upsert()` 保存向量及 `{ text: chunk }` metadata，客户端不能指定 namespace。两个用户即便同时提交相同问题，也不会搜到对方的文档。
4. **检索器（retriever）**：用问题向量调用 `env.VECTORIZE.query()`，限定本次 namespace，按 cosine 相似度取 `topK: min(4, chunkCount)`，并取回完整 metadata 文本；不是在内存中计算相似度。直接用原生 Vectorize V2 binding，避免当前 LangChain Vectorize store 未透传 namespace 的限制。
5. **最终一致性（eventual consistency）**：Vectorize upsert 只表示写入已接受，不保证立即可检索。每秒检查 `getByIds()`，所有 chunks 可见后再 query；若查询结果仍未就绪则继续等待，最多等待约 20 秒。超时返回可重试 `503`（`Retry-After: 5`），**不把空检索当成“文档没有答案”，不回退整文/内存搜索**。绑定调用自身的耗时不受此轮询预算硬取消。
6. **请求级清理（cleanup）**：检索成功、失败或写入响应丢失时，`finally` 中通过 `ctx.waitUntil()` 提交 `deleteByIds()`。删除也是异步的、best-effort；清理失败只记固定警告，不泄露文本/凭据，也不覆盖回答。这里没有 TTL、持久任务或保证删除的后台服务，失败/中断可能留下数据；需由账号管理员清理。残留数据仍不会进入其他请求的 namespace。

这是单次 paste-then-ask 演示：每次提问重新切块、嵌入和索引；不会复用上一次文档或聊天上下文。生产场景通常将离线索引与在线问答分开，并增加可靠清理/鉴权；本项目不添加这些系统。

### 保留的 LCEL

[`src/chain.ts`](src/chain.ts)：

```ts
const prompt = PromptTemplate.fromTemplate(`...{document}...{question}...`);
const model = new ChatCloudflareWorkersAI({
  model: "@cf/meta/llama-3.1-8b-instruct",
  cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
  cloudflareApiToken: env.CLOUDFLARE_API_TOKEN,
  maxRetries: 0,
});
return prompt.pipe(model).pipe(new StringOutputParser());
```

[`src/index.ts`](src/index.ts) 接收并校验 HTTP 输入，先检索，再把检索结果交给原链：

```ts
const context = await retrieveDocument(env, document.trim(), question.trim(), ctx);
// context === null 表示索引超时；HTTP handler 返回 503，不执行生成。
const chain = createAnswerChain(env);
const answer = await chain.invoke(
  { document: context, question: question.trim() },
  { signal: AbortSignal.timeout(30_000) },
);
```

- **PromptTemplate**：把检索 chunks 拼成 `{document}`，与问题填入模板，要求只依据证据作答、未知则明确说明、跟随问题语言。
- **ChatCloudflareWorkersAI**：LangChain chat model，将格式化后的 prompt 转为消息，使用 Web `fetch` 请求模型，返回 `AIMessage`。
- **StringOutputParser**：把模型消息转为字符串，而非向浏览器暴露 LangChain 对象。
- **`.pipe()` / `.invoke()`**：前者连接可运行组件（Runnable），后者执行链，并沿链传递输入与取消信号。
- 区别于 v1 的整文上下文填充（context stuffing）：完整文档只参与切块/embeddings，生成模型最多看到四个相关 chunks。短文少于四块时可能仍取回全文，但它也经过真正的 Vectorize 检索，不是特殊回退。RAG 可能漏检、overlap 可能重复，不能保证答案质量；字符数限制也不等于 token 预算。
- `nodejs_als` 仅启用 LangChain 上下文传播需要的 `AsyncLocalStorage`；没有启用完整 `nodejs_compat`，也不依赖 Node HTTP、文件系统或模型 SDK 的 Node 服务端运行时。

## API 与限制

`POST /api/ask`，`Content-Type: application/json`：

```json
{ "document": "The launch is on Friday.", "question": "When is the launch?" }
```

成功：`200 { "answer": "..." }`。错误：`{ "error": "..." }`，包括输入错误 `400`、请求过大 `413`、格式错误 `415`、缺少配置/索引尚未可检索 `503`、embeddings/Vectorize/模型失败 `502`。未知 API 路由为 `404`，非 POST 请求为 `405`。

- 文档上限 20,000 字符，问题上限 1,000 字符（与浏览器一致，按 UTF-16 code units 计数）；JSON body 上限 128,000 bytes，读取流时也强制执行。
- 生成模型调用超时 30 秒，索引可见性轮询约 20 秒，浏览器请求超时 75 秒；embeddings/生成不自动重试，提交期间防止重复点击。模型和 binding 的网络耗时会增加总延迟。
- **与 v1 不同，chunk 文本和向量会临时持久化到 Vectorize**，并尝试异步删除；不保存聊天历史或答案，不记录文档/问题内容。API 响应带 `Cache-Control: no-store`。Cloudflare 是处理这些数据的第三方；删除不保证成功，不要粘贴敏感文档。
- 答案用 `textContent` 渲染，不执行模型输出的 HTML。
- 提示词不是安全边界，不能保证防住提示注入或幻觉。请求 namespace 只是检索数据隔离，不代替用户认证。本项目无访问控制、速率限制或预算控制；**只用于个人学习/受控演示**。公开分享前请先配置 Cloudflare Access/限流，防止匿名调用消耗 AI/Vectorize 额度。

## 验证

```sh
npm run check
```

依次执行 TypeScript 检查、Vitest 测试、Wrangler 部署预演（dry-run，不发布）。测试在真实 Workers 运行时 **workerd** 中执行真实 splitter、LangChain embeddings 和 LCEL，**仅 mock 外部 AI binding、Vectorize binding 和生成 HTTP 响应**，并禁用 remote bindings：覆盖只将检索 top-k 送入 prompt、中文/花括号、切块重叠、并发请求隔离、延迟可见/索引超时、成功/失败清理、配置和输入边界。不需要凭据、不会访问真实 index/AI、不产生费用；不验证线上 Vectorize 可用性、真实索引延迟或模型质量。真实联调需先完成上述 index 和登录设置，再运行 `npm run dev`。

## 文件

- `src/chain.ts` — prompt、chat model、output parser 与 LCEL。
- `src/retrieval.ts` — LangChain splitter、Workers AI embeddings、请求 namespace、Vectorize 入库/检索/等待/清理。
- `src/index.ts` — `/api/ask`、校验、超时与安全错误响应。
- `public/` — 原生 HTML/CSS/JS；示例填充、字符数、加载/成功/错误状态与响应式布局。
- `wrangler.jsonc` / `.dev.vars.example` — 静态资源、Worker、AI/Vectorize bindings 与原有凭据配置。
- `test/worker.test.ts` / `vitest.config.ts` — Workers 运行时测试。

参考：[LangChain Cloudflare chat model](https://docs.langchain.com/oss/javascript/integrations/chat/cloudflare_workersai)、[BGE-M3](https://developers.cloudflare.com/workers-ai/models/bge-m3/)、[Vectorize binding API](https://developers.cloudflare.com/vectorize/reference/client-api/)、[远程 bindings](https://developers.cloudflare.com/workers/local-development/#remote-bindings)。
