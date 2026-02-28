const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// Persistência local (ok para debug; em cloud pode ser efêmero)
const EVENTS_FILE = path.join(__dirname, "events.jsonl");

// ====== Config ChatGuru API (via env do Render) ======
const CHATGURU_API_ENDPOINT = process.env.CHATGURU_API_ENDPOINT; // ex: https://app.zap.guru/api/v1
const CHATGURU_API_KEY = process.env.CHATGURU_API_KEY; // key
const CHATGURU_ACCOUNT_ID = process.env.CHATGURU_ACCOUNT_ID; // account_id
const CHATGURU_PHONE_ID = process.env.CHATGURU_PHONE_ID; // phone_id

// Token simples para proteger rotas administrativas de teste
const RT_ADMIN_TOKEN = process.env.RT_ADMIN_TOKEN;

// Helper: grava 1 JSON por linha
function appendEvent(obj) {
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(obj) + "\n", { encoding: "utf8" });
}

// Helper: valida config mínima de API
function requireChatGuruConfig() {
  const missing = [];
  if (!CHATGURU_API_ENDPOINT) missing.push("CHATGURU_API_ENDPOINT");
  if (!CHATGURU_API_KEY) missing.push("CHATGURU_API_KEY");
  if (!CHATGURU_ACCOUNT_ID) missing.push("CHATGURU_ACCOUNT_ID");
  if (!CHATGURU_PHONE_ID) missing.push("CHATGURU_PHONE_ID");
  return missing;
}

// Chama a API do ChatGuru para enviar mensagem
async function chatGuruSendMessage({ chatNumber, text, sendDate }) {
  // Doc: action=message_send e query params key/account_id/phone_id/text/chat_number (+ opcional send_date)
  // https://app.zap.guru/api/v1?key=KEY&account_id=ACCOUNT_ID&phone_id=PHONE_ID&action=message_send&send_date=...&text=...&chat_number=...
  const params = new URLSearchParams({
    key: CHATGURU_API_KEY,
    account_id: CHATGURU_ACCOUNT_ID,
    phone_id: CHATGURU_PHONE_ID,
    action: "message_send",
    text: text,
    chat_number: chatNumber
  });

  if (sendDate) {
    // Formato: YYYY-MM-DD HH:MM (segundo doc)
    params.set("send_date", sendDate);
  }

  const url = `${CHATGURU_API_ENDPOINT}?${params.toString()}`;

  // Muitas implementações aceitam POST sem body; vamos mandar body vazio
  const resp = await axios.post(url, null, { timeout: 20000 });
  return resp.data;
}

// ====== Rotas ======

app.get("/health", (_req, res) => {
  return res.status(200).json({ status: "online" });
});

// Recebe o webhook do ChatGuru (você já usa isso)
app.post("/webhook/chatguru", (req, res) => {
  const event = {
    receivedAt: new Date().toISOString(),
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    headers: req.headers,
    body: req.body
  };

  console.log("=== Webhook recebido (ChatGuru) ===");
  console.log(JSON.stringify(event, null, 2));

  appendEvent(event);

  // Importante: aqui NÃO envia mensagem automática (por enquanto)
  return res.status(200).json({ ok: true });
});

// Endpoint de teste para enviar mensagem (manual, controlado)
app.post("/send-test", async (req, res) => {
  try {
    // Proteção simples
    const token = req.headers["x-rt-admin-token"];
    if (!RT_ADMIN_TOKEN || token !== RT_ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized (x-rt-admin-token inválido)" });
    }

    const missing = requireChatGuruConfig();
    if (missing.length) {
      return res.status(500).json({
        ok: false,
        error: "Config ChatGuru incompleta no servidor",
        missing
      });
    }

    const { chat_number, text, send_date } = req.body || {};
    if (!chat_number || !text) {
      return res.status(400).json({
        ok: false,
        error: "Body inválido. Envie { chat_number: '55...', text: '...' } (send_date opcional)"
      });
    }

    const data = await chatGuruSendMessage({
      chatNumber: String(chat_number),
      text: String(text),
      sendDate: send_date ? String(send_date) : undefined
    });

    console.log("=== Envio ChatGuru OK ===");
    console.log(JSON.stringify({ chat_number, text, data }, null, 2));

    return res.status(200).json({ ok: true, result: data });
  } catch (err) {
    const msg = err?.response?.data || err?.message || String(err);
    console.log("=== Erro ao enviar via ChatGuru ===");
    console.log(msg);
    return res.status(500).json({ ok: false, error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});