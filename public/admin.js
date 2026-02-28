cat > public/admin.js <<'EOF'
function getToken() {
  return localStorage.getItem('rt_admin_token') || '';
}

async function api(path, { method='GET', body } = {}) {
  const headers = { 'x-rt-admin-token': getToken() };
  if (body) headers['Content-Type'] = 'application/json';

  const resp = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }

  if (!resp.ok) throw new Error(data?.error || data?.raw || `HTTP ${resp.status}`);
  return data;
}

function $(id) { return document.getElementById(id); }

(async function init() {
  // versão (pra você ver se atualizou deploy)
  try {
    const v = await fetch('/version').then(r => r.json());
    $('versionInfo').textContent = `Versão: ${v.commit || 'sem commit'} • publicDir: ${v.publicDir || '—'}`;
  } catch (_) {}

  $('logout').addEventListener('click', () => {
    localStorage.removeItem('rt_admin_token');
    window.location.href = '/login';
  });

  // placeholders pro futuro (quando plugar config/knowledge em endpoints)
  $('saveConfig').addEventListener('click', () => {
    $('cfgMsg').textContent = 'OK (placeholder). Próximo passo: salvar via endpoint.';
    setTimeout(() => $('cfgMsg').textContent = '', 2500);
  });

  $('saveKnowledge').addEventListener('click', () => {
    $('knMsg').textContent = 'OK (placeholder). Próximo passo: salvar via endpoint.';
    setTimeout(() => $('knMsg').textContent = '', 2500);
  });
})();
EOF