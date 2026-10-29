// Servidor do site: entrega as páginas, valida o login da Twitch e contabiliza os minutos assistidos.
// Rode com `npm install` uma vez e depois `node server.js`.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const IMG_DIR = path.join(ROOT, 'img');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'minutos.json');

// config.json vale para rodar no PC; na hospedagem, as variáveis de ambiente têm prioridade.
const fileConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const config = {
  ...fileConfig,
  clientId: process.env.TWITCH_CLIENT_ID || fileConfig.clientId,
  channel: process.env.TWITCH_CHANNEL || fileConfig.channel,
};
const PORT = Number(process.env.PORT) || config.port || 3000;
const REDIRECT_URI = process.env.REDIRECT_URI || config.redirectUri || `http://localhost:${PORT}/callback`;
const DATABASE_URL = process.env.DATABASE_URL;

// Intervalo mínimo entre dois minutos contados para o mesmo usuário
// (um pouco abaixo de 60s para tolerar atrasos de rede).
const MIN_INTERVAL_MS = 55 * 1000;
const TOKEN_CACHE_MS = 10 * 60 * 1000;
const LIVE_CACHE_MS = 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------- Dados ----------
// Os minutos ficam em memória e são gravados no Postgres (se DATABASE_URL existir)
// ou no arquivo data/minutos.json (no PC).
// { [twitchUserId]: { login, displayName, profileImage, minutes, lastBeat } }
let users = {};
let db = null;

async function loadUsers() {
  if (!DATABASE_URL) {
    try {
      users = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
      users = {};
    }
    return;
  }

  const { Pool } = require('pg');
  db = new Pool({ connectionString: DATABASE_URL });
  await db.query(`CREATE TABLE IF NOT EXISTS viewers (
    id TEXT PRIMARY KEY,
    login TEXT,
    display_name TEXT,
    profile_image TEXT,
    minutes INTEGER NOT NULL DEFAULT 0,
    last_beat BIGINT NOT NULL DEFAULT 0
  )`);
  const { rows } = await db.query('SELECT * FROM viewers');
  for (const r of rows) {
    users[r.id] = {
      login: r.login,
      displayName: r.display_name,
      profileImage: r.profile_image,
      minutes: r.minutes,
      lastBeat: Number(r.last_beat),
    };
  }
}

function saveUser(id) {
  if (!db) return scheduleSave();
  const u = users[id];
  db.query(
    `INSERT INTO viewers (id, login, display_name, profile_image, minutes, last_beat)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET login = $2, display_name = $3, profile_image = $4, minutes = $5, last_beat = $6`,
    [id, u.login, u.displayName, u.profileImage, u.minutes, u.lastBeat]
  ).catch((err) => console.error('Erro ao salvar no banco:', err.message));
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, 2000);
}
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function rankOf(minutes) {
  if (!minutes) return null;
  return 1 + Object.values(users).filter((u) => u.minutes > minutes).length;
}

// ---------- Twitch ----------
function helixHeaders(token) {
  return { 'Client-Id': config.clientId, Authorization: `Bearer ${token}` };
}

const tokenCache = new Map(); // token -> { user, until }
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokenCache) if (entry.until <= now) tokenCache.delete(token);
}, TOKEN_CACHE_MS).unref();

// Confere o token com a Twitch e devolve quem é o usuário (ou null se for inválido).
async function twitchUser(token) {
  const cached = tokenCache.get(token);
  if (cached && cached.until > Date.now()) return cached.user;

  const v = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${token}` },
  });
  if (!v.ok) return null;
  const info = await v.json();
  if (info.client_id !== config.clientId) return null;

  let displayName = info.login;
  let profileImage = '';
  const r = await fetch(`https://api.twitch.tv/helix/users?id=${info.user_id}`, { headers: helixHeaders(token) });
  if (r.ok) {
    const u = (await r.json()).data?.[0];
    if (u) {
      displayName = u.display_name;
      profileImage = u.profile_image_url;
    }
  }

  const user = { id: info.user_id, login: info.login, displayName, profileImage };
  tokenCache.set(token, { user, until: Date.now() + TOKEN_CACHE_MS });
  return user;
}

let liveCache = { value: false, until: 0 };
async function channelIsLive(token) {
  if (liveCache.until > Date.now()) return liveCache.value;
  const r = await fetch(
    `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(config.channel)}`,
    { headers: helixHeaders(token) }
  );
  if (!r.ok) return false;
  const live = (await r.json()).data.length > 0;
  liveCache = { value: live, until: Date.now() + LIVE_CACHE_MS };
  return live;
}

// ---------- HTTP ----------
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function bearer(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/config') {
    return sendJson(res, 200, { clientId: config.clientId, channel: config.channel, redirectUri: REDIRECT_URI });
  }

  if (route === 'GET /api/ranking') {
    const top = Object.values(users)
      .filter((u) => u.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 50)
      .map(({ displayName, profileImage, minutes }) => ({ displayName, profileImage, minutes }));
    return sendJson(res, 200, top);
  }

  if (route !== 'GET /api/me' && route !== 'POST /api/heartbeat') {
    return sendJson(res, 404, { error: 'rota não encontrada' });
  }

  const token = bearer(req);
  const user = token && (await twitchUser(token));
  if (!user) return sendJson(res, 401, { error: 'login inválido ou expirado' });

  const rec = (users[user.id] ||= { minutes: 0, lastBeat: 0 });
  Object.assign(rec, { login: user.login, displayName: user.displayName, profileImage: user.profileImage });

  if (route === 'GET /api/me') {
    return sendJson(res, 200, { ...user, minutes: rec.minutes, rank: rankOf(rec.minutes) });
  }

  // POST /api/heartbeat: o navegador chama a cada 60s de player tocando.
  const live = !config.countOnlyLive || (await channelIsLive(token));
  const now = Date.now();
  let counted = false;
  if (live && now - rec.lastBeat >= MIN_INTERVAL_MS) {
    rec.minutes += 1;
    rec.lastBeat = now;
    counted = true;
    saveUser(user.id);
  }
  return sendJson(res, 200, { counted, live, minutes: rec.minutes, rank: rankOf(rec.minutes) });
}

function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  // /callback é o endereço de retorno do login da Twitch: mostra a mesma página.
  if (rel === '/' || rel === '/callback') rel = '/index.html';

  // Só serve arquivos de public/ e img/ — nunca server.js, config.json ou data/.
  const [base, sub] = rel.startsWith('/img/') ? [IMG_DIR, rel.slice(4)] : [PUBLIC_DIR, rel];
  const file = path.join(base, sub);
  if (!file.startsWith(base + path.sep)) {
    res.writeHead(404);
    return res.end();
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Não encontrado');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'erro interno' });
  }
});

loadUsers()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Site rodando em http://localhost:${PORT}`);
      console.log(db ? 'Minutos salvos no banco de dados.' : 'Minutos salvos em data/minutos.json.');
      if (!config.channel) console.log('Aviso: defina o canal da Twitch em config.json (campo "channel").');
    });
  })
  .catch((err) => {
    console.error('Não foi possível carregar os minutos:', err.message);
    process.exit(1);
  });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (saveTimer) saveNow();
    process.exit(0);
  });
}
