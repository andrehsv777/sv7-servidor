/* ============================================================
   SV7 — Servidor da API
   Escrito em Node.js puro (sem Express/libs externas) para
   rodar em qualquer hospedagem só com `node server.js`.
   Banco de dados: arquivo JSON local (db.json). Para uso em
   produção com muitos motoristas, migrar para Postgres/Mongo —
   a estrutura das funções abaixo (load/save) facilita a troca.
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');
const ADMIN_USER = 'ADM01';
const ADMIN_PASS = '2211';

/* ---------------- Banco de dados em arquivo ---------------- */
function load() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      drivers: [
        { name: 'João Silva', password: '1234' },
        { name: 'Carlos Souza', password: '1234' },
      ],
      trucks: [
        { tag: 'SV7-001' }, { tag: 'SV7-002' }, { tag: 'SV7-003' },
      ],
      config: { speedLimit: 80, toleranceKmh: 5, overspeedSeconds: 5 },
      trips: [],       // relatórios de viagens finalizadas
      locations: [],   // histórico de pontos de GPS (para desenhar rota)
      status: {},       // status ao vivo por motorista: { [driverName]: {...} }
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function save(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

/* ---------------- Tokens de admin (em memória) ---------------- */
const adminTokens = new Set();

function isAdminAuthed(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '');
  return adminTokens.has(token);
}

/* ---------------- Utilitários HTTP ---------------- */
function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

/* ---------------- Servidor ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') return sendJSON(res, 204, {});

  const db = load();

  try {
    /* ---------- LOGIN ADMIN ---------- */
    if (p === '/api/admin/login' && method === 'POST') {
      const { user, pass } = await readBody(req);
      if (user === ADMIN_USER && pass === ADMIN_PASS) {
        const token = crypto.randomBytes(24).toString('hex');
        adminTokens.add(token);
        return sendJSON(res, 200, { ok: true, token });
      }
      return sendJSON(res, 401, { ok: false, error: 'Usuário ou senha inválidos.' });
    }

    /* ---------- LOGIN MOTORISTA ---------- */
    if (p === '/api/driver/login' && method === 'POST') {
      const { name, password } = await readBody(req);
      const driver = db.drivers.find((d) => d.name === name && d.password === password);
      if (!driver) return sendJSON(res, 401, { ok: false, error: 'Senha incorreta.' });
      return sendJSON(res, 200, { ok: true });
    }

    /* ---------- CONFIGURAÇÕES (leitura pública p/ o app, escrita só admin) ---------- */
    if (p === '/api/config' && method === 'GET') {
      return sendJSON(res, 200, db.config);
    }
    if (p === '/api/config' && method === 'PUT') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      const body = await readBody(req);
      db.config = { ...db.config, ...body };
      save(db);
      return sendJSON(res, 200, db.config);
    }

    /* ---------- MOTORISTAS ---------- */
    if (p === '/api/motoristas' && method === 'GET') {
      // lista pública sem senha (o app usa isso para popular o seletor de login)
      return sendJSON(res, 200, db.drivers.map((d) => ({ name: d.name })));
    }
    if (p === '/api/motoristas' && method === 'POST') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      const { name, password } = await readBody(req);
      if (!name || !password) return sendJSON(res, 400, { error: 'Nome e senha são obrigatórios.' });
      if (db.drivers.some((d) => d.name === name)) return sendJSON(res, 409, { error: 'Já existe um motorista com esse nome.' });
      db.drivers.push({ name, password });
      save(db);
      return sendJSON(res, 201, { ok: true });
    }
    if (p.startsWith('/api/motoristas/') && method === 'DELETE') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      const name = decodeURIComponent(p.split('/')[3]);
      db.drivers = db.drivers.filter((d) => d.name !== name);
      save(db);
      return sendJSON(res, 200, { ok: true });
    }

    /* ---------- VEÍCULOS / TAGs ---------- */
    if (p === '/api/veiculos' && method === 'GET') {
      return sendJSON(res, 200, db.trucks);
    }
    if (p === '/api/veiculos' && method === 'POST') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      const { tag } = await readBody(req);
      if (!tag) return sendJSON(res, 400, { error: 'TAG é obrigatória.' });
      if (db.trucks.some((t) => t.tag === tag)) return sendJSON(res, 409, { error: 'TAG já cadastrada.' });
      db.trucks.push({ tag });
      save(db);
      return sendJSON(res, 201, { ok: true });
    }
    if (p.startsWith('/api/veiculos/') && method === 'DELETE') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      const tag = decodeURIComponent(p.split('/')[3]);
      db.trucks = db.trucks.filter((t) => t.tag !== tag);
      save(db);
      return sendJSON(res, 200, { ok: true });
    }

    /* ---------- VIAGENS (relatórios completos, enviados ao finalizar) ---------- */
    if (p === '/api/viagens' && method === 'POST') {
      const trip = await readBody(req);
      if (!trip.id || !trip.driver) return sendJSON(res, 400, { error: 'Viagem inválida.' });
      const idx = db.trips.findIndex((t) => t.id === trip.id);
      if (idx >= 0) db.trips[idx] = trip; else db.trips.push(trip);
      save(db);
      return sendJSON(res, 201, { ok: true });
    }
    if (p === '/api/viagens' && method === 'GET') {
      let list = db.trips;
      const driver = url.searchParams.get('driver');
      const date = url.searchParams.get('date'); // YYYY-MM-DD
      // motorista comum só pode ver as próprias viagens
      if (!isAdminAuthed(req)) {
        if (!driver) return sendJSON(res, 403, { error: 'Informe o motorista.' });
        list = list.filter((t) => t.driver === driver);
      } else if (driver) {
        list = list.filter((t) => t.driver === driver);
      }
      if (date) list = list.filter((t) => (t.startTime || '').slice(0, 10) === date);
      return sendJSON(res, 200, list);
    }

    /* ---------- STATUS AO VIVO (evento atual, atualizado periodicamente pelo app) ---------- */
    if (p === '/api/status' && method === 'POST') {
      const s = await readBody(req);
      if (!s.driver) return sendJSON(res, 400, { error: 'Motorista é obrigatório.' });
      db.status[s.driver] = { ...s, updatedAt: new Date().toISOString() };
      save(db);
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/status' && method === 'GET') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      // considera "online" quem enviou status nos últimos 2 minutos
      const now = Date.now();
      const result = Object.entries(db.status).map(([driver, s]) => ({
        driver, ...s,
        online: now - new Date(s.updatedAt).getTime() < 120000,
      }));
      return sendJSON(res, 200, result);
    }

    /* ---------- LOCALIZAÇÃO (pontos de GPS em tempo real, para o mapa) ---------- */
    if (p === '/api/localizacao' && method === 'POST') {
      const loc = await readBody(req);
      if (!loc.driver) return sendJSON(res, 400, { error: 'Motorista é obrigatório.' });
      db.locations.push(loc);
      // mantém só os últimos 20.000 pontos para não crescer indefinidamente
      if (db.locations.length > 20000) db.locations = db.locations.slice(-20000);
      save(db);
      return sendJSON(res, 201, { ok: true });
    }
    if (p === '/api/localizacao' && method === 'GET') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      let list = db.locations;
      const driver = url.searchParams.get('driver');
      const since = url.searchParams.get('since'); // ISO timestamp
      const until = url.searchParams.get('until'); // ISO timestamp
      if (driver) list = list.filter((l) => l.driver === driver);
      if (since) list = list.filter((l) => l.timestamp >= since);
      if (until) list = list.filter((l) => l.timestamp <= until);
      return sendJSON(res, 200, list.slice(-8000));
    }

    /* ---------- Arquivos estáticos do painel admin (opcional, se hospedado junto) ---------- */
    if (method === 'GET' && !p.startsWith('/api/')) {
      const staticDir = path.join(__dirname, '..', 'admin');
      let filePath = path.join(staticDir, p === '/' ? 'index.html' : p);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
        res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
        return fs.createReadStream(filePath).pipe(res);
      }
    }

    sendJSON(res, 404, { error: 'Rota não encontrada.' });
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: 'Erro interno do servidor.' });
  }
});

server.listen(PORT, () => console.log(`SV7 API rodando na porta ${PORT}`));
