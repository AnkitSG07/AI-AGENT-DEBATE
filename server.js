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

const OR_MODEL_LLAMA = process.env.OR_MODEL_LLAMA || "meta-llama/llama-3.1-8b-instruct";
const OR_MODEL_MISTRAL = process.env.OR_MODEL_MISTRAL || "mistralai/mistral-7b-instruct";

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
  // history: [{role, agentName?, content}]
  return history
    .map((m) => {
      const who = m.agentName ? `${m.role.toUpperCase()}(${m.agentName})` : m.role.toUpperCase();
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
      // Recommended by OpenRouter:
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
  // NDJSON streaming so UI can display the debate live
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const send = (obj) => {
    res.write(JSON.stringify(obj) + "\n");
  };

  try {
    const { prompt, rounds = 2, showDebate = true } = req.body || {};

    if (!prompt || typeof prompt !== "string") {
      send({ type: "error", at: nowISO(), message: "Missing prompt (string)." });
      return res.end();
    }

    // rounds=2 => total turns = rounds * number_of_agents (3 agents) => 6 turns
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
      agents: agents.map((a) => ({ name: a.name, provider: a.provider, model: a.model || "gemini-1.5-flash" }))
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

    // Judge (Gemini)
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
});import express from "express";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!OPENAI_API_KEY || !GEMINI_API_KEY) {
  console.error("Missing OPENAI_API_KEY or GEMINI_API_KEY in environment.");
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const AGENT_A_SYSTEM = `
You are Agent A (ChatGPT-side). Your job: be precise, challenge weak assumptions, and ask the other agent 2 sharp questions.
Rules:
- Do NOT invent facts. If uncertain, label as "uncertain".
- Use this format:

CLAIMS:
- ...
ASSUMPTIONS:
- ...
QUESTIONS FOR AGENT B:
1) ...
2) ...
PROPOSED FINAL CHANGES:
- ...
`;

const AGENT_B_SYSTEM = `
You are Agent B (Gemini-side). Your job: verify, correct, and improve clarity. Ask Agent A 2 sharp questions back.
Rules:
- Do NOT invent facts. If uncertain, label as "uncertain".
- Use this format:

RESPONSE TO AGENT A:
- ...
CORRECTIONS / DISAGREEMENTS:
- ...
QUESTIONS FOR AGENT A:
1) ...
2) ...
PROPOSED FINAL CHANGES:
- ...
`;

const JUDGE_SYSTEM = `
You are the Judge. You will read the full debate and produce ONE final answer for the user.

Rules:
- Do NOT invent facts.
- Prefer claims both agents agree on.
- Clearly mark uncertain points as "Depends / Uncertain".
- Output format:

FINAL ANSWER:
<clear, user-ready response>

AGREED POINTS:
- ...

CONTRADICTIONS / OPEN QUESTIONS:
- ...

(if needed) NEXT QUESTIONS TO ASK USER:
- ...
`;

// --- OpenAI call (Chat Completions style) ---
async function callOpenAI(messages) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini", // safe default; change if you want
      temperature: 0.3,
      messages
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI error: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

// --- Gemini call ---
async function callGemini(promptText) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const result = await model.generateContent(promptText);
  const text = result?.response?.text?.();
  return (text || "").trim();
}

// Helper: turn structured history into plain text for Gemini
function historyToText(history) {
  return history
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");
}

app.post("/api/debate", async (req, res) => {
  try {
    const { prompt, turns = 4, showDebate = true } = req.body || {};

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Missing prompt (string)." });
    }

    // history entries: { role: "user"|"agent_a"|"agent_b", content: "..." }
    const history = [{ role: "user", content: prompt }];

    // Debate loop
    for (let i = 0; i < turns; i++) {
      const isAgentA = i % 2 === 0;

      if (isAgentA) {
        // Agent A via OpenAI
        const messages = [
          { role: "system", content: AGENT_A_SYSTEM },
          {
            role: "user",
            content:
              `User prompt:\n${prompt}\n\nDebate so far:\n` +
              history.map(h => `${h.role}: ${h.content}`).join("\n\n") +
              `\n\nNow write your next turn as Agent A.`
          }
        ];
        const aText = await callOpenAI(messages);
        history.push({ role: "agent_a", content: aText });
      } else {
        // Agent B via Gemini
        const geminiPrompt =
          `${AGENT_B_SYSTEM}\n\n` +
          `User prompt:\n${prompt}\n\nDebate so far:\n${historyToText(history)}\n\n` +
          `Now write your next turn as Agent B.`;
        const bText = await callGemini(geminiPrompt);
        history.push({ role: "agent_b", content: bText });
      }
    }

    // Judge step (use OpenAI as judge for simplicity)
    const judgeMessages = [
      { role: "system", content: JUDGE_SYSTEM },
      {
        role: "user",
        content:
          `User prompt:\n${prompt}\n\nFull debate transcript:\n` +
          history.map(h => `${h.role}: ${h.content}`).join("\n\n")
      }
    ];
    const finalAnswer = await callOpenAI(judgeMessages);

    return res.json({
      finalAnswer,
      debate: showDebate ? history : undefined
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
