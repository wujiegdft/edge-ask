const form = document.querySelector("#ask-form");
const documentInput = document.querySelector("#document");
const questionInput = document.querySelector("#question");
const exampleButton = document.querySelector("#example");
const submitButton = document.querySelector("#submit");
const submitLabel = document.querySelector("#submit-label");
const answerPanel = document.querySelector("#answer-panel");
const answer = document.querySelector("#answer");
const answerState = document.querySelector("#answer-state");
const count = document.querySelector("#document-count");

documentInput.addEventListener("input", () => {
  count.textContent = `${documentInput.value.length.toLocaleString("en-US")} / 20,000`;
});

exampleButton.addEventListener("click", () => {
  documentInput.value = `Edge Ask is a small document question-answering demo built with TypeScript on Cloudflare Workers.

When you ask a question, a LangChain text splitter divides your document into overlapping chunks. Workers AI embeds those chunks and your question. Cloudflare Vectorize stores the chunks temporarily in an isolated request namespace and retrieves the four most relevant ones.

The backend uses LangChain Expression Language (LCEL). A PromptTemplate combines only the retrieved chunks and question into a prompt. The same Workers AI chat model generates a response. A StringOutputParser turns that response into plain text.

Edge Ask requests deletion of temporary vectors after retrieval, but cleanup is best-effort. It keeps no conversation history and uses no agents or tools. Each question independently indexes and searches the pasted document.`;
  questionInput.value = "What happens to my document when I ask a question?";
  documentInput.setCustomValidity("");
  questionInput.setCustomValidity("");
  documentInput.dispatchEvent(new Event("input"));
  questionInput.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submitButton.disabled) return;

  for (const input of [documentInput, questionInput]) {
    if (!input.value.trim()) {
      input.setCustomValidity("Please enter some text, not just spaces.");
      input.reportValidity();
      input.addEventListener("input", () => input.setCustomValidity(""), { once: true });
      return;
    }
  }

  const payload = { document: documentInput.value, question: questionInput.value };
  submitButton.disabled = true;
  exampleButton.disabled = true;
  documentInput.readOnly = true;
  questionInput.readOnly = true;
  submitLabel.textContent = "Reading…";
  answerPanel.dataset.state = "loading";
  answerPanel.setAttribute("aria-busy", "true");
  answerState.textContent = "READING YOUR DOCUMENT";
  answer.textContent = "Following the context. Finding your answer…";

  try {
    const response = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(75_000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");

    // Model output is untrusted text, never HTML or unsanitized Markdown.
    answer.textContent = data.answer;
    answerState.textContent = "BASED ON YOUR DOCUMENT";
    answerPanel.dataset.state = "success";
  } catch (error) {
    answer.textContent = error.name === "TimeoutError"
      ? "The request timed out. Please try again."
      : error instanceof TypeError
        ? "Couldn't reach the Worker. Check your connection and try again."
        : error.message;
    answerState.textContent = "COULDN'T GET AN ANSWER";
    answerPanel.dataset.state = "error";
  } finally {
    answerPanel.setAttribute("aria-busy", "false");
    submitButton.disabled = false;
    exampleButton.disabled = false;
    documentInput.readOnly = false;
    questionInput.readOnly = false;
    submitLabel.textContent = "Ask document";
  }
});
