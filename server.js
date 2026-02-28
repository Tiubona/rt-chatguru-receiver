const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// Persistência local (no Render pode ser efêmero; ok para debug)
const EVENTS_FILE = path.join(__dirname, "events.jsonl");

// ====== Config ChatGuru API (Render env vars) ======
const CHATGURU_API_ENDPOINT = process.env.CHATGURU_API_ENDPOINT; // ex: https://app.zap.guru/api/v1
const CHATGURU_API_KEY = process.env.CHATGURU_API_KEY; // key
const CHATGURU_ACCOUNT_ID = process.env.CHATGURU_ACCOUNT_ID; // account_id
const CHATGURU_PHONE_ID = process.env.CHATGURU_PHONE_ID; // phone_id

// Token simples para proteger rotas administrativas
const RT_ADMIN_TOKEN = process.env.RT_ADMIN_TOKEN;

function appendEvent(obj) {
  try {
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(obj) + "\n", { encoding: "utf8" });
  } catch (_) {
    // se falhar em cloud, não derruba o serviço
  }
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

  // Log seguro: não vaza key completa
  const safeUrl = requestUrl.replace(/key=[^&]+/i, `key=${encodeURIComponent(maskKey(CHATGURU_API_KEY))}`);
  console.log("=== ChatGuru request (safe) ===");
  console.log(safeUrl);

  const resp = await axios.post(requestUrl, null, { timeout: 20000 });
  return resp.data;
}

// ====== Rotas ======

app.get("/", (_req, res) => {
  return res.status(200).json({ ok: true, service: "rt-chatguru-receiver" });
});

app.get("/health", (_req, res) => {
  return res.status(200).json({ status: "online" });
});

app.post("/webhook/chatguru", (req, res) => {
  const event = {
    receivedAt: new Date().toISOString(),
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    headers: req.headers,
    body: req.body,
  };

  console.log("=== Webhook recebido (ChatGuru) ===");
  console.log(JSON.stringify(event, null, 2));

  appendEvent(event);

  // Por enquanto, NÃO envia mensagem automática
  return res.status(200).json({ ok: true });
});

app.post("/send-test", async (req, res) => {
  try {
    const token = req.headers["x-rt-admin-token"];
    if (!RT_ADMIN_TOKEN || token !== RT_ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized (x-rt-admin-token inválido)" });
    }

    const missing = requireChatGuruConfig();
    if (missing.length) {
      return res.status(500).json({ ok: false, error: "Config ChatGuru incompleta no servidor", missing });
    }

    // Debug seguro: imprime o que o servidor está usando (sem vazar key completa)
    console.log("=== ChatGuru config (safe) ===");
    console.log({
      endpoint: CHATGURU_API_ENDPOINT,
      account_id: CHATGURU_ACCOUNT_ID,
      phone_id: CHATGURU_PHONE_ID,
      key: maskKey(CHATGURU_API_KEY),
    });

    const { chat_number, text, send_date } = req.body || {};
    if (!chat_number || !text) {
      return res.status(400).json({
        ok: false,
        error: "Body inválido. Envie { chat_number: '55...', text: '...' } (send_date opcional)",
      });
    }

    const data = await chatGuruSendMessage({
      chatNumber: String(chat_number),
      text: String(text),
      sendDate: send_date ? String(send_date) : undefined,
    });

    console.log("=== Envio ChatGuru OK ===");
    console.log(JSON.stringify({ chat_number, text, data }, null, 2));

    return res.status(200).json({ ok: true, result: data });
  } catch (err) {
    const payload = err?.response?.data || null;
    const status = err?.response?.status || null;
    const msg = payload || err?.message || String(err);

    console.log("=== Erro ao enviar via ChatGuru ===");
    console.log({ status, msg });

    return res.status(500).json({ ok: false, error: msg, status });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});