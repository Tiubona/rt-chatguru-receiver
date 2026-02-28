cat > server.js <<'EOF'
const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// =====================================================
// Admin panel (prefer public/, fallback Public/)
// =====================================================
function resolvePublicDir() {
  const lower = path.join(__dirname, "public");
  const upper = path.join(__dirname, "Public");

  try {
    if (fs.existsSync(lower)) return lower;
    if (fs.existsSync(upper)) return upper;
  } catch (_) {}

  return null;
}

const PUBLIC_DIR = resolvePublicDir();

if (PUBLIC_DIR) {
  app.use(express.static(PUBLIC_DIR));
  console.log(`✅ Admin panel static dir: ${PUBLIC_DIR}`);
} else {
  console.log("⚠️ Admin panel static dir NÃO encontrada (public/Public).");
}

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch (_) {
    return false;
  }
}

function sendPublicFile(res, filename) {
  if (!PUBLIC_DIR) {
    return res.status(500).send("Admin panel folder not found (public/Public).");
  }
  const f = path.join(PUBLIC_DIR, filename);
  if (!fileExists(f)) {
    return res.status(404).send(`Arquivo não encontrado: ${filename}`);
  }
  return res.sendFile(f);
}

// =====================================================
// Persistência local (debug)
// =====================================================
const EVENTS_FILE = path.join(__dirname, "events.jsonl");

// =====================================================
// Config ChatGuru API (Render env vars)
// =====================================================
const CHATGURU_API_ENDPOINT = process.env.CHATGURU_API_ENDPOINT;
const CHATGURU_API_KEY = process.env.CHATGURU_API_KEY;
const CHATGURU_ACCOUNT_ID = process.env.CHATGURU_ACCOUNT_ID;
const CHATGURU_PHONE_ID = process.env.CHATGURU_PHONE_ID;

const RT_ADMIN_TOKEN = process.env.RT_ADMIN_TOKEN;

// =====================================================
// Estado em memória (para TESTE)
// =====================================================
let lastChat = null;

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
    res.status(401).json({ ok: false, error: "Unauthorized (x-rt-admin-token inválido)" });
    return true;
  }
  return false;
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

// =====================================================
// Rotas base
// =====================================================
app.get("/health", (_req, res) => res.status(200).json({ status: "online" }));

// ✅ rota pra você confirmar se o Render atualizou (sem achismo)
app.get("/version", (_req, res) => {
  res.status(200).json({
    ok: true,
    commit: process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA || null,
    renderedAt: new Date().toISOString(),
    publicDir: PUBLIC_DIR,
  });
});

// raiz: manda pro login
app.get("/", (_req, res) => res.redirect("/login"));

// ✅ rota amigável login
app.get("/login", (_req, res) => {
  if (PUBLIC_DIR && fileExists(path.join(PUBLIC_DIR, "login.html"))) return sendPublicFile(res, "login.html");
  if (PUBLIC_DIR && fileExists(path.join(PUBLIC_DIR, "admin.html"))) return sendPublicFile(res, "admin.html");
  return res.status(500).send("Admin panel files not found (login.html/admin.html).");
});

// ✅ rota amigável admin
app.get("/admin", (_req, res) => {
  if (PUBLIC_DIR && fileExists(path.join(PUBLIC_DIR, "admin.html"))) return sendPublicFile(res, "admin.html");
  if (PUBLIC_DIR && fileExists(path.join(PUBLIC_DIR, "login.html"))) return sendPublicFile(res, "login.html");
  return res.status(500).send("Admin panel files not found (admin.html/login.html).");
});

// =====================================================
// Webhook receiver
// =====================================================
app.post("/webhook/chatguru", (req, res) => {
  const body = req.body || {};

  const event = {
    receivedAt: new Date().toISOString(),
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    headers: req.headers,
    body,
  };

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
    console.log("=== lastChat atualizado ===");
    console.log(JSON.stringify(lastChat, null, 2));
  } else {
    console.log("⚠️ Webhook recebido, mas não achei 'celular' no body para lastChat.");
  }

  appendEvent(event);
  return res.status(200).json({ ok: true });
});

// =====================================================
// Envio manual
// =====================================================
app.post("/send-test", async (req, res) => {
  try {
    if (requireAdmin(req, res)) return;

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

    return res.status(200).json({ ok: true, result: data });
  } catch (err) {
    const payload = err?.response?.data || null;
    const status = err?.response?.status || null;
    return res.status(500).json({ ok: false, error: payload || err?.message || String(err), status });
  }
});

// =====================================================
// Responder último chat
// =====================================================
app.post("/reply-last", async (req, res) => {
  try {
    if (requireAdmin(req, res)) return;

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

    return res.status(200).json({ ok: true, target: lastChat.celular, lastChat, result: data });
  } catch (err) {
    const payload = err?.response?.data || null;
    const status = err?.response?.status || null;
    return res.status(500).json({ ok: false, error: payload || err?.message || String(err), status });
  }
});

// =====================================================
// Inspecionar lastChat (protegido)
// =====================================================
app.get("/last-chat", (req, res) => {
  const token = req.headers["x-rt-admin-token"];
  if (!RT_ADMIN_TOKEN || token !== RT_ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized (x-rt-admin-token inválido)" });
  }
  return res.status(200).json({ ok: true, lastChat });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
EOF