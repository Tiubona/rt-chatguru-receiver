// ai-engine.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { Pool } = require("pg");

// ====== OpenAI (IA) ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";
const OPENAI_PROJECT = process.env.OPENAI_PROJECT || null;
const OPENAI_ORG = process.env.OPENAI_ORG || null;

// Liga/desliga IA sem alterar código (Render env):
// AI_ENABLED="false" desliga. Qualquer outro valor = ligado.
const AI_ENABLED = String(process.env.AI_ENABLED || "").toLowerCase() === "false" ? false : true;

// ====== DB (para buscar treino) ======
const DATABASE_URL = process.env.DATABASE_URL || null;
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : undefined,
    })
  : null;

// ====== RTBRAIN (base do robô) ======
function loadRtBrain() {
  try {
    const p = path.join(__dirname, "rtbrain.txt");
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
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

// ====== Treino: buscar exemplos do banco ======
function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4)
    .slice(0, 10);
}

async function getTrainingExamples(userText, limit = 6) {
  if (!pool) return [];

  const words = tokenize(userText);
  if (!words.length) {
    const r = await pool.query(
      `SELECT tag, user_text, ideal_answer
       FROM ai_training
       ORDER BY id DESC
       LIMIT $1`,
      [limit]
    );
    return r.rows || [];
  }

  const likes = words.map((w) => `%${w}%`);
  const params = [];
  const where = [];

  likes.forEach((lk) => {
    params.push(lk);
    const p = `$${params.length}`;
    where.push(`user_text ILIKE ${p} OR tag ILIKE ${p}`);
  });

  params.push(limit);
  const limitParam = `$${params.length}`;

  const r = await pool.query(
    `SELECT tag, user_text, ideal_answer
     FROM ai_training
     WHERE ${where.join(" OR ")}
     ORDER BY id DESC
     LIMIT ${limitParam}`,
    params
  );

  return r.rows || [];
}

// ====== RTBRAIN System Prompt (TRAVADO) ======
function buildLockedSystemPrompt({ examples, historyBlockText, stateBlockText }) {
  const base = String(RTBRAIN_TEXT || "").trim();

  const scope = `
ESCOPO PERMITIDO (apenas):
- Remoção de tatuagem
- Remoção de micropigmentação de sobrancelha
- Tratamento de estrias
- Harmonização facial (Dra. Thay)

PROIBIDO:
- Responder qualquer coisa fora do escopo.
- Inventar informação, sugerir técnicas/medicamentos/procedimentos que não estejam no RTBRAIN.
- Usar internet ou conhecimento externo fora do RTBRAIN.
`.trim();

  const rules = `
REGRAS DE CONVERSA (MUITO IMPORTANTE):
- Você está em um chat contínuo. NÃO repita o que já foi feito.
- NÃO dê saudação se o estado disser que já foi saudado hoje.
- NÃO pergunte o nome se o estado já tiver nome.
- NÃO pergunte "qual procedimento" se o estado já tiver o procedimento escolhido.
- Se o cliente reclamar "já falei", reconheça e continue do ponto certo (sem reiniciar).

REGRAS DE ESTILO:
- Soe humano, cordial, direto e curto.
- 2 a 4 frases.
- Faça no máximo 1 pergunta objetiva no final (se precisar).
- Não repita a mesma resposta.
- Não misture procedimentos.
- Se for fora do escopo OU algo que não esteja no RTBRAIN:
  1) diga que vai confirmar com a Larissa e retornar
  2) faça 1 pergunta para trazer para o menu (tatuagem / sobrancelha / estrias / harmonização).
`.trim();

  const fallbackIfNoBrain = `
Você é um atendente humano, cordial e objetivo.
Você só pode responder sobre: tatuagem, sobrancelha, estrias ou harmonização facial.
Se for fora disso, diga que vai confirmar com Larissa e faça 1 pergunta para o cliente escolher um desses 4.
`.trim();

  const ex =
    Array.isArray(examples) && examples.length
      ? `
EXEMPLOS (use como referência de tom/estrutura quando fizer sentido):
${examples
  .slice(0, 6)
  .map((e, i) => {
    const tag = e.tag ? ` [${String(e.tag)}]` : "";
    return `(${i + 1}) Cliente${tag}: ${String(e.user_text || "").trim()}
Resposta ideal: ${String(e.ideal_answer || "").trim()}`;
  })
  .join("\n\n")}
`.trim()
      : "";

  const state =
    stateBlockText
      ? `
ESTADO DO ATENDIMENTO (verdade absoluta; obedeça isso):
${String(stateBlockText).trim()}
`.trim()
      : "";

  const history =
    historyBlockText
      ? `
CONTEXTO DO CHAT (mais recente por último):
${String(historyBlockText).trim()}
`.trim()
      : "";

  const head = base ? base : fallbackIfNoBrain;

  return `${head}\n\n${scope}\n\n${rules}\n\n${state}\n\n${history}\n\n${ex}`.trim();
}

// ✅ NÃO bloquear mensagem curta (WhatsApp é telegráfico)
function looksLikeOutOfScope(text) {
  const t = String(text || "").toLowerCase().trim();

  if (t.length <= 20) return false;

  const allowedHints = ["tatu", "sobr", "micro", "estria", "harmon", "botox", "preench", "laser"];
  if (allowedHints.some((h) => t.includes(h))) return false;

  const off = ["carro", "moto", "ipva", "bitcoin", "bet", "jogo", "política", "eleição", "advogado"];
  return off.some((w) => t.includes(w));
}

// ====== OpenAI call (Responses API) ======
async function openaiCreateReply({ system, user }) {
  const missing = requireOpenAIConfig();
  if (missing.length) throw new Error("Config OpenAI incompleta: " + missing.join(", "));

  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (OPENAI_PROJECT) headers["OpenAI-Project"] = OPENAI_PROJECT;
  if (OPENAI_ORG) headers["OpenAI-Organization"] = OPENAI_ORG;

  const payload = {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: [{ type: "input_text", text: String(system || "") }] },
      { role: "user", content: [{ type: "input_text", text: String(user || "") }] },
    ],
  };

  const resp = await axios.post("https://api.openai.com/v1/responses", payload, { timeout: 20000, headers });

  if (typeof resp?.data?.output_text === "string") return resp.data.output_text.trim();

  const output = resp?.data?.output;
  if (Array.isArray(output)) {
    let acc = "";
    for (const item of output) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if ((c?.type === "output_text" || c?.type === "text") && typeof c?.text === "string") acc += c.text;
        }
      }
    }
    return String(acc || "").trim();
  }

  return "";
}

// ====== Engine (principal) ======
async function generateLockedReply(userText, history = [], state = {}) {
  const examples = await getTrainingExamples(userText, 6);

  const historyBlockText =
    Array.isArray(history) && history.length
      ? history
          .slice(-12)
          .map((h) => `- ${String(h.text || "").trim()}`)
          .filter(Boolean)
          .join("\n")
      : "";

  const stateBlockText = state && typeof state === "object"
    ? [
        `greeted_today=${state.greeted_today ? "true" : "false"}`,
        `name=${state.name ? JSON.stringify(state.name) : "null"}`,
        `service=${state.service ? JSON.stringify(state.service) : "null"}`,
        `stage=${state.stage ? JSON.stringify(state.stage) : "null"}`,
      ].join("\n")
    : "";

  const systemPrompt = buildLockedSystemPrompt({
    examples,
    historyBlockText,
    stateBlockText,
  });

  return await openaiCreateReply({
    system: systemPrompt,
    user: String(userText || ""),
  });
}

module.exports = {
  AI_ENABLED,
  OPENAI_MODEL,
  RTBRAIN_TEXT,

  requireOpenAIConfig,
  canUseAI,
  buildLockedSystemPrompt,
  looksLikeOutOfScope,

  openaiCreateReply,
  generateLockedReply,
};