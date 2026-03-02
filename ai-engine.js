// ai-engine.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");

// ====== OpenAI (IA) ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";
const OPENAI_PROJECT = process.env.OPENAI_PROJECT || null;
const OPENAI_ORG = process.env.OPENAI_ORG || null;

// Liga/desliga IA sem alterar código (Render env):
// AI_ENABLED="false" desliga. Qualquer outro valor = ligado.
const AI_ENABLED = String(process.env.AI_ENABLED || "").toLowerCase() === "false" ? false : true;

// ====== RTBRAIN (base do robô) ======
function loadRtBrain() {
  try {
    const p = path.join(__dirname, "rtbrain.txt");
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, "utf8");
    }
  } catch (_) {}
  return null;
}
const RTBRAIN_TEXT = loadRtBrain();

// ====== OpenAI config checks ======
function requireOpenAIConfig() {
  const missing = [];
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!OPENAI_MODEL) missing.push("OPENAI_MODEL");
  return missing;
}

function canUseAI() {
  const missingAI = requireOpenAIConfig();
  return AI_ENABLED && missingAI.length === 0;
}

// ====== RTBRAIN System Prompt (TRAVADO) ======
function buildLockedSystemPrompt() {
  const base = String(RTBRAIN_TEXT || "").trim();

  // Escopo explícito (pra IA não “viajar”)
  const scope = `
ESCOPO PERMITIDO (apenas):
- Remoção de tatuagem
- Remoção de micropigmentação de sobrancelha
- Tratamento de estrias
- Harmonização facial (Dra. Thay)

PROIBIDO:
- Responder qualquer coisa fora do escopo (ex.: carros, saúde geral, receitas, dicas de produtos).
- Inventar informação, sugerir técnicas/medicamentos/procedimentos que não estejam no RTBRAIN.
- Buscar/usar internet, notícias, referências externas, ou "conhecimento geral" fora do RTBRAIN.
`;

  const rules = `
REGRAS DE ESTILO:
- Soe humano, cordial, direto e curto.
- 2 a 4 frases.
- Faça no máximo 1 pergunta objetiva no final (se precisar).
- Não repita a mesma resposta.
- Não misture procedimentos.
- Se o cliente perguntar algo fora do escopo OU algo que não esteja no RTBRAIN:
  1) diga que vai confirmar com a Larissa e retornar
  2) faça 1 pergunta para trazer para o menu (tatuagem / sobrancelha / estrias / harmonização).
`;

  const fallbackIfNoBrain = `
Você é um atendente humano, cordial e objetivo.
Você só pode responder sobre: tatuagem, sobrancelha, estrias ou harmonização facial.
Se for fora disso, diga que vai confirmar com Larissa e faça 1 pergunta para o cliente escolher um desses 4.
`;

  return base ? `${base}\n\n${scope}\n${rules}` : `${fallbackIfNoBrain}\n${scope}\n${rules}`;
}

function looksLikeOutOfScope(text) {
  const t = String(text || "").toLowerCase();
  // Esse filtro é simples e serve como “cinto de segurança”.
  // A IA também está travada no system prompt.
  const allowedHints = ["tatu", "sobr", "micro", "estria", "harmon", "botox", "preench", "laser"];
  return !allowedHints.some((h) => t.includes(h));
}

// ====== OpenAI call (Responses API) ======
async function openaiCreateReply({ system, user }) {
  const missing = requireOpenAIConfig();
  if (missing.length) {
    throw new Error("Config OpenAI incompleta: " + missing.join(", "));
  }

  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (OPENAI_PROJECT) headers["OpenAI-Project"] = OPENAI_PROJECT;
  if (OPENAI_ORG) headers["OpenAI-Organization"] = OPENAI_ORG;

  const resp = await axios.post(
    "https://api.openai.com/v1/responses",
    {
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: String(system || "") },
        { role: "user", content: String(user || "") },
      ],
    },
    { timeout: 20000, headers }
  );

  const outText = resp?.data?.output_text;
  if (typeof outText === "string") return outText.trim();

  const output = resp?.data?.output;
  if (Array.isArray(output)) {
    let acc = "";
    for (const item of output) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === "output_text" && typeof c?.text === "string") acc += c.text;
          if (c?.type === "text" && typeof c?.text === "string") acc += c.text;
        }
      }
    }
    return String(acc || "").trim();
  }

  return "";
}

// ====== Engine (1 função “principal” que o server usa) ======
async function generateLockedReply(userText) {
  const systemPrompt = buildLockedSystemPrompt();
  return await openaiCreateReply({
    system: systemPrompt,
    user: String(userText || ""),
  });
}

module.exports = {
  // status/consts
  AI_ENABLED,
  OPENAI_MODEL,
  RTBRAIN_TEXT,

  // helpers
  requireOpenAIConfig,
  canUseAI,
  buildLockedSystemPrompt,
  looksLikeOutOfScope,

  // core
  openaiCreateReply,
  generateLockedReply,
};