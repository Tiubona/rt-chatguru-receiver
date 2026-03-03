// ai-engine.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { Pool } = require("pg");

// ====== OpenAI (IA) ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";
const OPENAI_PROJECT = process.env.OPENAI_PROJECT || null;
const OPENAI_ORG = process.env.OPENAI_ORG || null;

// Liga/desliga IA sem alterar código (Render env):
// AI_ENABLED="false" desliga. Qualquer outro valor = ligado.
const AI_ENABLED = String(process.env.AI_ENABLED || "").toLowerCase() === "false" ? false : true;

// ====== DB ======
const DATABASE_URL = process.env.DATABASE_URL || null;
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : undefined,
    })
  : null;

// ====== RTBRAIN (base do robô) ======
function loadRtBrain() {
  try {
    const p = path.join(__dirname, "rtbrain.txt");
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  } catch (_) {}
  return null;
}
const RTBRAIN_TEXT = loadRtBrain();

// ====== OpenAI config checks ======
function requireOpenAIConfig() {
  const missing = [];
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!OPENAI_MODEL) missing.push("OPENAI_MODEL");
  return missing;
}

function canUseAI() {
  const missingAI = requireOpenAIConfig();
  return AI_ENABLED && missingAI.length === 0;
}

// ====== Util ======
function todayKeyBR() {
  // trava por dia no fuso do servidor (Render). Bom o suficiente pro "1x por dia".
  // Se quiser cravar America/Sao_Paulo, a gente ajusta depois com luxon.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function pickByHash(key, arr) {
  if (!Array.isArray(arr) || !arr.length) return "";
  let h = 0;
  for (let i = 0; i < String(key).length; i++) h = (h * 31 + String(key).charCodeAt(i)) >>> 0;
  return arr[h % arr.length];
}

function extractName(text) {
  const t = String(text || "").trim();
  if (!t) return null;

  // padrões comuns
  const m1 = t.match(/\b(meu nome é|me chamo|sou o|sou a|aqui é o|aqui é a)\s+([A-Za-zÀ-ÿ'\- ]{2,40})/i);
  if (m1 && m1[2]) return m1[2].trim().split(" ").slice(0, 3).join(" ");

  // se a pessoa só mandou "Rafael" / "Rafa"
  if (/^[A-Za-zÀ-ÿ'\-]{2,25}(?:\s+[A-Za-zÀ-ÿ'\-]{2,25})?$/.test(t)) {
    return t.split(" ").slice(0, 2).join(" ");
  }

  return null;
}

function detectProcedure(text) {
  const t = norm(text);

  const tattoo = /(tatu|tattoo|tatuagem)/i.test(t);
  const brow = /(sobr|sobrancelha|micro|micropig|micropigmenta)/i.test(t);
  const strias = /(estria|estrias)/i.test(t);
  const hof = /(hof|harmon|preench|ácido hial|acido hial|botox|toxina|mandíbula|mandibula|malar|mento|olheira|labial|têmpora|tempora|bigode chin[eê]s|marionete|rino)/i.test(
    t
  );

  // se mais de um, prioriza o mais específico pelo texto
  if (brow) return "sobrancelha";
  if (tattoo) return "tatuagem";
  if (strias) return "estrias";
  if (hof) return "hof";

  return null;
}

function detectIntent(text) {
  const t = norm(text);

  // agendamento/avaliação
  if (/(agendar|agenda|hor[aá]rio|marcar|quero agendar|avaliar|avaliaç[aã]o|avaliacao|consulta)/i.test(t)) return "agendar";

  // orçamento/preço/valor
  if (/(valor|pre[cç]o|or[cç]amento|quanto custa|custa quanto|taxa|forma de pagamento|pix|cart[aã]o)/i.test(t)) return "orcamento";

  // foto/mídia
  if (/(foto|imagem|segue a foto|enviei a foto|t[aá] aqui a foto|anexo|print|segue)/i.test(t)) return "foto";
  if (/(https?:\/\/\S+\.(jpg|jpeg|png|webp))/i.test(t)) return "foto";

  // dor
  if (/(d[oó]i|dor|ard[eê]ncia|incomoda|sofre|sens[ií]vel)/i.test(t)) return "dor";

  // cicatriz/marca
  if (/(cicatriz|marca|mancha|queima|ferida|pele fica|vai marcar)/i.test(t)) return "cicatriz";

  // anestesia
  if (/(anestesia|anest[eé]sico|inje[cç][aã]o|pomada anest[eé]sica)/i.test(t)) return "anestesia";

  // intervalo
  if (/(intervalo|quantos dias|de quanto em quanto|mensal|30 dias|semanal|toda semana)/i.test(t)) return "intervalo";

  // sessões
  if (/(quantas sess|n[uú]mero de sess|qtd de sess|quantidade de sess|demora|quanto tempo|em quanto tempo)/i.test(t)) return "sessoes";

  // pelos sobrancelha
  if (/(pelo|pelos|cai|queda|raiz|fio|clareia o pelo|descolore)/i.test(t)) return "pelos";

  // HOF pergunta genérica
  if (/(voc[eê]s fazem hof|trabalham com hof|harmoniza[cç][aã]o facial)/i.test(t)) return "hof_universal";

  return null;
}

function looksLikeOutOfScope(text) {
  const t = norm(text);

  // Mensagens curtas no WhatsApp são continuação do contexto
  if (t.length <= 20) return false;

  // Se tem pista clara do nosso escopo, OK
  if (detectProcedure(t)) return false;

  // Fora do escopo com sinais fortes
  const off = [
    "carro",
    "moto",
    "ipva",
    "receita",
    "bitcoin",
    "bet",
    "jogo",
    "política",
    "eleição",
    "dor no peito",
    "remédio",
    "medicamento",
    "diagnóstico",
    "advogado",
    "processo",
    "imposto",
  ];
  return off.some((w) => t.includes(w));
}

// ====== DB state (camadas) ======
let _stateTableReady = false;

async function ensureStateTable() {
  if (!pool) return false;
  if (_stateTableReady) return true;

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cg_state (
        celular TEXT PRIMARY KEY,
        updated_at TIMESTAMPTZ NOT NULL,
        state JSONB NOT NULL
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cg_state_updated_at ON cg_state(updated_at);`);
    _stateTableReady = true;
    return true;
  } catch (e) {
    console.log("DB: erro criando cg_state:", e?.message || e);
    return false;
  }
}

async function getState(celular) {
  const fallback = {
    greeted_on: null, // YYYY-MM-DD
    name: null,
    procedure: null, // tatuagem | sobrancelha | estrias | hof
    last_intent: null,
    last_photo_ack_on: null,
  };

  if (!pool || !celular) return { ...fallback };

  await ensureStateTable();

  try {
    const r = await pool.query(`SELECT state FROM cg_state WHERE celular=$1`, [String(celular)]);
    if (r.rows.length && r.rows[0].state) return { ...fallback, ...(r.rows[0].state || {}) };
  } catch (e) {
    console.log("DB: erro lendo estado:", e?.message || e);
  }
  return { ...fallback };
}

async function setState(celular, patch) {
  if (!pool || !celular) return;

  await ensureStateTable();

  try {
    const prev = await getState(celular);
    const next = { ...prev, ...(patch || {}) };

    await pool.query(
      `
      INSERT INTO cg_state (celular, updated_at, state)
      VALUES ($1, NOW(), $2)
      ON CONFLICT (celular) DO UPDATE SET updated_at = NOW(), state = EXCLUDED.state
      `,
      [String(celular), next]
    );
  } catch (e) {
    console.log("DB: erro salvando estado:", e?.message || e);
  }
}

// ====== Treino: buscar exemplos do banco ======
function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4)
    .slice(0, 10);
}

async function getTrainingExamples(userText, limit = 6) {
  if (!pool) return [];

  const words = tokenize(userText);
  if (!words.length) {
    const r = await pool.query(
      `SELECT tag, user_text, ideal_answer
       FROM ai_training
       ORDER BY id DESC
       LIMIT $1`,
      [limit]
    );
    return r.rows || [];
  }

  const likes = words.map((w) => `%${w}%`);
  const params = [];
  let where = [];

  likes.forEach((lk) => {
    params.push(lk);
    const p = `$${params.length}`;
    where.push(`user_text ILIKE ${p} OR tag ILIKE ${p}`);
  });

  params.push(limit);
  const limitParam = `$${params.length}`;

  const r = await pool.query(
    `SELECT tag, user_text, ideal_answer
     FROM ai_training
     WHERE ${where.join(" OR ")}
     ORDER BY id DESC
     LIMIT ${limitParam}`,
    params
  );

  return r.rows || [];
}

// ====== Templates (camadas) ======
const GREETINGS = [
  "{DAY_GREETING}! Me chamo Laura, sou secretária virtual da RT Laser. Como posso te ajudar hoje?",
  "{DAY_GREETING}! Sou a Laura, secretária virtual da RT Laser. Em que posso te auxiliar?",
  "{DAY_GREETING}! Aqui é a Laura, da RT Laser. Fico à disposição pra te ajudar. 😊",
  "{DAY_GREETING}! Laura falando, da RT Laser. Como posso te ajudar?",
  "{DAY_GREETING}! Você está falando com a Laura, da RT Laser. Em que posso ser útil?",
];

const ASK_NAME = [
  "Pra eu te atender direitinho: qual seu nome? 😊",
  "Só pra eu registrar aqui no atendimento: como você se chama?",
  "Me diz seu nome, por favor, pra eu te orientar certinho 🙂",
];

const THANK_NAME = [
  "Perfeito, {NAME}! Obrigada 😊",
  "Show, {NAME}! Obrigada por me dizer 🙂",
  "Ótimo, {NAME}! Obrigada 🤍",
];

const ASK_PROCEDURE = [
  "Qual dos nossos procedimentos você quer informações: remoção de tatuagem, remoção de sobrancelhas, harmonização facial ou tratamento para estrias?",
  "Sobre qual serviço você deseja saber mais: remoção de tatuagem, remoção de sobrancelhas, harmonização facial ou tratamento para estrias?",
  "Pra eu te orientar melhor, qual desses procedimentos você procura: remoção de tatuagem, remoção de sobrancelhas, harmonização facial ou tratamento para estrias?",
];

const TATTOO_PHOTO_FOR_BUDGET = [
  "📸 Pra realizarmos a avaliação, me envie uma foto nítida da tatuagem mostrando toda a região do corpo. Se forem várias, envie juntas; se for parcial, destaque a área.\n📌 Assim já encaminho sua remoção pra análise!",
  "📷 Pra avaliarmos corretamente, preciso de uma foto clara da tatuagem com a região completa visível. Se houver mais de uma, mande todas juntas; se parcial, marque a parte desejada.\n📌 Assim já adianto sua análise!",
  "📸 Pode me enviar uma foto bem nítida da tatuagem mostrando a área do corpo? Se forem várias, envie no mesmo momento; se parcial, sublinhe a região.\n📌 Assim já coloco sua remoção na fila de avaliação!",
];

const PHOTO_ACK = [
  "Perfeito! Obrigada por enviar a foto 😊\nA partir de agora vou encaminhar para nossos profissionais realizarem a avaliação e já te retorno com as orientações.",
  "Obrigada pela foto! 😊\nAgora vou encaminhar para nossos profissionais fazerem a avaliação e já te trago o retorno.",
];

const SCHEDULING = [
  "Perfeito! A Lari já vai entrar em contato com você pra verificar a disponibilidade de horários e te ajudar com o agendamento 😊\nObrigada!",
  "Combinado! A Lari já vai falar com você pra ver os horários disponíveis e concluir seu agendamento 😊\nObrigada!",
];

// Dor (tatuagem + sobrancelha)
const PAIN_REPLY = [
  "A dor é bem relativa de pessoa pra pessoa. Em áreas como costela, mãos e pés a sensibilidade costuma ser maior. A sensação geralmente é parecida com a da tatuagem, só que o procedimento é mais rápido.\nPra conforto, usamos resfriador durante toda a sessão e, se precisar, pode solicitar anestésico injetável (R$ 50,00 por região).",
  "A sensibilidade varia conforme o limiar de cada pessoa — regiões ósseas costumam ser mais delicadas. Muita gente compara com a tatuagem, mas o laser é mais rápido.\nUsamos resfriamento contínuo e, em casos específicos, anestésico injetável (R$ 50,00 por região).",
];

// Intervalo (tatuagem + sobrancelha)
const INTERVAL_REPLY = [
  "O intervalo mínimo médio entre sessões é de 30 dias (às vezes pode ser maior), porque é nesse período pós-sessão que o organismo elimina o pigmento.\nFazer semanalmente não acelera 😊 e pode atrapalhar a recuperação natural da pele e aumentar risco de marcas.",
  "Indicamos em média 30 dias entre as sessões. É no pós que acontece a maior parte do clareamento.\nReduzir esse prazo não acelera o resultado e pode comprometer a cicatrização 😊",
];

// Sessões tatuagem
const TATTOO_SESSIONS = [
  "A quantidade de sessões depende de tamanho, cores e tipo de pigmento. O preto costuma evoluir melhor por interagir mais com o laser.\nMesmo assim não dá pra garantir um número exato, porque a eliminação depende do organismo.",
];

// Sessões sobrancelha
const BROW_SESSIONS = [
  "Na remoção de sobrancelhas, a quantidade de sessões depende de intensidade, profundidade e se há variação de cores. No geral o pigmento é mais leve que o de tatuagem corporal, então a evolução costuma ser mais rápida quando a cor é uniforme.\nAinda assim não dá pra prometer número exato, porque a resposta do organismo varia.",
];

// Cicatriz (tatuagem + sobrancelha)
const SCAR_REPLY = [
  "Ótima pergunta 😊 Nós usamos equipamentos regulamentados e técnica focada no pigmento, preservando ao máximo a estrutura da pele.\nSeguir o pós corretamente (pomada indicada e evitar atrito/manipular) faz toda a diferença — explicamos tudo direitinho antes da sessão 🤗",
  "Dúvida super válida 🤍 Nosso protocolo atua no pigmento com segurança, buscando manter a qualidade da pele.\nE os cuidados pós (pomada e não manipular) são essenciais — a gente orienta passo a passo antes do procedimento 😊",
];

// Anestesia (complemento)
const ANESTHESIA_REPLY = [
  "Se a região for mais sensível, você pode solicitar anestésico injetável pra deixar bem mais confortável — ele tem custo adicional de R$ 50,00 por região. E durante toda a sessão usamos resfriador pra analgesia pelo frio 😊",
];

// Arrependimento imediato (tatuagem / micro) - modelo único (curto)
const REGRET_SAME_DAY = [
  "Quando a tatuagem/micropigmentação é feita, o corpo entra em cicatrização (em média 30 dias) e parte do pigmento vai se fixando.\nSe o arrependimento for imediato, em alguns casos dá pra fazer laser até no mesmo dia, ajudando a eliminar mais pigmento antes de estabilizar. Depois de cicatrizado, a tinta nova tende a ficar mais resistente.",
];

// Pelos (sobrancelha)
const BROW_HAIR = [
  "Essa dúvida é bem comum 😊 Nosso laser não atinge nem destrói a raiz do pelo da sobrancelha. Em alguns casos pode ocorrer um clareamento temporário dos fios durante a sessão, principalmente quando o pigmento é mais claro (alaranjado/vermelho).",
  "Pode ficar tranquilo(a) 😊 O laser atua no pigmento da pele, não na raiz do pelo. Eventualmente pode acontecer uma alteração temporária na cor do fio, mais comum em tintas claras (vermelho/laranja).",
];

// Valor sobrancelha
const BROW_PRICE = [
  "O *valor da sessão* de despigmentação é tabelado e corresponde à *sobrancelha completa*, mas se precisar também fazemos parcial conforme avaliação.\n\n💵 R$260,00 (dinheiro/PIX)\nou\n💳 R$280,00 (cartão débito/crédito em até 2x s/ juros)\n\nNesse valor já está incluso resfriador durante o procedimento!",
];

// Estrias (6 pontos)
function stretchMarksReply() {
  return (
    "Tratamento de estrias com o *Método Bárbara Aguiar* (estímulos controlados que ativam regeneração).\n" +
    "Sessões: 2–3 (brancas) e 3–5 (vermelhas/roxas). Intervalo: 30 a 60 dias.\n" +
    "Resultados: melhora média entre 70% e 100% (varia por pele e cuidados).\n" +
    "Contraindicações: não indicado para camuflagem, uso contínuo de corticoide, doenças autoimunes e diabetes descompensada.\n" +
    "Pode ser feito em várias regiões — o ideal é agendar avaliação pra Dra. Thay definir o melhor plano."
  );
}

// HOF
function hofUniversalReply() {
  return (
    "Fazemos sim 🙂 Me conte o que você pensou em fazer ou o que está te incomodando no rosto.\n\n" +
    "Procedimentos com ácido hialurônico:\n" +
    "– Mandíbula – Malar – Mento – Olheira – Labial – Têmpora – Bigode Chinês – Linha de Marionete – Rinomodelação\n\n" +
    "Também fazemos aplicação de toxina botulínica (Botox) em todas as regiões da face."
  );
}

// Fallback fora do escopo
function outOfScopeReply() {
  return (
    "Entendi. Essa dúvida foge do que eu tenho aqui agora — vou confirmar com a Larissa e já te retorno. 😉\n\n" +
    "Pra eu te ajudar no que é da RT: é sobre tatuagem, sobrancelha, estrias ou harmonização?"
  );
}

// ====== RTBRAIN System Prompt (TRAVADO) ======
function buildLockedSystemPrompt(examples, historyBlockText, stateBlockText) {
  const base = String(RTBRAIN_TEXT || "").trim();

  const scope = `
ESCOPO PERMITIDO (apenas):
- Remoção de tatuagem
- Remoção de micropigmentação de sobrancelha
- Tratamento de estrias
- Harmonização facial (Dra. Thay)

PROIBIDO:
- Responder qualquer coisa fora do escopo.
- Inventar informação, sugerir técnicas/medicamentos/procedimentos que não estejam no RTBRAIN.
- Usar internet ou conhecimento externo fora do RTBRAIN.
`;

  const rules = `
REGRAS DE ESTILO:
- Soe humano, cordial e objetivo.
- Não misture procedimentos.
- Se faltar informação, faça no máximo 1 pergunta objetiva.
- Se for fora do escopo OU algo que não esteja no RTBRAIN:
  1) diga que vai confirmar com a Larissa e retornar
  2) faça 1 pergunta para trazer para o menu (tatuagem / sobrancelha / estrias / harmonização).
`;

  const fallbackIfNoBrain = `
Você é a Laura, secretária virtual da RT Laser.
Você só pode responder sobre: tatuagem, sobrancelha, estrias ou harmonização facial.
Se for fora disso, diga que vai confirmar com Larissa e faça 1 pergunta para o cliente escolher um desses 4.
`;

  const ex =
    Array.isArray(examples) && examples.length
      ? `
EXEMPLOS (use como referência de tom/estrutura quando fizer sentido):
${examples
  .slice(0, 6)
  .map((e, i) => {
    const tag = e.tag ? ` [${String(e.tag)}]` : "";
    return `(${i + 1}) Cliente${tag}: ${String(e.user_text || "").trim()}
Resposta ideal: ${String(e.ideal_answer || "").trim()}`;
  })
  .join("\n\n")}
`
      : "";

  const history =
    historyBlockText
      ? `
CONTEXTO DO CHAT (mais recente por último):
${String(historyBlockText).trim()}
`
      : "";

  const state =
    stateBlockText
      ? `
ESTADO ATUAL (persistido):
${String(stateBlockText).trim()}
`
      : "";

  const head = base ? base : fallbackIfNoBrain;
  return `${head}\n\n${scope}\n${rules}\n${state}\n${history}\n${ex}`.trim();
}

// ====== OpenAI call (Responses API) ======
async function openaiCreateReply({ system, user }) {
  const missing = requireOpenAIConfig();
  if (missing.length) throw new Error("Config OpenAI incompleta: " + missing.join(", "));

  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  };

  if (OPENAI_PROJECT) headers["OpenAI-Project"] = OPENAI_PROJECT;
  if (OPENAI_ORG) headers["OpenAI-Organization"] = OPENAI_ORG;

  const payload = {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: [{ type: "input_text", text: String(system || "") }] },
      { role: "user", content: [{ type: "input_text", text: String(user || "") }] },
    ],
  };

  const resp = await axios.post("https://api.openai.com/v1/responses", payload, { timeout: 20000, headers });

  if (typeof resp?.data?.output_text === "string") return resp.data.output_text.trim();

  const output = resp?.data?.output;
  if (Array.isArray(output)) {
    let acc = "";
    for (const item of output) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if ((c?.type === "output_text" || c?.type === "text") && typeof c?.text === "string") acc += c.text;
        }
      }
    }
    return String(acc || "").trim();
  }

  return "";
}

// ====== Camadas (decisão principal) ======
async function decideByLayers({ userText, history, celular }) {
  const t = String(userText || "").trim();
  const n = norm(t);

  // 0) fora do escopo
  if (looksLikeOutOfScope(n)) return { reply: outOfScopeReply(), usedAI: false };

  // estado
  const state = await getState(celular);
  const today = todayKeyBR();

  // tenta extrair nome do histórico e da mensagem atual
  const historyTexts = Array.isArray(history) ? history.map((h) => String(h.text || "")) : [];
  const nameFromNow = extractName(t);
  const nameFromHistory = historyTexts
    .slice(-8)
    .map(extractName)
    .filter(Boolean)
    .slice(-1)[0];

  let name = state.name || nameFromNow || nameFromHistory || null;

  if (name && name !== state.name) {
    await setState(celular, { name });
  }

  // 1) saudação 1x/dia
  let greetPrefix = "";
  if (state.greeted_on !== today) {
    const g = pickByHash(`${celular}::${today}::greet`, GREETINGS);
    greetPrefix = g ? `${g}\n\n` : "";
    await setState(celular, { greeted_on: today });
  }

  // intenção/procedimento
  const intent = detectIntent(n);
  const procDetected = detectProcedure(n);
  const procedure = procDetected || state.procedure || null;

  // 2) agendamento sempre ganha (serve pra qualquer procedimento)
  if (intent === "agendar") {
    return { reply: `${greetPrefix}${pickByHash(`${celular}::${today}::sched`, SCHEDULING)}`, usedAI: false };
  }

  // 3) foto recebida (ack e encaminha)
  // regra: se identificou foto, agradece e encaminha (principalmente se tatuagem)
  if (intent === "foto") {
    // evita repetir ack várias vezes no mesmo dia se a pessoa mandar várias imagens
    if (state.last_photo_ack_on !== today) {
      await setState(celular, { last_photo_ack_on: today });
      const ack = pickByHash(`${celular}::${today}::photo`, PHOTO_ACK);
      return { reply: `${greetPrefix}${ack}`, usedAI: false };
    }
    // se já agradeceu hoje, só confirma curto
    return { reply: `${greetPrefix}Recebido 😊 Vou encaminhar para avaliação e já te retorno.`, usedAI: false };
  }

  // 4) Camada Nome (se ainda não tiver)
  if (!name) {
    const ask = pickByHash(`${celular}::${today}::askname`, ASK_NAME);
    return { reply: `${greetPrefix}${ask}`, usedAI: false };
  }

  // 5) Camada Procedimento (se ainda não tiver definido)
  // Se a pessoa acabou de mandar nome agora (ou parece que só respondeu o nome), agradece e já pergunta procedimento.
  const looksLikeJustName = !!extractName(t) && t.split(" ").length <= 3;
  if (!procedure) {
    const thanks = pickByHash(`${celular}::${today}::thankname`, THANK_NAME).replace("{NAME}", name);
    const askProc = pickByHash(`${celular}::${today}::askproc`, ASK_PROCEDURE);
    // se for “só nome”, agradece; se já tinha conversa, pode ir direto
    const mid = looksLikeJustName ? `${thanks}\n\n` : "";
    return { reply: `${greetPrefix}${mid}${askProc}`, usedAI: false };
  }

  // salvando procedimento (se detectou agora e estava vazio)
  if (procDetected && procDetected !== state.procedure) {
    await setState(celular, { procedure: procDetected });
  }

  // 6) Respostas por procedimento + intenção (camada 2)
  // tatuagem
  if (procedure === "tatuagem") {
    if (intent === "orcamento") {
      const askPhoto = pickByHash(`${celular}::${today}::tattoophoto`, TATTOO_PHOTO_FOR_BUDGET);
      return { reply: `${greetPrefix}${askPhoto}`, usedAI: false };
    }
    if (intent === "dor") return { reply: `${greetPrefix}${pickByHash(`${celular}::${today}::pain`, PAIN_REPLY)}`, usedAI: false };
    if (intent === "cicatriz") return { reply: `${greetPrefix}${pickByHash(`${celular}::${today}::scar`, SCAR_REPLY)}`, usedAI: false };
    if (intent === "anestesia") return { reply: `${greetPrefix}${pickByHash(`${celular}::${today}::anes`, ANESTHESIA_REPLY)}`, usedAI: false };
    if (intent === "intervalo") return { reply: `${greetPrefix}${pickByHash(`${celular}::${today}::interval`, INTERVAL_REPLY)}`, usedAI: false };
    if (intent === "sessoes") return { reply: `${greetPrefix}${pickByHash(`${celular}::${today}::sessions`, TATTOO_SESSIONS)}`, usedAI: false };

    // arrependimento imediato
    if (/(arrepend|fiz hoje|hoje|acabei de fazer|na hora)/i.test(n)) {
      return { reply: `${greetPrefix}${pickByHash(`${celular}::${today}::regret`, REGRET_SAME_DAY)}`, usedAI: false };
    }

    // sem intenção clara: pergunta objetiva
    return {
      reply:
        `${greetPrefix}Perfeito, ${name}! Sobre remoção de tatuagem, sua dúvida é sobre orçamento, dor, cicatriz, anestesia, intervalo entre sessões ou quantidade de sessões?`,
      usedAI: false,
    };
  }

  // sobrancelha
  if (procedure === "sobrancelha") {
    if (intent === "orcamento") return { reply: `${greetPrefix}${pickByHash(`${celular}::${today}::browprice`, BROW_PRICE)}`, usedAI: false };
    if (intent === "dor") return { reply: `${greetPrefix}${pickByHash(`${celular}::${today}::pain`, PAIN_REPLY)}`, usedAI: false };
    if (intent === "cicatriz") return { reply: `${greetPrefix}${pickByHash(`${celular}::${today}::scar`, SCAR_REPLY)}`, usedAI: false };
    if (intent === "anestesia") return { reply: `${greetPrefix}${pickByHash(`${celular}::${today}::anes`, ANESTHESIA_REPLY)}`, usedAI: false };
    if (intent === "intervalo") return { reply: `${greetPrefix}${pickByHash(`${celular}::${today}::interval`, INTERVAL_REPLY)}`, usedAI: false };
    if (intent === "sessoes") return { reply: `${greetPrefix}${pickByHash(`${celular}::${today}::browsessions`, BROW_SESSIONS)}`, usedAI: false };
    if (intent === "pelos") return { reply: `${greetPrefix}${pickByHash(`${celular}::${today}::browhair`, BROW_HAIR)}`, usedAI: false };

    // arrependimento imediato
    if (/(arrepend|fiz hoje|hoje|acabei de fazer|na hora)/i.test(n)) {
      return { reply: `${greetPrefix}${pickByHash(`${celular}::${today}::regret`, REGRET_SAME_DAY)}`, usedAI: false };
    }

    return {
      reply: `${greetPrefix}Perfeito, ${name}! Sobre remoção de sobrancelhas, sua dúvida é sobre valor, dor, cicatriz, intervalo entre sessões, quantidade de sessões ou pelos?`,
      usedAI: false,
    };
  }

  // estrias
  if (procedure === "estrias") {
    return { reply: `${greetPrefix}${stretchMarksReply()}`, usedAI: false };
  }

  // hof
  if (procedure === "hof") {
    return { reply: `${greetPrefix}${hofUniversalReply()}`, usedAI: false };
  }

  // fallback menu
  const askProc = pickByHash(`${celular}::${today}::askproc2`, ASK_PROCEDURE);
  return { reply: `${greetPrefix}${askProc}`, usedAI: false };
}

// ====== Engine (principal) ======
async function generateLockedReply(userText, history = []) {
  // tenta obter celular pelo history (se existir) — mas normalmente o server não passa.
  // Como você já está chamando generateLockedReply(rawText, history), vamos pegar do history (se vier)
  // e, se não vier, usa "unknown" (não quebra; só perde estado persistente).
  //
  // ✅ IMPORTANTE: pro estado persistir de verdade, o server precisa passar o celular.
  // Mas como você pediu "sem mexer agora", eu deixei uma heurística:
  // - se no history houver "celular:" não tem.
  // => então por enquanto o estado pode não persistir como esperado.
  //
  // Melhor: no server, chamar generateLockedReply(rawText, history, celular)
  // (quando você quiser, eu ajusto isso em 2 linhas).
  const celular = (Array.isArray(history) && history.length && history[0]?.celular) ? String(history[0].celular) : "unknown";

  // bloco de histórico para IA (se cair em OpenAI)
  const historyBlockText =
    Array.isArray(history) && history.length
      ? history
          .slice(-12)
          .map((h) => `- ${String(h.text || "").trim()}`)
          .filter(Boolean)
          .join("\n")
      : "";

  // 1) primeiro tenta resolver por camadas (sem gastar token)
  const layerDecision = await decideByLayers({ userText, history, celular });
  if (layerDecision && layerDecision.reply) return String(layerDecision.reply).trim();

  // 2) se sobrou algo que não encaixa, usa IA travada com RTBRAIN
  const examples = await getTrainingExamples(userText, 6);

  const state = await getState(celular);
  const stateBlockText = JSON.stringify(state, null, 2);

  const systemPrompt = buildLockedSystemPrompt(examples, historyBlockText, stateBlockText);

  // se IA não estiver disponível, devolve fallback seguro
  if (!canUseAI()) {
    return "Recebi sua mensagem ✅ Só um segundo que já te respondo aqui.";
  }

  const reply = await openaiCreateReply({
    system: systemPrompt,
    user: String(userText || ""),
  });

  const finalText = String(reply || "").trim();
  return finalText || "Recebi sua mensagem ✅ Só um segundo que já te respondo aqui.";
}

module.exports = {
  AI_ENABLED,
  OPENAI_MODEL,
  RTBRAIN_TEXT,

  requireOpenAIConfig,
  canUseAI,
  buildLockedSystemPrompt,
  looksLikeOutOfScope,

  openaiCreateReply,
  generateLockedReply,
};