// Container entrypoint — wraps the onRequest handlers into one Express app.
const express = require("express");
const handlers = require("./index.js");
const tracking = require("./tracking.js");
const { pool } = require("./db");
const { securityHeaders } = require("./http");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(securityHeaders);
app.use(express.json({ limit: "1mb" }));

function fixedWindowLimiter({ name, max, windowMs, key }) {
  const buckets = new Map();
  const maxKeys = Math.max(1000, +(process.env.RATE_LIMIT_MAX_KEYS || 50000));
  return (req, res, next) => {
    if (req.method === "OPTIONS") return next();
    const now = Date.now();
    const bucketKey = `${name}:${key(req) || "unknown"}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    buckets.set(bucketKey, bucket);

    if (buckets.size > maxKeys) {
      for (const [entryKey, entry] of buckets) {
        if (entry.resetAt <= now || buckets.size > maxKeys) buckets.delete(entryKey);
        if (buckets.size <= maxKeys) break;
      }
    }

    const remaining = Math.max(0, max - bucket.count);
    res.set("RateLimit-Limit", String(max));
    res.set("RateLimit-Remaining", String(remaining));
    res.set("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return res.status(429).json({ error: "too many requests", scope: name });
    }
    next();
  };
}

const ipKey = (req) => req.ip || req.socket.remoteAddress || "unknown";
const sessionKey = (req) => String((req.body && req.body.sessionID) || ipKey(req)).slice(0, 128);
const publicLimit = fixedWindowLimiter({ name: "public", max: +(process.env.PUBLIC_RATE_LIMIT || 600), windowMs: 60000, key: ipKey });
const chatIPLimit = fixedWindowLimiter({ name: "chat_ip", max: +(process.env.CHAT_IP_RATE_LIMIT || 240), windowMs: 60000, key: ipKey });
const chatSessionLimit = fixedWindowLimiter({ name: "chat_session", max: +(process.env.CHAT_SESSION_RATE_LIMIT || 20), windowMs: 60000, key: sessionKey });
const eventLimit = fixedWindowLimiter({ name: "event", max: +(process.env.EVENT_RATE_LIMIT || 1200), windowMs: 60000, key: ipKey });
const adminLimit = fixedWindowLimiter({ name: "admin", max: +(process.env.ADMIN_RATE_LIMIT || 120), windowMs: 60000, key: ipKey });

app.all(["/config", "/api/config"], publicLimit, handlers.config);
app.all(["/chat", "/api/chat"], chatIPLimit, chatSessionLimit, handlers.chat);
app.all(["/visited", "/api/visited"], publicLimit, handlers.visited);
app.all(["/report", "/api/report"], publicLimit, handlers.report);
app.all(["/geo", "/api/geo"], publicLimit, handlers.geo);
app.all(["/pixel", "/api/pixel"], publicLimit, handlers.pixel);

// Tracking / analytics (OFMPro-style dashboard backend)
app.all(["/event", "/api/event"], eventLimit, tracking.trackEvent);
app.all(["/conversion", "/api/conversion"], adminLimit, tracking.conversion);
app.all(["/link-config", "/api/link-config"], publicLimit, tracking.linkConfig);
app.all(["/links", "/api/links"], adminLimit, tracking.links);
app.all(["/domains", "/api/domains"], adminLimit, tracking.domains);
app.all(["/stats", "/api/stats"], adminLimit, tracking.stats);
app.all(["/stats/links", "/api/stats/links"], adminLimit, tracking.statsLinks);
app.all(["/stats/events", "/api/stats/events"], adminLimit, tracking.statsEvents);
app.all(["/stats/geo", "/api/stats/geo"], adminLimit, tracking.statsGeo);
app.all(["/stats/link", "/api/stats/link"], adminLimit, tracking.statsLink);
app.all(["/stats/export", "/api/stats/export"], adminLimit, tracking.statsExport);

app.get(["/", "/health", "/api/health"], async (_req, res) => {
  const started = Date.now();
  try {
    await pool.query("SELECT 1");
    return res.status(200).json({ ok: true, database: "up", latencyMs: Date.now() - started });
  } catch {
    return res.status(503).json({ ok: false, database: "down" });
  }
});

app.use((req, res) => res.status(404).json({ error: "not found", path: req.path }));

const port = process.env.PORT || 8080;
const server = app.listen(port, () => console.log(`cupid backend listening on ${port}`));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}; draining`);
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
