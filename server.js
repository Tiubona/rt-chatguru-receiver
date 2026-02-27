const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ✅ Cloud (Render) injeta a porta via variável de ambiente
const PORT = process.env.PORT || 3000;

const EVENTS_FILE = path.join(__dirname, "events.jsonl");

app.get("/health", (req, res) => {
  return res.status(200).json({ status: "online" });
});

app.post("/webhook/chatguru", (req, res) => {
  const event = {
    receivedAt: new Date().toISOString(),
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    headers: req.headers,
    body: req.body,
  };

  console.log("Webhook recebido:");
  console.log(JSON.stringify(event, null, 2));

  // Observação: em servidores cloud, o disco pode ser efêmero.
  // Para esta fase, serve para debug. Depois, a gente leva pra banco.
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + "\n", { encoding: "utf8" });

  return res.status(200).json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});