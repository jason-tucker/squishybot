# SquishyBot — AI / LLM / RAG / Agent Safety Review

## Verdict: Not applicable — no AI/LLM surface exists in this codebase.

A full search of the repository found **no** large-language-model, embedding, vector-DB, RAG,
agent, tool-calling, or model-file usage:

- No AI/LLM SDKs in `package.json` (`@anthropic-ai/*`, `openai`, `langchain`, `@google/generative-ai`, `cohere`, `ollama`, `transformers`, etc. — none present).
- No prompt templates, system prompts, embeddings, vector stores, or model files (`.gguf`/`.safetensors`/`.pt`/`.pkl`/`.onnx` — none).
- No `pickle` / `torch.load` / `joblib` / unsafe deserialization (this is a TypeScript project; `JSON.parse` outputs are validated into typed shapes — see HMAC envelope handling).
- The only "automation" is deterministic: voice-channel lifecycle, scheduled posts, RSS reposting, and HMAC-gated RPC verbs.

## The two GenAI-adjacent risks that *would* matter here, and their status
Even without an LLM, the GenAI-risk lens ("model/remote output used as code/SQL/shell/HTML
without validation", "untrusted retrieved content") maps onto two real surfaces, both already
addressed:

1. **Remote content treated as instructions/markup.** RSS feed content (titles, links, images)
   is third-party and untrusted. It is **never** executed, never used to build SQL/shell, and is
   posted to Discord with `allowedMentions: { parse: [] }` and `http(s)`-only URL gating — so a
   hostile feed cannot inject `@everyone`, `javascript:`/`data:` links, or mentions. The parser is
   non-executing (regex/`indexOf`), and the ReDoS + SSRF-redirect issues found in that path were
   fixed (H3, M1).

2. **Cross-actor command execution without per-actor authorization.** The RPC bus is the nearest
   analogue to "excessive agency / unsafe tool calling": botpanel asks the bot to perform
   privileged actions on behalf of a user the bot never authorizes. This is mitigated by HMAC
   signing + replay protection, and the most dangerous "tool" (role granting) is now gated by an
   **allowlist-style assignability guard** (`roleGuard.ts`) so it cannot hand out privileged roles
   regardless of caller (H1/H2). Full "human-approval-for-destructive-tools" already exists for the
   `/report` → GitHub flow (owner approves via DM) and staff-role grants (sudo approves).

## Recommendation
If an LLM feature is added later (e.g. a chat/summarize command), apply: instruction/data
separation, structured-output validation before any side-effect, tool allowlists with the same
`roleGuard`-style guards on any privileged action, per-user/tenant scoping on any memory/retrieval,
redaction of secrets/PII from prompts and traces (the logger already redacts the known secrets),
and prompt-injection regression tests. None of this is required today.
