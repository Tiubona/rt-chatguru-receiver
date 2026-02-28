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

// ====== Estado em memória (para TESTE) ======
// Guarda o último chat recebido pelo webhook
let lastChat = null;

function appendEvent(obj) {
  try {
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(obj) + "\n", { encoding: "utf8" });
  } catch (_) {
    // Em cloud, pode falhar (disco efêmero). Não derruba o serviço.
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

// Recebe o webhook do ChatGuru
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

  // Guarda o "último chat" (em memória) para o /reply-last
  // Usamos os campos que você já viu chegando: chat_id e celular
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

  // Por enquanto, NÃO envia mensagem automática aqui.
  return res.status(200).json({ ok: true });
});

// Envio manual para qualquer número (já existia)
app.post("/send-test", async (req, res) => {
  try {
    const auth = requireAdmin(req, res);
    if (auth) return;

    const missing = requireChatGuruConfig();
    if (missing.length) {
      return res.status(500).json({ ok: false, error: "Config ChatGuru incompleta no servidor", missing });
    }

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

    console.log("=== Envio ChatGuru OK (send-test) ===");
    console.log(JSON.stringify({ chat_number, text, data }, null, 2));

    return res.status(200).json({ ok: true, result: data });
  } catch (err) {
    const payload = err?.response?.data || null;
    const status = err?.response?.status || null;
    const msg = payload || err?.message || String(err);

    console.log("=== Erro ao enviar via ChatGuru (send-test) ===");
    console.log({ status, msg });

    return res.status(500).json({ ok: false, error: msg, status });
  }
});

// ✅ NOVO: responde o último chat recebido (sem digitar número)
app.post("/reply-last", async (req, res) => {
  try {
    const auth = requireAdmin(req, res);
    if (auth) return;

    const missing = requireChatGuruConfig();
    if (missing.length) {
      return res.status(500).json({ ok: false, error: "Config ChatGuru incompleta no servidor", missing });
    }

    if (!lastChat || !lastChat.celular) {
      return res.status(400).json({
        ok: false,
        error: "Ainda não existe lastChat em memória. Envie uma mensagem do celular para cair no webhook primeiro.",
      });
    }

    const { text, send_date } = req.body || {};
    if (!text) {
      return res.status(400).json({ ok: false, error: "Body inválido. Envie { text: '...' } (send_date opcional)" });
    }

    const target = lastChat.celular;

    console.log("=== reply-last ===");
    console.log({ target, lastChat });

    const data = await chatGuruSendMessage({
      chatNumber: target,
      text: String(text),
      sendDate: send_date ? String(send_date) : undefined,
    });

    console.log("=== Envio ChatGuru OK (reply-last) ===");
    console.log(JSON.stringify({ target, text, data }, null, 2));

    return res.status(200).json({
      ok: true,
      target,
      lastChat,
      result: data,
    });
  } catch (err) {
    const payload = err?.response?.data || null;
    const status = err?.response?.status || null;
    const msg = payload || err?.message || String(err);

    console.log("=== Erro ao enviar via ChatGuru (reply-last) ===");
    console.log({ status, msg });

    return res.status(500).json({ ok: false, error: msg, status });
  }
});

// Só pra você inspecionar qual é o lastChat atual (opcional, mas ajuda muito)
app.get("/last-chat", (req, res) => {
  // protegido também
  const token = req.headers["x-rt-admin-token"];
  if (!RT_ADMIN_TOKEN || token !== RT_ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized (x-rt-admin-token inválido)" });
  }
  return res.status(200).json({ ok: true, lastChat });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});