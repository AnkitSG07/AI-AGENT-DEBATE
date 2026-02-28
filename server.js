import express from "express";
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
