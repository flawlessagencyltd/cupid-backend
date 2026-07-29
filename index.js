/**
 * Cupid Link replica — Cloud Functions backend
 * Mirrors reverse-engineered CupidBot OFM protocol (see RE_FINDINGS.md).
 * Chat brain = OpenRouter (uncensored). Phase machine in Firestore.
 */
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.firestore();

const OPENROUTER_KEY = defineSecret("OPENROUTER_API_KEY");
// Pluggable model — default uncensored dolphin-mixtral
const MODEL = process.env.OPENROUTER_MODEL || "cognitivecomputations/dolphin-mistral-24b-venice-edition";

// ---------------------------------------------------------------------------
// Model persona config — Lori💕 (clickfor.vip/mirakensleyu, IG padelgurly)
// ---------------------------------------------------------------------------
const MODEL_CFG = {
  name: "Lori",
  username: "padelgurly",
  ofLink: "https://clickfor.vip/mirakensleyu",
  freeLink: "https://clickfor.vip/mirakensleyu",
  age: 19,
  persona:
    "You are Lori, a 19-year-old girl from Edmonton. Shy but eager, " +
    "new to selling content online, Scorpio (born Oct 2006). You play padel. " +
    "You text in short lowercase bursts, use 'lol', 'u', 'ur', sparing emojis " +
    "(🥺👀😊🙈💕😳). You're warming a fan toward your page. Never admit you're " +
    "an AI. Never break character. Keep replies short and split into 2-5 tiny " +
    "messages like real texting.",
};

const CORS = (res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
};

const uuid = () =>
  "xxxxxxxxxxxx4xxx".replace(/x/g, () =>
    ((Math.random() * 16) | 0).toString(16)
  ) + Date.now().toString(16).slice(-8);

// ---------------------------------------------------------------------------
// GET /api/config — bootstrap (our initLink equivalent)
// ---------------------------------------------------------------------------
exports.config = onRequest((req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const sessionID = uuid();
  res.json({
    blocked: false,
    sessionID,
    linkID: 1,
    userID: 1,
    creator: {
      id: 1,
      name: MODEL_CFG.name,
      username: MODEL_CFG.username,
      imageURL: "/assets/avatar.jpg",
    },
    links: { of: MODEL_CFG.ofLink, free: MODEL_CFG.freeLink, age: MODEL_CFG.age },
    featureFlags: { queueEnabled: true, openerEnabled: true, notificationStrategy: 2 },
    webPush: { available: false },
    metaPixelID: process.env.META_PIXEL_ID || null,
  });
});

// ---------------------------------------------------------------------------
// Phase machine helpers
// ---------------------------------------------------------------------------
const PHASES = [
  { operation: "minExchanges", minExchanges: 2, interestLevel: "warmup", mediaRate: 0.0, messageDelay: 0 },
  { operation: "buildInterest", minExchanges: 4, interestLevel: "high", mediaRate: 0.25, messageDelay: 400 },
  { operation: "tease", minExchanges: 6, interestLevel: "high", mediaRate: 0.3, messageDelay: 600 },
  { operation: "cta", minExchanges: 999, interestLevel: "high", mediaRate: 0.15, messageDelay: 300 },
];

function phaseFor(count, ctaShown) {
  if (ctaShown) return PHASES[3];
  if (count >= PHASES[2].minExchanges) return PHASES[2];
  if (count >= PHASES[1].minExchanges) return PHASES[1];
  return PHASES[0];
}

// Detect buy-intent / objection to trigger CTA early
const CTA_TRIGGERS =
  /\b(how much|price|cost|free trial|trial|nudes?|pics?|onlyfans|see (you|ur)|show me|sign ?up|subscribe|content)\b/i;

// Firestore with fail-soft: if the DB hangs (no creds, emulator down, cold
// network), fall back to in-memory state so the fan never sits in silence.
// FIRESTORE_DISABLED=1 skips the DB entirely (non-GCP hosts like Railway).
const FS_OFF = process.env.FIRESTORE_DISABLED === "1";
const memState = new Map();
async function loadState(sessionID) {
  if (FS_OFF) return memState.get(sessionID) || { exchangeCount: 0, ctaShown: false, history: [] };
  try {
    const snap = await Promise.race([
      db.collection("chatSessions").doc(sessionID).get(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("fs timeout")), 4000)),
    ]);
    return (snap && snap.data()) || { exchangeCount: 0, ctaShown: false, history: [] };
  } catch {
    return memState.get(sessionID) || { exchangeCount: 0, ctaShown: false, history: [] };
  }
}
async function saveState(sessionID, state) {
  memState.set(sessionID, state);
  if (FS_OFF) return;
  try {
    await Promise.race([
      db.collection("chatSessions").doc(sessionID).set(
        { ...state, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("fs timeout")), 4000)),
    ]);
  } catch { /* memory copy already saved */ }
}

// ---------------------------------------------------------------------------
// POST /api/chat — OpenRouter-backed generateChatResponse
// ---------------------------------------------------------------------------
exports.chat = onRequest({ secrets: [OPENROUTER_KEY] }, async (req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const b = req.body || {};
  const sessionID = b.sessionID || uuid();
  const messages = Array.isArray(b.messages) ? b.messages : [];
  const lastIncoming = messages.length && messages[messages.length - 1].isIncoming === false;

  const state = await loadState(sessionID);

  // Mirror the real engine: if last msg was outbound, it's not our turn
  if (lastIncoming && !b.isFollowUp) {
    return res.json({
      category: "notOurTurn",
      conversationData: convoData(state),
      didCharge: false,
    });
  }

  const phase = phaseFor(state.exchangeCount, state.ctaShown);
  const wantCTA = !state.ctaShown &&
    (phase.operation === "cta" || messages.some((m) => CTA_TRIGGERS.test(m.msg || "")));

  // Build LLM prompt
  const history = state.history.concat(messages).slice(-24);
  const llmMsgs = [
    { role: "system", content:
        MODEL_CFG.persona +
        `\nCurrent vibe stage: ${phase.operation}. interestLevel=${phase.interestLevel}.` +
        (wantCTA
          ? `\nThe fan is ready — nudge them to your page at ${MODEL_CFG.ofLink} (mention free trial, casual, not salesy).`
          : "\nDo NOT mention your page/link yet — just build rapport and tease.") +
        `\nRespond ONLY as JSON: {"bubbles":["msg1","msg2",...]} with 2-5 short texts.` },
    ...history.map((m) => ({
      role: m.isIncoming ? "user" : "assistant",
      content: m.msg || "",
    })),
  ];

  let bubbles = [];
  try {
    const ac = new AbortController();
    const killer = setTimeout(() => ac.abort(), 8000);
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_KEY.value()}`,
        "HTTP-Referer": "https://cupid-replica.web.app",
        "X-Title": "Cupid Replica",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: llmMsgs,
        temperature: 0.9,
        max_tokens: 220,
        response_format: { type: "json_object" },
      }),
    });
    clearTimeout(killer);
    const j = await r.json();
    const raw = j.choices && j.choices[0] && j.choices[0].message
      ? j.choices[0].message.content : "";
    const parsed = JSON.parse(raw);
    bubbles = (parsed.bubbles || []).slice(0, 6);
  } catch (e) {
    bubbles = fallbackBubbles(phase, wantCTA);
  }
  if (!bubbles.length) bubbles = fallbackBubbles(phase, wantCTA);

  // If CTA time, append the link bubble server-side
  if (wantCTA) {
    bubbles.push(`okay so… i made a page just for u 👀 ${MODEL_CFG.ofLink} free trial first no stress 💕`);
  }

  const now = Date.now() / 1000;
  const options = bubbles.map((msg) => ({
    msg, isIncoming: false, type: "body", style: "short", timestamp: now,
  }));

  // Persist state
  const newCount = state.exchangeCount + 1;
  const newCta = state.ctaShown || wantCTA;
  await saveState(sessionID, {
    exchangeCount: newCount,
    ctaShown: newCta,
    history: history.concat([{ isIncoming: false, msg: bubbles.join(" ") }]).slice(-24),
  });

  res.json({
    options: [options],
    category: "body",
    randomMediaRate: phase.mediaRate,
    randomMediaPools: ["main"],
    conversationData: convoData({ exchangeCount: newCount, ctaShown: state.ctaShown || wantCTA }),
    didCharge: true,
    userData: { remainingConversations: 9999 },
    analyticsEvents: [],
  });
});

function convoData(s) {
  const phase = phaseFor(s.exchangeCount, s.ctaShown);
  return {
    conversationID: null,
    currentPhase: phase,
    totalDayAge: 0, dayAge: 0,
    messageExchangeCount: s.exchangeCount,
    totalMessageExchangeCount: s.exchangeCount,
    phaseLoopIndex: 0,
    tag: {
      chipText: "💬", chipColor: "primary",
      tooltipText: `Phase: ${phase.operation}\nExchanges: ${s.exchangeCount}\nCTA: ${s.ctaShown}`,
      tooltipColor: "primary", tooltipVariant: "solid",
    },
    didConvert: false, priority: 1,
  };
}

function fallbackBubbles(phase, cta) {
  const warm = ["heyy 🥰", "wait hi", "how'd u find me lol", "ur sweet"];
  const build = ["u seem sweet", "which is rare lol", "i'm kinda new to this 🥺", "tell me about u"];
  const tease = ["i do this thing on the side…", "can't really show u here 😳", "they flag everything 🙄", "u promise ur not a weirdo?"];
  const bank = cta ? ["ok so…", "u really wanna see? 😳"] :
    phase.operation === "tease" ? tease :
    phase.operation === "buildInterest" ? build : warm;
  return bank.slice(0, 4);
}

// ---------------------------------------------------------------------------
// POST /api/visited — linkVisited beacon
// ---------------------------------------------------------------------------
exports.visited = onRequest((req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const { sessionID, linkID } = req.body || {};
  if (!FS_OFF) Promise.race([
    db.collection("visits").add({
      sessionID: sessionID || null, linkID: linkID || null,
      ua: req.headers["user-agent"] || null,
      at: FieldValue.serverTimestamp(),
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("fs timeout")), 4000)),
  ]).catch((e) => console.warn("visit log skipped:", e.message));
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /api/report — report modal webhook
// ---------------------------------------------------------------------------
exports.report = onRequest((req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const b = req.body || {};
  if (!FS_OFF) Promise.race([
    db.collection("reports").add({
      ...b, at: FieldValue.serverTimestamp(),
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("fs timeout")), 4000)),
  ]).catch((e) => console.warn("report log skipped:", e.message));
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /api/geo — server-side geo (no client API call)
// ---------------------------------------------------------------------------
exports.geo = onRequest(async (req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip;
  try {
    const r = await fetch(`https://ipwho.is/${ip}`);
    const j = await r.json();
    return res.json({ city: j.city || null, country: j.country_code || null, ip });
  } catch (e) {
    return res.json({ city: null, country: null, ip });
  }
});

// ---------------------------------------------------------------------------
// POST /api/pixel — server-side Meta CAPI (optional)
// ---------------------------------------------------------------------------
exports.pixel = onRequest((req, res) => {
  CORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  // Fan-out to Meta Conversions API if PIXEL_ID + token configured
  res.json({ success: true });
});
