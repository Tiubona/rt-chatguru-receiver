const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ====== Static Admin UI ======
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// ====== Port ======
const PORT = process.env.PORT || 3000;

// ====== Files (debug/persistência simples) ======
const EVENTS_FILE = path.join(__dirname, "events.jsonl"); // pode ser efêmero no Render
const CONFIG_FILE = path.join(__dirname, "config.json");
const KNOWLEDGE_FILE = path.join(__dirname, "knowledge.txt");

// ====== ChatGuru env vars ======
const CHATGURU_API_ENDPOINT = process.env.CHATGURU_API_ENDPOINT; // ex: https://app.zap.guru/api/v1
const CHATGURU_API_KEY = process.env.CHATGURU_API_KEY;
const CHATGURU_ACCOUNT_ID = process.env.CHATGURU_ACCOUNT_ID;
const CHATGURU_PHONE_ID = process.env.CHATGURU_PHONE_ID;

// ====== Admin security ======
const RT_ADMIN_TOKEN = process.env.RT_ADMIN_TOKEN; // para curl endpoints
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin";
const JWT_SECRET = process.env.JWT_SECRET || "change-me-now";
const JWT_COOKIE_NAME = "rt_admin_session";

// ====== Runtime state ======
let lastChat = null;

const counters = {
  received_webhooks: 0,
  sent_messages: 0,
  send_errors: 0,
  last_error: null,
  started_at: new Date().toISOString(),
};

const defaultConfig = {
  enabled: true,
  // Horário em "HH:MM" no fuso do Brasil (America/Sao_Paulo) — lógica simples (sem DST handling)
  // Depois a gente deixa isso com timezone perfeito.
  operating_hours: {
    start: "08:30",
    end: "18:30",
  },
};

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeWriteJson(filePath, obj) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    // ignore
  }
}

function safeAppendLine(filePath, obj) {
  try {
    fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", { encoding: "utf8" });
  } catch {
    // ignore (cloud disk can be ephemeral)
  }
}

function safeReadText(filePath, fallback = "") {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function safeWriteText(filePath, text) {
  try {
    fs.writeFileSync(filePath, text, "utf8");
  } catch {
    // ignore
  }
}

let config = safeReadJson(CONFIG_FILE, defaultConfig);

// ====== Helpers ======
function maskKey(key) {
  if (!key || typeof key !== "string") return "(missing)";
  return `****${key.slice(-4)}`;
}

function requireChatGuruConfig() {
  const missing = [];
  if (!CHATGURU_API_ENDPOINT) missing.push("CHATGURU_API_ENDPOINT");
  if (!CHATGURU_API_KEY) missing.push("CHATGURU_API_KEY");
  if (!CHATGURU_ACCOUNT_ID) missing.push("CHATGURU_ACCOUNT_ID");
  if (!CHATGURU_PHONE_ID) missing.push("CHATGURU_PHONE_ID");
  return missing;
}

function requireAdminToken(req, res) {
  const token = req.headers["x-rt-admin-token"];
  if (!RT_ADMIN_TOKEN || token !== RT_ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized (x-rt-admin-token inválido)" });
  }
  return null;
}

// JWT cookie auth for Admin UI
function issueAdminJwt() {
  return jwt.sign(
    { role: "admin", user: ADMIN_USER },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function requireAdminSession(req, res, next) {
  try {
    const token = req.cookies[JWT_COOKIE_NAME];
    if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });
    jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
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

  const safeUrl = requestUrl.replace(
    /key=[^&]+/i,
    `key=${encodeURIComponent(maskKey(CHATGURU_API_KEY))}`
  );

  console.log("=== ChatGuru request (safe) ===");
  console.log(safeUrl);

  const resp = await axios.post(requestUrl, null, { timeout: 20000 });
  return resp.data;
}

// Simple operating hours check (string compare HH:MM)
function isWithinOperatingHours(now = new Date()) {
  if (!config.enabled) return false;

  // pega hora/minuto no horário local do servidor (no Render pode ser UTC)
  // solução simples: usar UTC e "shift" manual seria gambiarra.
  // Para agora, a gente usa o "horário do webhook" como referência do painel e deixa isso pro próximo upgrade.
  // Mesmo assim, já deixamos pronto o config e a API.
  return true;
}

// ====== Routes ======
app.get("/", (_req, res) => {
  return res.status(200).json({ ok: true, service: "rt-chatguru-receiver" });
});

app.get("/health", (_req, res) => {
  return res.status(200).json({ status: "online" });
});

// Pages (redirect simples)
app.get("/login", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "login.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));

// ====== Admin Auth ======
app.post("/api/login", (req, res) => {
  const { user, pass } = req.body || {};
  if (String(user) !== String(ADMIN_USER) || String(pass) !== String(ADMIN_PASS)) {
    return res.status(401).json({ ok: false, error: "Login inválido" });
  }

  const token = issueAdminJwt();
  res.cookie(JWT_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  return res.status(200).json({ ok: true });
});

app.post("/api/logout", (_req, res) => {
  res.clearCookie(JWT_COOKIE_NAME);
  return res.status(200).json({ ok: true });
});

// ====== Admin APIs (painel) ======
app.get("/api/stats", requireAdminSession, (_req, res) => {
  return res.status(200).json({
    ok: true,
    counters,
    lastChat,
    config,
  });
});

app.get("/api/config", requireAdminSession, (_req, res) => {
  return res.status(200).json({ ok: true, config });
});

app.post("/api/config", requireAdminSession, (req, res) => {
  const { enabled, operating_hours } = req.body || {};
  if (typeof enabled === "boolean") config.enabled = enabled;

  if (operating_hours && typeof operating_hours === "object") {
    const { start, end } = operating_hours;
    if (typeof start === "string") config.operating_hours.start = start;
    if (typeof end === "string") config.operating_hours.end = end;
  }

  safeWriteJson(CONFIG_FILE, config);
  return res.status(200).json({ ok: true, config });
});

app.get("/api/knowledge", requireAdminSession, (_req, res) => {
  const text = safeReadText(KNOWLEDGE_FILE, "");
  return res.status(200).json({ ok: true, text });
});

app.post("/api/knowledge", requireAdminSession, (req, res) => {
  const { text } = req.body || {};
  safeWriteText(KNOWLEDGE_FILE, String(text || ""));
  return res.status(200).json({ ok: true });
});

// ====== Webhook receiver ======
app.post("/webhook/chatguru", (req, res) => {
  counters.received_webhooks += 1;

  const body = req.body || {};
  const event = {
    receivedAt: new Date().toISOString(),
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    headers: req.headers,
    body,
  };

  console.log("=== Webhook recebido (ChatGuru) ===");
  console.log(JSON.stringify(event, null, 2));

  // Atualiza lastChat
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
    };
  }

  safeAppendLine(EVENTS_FILE, event);

  // Por enquanto: NÃO responde automaticamente aqui.
  // Próximo passo: ativar auto-reply respeitando horário + IA.
  return res.status(200).json({ ok: true });
});

// ====== Existing curl endpoints ======
app.post("/send-test", async (req, res) => {
  try {
    const auth = requireAdminToken(req, res);
    if (auth) return;

    const missing = requireChatGuruConfig();
    if (missing.length) {
      return res.status(500).json({ ok: false, error: "Config ChatGuru incompleta no servidor", missing });
    }

    const { chat_number, text, send_date } = req.body || {};
    if (!chat_number || !text) {
      return res.status(400).json({ ok: false, error: "Body inválido. Envie { chat_number, text }" });
    }

    const data = await chatGuruSendMessage({
      chatNumber: String(chat_number),
      text: String(text),
      sendDate: send_date ? String(send_date) : undefined,
    });

    counters.sent_messages += 1;

    return res.status(200).json({ ok: true, result: data });
  } catch (err) {
    counters.send_errors += 1;
    counters.last_error = err?.response?.data || err?.message || String(err);
    return res.status(500).json({ ok: false, error: counters.last_error });
  }
});

app.post("/reply-last", async (req, res) => {
  try {
    const auth = requireAdminToken(req, res);
    if (auth) return;

    const missing = requireChatGuruConfig();
    if (missing.length) {
      return res.status(500).json({ ok: false, error: "Config ChatGuru incompleta no servidor", missing });
    }

    if (!lastChat?.celular) {
      return res.status(400).json({ ok: false, error: "Sem lastChat. Envie mensagem pro webhook primeiro." });
    }

    const { text, send_date } = req.body || {};
    if (!text) return res.status(400).json({ ok: false, error: "Body inválido. Envie { text }" });

    const data = await chatGuruSendMessage({
      chatNumber: lastChat.celular,
      text: String(text),
      sendDate: send_date ? String(send_date) : undefined,
    });

    counters.sent_messages += 1;

    return res.status(200).json({ ok: true, target: lastChat.celular, result: data });
  } catch (err) {
    counters.send_errors += 1;
    counters.last_error = err?.response?.data || err?.message || String(err);
    return res.status(500).json({ ok: false, error: counters.last_error });
  }
});

app.get("/last-chat", (req, res) => {
  const auth = requireAdminToken(req, res);
  if (auth) return;
  return res.status(200).json({ ok: true, lastChat });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});