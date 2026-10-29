// Login com Twitch, player do canal e contagem de minutos assistidos.
const TOKEN_KEY = 'twitch_token';
const STATE_KEY = 'twitch_state';
const el = (id) => document.getElementById(id);

let config = null;
let token = null;
let me = null;
let player = null;
let watchedSeconds = 0;
let lastLive = null;

// localStorage/sessionStorage podem falhar em janela anônima ou com cookies bloqueados.
function storage(fn) {
  try { return fn(); } catch { return null; }
}

function showNotice(text) {
  el('aviso').textContent = text;
  el('aviso').hidden = false;
}

function setStatus(text, active = false) {
  el('status').textContent = text;
  el('status').classList.toggle('ativo', active);
}

function formatMinutes(total) {
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}min`;
}

// ---------- Login ----------
// A Twitch devolve o token no "#" da URL depois do login (fluxo implícito do OAuth).
function readTokenFromRedirect() {
  const query = new URLSearchParams(location.search);
  if (query.get('error')) {
    showNotice(`O login com a Twitch não foi concluído: ${query.get('error_description') || query.get('error')}`);
    history.replaceState(null, '', '/');
    return;
  }

  const hash = new URLSearchParams(location.hash.slice(1));
  const newToken = hash.get('access_token');
  if (!newToken) return;

  const expected = storage(() => sessionStorage.getItem(STATE_KEY));
  storage(() => sessionStorage.removeItem(STATE_KEY));
  history.replaceState(null, '', '/');

  if (!expected || hash.get('state') !== expected) {
    showNotice('Login ignorado: a resposta da Twitch não confere. Tente entrar de novo.');
    return;
  }
  storage(() => localStorage.setItem(TOKEN_KEY, newToken));
}

function login() {
  const state = crypto.randomUUID();
  storage(() => sessionStorage.setItem(STATE_KEY, state));
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'token',
    scope: '',
    state,
  });
  location.href = `https://id.twitch.tv/oauth2/authorize?${params}`;
}

function logout() {
  if (token) {
    fetch('https://id.twitch.tv/oauth2/revoke', {
      method: 'POST',
      body: new URLSearchParams({ client_id: config.clientId, token }),
    }).catch(() => {});
  }
  token = null;
  me = null;
  storage(() => localStorage.removeItem(TOKEN_KEY));
  showLoggedOut();
  loadRanking();
}

async function api(path, method = 'GET') {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(path, { method, headers });
  if (res.status === 401 && token) {
    logout();
    showNotice('Sua sessão da Twitch expirou. Entre de novo para continuar contando minutos.');
    return null;
  }
  if (!res.ok) throw new Error(`${path} respondeu ${res.status}`);
  return res.json();
}

// ---------- Tela ----------
function showLoggedOut() {
  el('entrar').hidden = false;
  el('usuario').hidden = true;
  setStatus('Entre com a Twitch para seus minutos assistidos contarem no ranking.');
}

function showUser() {
  el('entrar').hidden = true;
  el('usuario').hidden = false;
  el('usuario-nome').textContent = me.displayName;
  el('usuario-foto').src = me.profileImage || '/img/avatar.jpg';
  showMinutes();
  setStatus('Seus minutos começam a contar quando a live estiver no ar e o player tocando.');
}

function showMinutes() {
  const rank = me.rank ? ` · ${me.rank}º lugar` : '';
  el('usuario-minutos').textContent = `${formatMinutes(me.minutes)} assistidos${rank}`;
}

async function loadRanking() {
  let list;
  try {
    list = await api('/api/ranking');
  } catch {
    return;
  }
  const ol = el('ranking-lista');
  ol.replaceChildren();
  for (const row of list || []) {
    const li = document.createElement('li');
    if (me && row.displayName === me.displayName) li.classList.add('eu');

    const img = document.createElement('img');
    img.src = row.profileImage || '/img/avatar.jpg';
    img.alt = '';
    const name = document.createElement('span');
    name.className = 'nome';
    name.textContent = row.displayName;
    const min = document.createElement('span');
    min.className = 'min';
    min.textContent = formatMinutes(row.minutes);

    li.append(img, name, min);
    ol.append(li);
  }
  el('ranking-vazio').hidden = ol.children.length > 0;
}

// ---------- Player e contagem ----------
function startPlayer() {
  if (!config.channel) {
    showNotice('Falta definir o canal: coloque o nome do canal da Twitch em config.json (campo "channel") e reinicie o servidor.');
    return;
  }
  const embed = new Twitch.Embed('player', {
    channel: config.channel,
    parent: [location.hostname],
    width: '100%',
    height: '100%',
    layout: 'video',
    autoplay: true,
  });
  embed.addEventListener(Twitch.Embed.VIDEO_READY, () => {
    player = embed.getPlayer();
  });
}

// A cada segundo de player tocando com a aba visível soma 1s; a cada 60s avisa o servidor.
function tick() {
  if (!me || !player) return;

  const watching = !player.isPaused() && document.visibilityState === 'visible';
  if (!watching) {
    setStatus('Pausado: a contagem só corre com o player tocando e a aba aberta.');
    return;
  }
  if (lastLive === false) setStatus('O canal está offline: os minutos só contam durante a live.');
  else setStatus('Contando seus minutos assistidos…', true);

  watchedSeconds += 1;
  if (watchedSeconds < 60) return;
  watchedSeconds = 0;
  sendHeartbeat();
}

async function sendHeartbeat() {
  try {
    const r = await api('/api/heartbeat', 'POST');
    if (!r) return;
    lastLive = r.live;
    me.minutes = r.minutes;
    me.rank = r.rank;
    showMinutes();
    if (r.counted) loadRanking();
  } catch (err) {
    console.error(err);
  }
}

// ---------- Início ----------
(async () => {
  readTokenFromRedirect();
  token = storage(() => localStorage.getItem(TOKEN_KEY));

  try {
    config = await api('/api/config');
  } catch {
    showNotice('Não foi possível falar com o servidor. Ele está rodando?');
    return;
  }

  el('entrar').addEventListener('click', login);
  el('sair').addEventListener('click', logout);

  if (token) {
    try {
      me = await api('/api/me');
    } catch {
      showNotice('Não foi possível confirmar seu login com a Twitch agora. Recarregue a página em instantes.');
    }
  }
  if (me) showUser();
  else showLoggedOut();

  startPlayer();
  loadRanking();
  setInterval(loadRanking, 60 * 1000);
  setInterval(tick, 1000);
})();
