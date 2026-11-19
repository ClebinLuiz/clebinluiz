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
let admOpen = false;
let rubinot = null;
let pasta = null;

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

async function api(path, method = 'GET', body) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
  closeAdm();
  setStatus('Entre com a Twitch para seus minutos assistidos contarem no ranking.');
}

function showUser() {
  el('entrar').hidden = true;
  el('usuario').hidden = false;
  el('usuario-nome').textContent = me.displayName;
  el('usuario-foto').src = me.profileImage || '/img/avatar.jpg';
  el('abrir-adm').hidden = !me.isAdmin;
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

  const watching = !admOpen && !player.isPaused() && document.visibilityState === 'visible';
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

// ---------- ADM: controle do Rubinot ----------
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const num = (v, casas = 0) =>
  v == null || Number.isNaN(v) ? '–' : v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
const sinal = (v, casas = 0) => (v == null ? '–' : (v > 0 ? '+' : '') + num(v, casas));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Mesma conta da planilha: saldo inicial puxa o último saldo final; lucro = final − inicial;
// lucro em RC = lucro ÷ cotação (se o dia não tiver cotação, usa a última informada).
function computeDays(dias) {
  let lastFinal = null;
  let lastCot = null;
  return [...dias]
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.data || ''))
    .sort((a, b) => a.data.localeCompare(b.data))
    .map((d) => {
      const inicial = isNum(d.saldoInicial) ? d.saldoInicial : lastFinal;
      const final = isNum(d.saldoFinal) ? d.saldoFinal : null;
      if (isNum(d.cotacao) && d.cotacao > 0) lastCot = d.cotacao;
      const lucro = final != null && inicial != null ? final - inicial : null;
      const rc = lucro != null && lastCot ? lucro / lastCot : null;
      if (final != null) lastFinal = final;
      return { ...d, inicial, final, cot: lastCot, cotDoDia: isNum(d.cotacao), lucro, rc, mes: d.data.slice(0, 7) };
    });
}

function td(text, cls) {
  const c = document.createElement('td');
  c.textContent = text;
  if (cls) c.className = cls;
  return c;
}
const corDe = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const hoje = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// Aceita "72.783.309", "72,783,309" ou "72783309".
const lerNumero = (txt) => {
  const digits = String(txt || '').replace(/\D/g, '');
  return digits ? Number(digits) : null;
};

function renderRubinot() {
  const all = computeDays(rubinot.dias || []);
  const select = el('adm-mes');
  const meses = [...new Set(all.map((d) => d.mes))].reverse();
  const atual = select.value && meses.includes(select.value) ? select.value : meses[0];
  select.replaceChildren(
    ...meses.map((m) => {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = `${MESES[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
      return o;
    })
  );
  if (atual) select.value = atual;
  el('adm-mes-caixa').hidden = meses.length === 0;

  const dias = all.filter((d) => d.mes === atual);
  const comLucro = dias.filter((d) => d.lucro != null);
  const total = comLucro.reduce((s, d) => s + d.lucro, 0);
  const totalRc = dias.reduce((s, d) => s + (d.rc || 0), 0);
  const ultimoFinal = [...all].reverse().find((d) => d.final != null);
  const ultimo = all[all.length - 1];
  const ultimoRcs = [...all].reverse().find((d) => isNum(d.rubinicoins));

  el('c-saldo').textContent = num(ultimoFinal ? ultimoFinal.final : ultimo?.inicial);
  el('c-saldo-data').textContent = ultimoFinal
    ? `fechamento de ${ultimoFinal.data.split('-').reverse().join('/')}`
    : ultimo ? 'saldo inicial (ainda sem fechamento)' : 'nenhum dia lançado';
  el('c-lucro').textContent = comLucro.length ? sinal(total) : '–';
  el('c-lucro').className = corDe(total);
  const pos = comLucro.filter((d) => d.lucro > 0).length;
  const neg = comLucro.filter((d) => d.lucro < 0).length;
  el('c-dias').textContent = `${pos} dia(s) com lucro · ${neg} com prejuízo`;
  el('c-rc').textContent = comLucro.length ? sinal(totalRc, 2) : '–';
  el('c-rc').className = corDe(totalRc);
  el('c-media').textContent = comLucro.length ? `média de ${sinal(total / comLucro.length)} por dia` : '';
  el('c-cot').textContent = num(ultimo?.cot);
  el('c-rcs').textContent = ultimoRcs ? `${num(ultimoRcs.rubinicoins)} RC na conta` : '';

  const body = el('adm-dias');
  body.replaceChildren();
  for (const d of dias) {
    const tr = document.createElement('tr');
    const [y, m, dd] = d.data.split('-');
    const semana = DIAS_SEMANA[new Date(Number(y), Number(m) - 1, Number(dd)).getDay()];
    const acoes = document.createElement('td');
    acoes.className = 'acoes';
    const editar = document.createElement('button');
    editar.className = 'link';
    editar.textContent = 'Editar';
    editar.addEventListener('click', () => editDay(d.data));
    acoes.append(editar);
    // Dias do GitHub não são apagados pelo site; se você editou um, "Desfazer" volta ao valor do GitHub.
    if (d.origem === 'site') {
      const apagar = document.createElement('button');
      apagar.className = 'link neg';
      apagar.textContent = d.noGithub ? 'Desfazer' : 'Apagar';
      apagar.addEventListener('click', () => deleteDay(d.data, d.noGithub));
      acoes.append(apagar);
    }
    tr.append(
      td(`${dd}/${m} ${semana}`, 'data'),
      td(num(d.inicial), isNum(d.saldoInicial) ? '' : 'suave'),
      td(num(d.final)),
      td(sinal(d.lucro), corDe(d.lucro)),
      td(num(d.cot), d.cotDoDia ? '' : 'suave'),
      td(sinal(d.rc, 2), corDe(d.rc)),
      td(d.obs || '', 'obs'),
      acoes
    );
    body.append(tr);
  }
  if (!dias.length) {
    const tr = document.createElement('tr');
    const c = td('Nenhum dia lançado ainda. Use o formulário acima.', 'suave vazio-linha');
    c.colSpan = 8;
    tr.append(c);
    body.append(tr);
  }

  const foot = el('adm-total');
  foot.replaceChildren();
  if (comLucro.length) {
    const tr = document.createElement('tr');
    const label = td('Total do mês');
    label.colSpan = 3;
    tr.append(label, td(sinal(total), corDe(total)), td(''), td(sinal(totalRc, 2), corDe(totalRc)), td(''), td(''));
    foot.append(tr);
  }
}

function formMsg(text, erro = false) {
  el('form-msg').textContent = text;
  el('form-msg').classList.toggle('neg', erro);
}

function resetForm() {
  const f = el('form-dia');
  f.reset();
  f.data.value = hoje();
  el('form-titulo').textContent = 'Lançar dia';
  formMsg('');
}

function editDay(data) {
  const d = (rubinot.dias || []).find((x) => x.data === data);
  if (!d) return;
  const f = el('form-dia');
  f.data.value = d.data;
  for (const k of ['saldoInicial', 'saldoFinal', 'cotacao', 'rubinicoins']) f[k].value = isNum(d[k]) ? num(d[k]) : '';
  f.obs.value = d.obs || '';
  el('form-titulo').textContent = `Editando ${d.data.split('-').reverse().join('/')}`;
  formMsg('');
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveDay(ev) {
  ev.preventDefault();
  const f = el('form-dia');
  const day = {
    data: f.data.value,
    saldoInicial: lerNumero(f.saldoInicial.value),
    saldoFinal: lerNumero(f.saldoFinal.value),
    cotacao: lerNumero(f.cotacao.value),
    rubinicoins: lerNumero(f.rubinicoins.value),
    obs: f.obs.value.trim(),
  };
  if (!day.data) return formMsg('Escolha a data.', true);
  formMsg('Salvando…');
  try {
    const r = await api('/api/admin/rubinot', 'PUT', day);
    if (!r) return;
    rubinot = r;
    renderRubinot(); // cria a opção do mês, se for novo
    el('adm-mes').value = day.data.slice(0, 7);
    renderRubinot();
    resetForm();
    formMsg(`Dia ${day.data.split('-').reverse().join('/')} salvo.`);
  } catch {
    formMsg('Não foi possível salvar. Tente de novo.', true);
  }
}

async function deleteDay(data, noGithub = false) {
  const dia = data.split('-').reverse().join('/');
  const pergunta = noGithub ? `Desfazer sua edição de ${dia} e voltar ao valor do GitHub?` : `Apagar o dia ${dia}?`;
  if (!confirm(pergunta)) return;
  try {
    const r = await api('/api/admin/rubinot', 'DELETE', { data });
    if (!r) return;
    rubinot = r;
    renderRubinot();
  } catch {
    formMsg('Não foi possível apagar. Tente de novo.', true);
  }
}

function showPastas() {
  pasta = null;
  el('adm-titulo').textContent = 'Painel ADM';
  el('adm-pastas').hidden = false;
  el('pasta-rubinot').hidden = true;
  el('adm-mes-caixa').hidden = true;
  el('adm-voltar').textContent = 'Voltar pra live';
  el('adm-erro').hidden = true;
}

async function openRubinot() {
  pasta = 'rubinot';
  el('adm-titulo').textContent = 'Controle Rubinot';
  el('adm-pastas').hidden = true;
  el('pasta-rubinot').hidden = false;
  el('adm-voltar').textContent = '← Pastas';
  el('adm-erro').hidden = true;
  resetForm();
  try {
    const data = await api('/api/admin/rubinot');
    if (!data) return;
    rubinot = data;
    renderRubinot();
  } catch {
    el('adm-erro').textContent = 'Não foi possível carregar o Controle Rubinot agora.';
    el('adm-erro').hidden = false;
  }
}

function openAdm() {
  admOpen = true;
  el('adm').hidden = false;
  document.querySelector('.layout').hidden = true;
  showPastas();
}

function closeAdm() {
  admOpen = false;
  el('adm').hidden = true;
  document.querySelector('.layout').hidden = false;
  el('abrir-adm').hidden = true;
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
  el('abrir-adm').addEventListener('click', openAdm);
  el('adm-voltar').addEventListener('click', () => {
    if (pasta) return showPastas();
    closeAdm();
    el('abrir-adm').hidden = !me?.isAdmin;
  });
  el('adm-pastas').querySelector('[data-pasta="rubinot"]').addEventListener('click', openRubinot);
  el('adm-mes').addEventListener('change', () => rubinot && renderRubinot());
  el('form-dia').addEventListener('submit', saveDay);
  el('form-limpar').addEventListener('click', resetForm);
  for (const name of ['saldoInicial', 'saldoFinal', 'cotacao', 'rubinicoins']) {
    const input = el('form-dia')[name];
    input.addEventListener('blur', () => {
      const v = lerNumero(input.value);
      input.value = v == null ? '' : num(v);
    });
  }

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
