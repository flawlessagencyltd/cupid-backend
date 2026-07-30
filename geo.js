const fetch = require("node-fetch");
const { pool } = require("./db");
const { clientIP } = require("./http");

const memory = new Map();
const inflight = new Map();
const MEMORY_MAX = Math.max(1000, +(process.env.GEO_CACHE_MAX || 20000));
const TTL_MS = Math.max(3600000, +(process.env.GEO_CACHE_TTL_MS || 7 * 86400000));
let schemaReady = false;

function remember(ip, geo, expiresAt = Date.now() + TTL_MS) {
  if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value);
  memory.set(ip, { geo, expiresAt });
  return geo;
}

async function ensureGeoSchema() {
  if (schemaReady || !process.env.DATABASE_URL) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS geo_cache (
      ip TEXT PRIMARY KEY,
      city TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT '',
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_geo_cache_expiry ON geo_cache (expires_at);
  `);
  schemaReady = true;
}

function headerGeo(req) {
  const city = String(req.headers["cf-ipcity"] || req.headers["x-vercel-ip-city"] || "").slice(0, 120);
  const country = String(req.headers["cf-ipcountry"] || req.headers["x-vercel-ip-country"] || "").slice(0, 2).toUpperCase();
  return city || country ? { city: city || null, country: country || null } : null;
}

async function resolveFresh(ip) {
  const empty = { city: null, country: null };
  try {
    await ensureGeoSchema();
    if (schemaReady) {
      const { rows } = await pool.query(
        `SELECT city,country,expires_at FROM geo_cache WHERE ip=$1 AND expires_at > now()`, [ip]);
      if (rows[0]) {
        return remember(ip, {
          city: rows[0].city || null,
          country: rows[0].country || null,
        }, new Date(rows[0].expires_at).getTime());
      }
    }
  } catch (error) {
    console.warn("geo cache read skipped:", error.message);
  }

  let geo = empty;
  try {
    const ac = new AbortController();
    const killer = setTimeout(() => ac.abort(), 2200);
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: ac.signal });
    clearTimeout(killer);
    const body = await response.json();
    if (body && body.success !== false) {
      geo = { city: body.city || null, country: body.country_code || null };
    }
  } catch { /* geo must never block chat or analytics */ }

  remember(ip, geo);
  if (schemaReady) {
    pool.query(`
      INSERT INTO geo_cache (ip,city,country,expires_at,updated_at)
      VALUES ($1,$2,$3,now() + interval '7 days',now())
      ON CONFLICT (ip) DO UPDATE SET city=EXCLUDED.city,country=EXCLUDED.country,
        expires_at=EXCLUDED.expires_at,updated_at=now()`,
    [ip, geo.city || "", geo.country || ""]).catch((error) =>
      console.warn("geo cache write skipped:", error.message));
  }
  return geo;
}

async function lookupGeo(req) {
  const fromHeaders = headerGeo(req);
  if (fromHeaders) return fromHeaders;
  const ip = clientIP(req);
  if (!ip) return { city: null, country: null };
  const cached = memory.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.geo;
  if (cached) memory.delete(ip);
  if (inflight.has(ip)) return inflight.get(ip);
  const promise = resolveFresh(ip).finally(() => inflight.delete(ip));
  inflight.set(ip, promise);
  return promise;
}

module.exports = { lookupGeo };
