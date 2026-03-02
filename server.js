const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// ====== Persistência local (debug) ======
const EVENTS_FILE = path.join(__dirname, "events.jsonl");

// ====== Config ChatGuru API (Render env vars) ======
const CHATGURU_API_ENDPOINT = process.env.CHATGURU_API_ENDPOINT; // ex: https://app.zap.guru/api/v1
const CHATGURU_API_KEY = process.env.CHATGURU_API_KEY;
const CHATGURU_ACCOUNT_ID = process.env.CHATGURU_ACCOUNT_ID;
const CHATGURU_PHONE_ID = process.env.CHATGURU_PHONE_ID;

// Token para rotas administrativas "API" (send-test, reply-last etc.)
const RT_ADMIN_TOKEN = process.env.RT_ADMIN_TOKEN;

// ====== Admin Panel Login ======
const ADMIN_USER = process.env.ADMIN_USER || "admin";
// você pode setar ADMIN_PASSWORD direto (simples)
// ou setar ADMIN_PASSWORD_HASH (mais seguro)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || null;

// ⚠️ Reaproveitando sua env atual: se você já usa SESSION_SECRET, ele vira o segredo do JWT
const ADMIN_JWT_SECRET = process.env.SESSION_SECRET || "change_me_super_secret";
const ADMIN_JWT_COOKIE = "rt_admin_jwt";
const ADMIN_JWT_MAX_AGE_MS = 1000 * 60 * 60 * 12; // 12h

// ====== Email (alerts) ======
const SMTP_HOST = process.env.SMTP_HOST || null;
const SMTP_PORT = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : null;
const SMTP_USER = process.env.SMTP_USER || null;
const SMTP_PASS = process.env.SMTP_PASS || null;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || null;

// ====== DB (Postgres) ======
const DATABASE_URL = process.env.DATABASE_URL || null;
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : undefined,
    })
  : null;

// ====== Estado em memória (para TESTE) ======
let lastChat = null;

// ====== AUTO-REPLY (Gatilho) ======
const AUTO_TRIGGER_TEXT = "teste"; // "Teste" (case-insensitive)

// Quando a IA estiver ligada, essa mensagem fixa vira fallback
const AUTO_REPLY_FALLBACK_TEXT = "Recebi sua mensagem ✅ Só um segundo que já te respondo aqui.";

// ====== OpenAI (IA) ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
// Se você não setar, ele usa gpt-5.2 (pode trocar no Render depois)
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";
const OPENAI_PROJECT = process.env.OPENAI_PROJECT || null;
const OPENAI_ORG = process.env.OPENAI_ORG || null;

// Liga/desliga IA sem alterar código (Render env):
// AI_ENABLED="true" (padrão: true quando tem chave)
const AI_ENABLED = String(process.env.AI_ENABLED || "").toLowerCase() === "false" ? false : true;

// Tamanho máximo por mensagem (pra evitar textão quebrar no WhatsApp)
const MAX_WPP_CHARS = process.env.MAX_WPP_CHARS ? Number(process.env.MAX_WPP_CHARS) : 650;

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

// ====== Helpers ======
function appendEvent(obj) {
  try {
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(obj) + "\n", { encoding: "utf8" });
  } catch (_) {}
}

function maskKey(key) {
  if (!key || typeof key !== "string") return "(missing)";
  const end = key.slice(-4);
  return `****${end}`;
}

function requireChatGuruConfig() {
  const missing = [];
  if (!CHATGURU_API_ENDPOINT) missing.push("CHATGURU_API_ENDPOINT");
  if (!CHATGURU_API_KEY) missing.push("CHATGURU_API_KEY");
  if (!CHATGURU_ACCOUNT_ID) missing.push("CHATGURU_ACCOUNT_ID");
  if (!CHATGURU_PHONE_ID) missing.push("CHATGURU_PHONE_ID");
  return missing;
}

function requireOpenAIConfig() {
  const missing = [];
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!OPENAI_MODEL) missing.push("OPENAI_MODEL");
  return missing;
}

function requireAdminToken(req, res) {
  const token = req.headers["x-rt-admin-token"];
  if (!RT_ADMIN_TOKEN || token !== RT_ADMIN_TOKEN) {
    res.status(401).json({ ok: false, error: "Unauthorized (x-rt-admin-token inválido)" });
    return false;
  }
  return true;
}

// ====== Cookies (sem dependência) ======
function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const p = part.trim();
    if (!p) return;
    const idx = p.indexOf("=");
    if (idx === -1) return;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function setCookie(res, name, value, opts = {}) {
  const parts = [];
  parts.push(`${name}=${encodeURIComponent(value)}`);

  if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure) parts.push("Secure");

  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearCookie(res, name) {
  res.setHeader("Set-Cookie", `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
}

// ====== Auth (JWT) ======
function issueAdminJwt() {
  const payload = { admin: true };
  return jwt.sign(payload, ADMIN_JWT_SECRET, { expiresIn: "12h" });
}

function verifyAdminJwt(token) {
  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    return !!decoded && decoded.admin === true;
  } catch (_) {
    return false;
  }
}

function isAdminAuthed(req) {
  const cookies = parseCookies(req);
  const token = cookies[ADMIN_JWT_COOKIE] || null;
  if (!token) return false;
  return verifyAdminJwt(token);
}

function requireAdminSession(req, res) {
  if (!isAdminAuthed(req)) {
    res.redirect("/admin/login");
    return false;
  }
  return true;
}

// ====== ChatGuru Send ======
async function chatGuruSendMessage({ chatNumber, text, sendDate }) {
  const params = new URLSearchParams({
    key: CHATGURU_API_KEY,
    account_id: CHATGURU_ACCOUNT_ID,
    phone_id: CHATGURU_PHONE_ID,
    action: "message_send",
    text: String(text),
    chat_number: String(chatNumber),
  });

  if (sendDate) params.set("send_date", String(sendDate));

  const requestUrl = `${CHATGURU_API_ENDPOINT}?${params.toString()}`;

  const safeUrl = requestUrl.replace(/key=[^&]+/i, `key=${encodeURIComponent(maskKey(CHATGURU_API_KEY))}`);
  console.log("=== ChatGuru request (safe) ===");
  console.log(safeUrl);

  const resp = await axios.post(requestUrl, null, { timeout: 20000 });
  return resp.data;
}

// ====== 2-part send (para evitar corte) ======
function splitIntoTwoMessages(text, maxChars) {
  const t = String(text || "").trim();
  if (!t) return [""];

  if (t.length <= maxChars) return [t];

  // tenta quebrar em 2 partes com bom senso
  // prioridade: dupla quebra de linha, depois linha, depois ponto final
  const breakCandidates = ["\n\n", "\n", ". "];
  let cut = -1;

  for (const sep of breakCandidates) {
    const idx = t.lastIndexOf(sep, maxChars);
    if (idx > 80) {
      cut = idx + sep.length;
      break;
    }
  }

  if (cut === -1) cut = maxChars;

  const part1 = t.slice(0, cut).trim();
  const part2 = t.slice(cut).trim();

  // se ainda ficou enorme, corta a segunda (a regra aqui é 2 mensagens)
  if (part2.length > maxChars) {
    return [part1, part2.slice(0, maxChars).trim()];
  }
  return [part1, part2];
}

async function chatGuruSendPossiblyChunked({ chatNumber, fullText, source }) {
  const parts = splitIntoTwoMessages(fullText, MAX_WPP_CHARS).filter((p) => p && p.trim());
  const sentResults = [];

  for (let i = 0; i < parts.length; i++) {
    const data = await chatGuruSendMessage({ chatNumber, text: parts[i] });
    sentResults.push(data);
    await dbSaveSend({ celular: String(chatNumber), text: parts[i], source: String(source || "auto"), result: data });

    // micro delay entre msg 1 e 2 (evita "colar" / rate limit)
    if (i === 0 && parts.length > 1) {
      await new Promise((r) => setTimeout(r, 900));
    }
  }

  return sentResults;
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

  // Parsing robusto
  const outText = resp?.data?.output_text;
  if (typeof outText === "string") return outText.trim();

  // fallback: tenta achar texto em output[]
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

// ====== DB bootstrap ======
async function dbInit() {
  if (!pool) {
    console.log("DB: DATABASE_URL não configurado (painel funciona, mas métricas ficarão limitadas).");
    return;
  }
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS cg_events (
        id BIGSERIAL PRIMARY KEY,
        received_at TIMESTAMPTZ NOT NULL,
        origem TEXT,
        chat_id TEXT,
        phone_id TEXT,
        celular TEXT,
        nome TEXT,
        tipo_mensagem TEXT,
        texto_mensagem TEXT,
        payload JSONB NOT NULL
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_cg_events_received_at ON cg_events(received_at);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cg_events_celular ON cg_events(celular);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS cg_sends (
        id BIGSERIAL PRIMARY KEY,
        sent_at TIMESTAMPTZ NOT NULL,
        celular TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL, -- send-test | reply-last | auto | ai
        result JSONB
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_cg_sends_sent_at ON cg_sends(sent_at);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_config (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_training (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL,
        tag TEXT,
        user_text TEXT NOT NULL,
        ideal_answer TEXT NOT NULL
      );
    `);

    console.log("DB: tabelas OK");
  } finally {
    client.release();
  }
}

async function dbSaveEvent(body) {
  if (!pool) return;
  try {
    const receivedAt = new Date().toISOString();
    await pool.query(
      `
      INSERT INTO cg_events (received_at, origem, chat_id, phone_id, celular, nome, tipo_mensagem, texto_mensagem, payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `,
      [
        receivedAt,
        body.origem || null,
        body.chat_id || null,
        body.phone_id || null,
        body.celular || body.chat_number || body.telefone || null,
        body.nome || null,
        body.tipo_mensagem || null,
        body.texto_mensagem || null,
        body,
      ]
    );
  } catch (e) {
    console.log("DB: erro salvando evento:", e?.message || e);
  }
}

async function dbSaveSend({ celular, text, source, result }) {
  if (!pool) return;
  try {
    await pool.query(
      `
      INSERT INTO cg_sends (sent_at, celular, text, source, result)
      VALUES ($1,$2,$3,$4,$5)
      `,
      [new Date().toISOString(), String(celular), String(text), String(source), result || null]
    );
  } catch (e) {
    console.log("DB: erro salvando envio:", e?.message || e);
  }
}

async function cfgGet(key, fallbackJson) {
  if (!pool) return fallbackJson;
  try {
    const r = await pool.query(`SELECT value FROM admin_config WHERE key=$1`, [key]);
    if (r.rows.length) return r.rows[0].value;
  } catch (_) {}
  return fallbackJson;
}

async function cfgSet(key, valueJson) {
  if (!pool) return;
  await pool.query(
    `
    INSERT INTO admin_config (key, value)
    VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `,
    [key, valueJson]
  );
}

// ====== Email alerts ======
function canEmail() {
  return !!(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && SMTP_FROM);
}

function getMailer() {
  if (!canEmail()) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

async function sendAlertEmail(subject, text) {
  try {
    const recipients = await cfgGet("alert_emails", { emails: [] });
    const emails = Array.isArray(recipients.emails) ? recipients.emails : [];
    if (!emails.length) return;

    const transporter = getMailer();
    if (!transporter) return;

    await transporter.sendMail({
      from: SMTP_FROM,
      to: emails.join(","),
      subject,
      text,
    });
  } catch (e) {
    console.log("ALERT email fail:", e?.message || e);
  }
}

// ====== Pages (HTML) ======
function htmlLayout(title, body) {
  return `<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>
  <style>
    :root{
      --bg:#06162f;
      --card:#0b2450;
      --card2:#0d2c63;
      --text:#e8f1ff;
      --muted:#9db7e6;
      --accent:#3aa0ff;
      --accent2:#65c2ff;
      --danger:#ff6b6b;
      --ok:#48d597;
      --shadow: 0 10px 30px rgba(0,0,0,.35);
      --radius: 18px;
    }
    *{box-sizing:border-box}
    body{
      margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
      background: radial-gradient(1200px 600px at 20% 10%, #123a7a 0%, rgba(18,58,122,0) 60%),
                  radial-gradient(1000px 700px at 80% 0%, #0c2b63 0%, rgba(12,43,99,0) 55%),
                  var(--bg);
      color:var(--text);
    }
    a{color:var(--accent); text-decoration:none}
    .wrap{max-width:1100px; margin:0 auto; padding:24px}
    .topbar{
      display:flex; align-items:center; justify-content:space-between;
      padding:14px 18px; background:rgba(11,36,80,.7); border:1px solid rgba(255,255,255,.08);
      border-radius: var(--radius); box-shadow: var(--shadow); backdrop-filter: blur(10px);
    }
    .brand{display:flex; gap:10px; align-items:center}
    .dot{width:12px; height:12px; border-radius:999px; background:linear-gradient(135deg,var(--accent),var(--accent2))}
    .title{font-weight:800; letter-spacing:.2px}
    .nav{display:flex; gap:10px; flex-wrap:wrap}
    .pill{
      padding:8px 12px; border-radius:999px; background:rgba(255,255,255,.06);
      border:1px solid rgba(255,255,255,.10);
    }
    .grid{display:grid; grid-template-columns: repeat(12, 1fr); gap:16px; margin-top:16px}
    .card{
      grid-column: span 12;
      background: linear-gradient(180deg, rgba(13,44,99,.85), rgba(11,36,80,.85));
      border:1px solid rgba(255,255,255,.10);
      border-radius: var(--radius); box-shadow: var(--shadow);
      padding:16px;
    }
    .kpis{display:grid; grid-template-columns: repeat(4, 1fr); gap:12px}
    @media (max-width: 900px){ .kpis{grid-template-columns: repeat(2, 1fr);} }
    @media (max-width: 520px){ .kpis{grid-template-columns: 1fr;} }
    .kpi{
      background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.10);
      border-radius: 16px; padding:14px;
    }
    .kpi .label{color:var(--muted); font-size:12px; letter-spacing:.2px}
    .kpi .value{font-size:28px; font-weight:900; margin-top:6px}
    .row{display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end}
    input, textarea, select{
      width:100%; padding:10px 12px; border-radius: 14px; border:1px solid rgba(255,255,255,.12);
      background:rgba(0,0,0,.18); color:var(--text); outline:none;
    }
    textarea{min-height:110px; resize:vertical}
    button{
      padding:10px 14px; border-radius: 14px; border:1px solid rgba(255,255,255,.12);
      background: linear-gradient(135deg, rgba(58,160,255,.9), rgba(101,194,255,.9));
      color:#001430; font-weight:900; cursor:pointer;
    }
    button.secondary{
      background:rgba(255,255,255,.08); color:var(--text);
    }
    .hint{color:var(--muted); font-size:12px}
    .badge{display:inline-flex; gap:8px; align-items:center; padding:6px 10px; border-radius:999px; font-weight:800; font-size:12px}
    .ok{background:rgba(72,213,151,.12); border:1px solid rgba(72,213,151,.35); color:#a9ffd9}
    .bad{background:rgba(255,107,107,.10); border:1px solid rgba(255,107,107,.30); color:#ffd0d0}
    table{width:100%; border-collapse:collapse; margin-top:10px}
    th, td{padding:10px 8px; border-bottom:1px solid rgba(255,255,255,.10); text-align:left; font-size:13px}
    th{color:var(--muted); font-weight:800}
    .footer{margin-top:16px; color:var(--muted); font-size:12px}
    .center{min-height: calc(100vh - 48px); display:flex; align-items:center; justify-content:center}
    .loginCard{max-width:420px; width:100%}
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}

function loginPage(errorMsg) {
  const err = errorMsg ? `<div class="badge bad" style="margin-bottom:10px;">${errorMsg}</div>` : "";
  return htmlLayout(
    "RT Admin - Login",
    `<div class="wrap center">
      <div class="card loginCard">
        <div class="brand" style="margin-bottom:10px;">
          <div class="dot"></div>
          <div>
            <div class="title">RT Admin Panel</div>
            <div class="hint">Acesso restrito</div>
          </div>
        </div>
        ${err}
        <form method="POST" action="/admin/login">
          <div style="margin-bottom:10px;">
            <div class="hint">Usuário</div>
            <input name="user" placeholder="admin" />
          </div>
          <div style="margin-bottom:12px;">
            <div class="hint">Senha</div>
            <input name="pass" type="password" placeholder="••••••••" />
          </div>
          <button type="submit" style="width:100%;">Entrar</button>
          <div class="footer">Tema azul 5⭐ • RT ChatGuru Receiver</div>
        </form>
      </div>
    </div>`
  );
}

function adminShell(active) {
  const nav = (href, label) =>
    `<a class="pill" href="${href}" style="${
      active === href ? "background:rgba(58,160,255,.18);border-color:rgba(58,160,255,.35);" : ""
    }">${label}</a>`;
  return `
  <div class="wrap">
    <div class="topbar">
      <div class="brand">
        <div class="dot"></div>
        <div class="title">RT Admin Panel</div>
      </div>
      <div class="nav">
        ${nav("/admin", "Dashboard")}
        ${nav("/admin/chats", "Chats & Mensagens")}
        ${nav("/admin/alerts", "Alertas (Email)")}
        ${nav("/admin/training", "Treino IA")}
        <a class="pill" href="/admin/logout">Sair</a>
      </div>
    </div>
  `;
}

function adminFooter() {
  return `</div>`;
}

function short(s) {
  const t = (s || "").toString();
  return t.length > 70 ? t.slice(0, 70) + "…" : t;
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ====== Rotas base ======
app.get("/", (_req, res) => res.status(200).json({ ok: true, service: "rt-chatguru-receiver" }));
app.get("/health", (_req, res) => res.status(200).json({ status: "online" }));

// ====== Webhook receiver ======
app.post("/webhook/chatguru", async (req, res) => {
  const body = req.body || {};

  const event = {
    receivedAt: new Date().toISOString(),
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    headers: req.headers,
    body,
  };

  console.log("=== Webhook recebido (ChatGuru) ===");
  console.log(JSON.stringify(event, null, 2));

  // lastChat em memória (teste)
  const celular = body.celular || body.chat_number || body.telefone || null;
  const chatId = body.chat_id || null;

  if (celular) {
    lastChat = {
      updatedAt: new Date().toISOString(),
      celular: String(celular),
      chat_id: chatId ? String(chatId) : null,
      nome: body.nome ? String(body.nome) : null,
      phone_id: body.phone_id ? String(body.phone_id) : null,
      origem: body.origem ? String(body.origem) : null,
      texto_mensagem: body.texto_mensagem ? String(body.texto_mensagem) : null,
      tipo_mensagem: body.tipo_mensagem ? String(body.tipo_mensagem) : null,
    };

    console.log("=== lastChat atualizado ===");
    console.log(JSON.stringify(lastChat, null, 2));
  } else {
    console.log("⚠️ Webhook recebido, mas não achei 'celular' no body.");
  }

  appendEvent(event);
  await dbSaveEvent(body);

// ====== AUTO-REPLY / AI REPLY ======
try {
  const rawText = (body.texto_mensagem || "").toString();
  const normalized = rawText.trim().toLowerCase();
  const tipo = (body.tipo_mensagem || "").toString().toLowerCase();

  // Só responde chat "humano"
  if (!celular || !rawText.trim() || tipo !== "chat") {
    // ignora eventos vazios/sistema
    return res.status(200).json({ ok: true });
  }

  // --- trava anti-duplicação (memória) ---
  // assinatura baseada em chat_id + texto + datetime_post (ou receivedAt)
  const sig = `${body.chat_id || ""}::${rawText.trim()}::${body.datetime_post || event.receivedAt || ""}`;

  // guarda no lastChat também (rápido e simples)
  if (lastChat && lastChat._lastSig === sig) {
    console.log("🔁 Evento duplicado - ignorado:", sig);
    return res.status(200).json({ ok: true, duplicate: true });
  }
  if (lastChat) lastChat._lastSig = sig;

  // --- modo “teste” opcional ---
  const forceTest = normalized === AUTO_TRIGGER_TEXT; // "teste"

  // Se você quiser que responda SEMPRE, deixe a condição true.
  // Se você quiser responder só no "teste", deixe forceTest.
  const SHOULD_REPLY = true; // <<< aqui liga o robô de verdade

  if (!SHOULD_REPLY && !forceTest) {
    console.log("🛑 SHOULD_REPLY=false e não foi gatilho 'teste'. Ignorando.");
    return res.status(200).json({ ok: true });
  }

  // --- IA responde ---
  const missingCG = requireChatGuruConfig();
  if (missingCG.length) {
    console.log("⚠️ Não respondeu (faltam envs ChatGuru):", missingCG);
    return res.status(200).json({ ok: true, warn: "missing_chatguru_env" });
  }

  const missingAI = requireOpenAIConfig();
  const canUseAI = AI_ENABLED && missingAI.length === 0;

  if (!canUseAI) {
    console.log("⚠️ IA desligada ou sem chave. Enviando fallback.");
    const data = await chatGuruSendMessage({ chatNumber: String(celular), text: AUTO_REPLY_TEXT });
    await dbSaveSend({ celular: String(celular), text: AUTO_REPLY_TEXT, source: "auto", result: data });
    return res.status(200).json({ ok: true });
  }

  const systemPrompt =
    "Você é um atendente humano, rápido, cordial e objetivo. " +
    "Responda curto. Se faltar info, faça 1 pergunta objetiva. " +
    "Nunca repita a resposta duas vezes.";

  const reply = await openaiCreateReply({
    system: systemPrompt,
    user: rawText,
  });

  const finalText = (reply || "").trim() || AUTO_REPLY_TEXT;

  const data = await chatGuruSendMessage({
    chatNumber: String(celular),
    text: finalText,
  });

  await dbSaveSend({ celular: String(celular), text: finalText, source: "ai", result: data });
} catch (e) {
  console.log("⚠️ AI/AUTO-REPLY erro:", e?.message || e);
}

  return res.status(200).json({ ok: true });
});

// ====== send-test (manual) ======
app.post("/send-test", async (req, res) => {
  try {
    if (!requireAdminToken(req, res)) return;

    const missing = requireChatGuruConfig();
    if (missing.length) return res.status(500).json({ ok: false, error: "Config ChatGuru incompleta no servidor", missing });

    const { chat_number, text, send_date } = req.body || {};
    if (!chat_number || !text) return res.status(400).json({ ok: false, error: "Body inválido. Envie { chat_number, text }" });

    const data = await chatGuruSendMessage({
      chatNumber: String(chat_number),
      text: String(text),
      sendDate: send_date ? String(send_date) : undefined,
    });

    await dbSaveSend({ celular: chat_number, text, source: "send-test", result: data });

    return res.status(200).json({ ok: true, result: data });
  } catch (err) {
    const payload = err?.response?.data || null;
    const status = err?.response?.status || null;
    const msg = payload || err?.message || String(err);

    await sendAlertEmail("RT ALERTA: Falha no send-test", `Status: ${status}\nErro: ${JSON.stringify(msg)}`);

    return res.status(500).json({ ok: false, error: msg, status });
  }
});

// ====== reply-last (manual) ======
app.post("/reply-last", async (req, res) => {
  try {
    if (!requireAdminToken(req, res)) return;

    const missing = requireChatGuruConfig();
    if (missing.length) return res.status(500).json({ ok: false, error: "Config ChatGuru incompleta no servidor", missing });

    if (!lastChat || !lastChat.celular) {
      return res.status(400).json({ ok: false, error: "Ainda não existe lastChat em memória. Envie mensagem no webhook primeiro." });
    }

    const { text, send_date } = req.body || {};
    if (!text) return res.status(400).json({ ok: false, error: "Body inválido. Envie { text }" });

    const target = lastChat.celular;

    const data = await chatGuruSendMessage({
      chatNumber: target,
      text: String(text),
      sendDate: send_date ? String(send_date) : undefined,
    });

    await dbSaveSend({ celular: target, text, source: "reply-last", result: data });

    return res.status(200).json({ ok: true, target, lastChat, result: data });
  } catch (err) {
    const payload = err?.response?.data || null;
    const status = err?.response?.status || null;
    const msg = payload || err?.message || String(err);

    await sendAlertEmail("RT ALERTA: Falha no reply-last", `Status: ${status}\nErro: ${JSON.stringify(msg)}`);

    return res.status(500).json({ ok: false, error: msg, status });
  }
});

app.get("/last-chat", (req, res) => {
  const token = req.headers["x-rt-admin-token"];
  if (!RT_ADMIN_TOKEN || token !== RT_ADMIN_TOKEN) return res.status(401).json({ ok: false, error: "Unauthorized" });
  return res.status(200).json({ ok: true, lastChat });
});

// ================== ADMIN PANEL ==================

// Login pages
app.get("/admin/login", (_req, res) => res.status(200).send(loginPage(null)));

app.post("/admin/login", async (req, res) => {
  const user = String(req.body.user || "");
  const pass = String(req.body.pass || "");

  if (user !== ADMIN_USER) return res.status(200).send(loginPage("Usuário ou senha inválidos."));

  let ok = false;

  if (ADMIN_PASSWORD_HASH) {
    ok = await bcrypt.compare(pass, ADMIN_PASSWORD_HASH);
  } else if (ADMIN_PASSWORD) {
    ok = pass === ADMIN_PASSWORD;
  } else {
    ok = false;
  }

  if (!ok) return res.status(200).send(loginPage("Usuário ou senha inválidos."));

  const token = issueAdminJwt();

  setCookie(res, ADMIN_JWT_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: ADMIN_JWT_MAX_AGE_MS,
  });

  return res.redirect("/admin");
});

app.get("/admin/logout", (_req, res) => {
  clearCookie(res, ADMIN_JWT_COOKIE);
  return res.redirect("/admin/login");
});

// Dashboard
app.get("/admin", async (req, res) => {
  if (!requireAdminSession(req, res)) return;

  const shell = adminShell("/admin");
  const statusBadge = `<span class="badge ok">ONLINE</span>`;

  const dbBadge = pool ? `<span class="badge ok">DB OK</span>` : `<span class="badge bad">DB OFF</span>`;
  const emailBadge = canEmail() ? `<span class="badge ok">EMAIL OK</span>` : `<span class="badge bad">EMAIL OFF</span>`;
  const aiBadge =
    AI_ENABLED && OPENAI_API_KEY ? `<span class="badge ok">IA ON</span>` : `<span class="badge bad">IA OFF</span>`;
  const brainBadge = RTBRAIN_TEXT ? `<span class="badge ok">RTBRAIN OK</span>` : `<span class="badge bad">RTBRAIN OFF</span>`;

  const stats = await getStats("30d");

  const body = `
    ${shell}
      <div class="grid">
        <div class="card">
          <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; justify-content:space-between;">
            <div>
              <div class="title" style="font-size:18px;">Visão Geral</div>
              <div class="hint">Status do sistema e principais números</div>
            </div>
            <div style="display:flex; gap:8px; flex-wrap:wrap;">
              ${statusBadge}
              ${dbBadge}
              ${emailBadge}
              ${aiBadge}
              ${brainBadge}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="kpis">
            <div class="kpi">
              <div class="label">Chats distintos (30 dias)</div>
              <div class="value">${stats.uniqueChats}</div>
            </div>
            <div class="kpi">
              <div class="label">Chats novos (30 dias)</div>
              <div class="value">${stats.newChats}</div>
            </div>
            <div class="kpi">
              <div class="label">Mensagens recebidas (30 dias)</div>
              <div class="value">${stats.received}</div>
            </div>
            <div class="kpi">
              <div class="label">Mensagens enviadas (30 dias)</div>
              <div class="value">${stats.sent}</div>
            </div>
          </div>
          <div class="footer">* “Chats novos” = primeira vez que o número aparece no banco.</div>
        </div>

        <div class="card">
          <div class="title" style="font-size:16px; margin-bottom:6px;">Último chat (memória do servidor)</div>
          <div class="hint">Isso zera se o Render reiniciar — serve para debug rápido.</div>
          <pre style="white-space:pre-wrap; margin:12px 0 0; background:rgba(0,0,0,.18); padding:12px; border-radius:16px; border:1px solid rgba(255,255,255,.10);">${escapeHtml(
            JSON.stringify(lastChat, null, 2)
          )}</pre>
        </div>
      </div>
    ${adminFooter()}
  `;
  res.status(200).send(htmlLayout("RT Admin - Dashboard", body));
});

// Chats & mensagens
app.get("/admin/chats", async (req, res) => {
  if (!requireAdminSession(req, res)) return;

  const period = req.query.period || "7d";
  const stats = await getStats(period);
  const top = await getTopChats(period);

  const shell = adminShell("/admin/chats");
  const body = `
    ${shell}
    <div class="grid">
      <div class="card">
        <div class="row">
          <div style="flex:1; min-width:220px;">
            <div class="title" style="font-size:16px;">Chats & Mensagens</div>
            <div class="hint">Novos vs recorrentes • filtros por período</div>
          </div>
          <form method="GET" action="/admin/chats" style="display:flex; gap:10px; align-items:flex-end;">
            <div style="min-width:180px;">
              <div class="hint">Período</div>
              <select name="period">
                ${["1d", "7d", "30d", "90d"]
                  .map((p) => `<option value="${p}" ${String(period) === p ? "selected" : ""}>${p}</option>`)
                  .join("")}
              </select>
            </div>
            <button type="submit">Aplicar</button>
          </form>
        </div>
      </div>

      <div class="card">
        <div class="kpis">
          <div class="kpi">
            <div class="label">Chats distintos</div>
            <div class="value">${stats.uniqueChats}</div>
          </div>
          <div class="kpi">
            <div class="label">Chats novos</div>
            <div class="value">${stats.newChats}</div>
          </div>
          <div class="kpi">
            <div class="label">Recebidas</div>
            <div class="value">${stats.received}</div>
          </div>
          <div class="kpi">
            <div class="label">Enviadas</div>
            <div class="value">${stats.sent}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="title" style="font-size:16px;">Top chats (por volume de mensagens recebidas)</div>
        <table>
          <thead>
            <tr><th>Celular</th><th>Nome</th><th>Recebidas</th><th>Última</th></tr>
          </thead>
          <tbody>
            ${top
              .map(
                (r) => `
              <tr>
                <td>${escapeHtml(r.celular || "-")}</td>
                <td>${escapeHtml(r.nome || "-")}</td>
                <td>${r.count}</td>
                <td>${escapeHtml(r.last_at || "-")}</td>
              </tr>
            `
              )
              .join("") || `<tr><td colspan="4" class="hint">Sem dados (ou DB desligado).</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
    ${adminFooter()}
  `;
  res.status(200).send(htmlLayout("RT Admin - Chats", body));
});

// Alertas (email)
app.get("/admin/alerts", async (req, res) => {
  if (!requireAdminSession(req, res)) return;

  const cfg = await cfgGet("alert_emails", { emails: [] });
  const emails = Array.isArray(cfg.emails) ? cfg.emails : [];

  const shell = adminShell("/admin/alerts");
  const body = `
    ${shell}
    <div class="grid">
      <div class="card">
        <div class="title" style="font-size:16px;">Alertas por e-mail</div>
        <div class="hint">Quando o envio falhar (send-test/reply-last/auto/ai), o sistema tenta alertar os e-mails cadastrados.</div>
        <div style="margin-top:10px;">
          <span class="badge ${canEmail() ? "ok" : "bad"}">${canEmail() ? "SMTP configurado" : "SMTP não configurado"}</span>
        </div>
      </div>

      <div class="card">
        <form method="POST" action="/admin/alerts">
          <div class="hint">E-mails (1 por linha)</div>
          <textarea name="emails" placeholder="email1@dominio.com&#10;email2@dominio.com">${escapeHtml(emails.join("\n"))}</textarea>
          <div style="display:flex; gap:10px; margin-top:10px; flex-wrap:wrap;">
            <button type="submit">Salvar</button>
            <button type="submit" name="action" value="test" class="secondary">Enviar e-mail de teste</button>
          </div>
          <div class="footer">Para ativar SMTP, configure as env vars SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM.</div>
        </form>
      </div>
    </div>
    ${adminFooter()}
  `;
  res.status(200).send(htmlLayout("RT Admin - Alertas", body));
});

app.post("/admin/alerts", async (req, res) => {
  if (!requireAdminSession(req, res)) return;

  const raw = String(req.body.emails || "");
  const emails = raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  await cfgSet("alert_emails", { emails });

  if (req.body.action === "test") {
    await sendAlertEmail("RT ALERTA: teste de e-mail ✅", "Se você recebeu isso, o SMTP está funcionando.");
  }

  return res.redirect("/admin/alerts");
});

// Treino IA (futuro)
app.get("/admin/training", async (req, res) => {
  if (!requireAdminSession(req, res)) return;

  const rows = await getTrainingRows();

  const shell = adminShell("/admin/training");
  const body = `
    ${shell}
    <div class="grid">
      <div class="card">
        <div class="title" style="font-size:16px;">Treino IA (futuro)</div>
        <div class="hint">Aqui você cadastra exemplos do jeito que você quer que a IA responda depois.</div>
      </div>

      <div class="card">
        <form method="POST" action="/admin/training">
          <div class="row">
            <div style="flex:1; min-width:200px;">
              <div class="hint">Tag/Intenção (opcional)</div>
              <input name="tag" placeholder="ex: preco, agendamento, duvida" />
            </div>
          </div>
          <div style="margin-top:10px;">
            <div class="hint">Mensagem do cliente</div>
            <textarea name="user_text" placeholder="Ex: Qual o valor para remover tatuagem?"></textarea>
          </div>
          <div style="margin-top:10px;">
            <div class="hint">Resposta ideal</div>
            <textarea name="ideal_answer" placeholder="Ex: Claro! O valor depende de tamanho/cor..."></textarea>
          </div>
          <div style="margin-top:10px;">
            <button type="submit">Salvar exemplo</button>
          </div>
        </form>
      </div>

      <div class="card">
        <div class="title" style="font-size:16px;">Exemplos cadastrados</div>
        <table>
          <thead>
            <tr><th>Data</th><th>Tag</th><th>Cliente</th><th>Resposta</th></tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (r) => `
              <tr>
                <td>${escapeHtml(r.created_at || "-")}</td>
                <td>${escapeHtml(r.tag || "-")}</td>
                <td>${escapeHtml(short(r.user_text))}</td>
                <td>${escapeHtml(short(r.ideal_answer))}</td>
              </tr>
            `
              )
              .join("") || `<tr><td colspan="4" class="hint">Sem dados (ou DB desligado).</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
    ${adminFooter()}
  `;
  res.status(200).send(htmlLayout("RT Admin - Treino IA", body));
});

app.post("/admin/training", async (req, res) => {
  if (!requireAdminSession(req, res)) return;

  const tag = (req.body.tag || "").toString().trim() || null;
  const user_text = (req.body.user_text || "").toString().trim();
  const ideal_answer = (req.body.ideal_answer || "").toString().trim();

  if (!user_text || !ideal_answer) return res.redirect("/admin/training");
  if (!pool) return res.redirect("/admin/training");

  await pool.query(`INSERT INTO ai_training (created_at, tag, user_text, ideal_answer) VALUES ($1,$2,$3,$4)`, [
    new Date().toISOString(),
    tag,
    user_text,
    ideal_answer,
  ]);

  return res.redirect("/admin/training");
});

// ====== Admin APIs (JSON) ======
app.get("/admin/api/stats", async (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const period = req.query.period || "7d";
  const stats = await getStats(period);
  return res.status(200).json({ ok: true, period, stats });
});

// ====== OpenAI TEST (JSON) ======
app.post("/admin/api/ai-test", async (req, res) => {
  try {
    const token = req.headers["x-rt-admin-token"];
    const okByToken = RT_ADMIN_TOKEN && token === RT_ADMIN_TOKEN;
    const okBySession = isAdminAuthed(req);

    if (!okByToken && !okBySession) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { text, system } = req.body || {};
    if (!text) return res.status(400).json({ ok: false, error: "Body inválido. Envie { text }" });

    const base = RTBRAIN_TEXT || "";
    const systemPrompt =
      (system && String(system).trim()) ||
      (base
        ? `${base}\n\nREGRAS TÉCNICAS IMPORTANTES:\n- Nunca repita a mesma resposta duas vezes.\n- Seja direto, humano e curto.\n- Se faltar informação essencial, faça apenas 1 pergunta objetiva.\n`
        : "Você é um atendente humano, rápido, cordial e objetivo. Responda curto. Se faltar info, faça 1 pergunta objetiva.");

    const reply = await openaiCreateReply({
      system: systemPrompt,
      user: String(text),
    });

    return res.status(200).json({ ok: true, model: OPENAI_MODEL, reply });
  } catch (err) {
    const status = err?.response?.status || null;
    const payload = err?.response?.data || null;
    const msg = payload || err?.message || String(err);
    return res.status(500).json({ ok: false, error: msg, status });
  }
});

// ====== Stats functions ======
function periodToSql(period) {
  const map = { "1d": "1 day", "7d": "7 days", "30d": "30 days", "90d": "90 days" };
  return map[String(period)] || "7 days";
}

async function getStats(period) {
  if (!pool) {
    return { uniqueChats: 0, newChats: 0, received: 0, sent: 0 };
  }

  const interval = periodToSql(period);

  const receivedR = await pool.query(`SELECT COUNT(*)::int AS c FROM cg_events WHERE received_at >= NOW() - INTERVAL '${interval}'`);
  const sentR = await pool.query(`SELECT COUNT(*)::int AS c FROM cg_sends WHERE sent_at >= NOW() - INTERVAL '${interval}'`);

  const uniqR = await pool.query(
    `SELECT COUNT(DISTINCT celular)::int AS c FROM cg_events WHERE received_at >= NOW() - INTERVAL '${interval}' AND celular IS NOT NULL`
  );

  const newR = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM (
      SELECT celular, MIN(received_at) AS first_seen
      FROM cg_events
      WHERE celular IS NOT NULL
      GROUP BY celular
    ) t
    WHERE t.first_seen >= NOW() - INTERVAL '${interval}'
  `);

  return {
    uniqueChats: uniqR.rows[0].c,
    newChats: newR.rows[0].c,
    received: receivedR.rows[0].c,
    sent: sentR.rows[0].c,
  };
}

async function getTopChats(period) {
  if (!pool) return [];
  const interval = periodToSql(period);

  const r = await pool.query(`
    SELECT
      celular,
      MAX(nome) AS nome,
      COUNT(*)::int AS count,
      MAX(received_at)::text AS last_at
    FROM cg_events
    WHERE received_at >= NOW() - INTERVAL '${interval}'
      AND celular IS NOT NULL
    GROUP BY celular
    ORDER BY count DESC
    LIMIT 15
  `);
  return r.rows;
}

async function getTrainingRows() {
  if (!pool) return [];
  const r = await pool.query(`SELECT created_at::text, tag, user_text, ideal_answer FROM ai_training ORDER BY id DESC LIMIT 30`);
  return r.rows;
}

// ====== Start ======
(async () => {
  await dbInit();

  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Admin: /admin/login`);
    console.log(`AI_ENABLED=${AI_ENABLED} | MODEL=${OPENAI_MODEL} | RTBRAIN=${RTBRAIN_TEXT ? "loaded" : "missing"}`);
  });
})();