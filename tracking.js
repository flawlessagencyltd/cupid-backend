/**
 * Cupid Track — Postgres-backed deep links and analytics.
 *
 * One Firebase Hosting site can serve every generated path on the web.app host
 * and on any connected custom domain. The link registry maps each globally
 * unique slug to an Instagram account, destination, domain and optional
 * campaign metadata. The event stream records the OFMPRO-style visitor and CTR
 * dimensions used by the admin dashboard.
 */
const { onRequest } = require("firebase-functions/v2/https");
const { randomBytes } = require("crypto");
const { pool } = require("./db");
const { applyCors: CORS, clientIP } = require("./http");
const { lookupGeo } = require("./geo");

const VALID_EVENTS = new Set([
  "view", "chat_start", "message", "snap_view", "fan_pic",
  "cta_view", "cta_click",
]);

function text(value, max = 300) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function slugify(value) {
  return text(value, 80)
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalizeHost(value) {
  let host = text(value, 253).toLowerCase();
  if (!host) return "";
  try { host = new URL(host.includes("://") ? host : `https://${host}`).hostname; }
  catch { return ""; }
  return host.replace(/^www\./, "").replace(/\.$/, "");
}

function validHost(host) {
  return !!host && host.includes(".") && /^[a-z0-9.-]+$/.test(host) && !host.includes("..");
}

function validDestination(value) {
  try {
    const u = new URL(text(value, 1000));
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : "";
  } catch { return ""; }
}

function stringArray(value, maxItems = 30, maxLen = 80) {
  const raw = Array.isArray(value) ? value : text(value, 2000).split(",");
  return [...new Set(raw.map((x) => text(x, maxLen)).filter(Boolean))].slice(0, maxItems);
}

function referrerDomain(value) {
  if (!value) return "Direct";
  try { return new URL(value).hostname.replace(/^www\./, "") || "Direct"; }
  catch { return text(value, 120) || "Direct"; }
}

function clientInfo(uaRaw) {
  const ua = String(uaRaw || "");
  const lower = ua.toLowerCase();
  let device = "Desktop";
  if (/ipad|tablet/.test(lower)) device = "Tablet";
  else if (/mobile|iphone|ipod|android/.test(lower)) device = "Mobile";

  let os = "Other";
  if (/iphone|ipad|ipod/.test(lower)) os = "iOS";
  else if (/android/.test(lower)) os = "Android";
  else if (/windows/.test(lower)) os = "Windows";
  else if (/mac os|macintosh/.test(lower)) os = "macOS";
  else if (/linux/.test(lower)) os = "Linux";

  let browser = "Other";
  if (/instagram/.test(lower)) browser = "Instagram";
  else if (/fban|fbav|facebook/.test(lower)) browser = "Facebook";
  else if (/musical_ly|tiktok/.test(lower)) browser = "TikTok";
  else if (/edg\//.test(lower)) browser = "Edge";
  else if (/firefox|fxios/.test(lower)) browser = "Firefox";
  else if (/crios|chrome/.test(lower)) browser = "Chrome";
  else if (/safari/.test(lower)) browser = "Safari";

  const flags = [];
  if (!ua) flags.push("missing_user_agent");
  if (/bot|crawler|spider|headless|phantom|selenium|playwright|puppeteer/.test(lower)) {
    flags.push("automated_user_agent");
  }
  return { device, os, browser, flags, verdict: flags.length ? "flagged" : "allowed" };
}

let booted = false;
async function ensureSchema() {
  if (booted) return true;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS domains (
        host        TEXT PRIMARY KEY,
        label       TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'pending',
        is_primary  BOOLEAN NOT NULL DEFAULT false,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS links (
        slug        TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        destination TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE links ADD COLUMN IF NOT EXISTS domain TEXT NOT NULL DEFAULT '';
      ALTER TABLE links ADD COLUMN IF NOT EXISTS instagram_account TEXT NOT NULL DEFAULT '';
      ALTER TABLE links ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
      ALTER TABLE links ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
      ALTER TABLE links ADD COLUMN IF NOT EXISTS recovery_url TEXT NOT NULL DEFAULT '';
      ALTER TABLE links ADD COLUMN IF NOT EXISTS google_analytics_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE links ADD COLUMN IF NOT EXISTS facebook_pixel_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE links ADD COLUMN IF NOT EXISTS tiktok_pixel_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE links ADD COLUMN IF NOT EXISTS excluded_countries TEXT[] NOT NULL DEFAULT '{}';
      ALTER TABLE links ADD COLUMN IF NOT EXISTS sensitive_warning BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE links ADD COLUMN IF NOT EXISTS deeplinking BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE links ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE links ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

      CREATE TABLE IF NOT EXISTS events (
        id         BIGSERIAL PRIMARY KEY,
        at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        type       TEXT NOT NULL,
        link_slug  TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        ip         TEXT NOT NULL DEFAULT '',
        country    TEXT NOT NULL DEFAULT '',
        city       TEXT NOT NULL DEFAULT '',
        ua         TEXT NOT NULL DEFAULT '',
        referrer   TEXT NOT NULL DEFAULT ''
      );
      ALTER TABLE events ADD COLUMN IF NOT EXISTS visitor_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE events ADD COLUMN IF NOT EXISTS link_domain TEXT NOT NULL DEFAULT '';
      ALTER TABLE events ADD COLUMN IF NOT EXISTS pathname TEXT NOT NULL DEFAULT '';
      ALTER TABLE events ADD COLUMN IF NOT EXISTS page_url TEXT NOT NULL DEFAULT '';
      ALTER TABLE events ADD COLUMN IF NOT EXISTS device TEXT NOT NULL DEFAULT '';
      ALTER TABLE events ADD COLUMN IF NOT EXISTS os TEXT NOT NULL DEFAULT '';
      ALTER TABLE events ADD COLUMN IF NOT EXISTS browser TEXT NOT NULL DEFAULT '';
      ALTER TABLE events ADD COLUMN IF NOT EXISTS verdict TEXT NOT NULL DEFAULT 'allowed';
      ALTER TABLE events ADD COLUMN IF NOT EXISTS security_flags TEXT[] NOT NULL DEFAULT '{}';
      ALTER TABLE events ADD COLUMN IF NOT EXISTS utm_source TEXT NOT NULL DEFAULT '';
      ALTER TABLE events ADD COLUMN IF NOT EXISTS utm_medium TEXT NOT NULL DEFAULT '';
      ALTER TABLE events ADD COLUMN IF NOT EXISTS utm_campaign TEXT NOT NULL DEFAULT '';
      ALTER TABLE events ADD COLUMN IF NOT EXISTS utm_content TEXT NOT NULL DEFAULT '';
      ALTER TABLE events ADD COLUMN IF NOT EXISTS utm_term TEXT NOT NULL DEFAULT '';
      ALTER TABLE events ADD COLUMN IF NOT EXISTS click_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE events ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
      ALTER TABLE events ADD COLUMN IF NOT EXISTS external_id TEXT NOT NULL DEFAULT '';

      CREATE INDEX IF NOT EXISTS idx_events_at ON events (at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_slug_at ON events (link_slug, at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_type_at ON events (type, at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id);
      CREATE INDEX IF NOT EXISTS idx_events_visitor ON events (visitor_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_external_id_unique
        ON events (external_id) WHERE external_id<>'';
      CREATE INDEX IF NOT EXISTS idx_links_domain ON links (domain);

      INSERT INTO domains (host, label, status, is_primary)
      VALUES ('cupid-replica1.web.app', 'Firebase Hosting', 'connected', true)
      ON CONFLICT (host) DO NOTHING;
    `);
    booted = true;
    return true;
  } catch (error) {
    console.warn("tracking schema boot failed:", error.message);
    return false;
  }
}

function sinceClause(range, alias = "") {
  const col = alias ? `${alias}.at` : "at";
  switch (range) {
    case "24h": return `${col} >= now() - interval '24 hours'`;
    case "7d": return `${col} >= now() - interval '7 days'`;
    case "14d": return `${col} >= now() - interval '14 days'`;
    case "30d": return `${col} >= now() - interval '30 days'`;
    case "3m": return `${col} >= now() - interval '3 months'`;
    case "6m": return `${col} >= now() - interval '6 months'`;
    case "12m": return `${col} >= now() - interval '12 months'`;
    default: return "TRUE";
  }
}

function visitorExpr(alias = "") {
  const p = alias ? `${alias}.` : "";
  return `COALESCE(NULLIF(${p}visitor_id,''), NULLIF(${p}session_id,''), NULLIF(${p}ip,''), ${p}id::text)`;
}

function adminOK(req) {
  const want = process.env.ADMIN_KEY || "";
  return !want || req.headers["x-admin-key"] === want;
}
const deny = (res) => res.status(401).json({ error: "unauthorized" });

function conversionOK(req) {
  const want = process.env.CONVERSION_API_KEY || process.env.ADMIN_KEY || "";
  const supplied = req.headers["x-api-key"] || req.headers["x-admin-key"] || "";
  return !!want && supplied === want;
}

// Public beacon. It records only server-observed IP/UA plus bounded attribution
// supplied by this page; the client cannot choose its own verdict or geo.
exports.trackEvent = onRequest(async (req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const body = req.body || {};
  const type = text(body.type, 40);
  if (!VALID_EVENTS.has(type)) return res.status(400).json({ error: "bad type" });

  const ip = text(clientIP(req), 80);
  const ua = text(req.headers["user-agent"], 500);
  const client = clientInfo(ua);
  const geo = await lookupGeo(req);
  const clickID = text(body.clickID || body.fbclid || body.gclid || body.ttclid, 180);
  const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    ? body.metadata : {};

  if (await ensureSchema()) {
    try {
      await pool.query(
        `INSERT INTO events (
           type, link_slug, session_id, visitor_id, ip, country, city, ua,
           referrer, link_domain, pathname, page_url, device, os, browser,
           verdict, security_flags, utm_source, utm_medium, utm_campaign,
           utm_content, utm_term, click_id, metadata
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
           $18,$19,$20,$21,$22,$23,$24
         )`,
        [
          type, slugify(body.linkSlug), text(body.sessionID, 100), text(body.visitorID, 100),
          ip, geo.country || "", geo.city || "", ua,
          text(body.referrer || req.headers.referer, 1000), normalizeHost(body.linkDomain),
          text(body.pathname, 300), text(body.pageURL, 1000), client.device, client.os,
          client.browser, client.verdict, client.flags,
          text(body.utmSource, 120), text(body.utmMedium, 120), text(body.utmCampaign, 160),
          text(body.utmContent, 160), text(body.utmTerm, 160), clickID,
          JSON.stringify(metadata).slice(0, 4000),
        ]
      );
    } catch (error) {
      console.warn("event insert failed:", error.message);
    }
  }
  return res.json({ success: true });
});

// Protected server-to-server conversion postback. Browser beacons cannot mark
// themselves converted, and external IDs make provider retries idempotent.
exports.conversion = onRequest(async (req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!conversionOK(req)) return deny(res);
  if (!(await ensureSchema())) return res.status(503).json({ error: "analytics unavailable" });

  const body = req.body || {};
  const slug = slugify(body.linkSlug || body.slug);
  if (!slug) return res.status(400).json({ error: "linkSlug required" });
  const externalID = text(body.externalID || body.externalId || body.transactionID || body.clickID, 180)
    || `conv-${randomBytes(8).toString("hex")}`;
  const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    ? body.metadata : {};
  try {
    const result = await pool.query(`
      INSERT INTO events (
        type,link_slug,session_id,visitor_id,ip,ua,referrer,link_domain,
        pathname,page_url,device,os,browser,verdict,security_flags,click_id,
        metadata,external_id
      ) VALUES (
        'conversion',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'allowed','{}',$13,$14,$15
      ) ON CONFLICT (external_id) WHERE external_id<>'' DO NOTHING`,
    [
      slug, text(body.sessionID, 100), text(body.visitorID, 100), text(clientIP(req), 80),
      text(req.headers["user-agent"], 500), text(body.referrer, 1000), normalizeHost(body.linkDomain),
      text(body.pathname, 300), text(body.pageURL, 1000), text(body.device, 40), text(body.os, 40),
      text(body.browser, 40), text(body.clickID, 180), JSON.stringify(metadata).slice(0, 4000), externalID,
    ]);
    return res.status(result.rowCount ? 201 : 200).json({ success: true, duplicate: result.rowCount === 0, externalID });
  } catch (error) {
    console.warn("conversion postback failed:", error.message);
    return res.status(500).json({ error: "conversion unavailable" });
  }
});

// Public link resolution. The chat page uses this to select the CTA destination
// and optional pixels for the slug currently present in the URL.
exports.linkConfig = onRequest(async (req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  if (!(await ensureSchema())) return res.json({ link: null });
  const slug = slugify(req.query.slug);
  if (!slug) return res.json({ link: null });
  try {
    const { rows: [link] } = await pool.query(`
      SELECT slug, name, destination, recovery_url AS "recoveryURL",
             google_analytics_id AS "googleAnalyticsID",
             facebook_pixel_id AS "facebookPixelID",
             tiktok_pixel_id AS "tiktokPixelID", deeplinking
      FROM links WHERE slug = $1 AND active = true LIMIT 1`, [slug]);
    return res.json({ link: link || null });
  } catch (error) {
    console.warn("link config failed:", error.message);
    return res.json({ link: null });
  }
});

exports.domains = onRequest(async (req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!adminOK(req)) return deny(res);
  if (!(await ensureSchema())) return res.json({ domains: [] });
  try {
    if (req.method === "GET") {
      const { rows } = await pool.query(`
        SELECT d.host, d.label, d.status, d.is_primary AS "isPrimary", d.created_at,
               COUNT(l.slug) AS link_count
        FROM domains d LEFT JOIN links l
          ON l.domain = d.host OR (l.domain = '' AND d.is_primary = true)
        GROUP BY d.host ORDER BY d.is_primary DESC, d.created_at ASC`);
      return res.json({ domains: rows });
    }
    if (req.method === "POST") {
      const body = req.body || {};
      const host = normalizeHost(body.host);
      if (!validHost(host)) return res.status(400).json({ error: "valid domain required" });
      const status = ["pending", "connected", "needs_setup"].includes(body.status)
        ? body.status : "pending";
      const primary = body.isPrimary === true;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (primary) await client.query(`UPDATE domains SET is_primary = false`);
        await client.query(`
          INSERT INTO domains (host, label, status, is_primary)
          VALUES ($1,$2,$3,$4)
          ON CONFLICT (host) DO UPDATE SET
            label=EXCLUDED.label, status=EXCLUDED.status,
            is_primary=EXCLUDED.is_primary, updated_at=now()`,
          [host, text(body.label || host, 120), status, primary]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return res.json({ success: true, host });
    }
    if (req.method === "DELETE") {
      const host = normalizeHost(req.query.host);
      if (!host) return res.status(400).json({ error: "domain required" });
      const { rows: [domain] } = await pool.query(`SELECT is_primary FROM domains WHERE host=$1`, [host]);
      if (domain && domain.is_primary) return res.status(400).json({ error: "choose another primary domain first" });
      await pool.query(`DELETE FROM domains WHERE host=$1`, [host]);
      return res.json({ success: true });
    }
    return res.status(405).json({ error: "GET/POST/DELETE only" });
  } catch (error) {
    console.warn("domains api failed:", error.message);
    return res.status(500).json({ error: "domain operation failed" });
  }
});

function generatedSlug(account, used) {
  const base = slugify(account) || `link-${randomBytes(3).toString("hex")}`;
  let candidate = base;
  while (used.has(candidate)) {
    candidate = `${base.slice(0, 57)}-${randomBytes(3).toString("hex")}`;
  }
  used.add(candidate);
  return candidate;
}

function linkPayload(body, slug) {
  const destination = validDestination(body.destination);
  if (!slug || !destination) return null;
  const recovery = body.recoveryURL ? validDestination(body.recoveryURL) : "";
  return {
    slug,
    name: text(body.name || body.instagramAccount || slug, 120),
    destination,
    domain: normalizeHost(body.domain),
    instagramAccount: text(body.instagramAccount, 120).replace(/^@/, ""),
    notes: text(body.notes, 1000),
    tags: stringArray(body.tags),
    recoveryURL: recovery,
    googleAnalyticsID: text(body.googleAnalyticsID, 80),
    facebookPixelID: text(body.facebookPixelID, 80),
    tiktokPixelID: text(body.tiktokPixelID, 80),
    excludedCountries: stringArray(body.excludedCountries, 100, 2).map((x) => x.toUpperCase()),
    sensitiveWarning: body.sensitiveWarning === true,
    deeplinking: body.deeplinking !== false,
    active: body.active !== false,
  };
}

async function upsertLink(client, link) {
  await client.query(`
    INSERT INTO links (
      slug, name, destination, domain, instagram_account, notes, tags,
      recovery_url, google_analytics_id, facebook_pixel_id, tiktok_pixel_id,
      excluded_countries, sensitive_warning, deeplinking, active, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
    ON CONFLICT (slug) DO UPDATE SET
      name=EXCLUDED.name, destination=EXCLUDED.destination, domain=EXCLUDED.domain,
      instagram_account=EXCLUDED.instagram_account, notes=EXCLUDED.notes,
      tags=EXCLUDED.tags, recovery_url=EXCLUDED.recovery_url,
      google_analytics_id=EXCLUDED.google_analytics_id,
      facebook_pixel_id=EXCLUDED.facebook_pixel_id,
      tiktok_pixel_id=EXCLUDED.tiktok_pixel_id,
      excluded_countries=EXCLUDED.excluded_countries,
      sensitive_warning=EXCLUDED.sensitive_warning,
      deeplinking=EXCLUDED.deeplinking, active=EXCLUDED.active, updated_at=now()`,
    [
      link.slug, link.name, link.destination, link.domain, link.instagramAccount,
      link.notes, link.tags, link.recoveryURL, link.googleAnalyticsID,
      link.facebookPixelID, link.tiktokPixelID, link.excludedCountries,
      link.sensitiveWarning, link.deeplinking, link.active,
    ]);
}

exports.links = onRequest(async (req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!adminOK(req)) return deny(res);
  if (!(await ensureSchema())) return res.json({ links: [] });
  try {
    if (req.method === "GET") {
      const { rows } = await pool.query(`
        SELECT l.slug, l.name, l.destination, l.domain,
               l.instagram_account AS "instagramAccount", l.notes, l.tags,
               l.recovery_url AS "recoveryURL",
               l.google_analytics_id AS "googleAnalyticsID",
               l.facebook_pixel_id AS "facebookPixelID",
               l.tiktok_pixel_id AS "tiktokPixelID",
               l.excluded_countries AS "excludedCountries",
               l.sensitive_warning AS "sensitiveWarning", l.deeplinking,
               l.active, l.created_at, l.updated_at,
               COUNT(e.id) FILTER (WHERE e.type='view') AS visits,
               COUNT(DISTINCT ${visitorExpr("e")}) FILTER (WHERE e.type='view') AS unique_visitors,
               COUNT(e.id) FILTER (WHERE e.type='cta_click') AS clicks,
               COUNT(DISTINCT ${visitorExpr("e")}) FILTER (WHERE e.type='cta_click') AS unique_clicks
        FROM links l LEFT JOIN events e ON e.link_slug=l.slug
        GROUP BY l.slug ORDER BY l.created_at DESC`);
      return res.json({ links: rows });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const accounts = Array.isArray(body.accounts)
        ? body.accounts.map((x) => text(x, 120).replace(/^@/, "")).filter(Boolean).slice(0, 500)
        : [];
      if (accounts.length || +body.count > 1) {
        const count = accounts.length || Math.min(Math.max(+body.count || 1, 1), 500);
        const destination = validDestination(body.destination);
        if (!destination) return res.status(400).json({ error: "valid destination required" });
        const { rows } = await pool.query(`SELECT slug FROM links`);
        const used = new Set(rows.map((r) => r.slug));
        const created = [];
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (let i = 0; i < count; i++) {
            const account = accounts[i] || "";
            const slug = generatedSlug(account, used);
            const link = linkPayload({
              ...body,
              name: account ? (body.name || account) : (body.name || slug),
              instagramAccount: account,
              destination,
            }, slug);
            await upsertLink(client, link);
            created.push({ slug, instagramAccount: account, domain: link.domain });
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
        return res.json({ success: true, created });
      }

      const slug = slugify(body.slug || body.instagramAccount);
      const link = linkPayload(body, slug);
      if (!link) return res.status(400).json({ error: "slug and valid destination required" });
      await upsertLink(pool, link);
      return res.json({ success: true, slug });
    }

    if (req.method === "DELETE") {
      const slug = slugify(req.query.slug);
      if (!slug) return res.status(400).json({ error: "slug required" });
      await pool.query(`DELETE FROM links WHERE slug=$1`, [slug]);
      return res.json({ success: true });
    }
    return res.status(405).json({ error: "GET/POST/DELETE only" });
  } catch (error) {
    console.warn("links api failed:", error.message);
    return res.status(500).json({ error: "link operation failed" });
  }
});

const emptyStats = () => ({
  visits: 0, allowedVisitors: 0, blockedVisitors: 0, uniqueVisitors: 0,
  chatsStarted: 0, messages: 0, totalClicks: 0, uniqueClicks: 0,
  conversions: 0, conversionRate: 0, chatRate: 0, countries: 0,
});

exports.stats = onRequest(async (req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!adminOK(req)) return deny(res);
  if (!(await ensureSchema())) return res.json(emptyStats());
  try {
    const since = sinceClause(req.query.range);
    const { rows: [row] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE type='view') AS visits,
        COUNT(*) FILTER (WHERE type='view' AND verdict<>'blocked') AS allowed_visitors,
        COUNT(*) FILTER (WHERE type='view' AND verdict='blocked') AS blocked_visitors,
        COUNT(DISTINCT ${visitorExpr()}) FILTER (WHERE type='view') AS unique_visitors,
        COUNT(DISTINCT ${visitorExpr()}) FILTER (WHERE type='chat_start') AS chats_started,
        COUNT(*) FILTER (WHERE type='message') AS messages,
        COUNT(*) FILTER (WHERE type='cta_click') AS total_clicks,
        COUNT(DISTINCT ${visitorExpr()}) FILTER (WHERE type='cta_click') AS unique_clicks,
        COUNT(DISTINCT ${visitorExpr()}) FILTER (WHERE type='conversion') AS conversions,
        COUNT(DISTINCT country) FILTER (WHERE country<>'') AS countries
      FROM events WHERE ${since}`);
    const visits = +row.visits || 0;
    const uniqueVisitors = +row.unique_visitors || 0;
    const uniqueClicks = +row.unique_clicks || 0;
    return res.json({
      visits,
      allowedVisitors: +row.allowed_visitors || 0,
      blockedVisitors: +row.blocked_visitors || 0,
      uniqueVisitors,
      chatsStarted: +row.chats_started || 0,
      messages: +row.messages || 0,
      totalClicks: +row.total_clicks || 0,
      uniqueClicks,
      conversions: +row.conversions || 0,
      conversionRate: uniqueVisitors ? +(100 * uniqueClicks / uniqueVisitors).toFixed(1) : 0,
      chatRate: uniqueVisitors ? +(100 * (+row.chats_started || 0) / uniqueVisitors).toFixed(1) : 0,
      countries: +row.countries || 0,
    });
  } catch (error) {
    console.warn("stats failed:", error.message);
    return res.json(emptyStats());
  }
});

exports.statsLinks = onRequest(async (req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!adminOK(req)) return deny(res);
  if (!(await ensureSchema())) return res.json({ rows: [] });
  try {
    const since = sinceClause(req.query.range, "e");
    const { rows } = await pool.query(`
      SELECT l.slug, l.name, l.domain, l.instagram_account AS "instagramAccount",
        COUNT(e.id) FILTER (WHERE e.type='view') AS visits,
        COUNT(DISTINCT ${visitorExpr("e")}) FILTER (WHERE e.type='view') AS uniques,
        COUNT(DISTINCT ${visitorExpr("e")}) FILTER (WHERE e.type='chat_start') AS chats,
        COUNT(e.id) FILTER (WHERE e.type='cta_click') AS clicks,
        COUNT(DISTINCT ${visitorExpr("e")}) FILTER (WHERE e.type='cta_click') AS unique_clicks,
        MODE() WITHIN GROUP (ORDER BY NULLIF(e.country,'')) AS top_country
      FROM links l LEFT JOIN events e ON e.link_slug=l.slug AND ${since}
      GROUP BY l.slug ORDER BY visits DESC, l.created_at DESC`);
    return res.json({ rows: rows.map((row) => ({
      ...row,
      conversionRate: +row.uniques ? +(100 * (+row.unique_clicks || 0) / +row.uniques).toFixed(1) : 0,
    })) });
  } catch (error) {
    console.warn("statsLinks failed:", error.message);
    return res.json({ rows: [] });
  }
});

exports.statsEvents = onRequest(async (req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!adminOK(req)) return deny(res);
  if (!(await ensureSchema())) return res.json({ events: [] });
  try {
    const since = sinceClause(req.query.range);
    const limit = Math.min(Math.max(+(req.query.limit || 50), 1), 200);
    const { rows } = await pool.query(`
      SELECT id, at, type, link_slug AS "linkSlug", link_domain AS "linkDomain",
             session_id AS "sessionID", visitor_id AS "visitorID", ip, country,
             city, device, os, browser, verdict, security_flags AS "securityFlags"
      FROM events WHERE ${since} ORDER BY at DESC LIMIT $1`, [limit]);
    return res.json({ events: rows });
  } catch (error) {
    console.warn("statsEvents failed:", error.message);
    return res.json({ events: [] });
  }
});

exports.statsGeo = onRequest(async (req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!adminOK(req)) return deny(res);
  if (!(await ensureSchema())) return res.json({ rows: [] });
  try {
    const since = sinceClause(req.query.range);
    const { rows } = await pool.query(`
      SELECT country,
        COUNT(*) FILTER (WHERE type='view') AS visits,
        COUNT(DISTINCT ${visitorExpr()}) FILTER (WHERE type='view') AS uniques,
        COUNT(DISTINCT ${visitorExpr()}) FILTER (WHERE type='cta_click') AS clicks,
        MODE() WITHIN GROUP (ORDER BY NULLIF(city,'')) AS top_city
      FROM events WHERE ${since} AND country<>''
      GROUP BY country ORDER BY visits DESC LIMIT 50`);
    return res.json({ rows });
  } catch (error) {
    console.warn("statsGeo failed:", error.message);
    return res.json({ rows: [] });
  }
});

exports.statsLink = onRequest(async (req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!adminOK(req)) return deny(res);
  if (!(await ensureSchema())) return res.json({ link: null });
  const slug = slugify(req.query.slug);
  if (!slug) return res.status(400).json({ error: "slug required" });
  try {
    const since = sinceClause(req.query.range);
    const [linkQ, overviewQ, timelineQ, refsQ, countriesQ, devicesQ, visitorsQ] = await Promise.all([
      pool.query(`SELECT l.slug,l.name,l.destination,l.domain,
                         l.instagram_account AS "instagramAccount",l.notes,l.tags,l.active,l.created_at,
                         (SELECT COUNT(DISTINCT ${visitorExpr("e")})
                          FROM events e WHERE e.link_slug=l.slug AND e.type='view') AS "allTimeVisitors"
                  FROM links l WHERE l.slug=$1`, [slug]),
      pool.query(`SELECT
          COUNT(*) FILTER (WHERE type='view') AS visits,
          COUNT(*) FILTER (WHERE type='view' AND verdict<>'blocked') AS allowed,
          COUNT(*) FILTER (WHERE type='view' AND verdict='blocked') AS blocked,
          COUNT(DISTINCT ${visitorExpr()}) FILTER (WHERE type='view') AS unique_visits,
          COUNT(*) FILTER (WHERE type='cta_click') AS total_clicks,
          COUNT(DISTINCT ${visitorExpr()}) FILTER (WHERE type='cta_click') AS unique_clicks,
          COUNT(DISTINCT ${visitorExpr()}) FILTER (WHERE type='chat_start') AS chats
        FROM events WHERE link_slug=$1 AND ${since}`, [slug]),
      pool.query(`SELECT to_char(date_trunc('day',at),'YYYY-MM-DD') AS day,
          COUNT(*) FILTER (WHERE type='view') AS visits,
          COUNT(DISTINCT ${visitorExpr()}) FILTER (WHERE type='view') AS unique_visits,
          COUNT(*) FILTER (WHERE type='view' AND verdict='blocked') AS blocked,
          COUNT(*) FILTER (WHERE type='cta_click') AS clicks,
          COUNT(DISTINCT ${visitorExpr()}) FILTER (WHERE type='cta_click') AS unique_clicks
        FROM events WHERE link_slug=$1 AND ${since}
        GROUP BY 1 ORDER BY 1`, [slug]),
      pool.query(`SELECT referrer, COUNT(*) AS visits FROM events
        WHERE link_slug=$1 AND type='view' AND ${since}
        GROUP BY referrer ORDER BY visits DESC LIMIT 100`, [slug]),
      pool.query(`SELECT country, COUNT(*) AS visits,
          COUNT(DISTINCT ${visitorExpr()}) AS uniques
        FROM events WHERE link_slug=$1 AND type='view' AND country<>'' AND ${since}
        GROUP BY country ORDER BY visits DESC LIMIT 50`, [slug]),
      pool.query(`SELECT COALESCE(NULLIF(device,''),'Other') AS device, COUNT(*) AS visits
        FROM events WHERE link_slug=$1 AND type='view' AND ${since}
        GROUP BY 1 ORDER BY visits DESC`, [slug]),
      pool.query(`SELECT at, verdict, country, city, ip, device, os, browser,
                         security_flags AS "securityFlags", referrer,
                         visitor_id AS "visitorID", session_id AS "sessionID"
        FROM events WHERE link_slug=$1 AND type='view' AND ${since}
        ORDER BY at DESC LIMIT 100`, [slug]),
    ]);
    const overview = overviewQ.rows[0] || {};
    const uniqueVisits = +overview.unique_visits || 0;
    const uniqueClicks = +overview.unique_clicks || 0;
    const refs = new Map();
    for (const row of refsQ.rows) {
      const domain = referrerDomain(row.referrer);
      refs.set(domain, (refs.get(domain) || 0) + (+row.visits || 0));
    }
    return res.json({
      link: linkQ.rows[0] || null,
      overview: {
        visits: +overview.visits || 0,
        allowedVisitors: +overview.allowed || 0,
        blockedVisitors: +overview.blocked || 0,
        uniqueVisits,
        totalClicks: +overview.total_clicks || 0,
        uniqueClicks,
        chats: +overview.chats || 0,
        ctr: uniqueVisits ? +(100 * uniqueClicks / uniqueVisits).toFixed(1) : 0,
      },
      timeline: timelineQ.rows,
      referrers: [...refs.entries()].map(([referrer, visits]) => ({ referrer, visits }))
        .sort((a, b) => b.visits - a.visits).slice(0, 20),
      countries: countriesQ.rows,
      devices: devicesQ.rows,
      visitors: visitorsQ.rows,
    });
  } catch (error) {
    console.warn("link detail stats failed:", error.message);
    return res.status(500).json({ error: "analytics unavailable" });
  }
});

function csvCell(value) {
  let out = Array.isArray(value) ? value.join("|") : String(value == null ? "" : value);
  if (/^[=+@]/.test(out)) out = `'${out}`;
  return `"${out.replace(/"/g, '""')}"`;
}

exports.statsExport = onRequest(async (req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!adminOK(req)) return deny(res);
  if (!(await ensureSchema())) return res.status(503).send("analytics unavailable");
  const slug = slugify(req.query.slug);
  if (!slug) return res.status(400).send("slug required");
  try {
    const since = sinceClause(req.query.range);
    const { rows } = await pool.query(`
      SELECT at,type,link_slug,session_id,visitor_id,ip,country,city,device,os,
             browser,verdict,security_flags,referrer,utm_source,utm_medium,
             utm_campaign,utm_content,utm_term,click_id
      FROM events WHERE link_slug=$1 AND ${since} ORDER BY at DESC LIMIT 100000`, [slug]);
    const columns = ["at","type","link_slug","session_id","visitor_id","ip","country","city",
      "device","os","browser","verdict","security_flags","referrer","utm_source","utm_medium",
      "utm_campaign","utm_content","utm_term","click_id"];
    const csv = [columns.map(csvCell).join(","), ...rows.map((row) =>
      columns.map((column) => csvCell(row[column])).join(","))].join("\n");
    res.set("Content-Disposition", `attachment; filename="${slug}-analytics.csv"`);
    res.type("text/csv").send(csv);
  } catch (error) {
    console.warn("stats export failed:", error.message);
    res.status(500).send("export failed");
  }
});

exports._internal = {
  ensureSchema, slugify, normalizeHost, clientInfo, referrerDomain,
};
