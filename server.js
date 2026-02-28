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

const OR_MODEL_LLAMA =
  process.env.OR_MODEL_LLAMA || "meta-llama/llama-3.1-8b-instruct";
const OR_MODEL_MISTRAL =
  process.env.OR_MODEL_MISTRAL || "mistralai/mistral-7b-instruct";

if (!GEMINI_API_KEY) console.error("Missing GEMINI_API_KEY");
if (!OPENROUTER_API_KEY) console.error("Missing OPENROUTER_API_KEY");

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ---------- Debate System Prompts ----------
const FORMAT_RULES = `
Rules:
- Do NOT invent facts. If unsure, say "UNCERTAIN" and explain what would confirm it.
- Keep it concise but complete.
- Use the required format strictly.
`;

const AGENT_A_SYSTEM = `
You are Agent A (Gemini). Your job is to produce a strong first answer and then debate.

Required format:
CLAIMS:
- ...
ASSUMPTIONS:
- ...
QUESTIONS FOR OTHERS:
1) ...
2) ...
3) ...
PROPOSED FINAL CHANGES:
- ...
${FORMAT_RULES}
`;

const AGENT_B_SYSTEM = `
You are Agent B (Llama via OpenRouter). Your job: challenge weak logic, correct errors, and improve clarity.

Required format:
RESPONSE TO PREVIOUS:
- ...
CORRECTIONS / DISAGREEMENTS:
- ...
QUESTIONS FOR OTHERS:
1) ...
2) ...
3) ...
PROPOSED FINAL CHANGES:
- ...
${FORMAT_RULES}
`;

const AGENT_C_SYSTEM = `
You are Agent C (Mistral via OpenRouter). Your job: spot edge-cases, missing constraints, and propose a better synthesis.

Required format:
RESPONSE TO PREVIOUS:
- ...
RISKS / EDGE CASES:
- ...
QUESTIONS FOR OTHERS:
1) ...
2) ...
3) ...
PROPOSED FINAL CHANGES:
- ...
${FORMAT_RULES}
`;

const JUDGE_SYSTEM = `
You are the Judge (Gemini). You will read the full debate and produce ONE final answer for the user.

Rules:
- Do NOT invent facts.
- Prefer claims agreed upon by multiple agents.
- Clearly mark uncertain points as "Depends / Uncertain".
- If user input is missing, ask up to 3 short questions.

Output format:
FINAL ANSWER:
...

AGREED POINTS:
- ...

CONTRADICTIONS / OPEN QUESTIONS:
- ...

NEXT QUESTIONS (if needed):
- ...
${FORMAT_RULES}
`;

// ---------- Helpers ----------
function nowISO() {
  return new Date().toISOString();
}

function safeTrim(x) {
  return (x || "").toString().trim();
}

function historyToText(history) {
  return history
    .map((m) => {
      const who = m.agentName
        ? `${m.role.toUpperCase()}(${m.agentName})`
        : m.role.toUpperCase();
      return `${who}:\n${m.content}`;
    })
    .join("\n\n---\n\n");
}

// ---------- Model Calls ----------
async function callGemini({ system, prompt, debateText }) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const fullPrompt =
    `${system}\n\n` +
    `USER PROMPT:\n${prompt}\n\n` +
    (debateText ? `DEBATE SO FAR:\n${debateText}\n\n` : "") +
    `Now produce your next message in the required format.`;

  const result = await model.generateContent(fullPrompt);
  return safeTrim(result?.response?.text?.());
}

async function callOpenRouter({ system, prompt, debateText, modelName }) {
  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content:
        `USER PROMPT:\n${prompt}\n\n` +
        (debateText ? `DEBATE SO FAR:\n${debateText}\n\n` : "") +
        `Now produce your next message in the required format.`
    }
  ];

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_URL || "http://localhost",
      "X-Title": "AI Agent Debate"
    },
    body: JSON.stringify({
      model: modelName,
      messages,
      temperature: 0.35
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenRouter error: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  return safeTrim(data?.choices?.[0]?.message?.content);
}

// ---------- Streaming Endpoint (NDJSON) ----------
app.post("/api/debate-stream", async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  try {
    const { prompt, rounds = 2, showDebate = true } = req.body || {};

    if (!prompt || typeof prompt !== "string") {
      send({ type: "error", at: nowISO(), message: "Missing prompt (string)." });
      return res.end();
    }

    const agents = [
      { key: "agent_a", name: "Gemini", provider: "gemini", system: AGENT_A_SYSTEM },
      { key: "agent_b", name: "Llama", provider: "openrouter", system: AGENT_B_SYSTEM, model: OR_MODEL_LLAMA },
      { key: "agent_c", name: "Mistral", provider: "openrouter", system: AGENT_C_SYSTEM, model: OR_MODEL_MISTRAL }
    ];

    const history = [{ role: "user", content: prompt }];

    send({
      type: "meta",
      at: nowISO(),
      prompt,
      rounds,
      agents: agents.map((a) => ({
        name: a.name,
        provider: a.provider,
        model: a.model || "gemini-1.5-flash"
      }))
    });

    const totalTurns = Math.max(1, Number(rounds)) * agents.length;

    for (let i = 0; i < totalTurns; i++) {
      const agent = agents[i % agents.length];
      const debateText = historyToText(history);

      send({
        type: "status",
        at: nowISO(),
        message: `Thinking… ${agent.name} (turn ${i + 1}/${totalTurns})`
      });

      let content = "";
      if (agent.provider === "gemini") {
        content = await callGemini({ system: agent.system, prompt, debateText });
      } else {
        content = await callOpenRouter({
          system: agent.system,
          prompt,
          debateText,
          modelName: agent.model
        });
      }

      history.push({ role: agent.key, agentName: agent.name, content });

      if (showDebate) {
        send({
          type: "turn",
          at: nowISO(),
          turn: i + 1,
          agent: agent.name,
          content
        });
      }
    }

    send({ type: "status", at: nowISO(), message: "Judge is synthesizing the final answer…" });

    const finalAnswer = await callGemini({
      system: JUDGE_SYSTEM,
      prompt,
      debateText: historyToText(history)
    });

    send({ type: "final", at: nowISO(), content: finalAnswer });
    send({ type: "done", at: nowISO() });
    return res.end();
  } catch (err) {
    send({ type: "error", at: nowISO(), message: String(err?.message || err) });
    return res.end();
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
