async function api(url, opts={}) {
  const r = await fetch(url, opts);
  if (r.status === 401) { window.location.href = "/login"; return null; }
  return { r, j: await r.json().catch(()=>({})) };
}

async function load() {
  const s = await api("/api/stats");
  if (!s) return;

  const { counters, lastChat, config } = s.j;

  document.getElementById("kpiRecv").textContent = counters?.received_webhooks ?? 0;
  document.getElementById("kpiSent").textContent = counters?.sent_messages ?? 0;
  document.getElementById("kpiErr").textContent  = counters?.send_errors ?? 0;

  document.getElementById("lastChat").textContent =
    lastChat?.celular
      ? `Último chat: ${lastChat.celular} • ${lastChat.nome || "Sem nome"} • msg: ${lastChat.texto_mensagem || "—"}`
      : "Último chat: —";

  document.getElementById("lastErr").textContent =
    counters?.last_error ? `Último erro: ${JSON.stringify(counters.last_error)}` : "Último erro: —";

  document.getElementById("enabled").checked = !!config?.enabled;
  document.getElementById("start").value = config?.operating_hours?.start || "08:30";
  document.getElementById("end").value   = config?.operating_hours?.end   || "18:30";

  const k = await api("/api/knowledge");
  if (!k) return;
  document.getElementById("knowledge").value = k.j.text || "";
}

document.getElementById("saveConfig").onclick = async () => {
  const enabled = document.getElementById("enabled").checked;
  const start = document.getElementById("start").value.trim();
  const end = document.getElementById("end").value.trim();

  const out = await api("/api/config", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ enabled, operating_hours: { start, end } })
  });

  const msg = document.getElementById("cfgMsg");
  msg.textContent = out?.r.ok ? "Salvo ✅" : (out?.j?.error || "Falhou");
  setTimeout(()=>msg.textContent="", 2000);
};

document.getElementById("saveKnowledge").onclick = async () => {
  const text = document.getElementById("knowledge").value;
  const out = await api("/api/knowledge", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ text })
  });

  const msg = document.getElementById("knMsg");
  msg.textContent = out?.r.ok ? "Salvo ✅" : (out?.j?.error || "Falhou");
  setTimeout(()=>msg.textContent="", 2000);
};

document.getElementById("logout").onclick = async () => {
  await fetch("/api/logout", { method:"POST" });
  window.location.href = "/login";
};

load();
setInterval(load, 5000); // auto refresh