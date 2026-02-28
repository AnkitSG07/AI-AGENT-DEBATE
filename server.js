import express from "express";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!GEMINI_API_KEY) console.error("❌ Missing GEMINI_API_KEY");
if (!OPENROUTER_API_KEY) console.error("❌ Missing OPENROUTER_API_KEY");

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ====== MODEL CONFIG ======
const GEMINI_MODEL = "gemini-1.5-flash-latest";
const LLAMA_MODEL =
  process.env.OR_MODEL_LLAMA || "meta-llama/llama-3.1-8b-instruct";
const MISTRAL_MODEL =
  process.env.OR_MODEL_MISTRAL || "mistralai/mistral-7b-instruct";

// ====== PROMPTS ======
const BASE_RULES = `
Rules:
- Do NOT invent facts.
- If unsure, say "UNCERTAIN".
- Be concise but logical.
- Follow required format strictly.
`;

const AGENT_A_SYSTEM = `
You are Agent A (Gemini).
Provide a strong answer and start the debate.

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
You are Agent B (Llama).
Challenge weak reasoning and correct mistakes.

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
You are Agent C (Mistral).
Focus on risks and missing constraints.

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

// ====== HELPERS ======
function now() {
  return new Date().toISOString();
}

function historyToText(history) {
  return history
    .map((m) => `${m.role.toUpperCase()} (${m.agent || "User"}):\n${m.content}`)
    .join("\n\n---\n\n");
}

// ====== GEMINI CALL ======
async function callGemini(system, prompt, debateText) {
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const fullPrompt =
    `${system}\n\n` +
    `USER PROMPT:\n${prompt}\n\n` +
    (debateText ? `DEBATE SO FAR:\n${debateText}\n\n` : "");

  const result = await model.generateContent(fullPrompt);
  return (result?.response?.text?.() || "").trim();
}

// ====== OPENROUTER CALL ======
async function callOpenRouter(system, prompt, debateText, modelName) {
  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || "http://localhost",
        "X-Title": "AI Debate App"
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content:
              `USER PROMPT:\n${prompt}\n\n` +
              (debateText ? `DEBATE SO FAR:\n${debateText}\n\n` : "")
          }
        ],
        temperature: 0.4
      })
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter Error: ${err}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

// ====== STREAMING ENDPOINT ======
app.post("/api/debate-stream", async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  try {
    const { prompt, rounds = 1 } = req.body;
    if (!prompt) {
      send({ type: "error", message: "Missing prompt" });
      return res.end();
    }

    const agents = [
      { name: "Gemini", type: "gemini", system: AGENT_A_SYSTEM },
      { name: "Llama", type: "openrouter", system: AGENT_B_SYSTEM, model: LLAMA_MODEL },
      { name: "Mistral", type: "openrouter", system: AGENT_C_SYSTEM, model: MISTRAL_MODEL }
    ];

    const history = [{ role: "user", content: prompt }];

    const totalTurns = rounds * agents.length;

    for (let i = 0; i < totalTurns; i++) {
      const agent = agents[i % agents.length];
      const debateText = historyToText(history);

      send({
        type: "status",
        message: `Thinking... ${agent.name}`,
        time: now()
      });

      let reply;

      if (agent.type === "gemini") {
        reply = await callGemini(agent.system, prompt, debateText);
      } else {
        reply = await callOpenRouter(
          agent.system,
          prompt,
          debateText,
          agent.model
        );
      }

      history.push({ role: "assistant", agent: agent.name, content: reply });

      send({
        type: "turn",
        agent: agent.name,
        content: reply,
        time: now()
      });
    }

    // Judge
    send({ type: "status", message: "Judge finalizing answer...", time: now() });

    const finalAnswer = await callGemini(
      JUDGE_SYSTEM,
      prompt,
      historyToText(history)
    );

    send({
      type: "final",
      content: finalAnswer,
      time: now()
    });

    send({ type: "done" });
    res.end();
  } catch (err) {
    send({ type: "error", message: err.message });
    res.end();
  }
});

// ====== HEALTH CHECK ======
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
