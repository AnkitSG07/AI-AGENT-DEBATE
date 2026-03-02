# AI-AGENT-DEBATE

## Product Knowledge Bot

A floating **Ask AI** chatbot is available in the UI (bottom-left launcher).

### Configure knowledge
1. Edit `product-knowledge.md` with your product, pairing, integration, compliance, and company details.
2. Start the app with `GEMINI_API_KEY` configured.

### Retrieval architecture (upgraded)
- Uses **Gemini embeddings** (`text-embedding-004` by default) to index chunks from `product-knowledge.md`.
- Uses **semantic retrieval** to fetch top relevant chunks for each question.
- Falls back to keyword retrieval if embedding generation fails.
- Sends only retrieved chunks (not full file) to the answer model (`gemini-2.5-flash`).

### Bot modes
The widget supports these modes:
- `simple_chatbot` → Simple website chatbot
- `b2b_sales_assistant` → Advanced B2B sales assistant
- `compliance_assistant` → Export-grade compliance assistant
- `sales_automation` → Full AI sales automation system

### Environment variables
- `PRODUCT_KNOWLEDGE_PATH` (default: `./product-knowledge.md`)
- `PRODUCT_BOT_CONTEXT` (fallback inline context if file is unavailable)
- `PRODUCT_BOT_EMBED_MODEL` (default: `text-embedding-004`)
- `PRODUCT_BOT_TOP_K` (default: `6`)

### API
#### `GET /api/product-bot/modes`
Returns available bot modes for the widget.

#### `POST /api/product-bot`
Request body:
```json
{
  "message": "What integrations are available?",
  "mode": "b2b_sales_assistant",
  "history": [{ "role": "user", "content": "..." }]
}
```

Response includes `answer` plus retrieval metadata (`strategy`, `sources`, `pricing_status`, `policy_status`, `compliance_status`, `disclaimer_required`).


- `sales_automation` mode supports JSON workflow outputs for quote intake templates.
