import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!GEMINI_API_KEY) console.error("❌ Missing GEMINI_API_KEY");
if (!OPENROUTER_API_KEY) console.error("❌ Missing OPENROUTER_API_KEY");

// Gemini (new SDK)
const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Models (match your Render env var names exactly)
const GEMINI_MODEL = "gemini-2.5-flash";

const LLAMA_MODEL =
  process.env.OR_MODEL_LLAMA || "meta-llama/llama-3.1-8b-instruct";

const MISTRAL_MODEL =
  process.env.OR_MODEL_MISTRAL || "google/gemma-2-9b-it";

// Print once in logs (helps debugging on Render)
console.log("✅ Using Gemini model:", GEMINI_MODEL);
console.log("✅ Using OpenRouter model (Llama):", LLAMA_MODEL);
console.log("✅ Using OpenRouter model (Mistral/Gemma):", MISTRAL_MODEL);

// ===== PROMPTS =====
const BASE_RULES = `
Rules:
- Do NOT invent facts.
- If unsure, say "UNCERTAIN".
- Be concise and logical.
- Follow required format strictly.
`;

const AGENT_A_SYSTEM = `
You are Agent A (Gemini).
Start the debate with a strong answer.

Format:
CLAIMS:
- ...
ASSUMPTIONS:
- ...
QUESTIONS:
1) ...
2) ...
PROPOSED CHANGES:
- ...
${BASE_RULES}
`;

const AGENT_B_SYSTEM = `
You are Agent B (OpenRouter Model 1).
Challenge reasoning and fix weak logic.

Format:
RESPONSE:
- ...
DISAGREEMENTS:
- ...
QUESTIONS:
1) ...
2) ...
PROPOSED CHANGES:
- ...
${BASE_RULES}
`;

const AGENT_C_SYSTEM = `
You are Agent C (OpenRouter Model 2).
Focus on risks and edge cases.

Format:
RESPONSE:
- ...
RISKS:
- ...
QUESTIONS:
1) ...
2) ...
PROPOSED CHANGES:
- ...
${BASE_RULES}
`;

const JUDGE_SYSTEM = `
You are the Judge (Gemini).
Read the full debate and produce ONE final unified answer.

Format:
FINAL ANSWER:
...

AGREED POINTS:
- ...

UNCERTAIN OR CONFLICTING:
- ...
${BASE_RULES}
`;

// ===== HELPERS =====
function now() {
  return new Date().toISOString();
}

function historyToText(history) {
  return history
    .map((m) => `${m.agent}:\n${m.content}`)
    .join("\n\n---\n\n");
}

// ===== GEMINI CALL =====
async function callGemini(system, prompt, debateText) {
  const fullPrompt =
    `${system}\n\nUSER PROMPT:\n${prompt}\n\n` +
    (debateText ? `DEBATE SO FAR:\n${debateText}` : "");

  const response = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: fullPrompt
  });

  return response.text?.trim() || "";
}

// ===== OPENROUTER CALL with fallback =====
async function callOpenRouter(system, prompt, debateText, modelName) {
  const fallbacks = [
    modelName,
    "google/gemma-2-9b-it",
    "meta-llama/llama-3.1-8b-instruct",
    "meta-llama/llama-3-8b-instruct"
  ];

  let lastErr = null;

  for (const m of fallbacks) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_URL || "http://localhost",
          "X-Title": "AI Agent Debate"
        },
        body: JSON.stringify({
          model: m,
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content:
                `USER PROMPT:\n${prompt}\n\n` +
                (debateText ? `DEBATE SO FAR:\n${debateText}` : "")
            }
          ],
          temperature: 0.4
        })
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(err);
      }

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content?.trim() || "";
      if (!text) throw new Error("Empty response from provider");
      return text;
    } catch (e) {
      lastErr = e;
    }
  }

  throw new Error(`OpenRouter Error (all models failed): ${String(lastErr?.message || lastErr)}`);
}

// ===== STREAMING ENDPOINT =====
app.post("/api/debate-stream", async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  try {
    const { prompt, rounds = 1, showDebate = true } = req.body || {};
    if (!prompt) {
      send({ type: "error", message: "Missing prompt" });
      return res.end();
    }

    const agents = [
      { name: "Gemini", type: "gemini", system: AGENT_A_SYSTEM },
      { name: "Llama", type: "openrouter", system: AGENT_B_SYSTEM, model: LLAMA_MODEL },
      { name: "Gemma", type: "openrouter", system: AGENT_C_SYSTEM, model: MISTRAL_MODEL }
    ];

    send({ type: "meta", time: now(), agents: agents.map(a => a.name), rounds });

    const history = [{ agent: "User", content: prompt }];
    const totalTurns = Math.max(1, Number(rounds)) * agents.length;

    for (let i = 0; i < totalTurns; i++) {
      const agent = agents[i % agents.length];
      const debateText = historyToText(history);

      send({ type: "status", message: `Thinking... ${agent.name}`, time: now() });

      let reply = "";
      if (agent.type === "gemini") {
        reply = await callGemini(agent.system, prompt, debateText);
      } else {
        reply = await callOpenRouter(agent.system, prompt, debateText, agent.model);
      }

      history.push({ agent: agent.name, content: reply });

      if (showDebate) {
        send({ type: "turn", agent: agent.name, content: reply, time: now() });
      }
    }

    send({ type: "status", message: "Judge finalizing...", time: now() });

    const finalAnswer = await callGemini(JUDGE_SYSTEM, prompt, historyToText(history));

    send({ type: "final", content: finalAnswer, time: now() });
    send({ type: "done", time: now() });
    res.end();
  } catch (err) {
    send({ type: "error", message: err.message, time: now() });
    res.end();
  }
});

// Health
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
