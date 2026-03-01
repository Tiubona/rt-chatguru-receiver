const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// ====== Resolve pasta public/Public ======
function resolvePublicDir() {
  const lower = path.join(__dirname, "public");
  const upper = path.join(__dirname, "Public");
  if (fs.existsSync(lower)) return lower;
  if (fs.existsSync(upper)) return upper;
  return null;
}

const PUBLIC_DIR = resolvePublicDir();
if (PUBLIC_DIR) console.log(`Admin panel static dir: ${PUBLIC_DIR}`);
else console.log("⚠️ Admin panel static dir NÃO encontrada (public/Public).");

// ====== Persistência local (debug) ======
const EVENTS_FILE = path.join(__dirname, "events.jsonl");

// ====== ChatGuru config (Render env vars) ======
const CHATGURU_API_ENDPOINT = process.env.CHATGURU_API_ENDPOINT;
const CHATGURU_API_KEY = process.env.CHATGURU_API_KEY;
const CHATGURU_ACCOUNT_ID = process.env.CHATGURU_ACCOUNT_ID;
const CHATGURU_PHONE_ID = process.env.CHATGURU_PHONE_ID;

const RT_ADMIN_TOKEN = process.env.RT_ADMIN_TOKEN;

// ====== Estado em memória ======
let lastChat = null;
let stats = {
  received: 0,
  sent: 0,
  sendErrors: 0,
  lastError: null,
};
let knowledgeText = "";
let config = {
  enabled: false,
  start: "08:30",
  end: "18:30",
};

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

// ====== Helper: servir HTML SEM chance de virar texto ======
function sendHtmlFile(res, filename) {
  if (!PUBLIC_DIR) return res.status(500).send("Admin panel folder not found (public/Public).");

  const full = path.join(PUBLIC_DIR, filename);
  if (!fs.existsSync(full)) return res.status(404).send(`File not found: ${filename}`);

  // mata cache (principalmente Cloudflare/Render)
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  // garante que o browser interprete como HTML
  res.status(200).type("html; charset=utf-8").send(fs.readFileSync(full, "utf8"));
}

// ====== Estáticos (CSS/JS) ======
if (PUBLIC_DIR) {
  app.use(
    express.static(PUBLIC_DIR, {
      etag: false,
      lastModified: false,
      setHeaders(res, filePath) {
        // cache curto pra assets
        if (filePath.endsWith(".css") || filePath.endsWith(".js")) {
          res.setHeader("Cache-Control", "public, max-age=60");
        }
      },
    })
  );
}

// ====== Rotas base ======
app.get("/health", (_req, res) => res.status(200).json({ status: "online" }));

app.get("/", (_req, res) => res.redirect("/login"));

// ✅ login/admin SEM sendFile (pra não virar “texto”)
app.get("/login", (_req, res) => sendHtmlFile(res, "login.html"));
app.get("/admin", (_req, res) => sendHtmlFile(res, "admin.html"));

// ✅ version (pra você ver commit/versão no ar)
app.get("/version", (_req, res) => {
  res.status(200).json({
    ok: true,
    name: "rt-chatguru-receiver",
    version: process.env.npm_package_version || "1.0.0",
    commit: process.env.RENDER_GIT_COMMIT || process.env.COMMIT || null,
    node: process.version,
    env: process.env.NODE_ENV || "production",
    time: new Date().toISOString(),
  });
});

// ====== API do painel (pra parar 404 no log) ======
app.get("/api/stats", (req, res) => {
  const auth = requireAdmin(req, res);
  if (auth) return;
  return res.status(200).json({
    ok: true,
    stats,
    lastChat,
  });
});

app.get("/api/knowledge", (req, res) => {
  const auth = requireAdmin(req, res);
  if (auth) return;
  return res.status(200).json({ ok: true, text: knowledgeText });
});

app.post("/api/knowledge", (req, res) => {
  const auth = requireAdmin(req, res);
  if (auth) return;
  knowledgeText = String((req.body && req.body.text) || "");
  return res.status(200).json({ ok: true });
});

app.get("/api/config", (req, res) => {
  const auth = requireAdmin(req, res);
  if (auth) return;
  return res.status(200).json({ ok: true, config });
});

app.post("/api/config", (req, res) => {
  const auth = requireAdmin(req, res);
  if (auth) return;

  const body = req.body || {};
  if (typeof body.enabled === "boolean") config.enabled = body.enabled;
  if (typeof body.start === "string") config.start = body.start;
  if (typeof body.end === "string") config.end = body.end;

  return res.status(200).json({ ok: true, config });
});

// ====== ChatGuru sender ======
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

// ====== Webhook receiver ======
app.post("/webhook/chatguru", (req, res) => {
  const body = req.body || {};

  const event = {
    receivedAt: new Date().toISOString(),
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    headers: req.headers,
    body,
  };

  stats.received += 1;

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

    stats.sent += 1;
    return res.status(200).json({ ok: true, result: data });
  } catch (err) {
    stats.sendErrors += 1;
    stats.lastError = err?.response?.data || err?.message || String(err);

    const payload = err?.response?.data || null;
    const status = err?.response?.status || null;
    return res.status(500).json({ ok: false, error: payload || err?.message || String(err), status });
  }
});

// ====== lastChat protegido ======
app.get("/last-chat", (req, res) => {
  const auth = requireAdmin(req, res);
  if (auth) return;
  return res.status(200).json({ ok: true, lastChat });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});