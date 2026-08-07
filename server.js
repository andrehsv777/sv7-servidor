/* ============================================================
   SV7 — Servidor da API (versão com banco de dados permanente)
   Usa PostgreSQL (ex: Neon, gratuito) em vez de arquivo local —
   assim os dados NUNCA se perdem quando o servidor reinicia ou
   quando você atualiza o código. Só some se você apagar.
   ============================================================ */

const http = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = 'ADM01';
const ADMIN_PASS = '2211';

if (!process.env.DATABASE_URL) {
  console.error('ERRO: variável de ambiente DATABASE_URL não configurada. Configure a connection string do Postgres (ex: Neon) nas variáveis de ambiente do Render.');
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ---------------- Criação das tabelas (só roda se não existirem) ---------------- */
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS drivers (
      name TEXT PRIMARY KEY,
      password TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trucks (
      tag TEXT PRIMARY KEY
    );
    ALTER TABLE trucks ADD COLUMN IF NOT EXISTS placa TEXT;
    CREATE TABLE IF NOT EXISTS config (
      id INT PRIMARY KEY DEFAULT 1,
      speed_limit INT NOT NULL DEFAULT 80,
      tolerance_kmh INT NOT NULL DEFAULT 5,
      overspeed_seconds INT NOT NULL DEFAULT 5
    );
    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY,
      driver TEXT NOT NULL,
      tag TEXT,
      start_time TIMESTAMPTZ,
      end_time TIMESTAMPTZ,
      data JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS locations (
      id BIGSERIAL PRIMARY KEY,
      driver TEXT NOT NULL,
      tag TEXT,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      speed DOUBLE PRECISION,
      "timestamp" TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS status (
      driver TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS places (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE places ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'local';
    CREATE TABLE IF NOT EXISTS routes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      points JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE routes ADD COLUMN IF NOT EXISTS speed_limit INT;
    CREATE INDEX IF NOT EXISTS idx_locations_driver_time ON locations (driver, "timestamp");
    CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_unique ON locations (driver, "timestamp");
    CREATE INDEX IF NOT EXISTS idx_trips_driver ON trips (driver);
  `);

  // Semente inicial — só insere se as tabelas estiverem vazias (primeira vez).
  // Depois disso, nunca mais mexe sozinho nesses dados.
  const { rows: driverCount } = await pool.query('SELECT COUNT(*) FROM drivers');
  if (Number(driverCount[0].count) === 0) {
    await pool.query(`INSERT INTO drivers (name, password) VALUES ($1,$2),($3,$4)`,
      ['João Silva', '1234', 'Carlos Souza', '1234']);
  }
  const { rows: truckCount } = await pool.query('SELECT COUNT(*) FROM trucks');
  if (Number(truckCount[0].count) === 0) {
    await pool.query(`INSERT INTO trucks (tag) VALUES ($1),($2),($3)`, ['SV7-001', 'SV7-002', 'SV7-003']);
  }
  const { rows: configCount } = await pool.query('SELECT COUNT(*) FROM config');
  if (Number(configCount[0].count) === 0) {
    await pool.query('INSERT INTO config (id) VALUES (1)');
  }
  console.log('Banco de dados pronto.');
}

/* ---------------- Tokens de admin (em memória) ---------------- */
const adminTokens = new Set();
function isAdminAuthed(req) {
  const auth = req.headers['authorization'] || '';
  return adminTokens.has(auth.replace('Bearer ', ''));
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
    req.on('data', (c) => (raw += c));
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}

/* ---------------- Servidor ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const method = req.method;
  if (method === 'OPTIONS') return sendJSON(res, 204, {});

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
      const { rows } = await pool.query('SELECT * FROM drivers WHERE name=$1 AND password=$2', [name, password]);
      if (rows.length === 0) return sendJSON(res, 401, { ok: false, error: 'Senha incorreta.' });
      return sendJSON(res, 200, { ok: true });
    }

    /* ---------- CONFIGURAÇÕES ---------- */
    if (p === '/api/config' && method === 'GET') {
      const { rows } = await pool.query('SELECT speed_limit, tolerance_kmh, overspeed_seconds FROM config WHERE id=1');
      const c = rows[0] || { speed_limit: 80, tolerance_kmh: 5, overspeed_seconds: 5 };
      return sendJSON(res, 200, { speedLimit: c.speed_limit, toleranceKmh: c.tolerance_kmh, overspeedSeconds: c.overspeed_seconds });
    }
    if (p === '/api/config' && method === 'PUT') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      const body = await readBody(req);
      await pool.query(
        `UPDATE config SET
           speed_limit = COALESCE($1, speed_limit),
           tolerance_kmh = COALESCE($2, tolerance_kmh),
           overspeed_seconds = COALESCE($3, overspeed_seconds)
         WHERE id=1`,
        [body.speedLimit ?? null, body.toleranceKmh ?? null, body.overspeedSeconds ?? null]
      );
      const { rows } = await pool.query('SELECT speed_limit, tolerance_kmh, overspeed_seconds FROM config WHERE id=1');
      const c = rows[0];
      return sendJSON(res, 200, { speedLimit: c.speed_limit, toleranceKmh: c.tolerance_kmh, overspeedSeconds: c.overspeed_seconds });
    }

    /* ---------- MOTORISTAS ---------- */
    if (p === '/api/motoristas' && method === 'GET') {
      const { rows } = await pool.query('SELECT name FROM drivers ORDER BY name');
      return sendJSON(res, 200, rows);
    }
    if (p === '/api/motoristas' && method === 'POST') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      const { name, password } = await readBody(req);
      if (!name || !password) return sendJSON(res, 400, { error: 'Nome e senha são obrigatórios.' });
      try {
        await pool.query('INSERT INTO drivers (name, password) VALUES ($1,$2)', [name, password]);
      } catch (e) {
        if (e.code === '23505') return sendJSON(res, 409, { error: 'Já existe um motorista com esse nome.' });
        throw e;
      }
      return sendJSON(res, 201, { ok: true });
    }
    if (p.startsWith('/api/motoristas/') && method === 'DELETE') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      const name = decodeURIComponent(p.split('/')[3]);
      await pool.query('DELETE FROM drivers WHERE name=$1', [name]);
      return sendJSON(res, 200, { ok: true });
    }

    /* ---------- VEÍCULOS ---------- */
    if (p === '/api/veiculos' && method === 'GET') {
      const { rows } = await pool.query('SELECT tag, placa FROM trucks ORDER BY tag');
      return sendJSON(res, 200, rows);
    }
    if (p === '/api/veiculos' && method === 'POST') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      const { tag, placa } = await readBody(req);
      if (!tag) return sendJSON(res, 400, { error: 'TAG é obrigatória.' });
      try {
        await pool.query('INSERT INTO trucks (tag, placa) VALUES ($1,$2)', [tag, placa || null]);
      } catch (e) {
        if (e.code === '23505') return sendJSON(res, 409, { error: 'TAG já cadastrada.' });
        throw e;
      }
      return sendJSON(res, 201, { ok: true });
    }
    if (p.startsWith('/api/veiculos/') && method === 'DELETE') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      const tag = decodeURIComponent(p.split('/')[3]);
      await pool.query('DELETE FROM trucks WHERE tag=$1', [tag]);
      return sendJSON(res, 200, { ok: true });
    }

    /* ---------- VIAGENS ---------- */
    if (p === '/api/viagens' && method === 'POST') {
      const trip = await readBody(req);
      if (!trip.id || !trip.driver) return sendJSON(res, 400, { error: 'Viagem inválida.' });
      await pool.query(
        `INSERT INTO trips (id, driver, tag, start_time, end_time, data)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET tag=$3, start_time=$4, end_time=$5, data=$6`,
        [trip.id, trip.driver, trip.tag || null, trip.startTime || null, trip.endTime || null, JSON.stringify(trip)]
      );

      // Alimenta também o registro do tacógrafo (tabela locations) com TODOS
      // os pontos de GPS da viagem — inclusive os que foram gravados offline.
      // Isso garante que o gráfico de velocidade nunca fique com buracos,
      // mesmo que o celular tenha ficado sem sinal durante parte do trajeto.
      // ON CONFLICT evita duplicar pontos já enviados em syncs anteriores.
      if (Array.isArray(trip.gpsPoints) && trip.gpsPoints.length > 0) {
        const BATCH = 500;
        for (let i = 0; i < trip.gpsPoints.length; i += BATCH) {
          const chunk = trip.gpsPoints.slice(i, i + BATCH);
          const values = [];
          const placeholders = chunk.map((gp, idx) => {
            const b = idx * 6;
            values.push(trip.driver, trip.tag || null, gp.lat ?? null, gp.lng ?? null, gp.speed ?? 0, gp.timestamp);
            return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`;
          });
          await pool.query(
            `INSERT INTO locations (driver, tag, lat, lng, speed, "timestamp") VALUES ${placeholders.join(',')} ON CONFLICT (driver, "timestamp") DO NOTHING`,
            values
          );
        }
      }

      return sendJSON(res, 201, { ok: true });
    }
    if (p === '/api/viagens' && method === 'GET') {
      const driver = url.searchParams.get('driver');
      const date = url.searchParams.get('date');
      const since = url.searchParams.get('since');
      const until = url.searchParams.get('until');
      if (!isAdminAuthed(req) && !driver) return sendJSON(res, 403, { error: 'Informe o motorista.' });
      let query = 'SELECT data FROM trips WHERE 1=1';
      const params = [];
      if (driver) { params.push(driver); query += ` AND driver=$${params.length}`; }
      if (date) { params.push(date); query += ` AND start_time::date = $${params.length}::date`; }
      if (since) { params.push(since); query += ` AND start_time >= $${params.length}`; }
      if (until) { params.push(until); query += ` AND start_time <= $${params.length}`; }
      query += ' ORDER BY start_time';
      const { rows } = await pool.query(query, params);
      return sendJSON(res, 200, rows.map((r) => r.data));
    }
    if (p.startsWith('/api/viagens/') && method === 'DELETE') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      const id = decodeURIComponent(p.split('/')[3]);
      await pool.query('DELETE FROM trips WHERE id=$1', [id]);
      return sendJSON(res, 200, { ok: true });
    }

    /* ---------- STATUS AO VIVO ---------- */
    if (p === '/api/status' && method === 'POST') {
      const s = await readBody(req);
      if (!s.driver) return sendJSON(res, 400, { error: 'Motorista é obrigatório.' });
      await pool.query(
        `INSERT INTO status (driver, data, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (driver) DO UPDATE SET data=$2, updated_at=NOW()`,
        [s.driver, JSON.stringify(s)]
      );
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/status' && method === 'GET') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      const { rows } = await pool.query('SELECT driver, data, updated_at FROM status');
      const now = Date.now();
      const result = rows.map((r) => ({
        driver: r.driver,
        ...r.data,
        online: now - new Date(r.updated_at).getTime() < 120000,
      }));
      return sendJSON(res, 200, result);
    }

    /* ---------- LOCALIZAÇÃO ---------- */
    if (p === '/api/localizacao' && method === 'POST') {
      const loc = await readBody(req);
      if (!loc.driver) return sendJSON(res, 400, { error: 'Motorista é obrigatório.' });
      await pool.query(
        'INSERT INTO locations (driver, tag, lat, lng, speed, "timestamp") VALUES ($1,$2,$3,$4,$5,$6)',
        [loc.driver, loc.tag || null, loc.lat || null, loc.lng || null, loc.speed || 0, loc.timestamp || new Date().toISOString()]
      );
      return sendJSON(res, 201, { ok: true });
    }
    if (p === '/api/localizacao' && method === 'GET') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      const driver = url.searchParams.get('driver');
      const tag = url.searchParams.get('tag');
      const since = url.searchParams.get('since');
      const until = url.searchParams.get('until');
      let query = 'SELECT driver, tag, lat, lng, speed, "timestamp" FROM locations WHERE 1=1';
      const params = [];
      if (driver) { params.push(driver); query += ` AND driver=$${params.length}`; }
      if (tag) { params.push(tag); query += ` AND tag=$${params.length}`; }
      if (since) { params.push(since); query += ` AND "timestamp" >= $${params.length}`; }
      if (until) { params.push(until); query += ` AND "timestamp" <= $${params.length}`; }
      query += ' ORDER BY "timestamp"';
      // Sem limite artificial — traz o registro COMPLETO do período pedido,
      // independente de ter havido ocorrência de excesso de velocidade ou não.
      const { rows } = await pool.query(query, params);
      return sendJSON(res, 200, rows.map((r) => ({ ...r, timestamp: r.timestamp.toISOString() })));
    }

    /* ---------- LOCAIS SALVOS (alfinetes com nome, aparecem em todos os mapas) ---------- */
    if (p === '/api/locais' && method === 'GET') {
      const { rows } = await pool.query('SELECT id, name, lat, lng, type FROM places ORDER BY id');
      return sendJSON(res, 200, rows);
    }
    if (p === '/api/locais' && method === 'POST') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      const { name, lat, lng, type } = await readBody(req);
      if (!name || lat == null || lng == null) return sendJSON(res, 400, { error: 'Nome e coordenadas são obrigatórios.' });
      const { rows } = await pool.query('INSERT INTO places (name, lat, lng, type) VALUES ($1,$2,$3,$4) RETURNING id, name, lat, lng, type', [name, lat, lng, type || 'local']);
      return sendJSON(res, 201, rows[0]);
    }
    if (p.startsWith('/api/locais/') && method === 'PUT') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      const id = Number(p.split('/')[3]);
      const { name } = await readBody(req);
      if (!name) return sendJSON(res, 400, { error: 'Nome é obrigatório.' });
      await pool.query('UPDATE places SET name=$1 WHERE id=$2', [name, id]);
      return sendJSON(res, 200, { ok: true });
    }
    if (p.startsWith('/api/locais/') && method === 'DELETE') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      const id = Number(p.split('/')[3]);
      await pool.query('DELETE FROM places WHERE id=$1', [id]);
      return sendJSON(res, 200, { ok: true });
    }

    /* ---------- ROTAS DESENHADAS (trajeto real da estrada, com limite de velocidade próprio) ---------- */
    if (p === '/api/rotas' && method === 'GET') {
      const { rows } = await pool.query('SELECT id, name, points, speed_limit FROM routes ORDER BY id');
      return sendJSON(res, 200, rows.map(r => ({ id: r.id, name: r.name, points: r.points, speedLimit: r.speed_limit })));
    }
    if (p === '/api/rotas' && method === 'POST') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      const { name, points, speedLimit } = await readBody(req);
      if (!name || !Array.isArray(points) || points.length < 2) return sendJSON(res, 400, { error: 'Nome e ao menos 2 pontos são obrigatórios.' });
      const { rows } = await pool.query('INSERT INTO routes (name, points, speed_limit) VALUES ($1,$2,$3) RETURNING id, name, points, speed_limit', [name, JSON.stringify(points), speedLimit || null]);
      const r = rows[0];
      return sendJSON(res, 201, { id: r.id, name: r.name, points: r.points, speedLimit: r.speed_limit });
    }
    if (p.startsWith('/api/rotas/') && method === 'PUT') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      const id = Number(p.split('/')[3]);
      const body = await readBody(req);
      const setName = body.name != null ? body.name : null;
      const hasSpeedLimit = Object.prototype.hasOwnProperty.call(body, 'speedLimit');
      if (hasSpeedLimit) {
        await pool.query('UPDATE routes SET name = COALESCE($1, name), speed_limit = $2 WHERE id=$3', [setName, body.speedLimit, id]);
      } else {
        await pool.query('UPDATE routes SET name = COALESCE($1, name) WHERE id=$2', [setName, id]);
      }
      return sendJSON(res, 200, { ok: true });
    }
    if (p.startsWith('/api/rotas/') && method === 'DELETE') {
      if (!isAdminAuthed(req)) return sendJSON(res, 403, { error: 'Não autorizado.' });
      const id = Number(p.split('/')[3]);
      await pool.query('DELETE FROM routes WHERE id=$1', [id]);
      return sendJSON(res, 200, { ok: true });
    }

    sendJSON(res, 404, { error: 'Rota não encontrada.' });
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: 'Erro interno do servidor.' });
  }
});

initDB()
  .then(() => server.listen(PORT, () => console.log(`SV7 API rodando na porta ${PORT} (com banco de dados permanente)`)))
  .catch((err) => {
    console.error('Falha ao iniciar o banco de dados:', err);
    process.exit(1);
  });
