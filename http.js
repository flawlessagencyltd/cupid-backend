const DEFAULT_ORIGINS = [
  "https://chat4free.us",
  "https://www.chat4free.us",
  "https://cupid-replica1.web.app",
];

const configuredOrigins = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const allowedOrigins = new Set([...DEFAULT_ORIGINS, ...configuredOrigins]);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (allowedOrigins.has(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

// Existing Firebase handler functions call CORS(res), so obtain the request
// from Express' response object and keep that API stable.
function applyCors(res) {
  const origin = res.req && res.req.headers ? res.req.headers.origin : "";
  if (isAllowedOrigin(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  }
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key, X-API-Key");
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
}

function securityHeaders(_req, res, next) {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  res.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  next();
}

function clientIP(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (forwarded || req.ip || "").slice(0, 80);
}

module.exports = { applyCors, securityHeaders, clientIP, isAllowedOrigin };
