const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// ====== Painel (public/Public) ======
function resolvePublicDir() {
  const lower = path.join(__dirname, "public");
  const upper = path.join(__dirname, "Public");
  if (fs.existsSync(lower)) return lower;
  if (fs.existsSync(upper)) return upper;
  return null;
}
const PUBLIC_DIR = resolvePublicDir();

if (PUBLIC_DIR) {
  app.use(express.static(PUBLIC_DIR));
  console.log(`Admin panel static dir: ${PUBLIC_DIR}`);
} else {
  console.log("⚠️ Admin panel static dir NÃO encontrada (public/Public).");
}

// ====== Persistência local ======
const EVENTS_FILE = path.join(__dirname, "events.jsonl");
const CONFIG_FILE = path.join(__dirname, "config.json");
const KNOWLEDGE_FILE = path.join(__dirname, "knowledge.txt");

// ====== ChatGuru API (Render env vars) ======
const CHATGURU_API_ENDPOINT = process.env.CHATGURU_API_ENDPOINT;
const CHATGURU_API_KEY = process.env.CHATGURU_API_KEY;
const CHATGURU_ACCOUNT_ID = process.env.CHATGURU_ACCOUNT_ID;
const CHATGURU_PHONE_ID = process.env.CHATGURU_PHONE_ID;

const RT_ADMIN_TOKEN = process.env.RT_ADMIN_TOKEN;

// ====== Estado em memória ======
let lastChat = null;

// contadores simples pro painel
let counters = {
  webhooksReceived: 0,
  messagesSent: 0,
  sendErrors: 0,
  lastError: null,
};

// config/knowledge persistidos
function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function safeWriteJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function safeReadText(filePath, fallback = "") {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return fs.readFileSync(filePath, "utf8");
  } catch (_) {
    return fallback;
  }
}

function safeWriteText(filePath, text) {
  fs.writeFileSync(filePath, String(text || ""), "utf8");
}

let appConfig = safeReadJson(CONFIG_FILE, {
  enabled: true,
  start: "08:30",
  end: "18:30",
});

let knowledgeBase = safeReadText(KNOWLEDGE_FILE, "");

// ====== Helpers ======
function appendEvent(obj) {
  try {
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(obj) + "\n", { encoding: "utf8" });
  } catch (_) {}
}

function requireChatGuruConfig() {
  const missing = [];
  if (!CHATGURU_API_ENDPOINT) missing.push("CHATGURU_API_ENDPOINT");
  if (!CHATGURU_API_KEY) missing.push("CHATGURU_API_KEY");
  if (!CHATGURU_ACCOUNT_ID) missing.push("CHATGURU_ACCOUNT_ID");
  if (!CHATGURU_PHONE_ID) missing.push("CHATGURU_PHONE_ID");
  return missing;
}

function requireAdmin(req, res) {
  const token = req.headers["x-rt-admin-token"];
  if (!RT_ADMIN_TOKEN || token !== RT_ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized (x-rt-admin-token inválido)" });
  }
  return null;
}

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
  const resp = await axios.post(requestUrl, null, { timeout: 20000 });
  return resp.data;
}

// ====== Rotas base ======
app.get("/health", (_req, res) => res.status(200).json({ status: "online" }));

// ✅ /version (pra você conferir o que está rodando no Render)
app.get("/version", (_req, res) => {
  let pkg = {};
  try {
    pkg = require(path.join(__dirname, "package.json"));
  } catch (_) {}

  return res.status(200).json({
    ok: true,
    name: pkg.name || "rt-chatguru-receiver",
    version: pkg.version || "0.0.0",
    commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null,
    node: process.version,
    env: process.env.NODE_ENV || "unknown",
    time: new Date().toISOString(),
  });
});

// ✅ Rotas amigáveis do painel
app.get("/login", (_req, res) => {
  if (!PUBLIC_DIR) return res.status(500).send("Admin panel folder not found (public/Public).");
  return res.sendFile(path.join(PUBLIC_DIR, "login.html"));
});

app.get("/admin", (_req, res) => {
  if (!PUBLIC_DIR) return res.status(500).send("Admin panel folder not found (public/Public).");
  return res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

// raiz: manda pro login
app.get("/", (_req, res) => res.redirect("/login"));

// ====== API do painel (o admin.js chama isso) ======
app.get("/api/stats", (req, res) => {
  const auth = requireAdmin(req, res);
  if (auth) return;

  return res.status(200).json({
    ok: true,
    counters,
    lastChat,
  });
});

app.get("/api/config", (req, res) => {
  const auth = requireAdmin(req, res);
  if (auth) return;

  return res.status(200).json({ ok: true, config: appConfig });
});

app.post("/api/config", (req, res) => {
  const auth = requireAdmin(req, res);
  if (auth) return;

  const { enabled, start, end } = req.body || {};
  if (typeof enabled === "boolean") appConfig.enabled = enabled;
  if (typeof start === "string") appConfig.start = start;
  if (typeof end === "string") appConfig.end = end;

  safeWriteJson(CONFIG_FILE, appConfig);

  return res.status(200).json({ ok: true, config: appConfig });
});

app.get("/api/knowledge", (req, res) => {
  const auth = requireAdmin(req, res);
  if (auth) return;

  return res.status(200).json({ ok: true, knowledge: knowledgeBase || "" });
});

app.post("/api/knowledge", (req, res) => {
  const auth = requireAdmin(req, res);
  if (auth) return;

  const { knowledge } = req.body || {};
  knowledgeBase = String(knowledge || "");
  safeWriteText(KNOWLEDGE_FILE, knowledgeBase);

  return res.status(200).json({ ok: true });
});

// ====== Webhook receiver ======
app.post("/webhook/chatguru", (req, res) => {
  const body = req.body || {};

  const event = {
    type: "webhook_received",
    receivedAt: new Date().toISOString(),
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    headers: req.headers,
    body,
  };

  counters.webhooksReceived += 1;

  console.log("=== Webhook recebido (ChatGuru) ===");
  console.log(JSON.stringify(event, null, 2));

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
    };
  } else {
    console.log("⚠️ Webhook recebido, mas não achei 'celular' no body para lastChat.");
  }

  appendEvent(event);
  return res.status(200).json({ ok: true });
});

// ====== Envio manual ======
app.post("/send-test", async (req, res) => {
  try {
    const auth = requireAdmin(req, res);
    if (auth) return;

    const missing = requireChatGuruConfig();
    if (missing.length) return res.status(500).json({ ok: false, error: "Config ChatGuru incompleta", missing });

    const { chat_number, text, send_date } = req.body || {};
    if (!chat_number || !text) {
      return res.status(400).json({ ok: false, error: "Envie { chat_number: '55...', text: '...' }" });
    }

    const data = await chatGuruSendMessage({
      chatNumber: String(chat_number),
      text: String(text),
      sendDate: send_date ? String(send_date) : undefined,
    });

    counters.messagesSent += 1;

    appendEvent({
      type: "message_sent",
      at: new Date().toISOString(),
      chat_number: String(chat_number),
      ok: true,
      result: data,
    });

    return res.status(200).json({ ok: true, result: data });
  } catch (err) {
    const payload = err?.response?.data || null;
    const status = err?.response?.status || null;

    counters.sendErrors += 1;
    counters.lastError = payload || err?.message || String(err);

    appendEvent({
      type: "message_send_error",
      at: new Date().toISOString(),
      ok: false,
      status,
      error: counters.lastError,
    });

    return res.status(500).json({ ok: false, error: counters.lastError, status });
  }
});

// ====== Responder último chat ======
app.post("/reply-last", async (req, res) => {
  try {
    const auth = requireAdmin(req, res);
    if (auth) return;

    const missing = requireChatGuruConfig();
    if (missing.length) return res.status(500).json({ ok: false, error: "Config ChatGuru incompleta", missing });

    if (!lastChat || !lastChat.celular) {
      return res.status(400).json({ ok: false, error: "Sem lastChat. Envie uma msg pro webhook primeiro." });
    }

    const { text, send_date } = req.body || {};
    if (!text) return res.status(400).json({ ok: false, error: "Envie { text: '...' }" });

    const data = await chatGuruSendMessage({
      chatNumber: lastChat.celular,
      text: String(text),
      sendDate: send_date ? String(send_date) : undefined,
    });

    counters.messagesSent += 1;

    appendEvent({
      type: "message_sent",
      at: new Date().toISOString(),
      chat_number: lastChat.celular,
      ok: true,
      result: data,
    });

    return res.status(200).json({ ok: true, target: lastChat.celular, lastChat, result: data });
  } catch (err) {
    const payload = err?.response?.data || null;
    const status = err?.response?.status || null;

    counters.sendErrors += 1;
    counters.lastError = payload || err?.message || String(err);

    appendEvent({
      type: "message_send_error",
      at: new Date().toISOString(),
      ok: false,
      status,
      error: counters.lastError,
    });

    return res.status(500).json({ ok: false, error: counters.lastError, status });
  }
});

// inspecionar lastChat (protegido)
app.get("/last-chat", (req, res) => {
  const auth = requireAdmin(req, res);
  if (auth) return;
  return res.status(200).json({ ok: true, lastChat });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});