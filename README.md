# Edge Ask

粘贴文档 → 输入问题 → 得到回答。一个用于学习、面试讲解的 **LangChain.js + TypeScript + Cloudflare Workers** 最小示例。

v1 只有一条 LangChain 表达式链（LCEL）：`PromptTemplate | ChatCloudflareWorkersAI | StringOutputParser`。**没有 RAG、切块、向量数据库、Agent、工具调用或聊天历史。** 静态页面与 API 部署为同一个 Worker，无前端框架、无单独构建步骤。

## 本地运行

要求：Node.js 22+、npm、可访问 Cloudflare API 的网络。

```sh
npm ci
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填写下表中的账号 ID 和 token
npm run dev
```

打开 Wrangler 输出的本地地址，通常为 `http://localhost:8787`。点击 **Try an example** 可填入示例文档和问题，但回答仍需真实模型调用。没有凭据时页面可正常打开，提交时显示配置提示；不存在隐藏的假回答模式。

### 环境变量与密钥

| 名称 | 本地 | Cloudflare 部署 | 用途 |
| --- | --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | `.dev.vars` | `wrangler.jsonc` 的 `vars` | Cloudflare 账号 ID，非密钥 |
| `CLOUDFLARE_API_TOKEN` | `.dev.vars` | `wrangler secret put` | 具有该账号 **Workers AI: Read** 权限的 API token，必须保密 |

1. 在 Cloudflare 控制台复制 **Account ID**。
2. 在 **My Profile → API Tokens → Create Custom Token** 创建 token，授予 **Account → Workers AI → Read**，资源仅选目标账号。
3. 将值填入 `.dev.vars`；此文件已被 Git 忽略。不要将 token 放到网页、`wrangler.jsonc`、Git 或截图里。

默认模型：`@cf/meta/llama-3.1-8b-instruct`，在 `src/chain.ts` 中指定。

为什么走 REST 而非 `AI` binding？官方 `@langchain/cloudflare` 的 `ChatCloudflareWorkersAI` 当前使用 `fetch` 调用 REST API，不接收原生 binding。这样既保留真正的 LangChain chat model，也无需自定义适配器。即使 Worker 在本地运行，**推理仍在 Cloudflare 远端执行，并使用账号配额/可能产生费用**。无需 `wrangler dev --remote`。

## 部署

`wrangler.jsonc` 已配置部署账号、Workers AI 账号和自定义域名 `ask.wujie1123.shop`（zone：`wujie1123.shop`），并保留 `workers.dev` 地址。部署到其他账号时，同时修改 `account_id`、`vars.CLOUDFLARE_ACCOUNT_ID` 和域名路由。

使用交互式登录部署：

```sh
npx wrangler login
npx wrangler secret put CLOUDFLARE_API_TOKEN
# 在交互式提示中输入 Workers AI token；首次使用时按提示创建 edge-ask Worker
npm run deploy
```

若部署环境已提供 `CLOUDFLARE_API_TOKEN`，则无需登录。该 token 必须同时具有 Worker 发布、目标 zone 的自定义域名/DNS 管理和 **Workers AI: Read** 权限；可不输出密钥地写入 Worker：

```sh
printf '%s' "$CLOUDFLARE_API_TOKEN" | npx wrangler secret put CLOUDFLARE_API_TOKEN
npm run deploy
```

Wrangler 会创建自定义域名绑定并输出 `workers.dev` 地址；页面和 `/api/ask` 使用同一域名。首次绑定可能需要等待 DNS/HTTPS 证书生效。`.dev.vars` 不会随部署上传。

Worker 的 AI token 与 Wrangler 发布身份是两回事。只有 Workers AI 权限的 token 不能用作 shell 的 `CLOUDFLARE_API_TOKEN` 来发布 Worker；权限更小的独立 AI token 应通过上面的交互式 secret 命令写入。

## 主链：面试时从这里讲

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

[`src/index.ts`](src/index.ts) 接收并校验 HTTP 输入，然后调用：

```ts
const chain = createAnswerChain(env);
const answer = await chain.invoke(
  { document: document.trim(), question: question.trim() },
  { signal: AbortSignal.timeout(30_000) },
);
```

- **PromptTemplate**：把整篇文档与问题填入模板，要求只依据文档作答、未知则明确说明、跟随问题语言。
- **ChatCloudflareWorkersAI**：LangChain chat model，将格式化后的 prompt 转为消息，使用 Web `fetch` 请求模型，返回 `AIMessage`。
- **StringOutputParser**：把模型消息转为字符串，而非向浏览器暴露 LangChain 对象。
- **`.pipe()` / `.invoke()`**：前者连接可运行组件（Runnable），后者执行链，并沿链传递输入与取消信号。
- 这是整文上下文问答（context stuffing），**不是 RAG**：没有检索步骤，每次将完整文档送入模型。超长文档会受模型上下文窗口限制；字符数限制不等于 token 预算。
- `nodejs_als` 仅启用 LangChain 上下文传播需要的 `AsyncLocalStorage`；没有启用完整 `nodejs_compat`，也不依赖 Node HTTP、文件系统或模型 SDK 的 Node 服务端运行时。

## API 与限制

`POST /api/ask`，`Content-Type: application/json`：

```json
{ "document": "The launch is on Friday.", "question": "When is the launch?" }
```

成功：`200 { "answer": "..." }`。错误：`{ "error": "..." }`，包括输入错误 `400`、请求过大 `413`、格式错误 `415`、缺少配置 `503`、模型失败 `502`。未知 API 路由为 `404`，非 POST 请求为 `405`。

- 文档上限 20,000 字符，问题上限 1,000 字符（与浏览器一致，按 UTF-16 code units 计数）；JSON body 上限 128,000 bytes，读取流时也强制执行。
- 模型调用超时 30 秒，不自动重试；浏览器请求超时 40 秒，提交期间防止重复点击。
- 不持久化文档/问题/答案，不记录其内容；API 响应带 `Cache-Control: no-store`。Cloudflare 仍是处理这些数据的第三方，不要粘贴敏感文档。
- 答案用 `textContent` 渲染，不执行模型输出的 HTML。
- 提示词不是安全边界，不能保证防住提示注入或幻觉。v1 无用户认证、访问控制、速率限制或预算控制；**只用于个人学习/受控演示**。公开分享前请先配置 Cloudflare Access/限流，防止匿名调用消耗你的额度。

## 验证

```sh
npm run check
```

依次执行 TypeScript 检查、Vitest 测试、Wrangler 部署预演（dry-run，不发布）。测试在真实 Workers 运行时 **workerd** 中执行真实 LCEL 链，仅替换出站模型 HTTP 响应：覆盖 prompt 输入与字符串输出、中文/花括号、输入边界、错误 JSON、超大请求、未配置及提供商错误。不需要凭据、不调用真实 AI、不产生费用；不验证模型回答质量。

## 文件

- `src/chain.ts` — prompt、chat model、output parser 与 LCEL。
- `src/index.ts` — `/api/ask`、校验、超时与安全错误响应。
- `public/` — 原生 HTML/CSS/JS；示例填充、字符数、加载/成功/错误状态与响应式布局。
- `wrangler.jsonc` / `.dev.vars.example` — 静态资源、Worker 与凭据配置。
- `test/worker.test.ts` / `vitest.config.ts` — Workers 运行时测试。

参考：[LangChain Cloudflare chat model](https://docs.langchain.com/oss/javascript/integrations/chat/cloudflare_workersai)、[Cloudflare 模型说明](https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct/)。
