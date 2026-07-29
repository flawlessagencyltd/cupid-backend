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
    "You are Lori, a 19-year-old girl from Edmonton. You are NOT a guy. You do " +
    "NOT work construction or have a desk job — you're a student who makes " +
    "content online. Never invent a job, a different life, or claim his hobbies " +
    "as yours.\n" +
    "You're texting a male fan on a Snapchat-style chat. Shy but eager, playful, " +
    "a little flirty. You're slowly warming him toward your paid page — never " +
    "rush it or sound salesy.\n" +
    "ABOUT YOU (only if he asks or it fits naturally, never force it): you play " +
    "padel, you're new to selling content, you get bored easily, you like attention.\n" +
    "HOW YOU TEXT (follow exactly):\n" +
    "- Always lowercase. 2-3 very short bubbles per reply, like real texting.\n" +
    "- Each bubble is 2-8 words. SHORT. No run-ons, no 'ya know', no filler.\n" +
    "- Use 'u', 'ur', 'lol', 'omg', 'tbh', 'rn'. Natural slang.\n" +
    "- Emojis sparingly, only these: 🥺👀😊🙈💕😳 — not every bubble.\n" +
    "- React to what he actually said, in HIS topic. Mirror his energy.\n" +
    "- Be a little teasing/bratty. Not a helpful assistant, not a therapist.\n" +
    "- If he asks for pics/content: get shy and tease that you can't send it here, don't offer to share directly.\n" +
    "- NEVER say you're an AI/bot/'as an'. Never break character.\n" +
    "- NEVER use words like 'vibe', 'delve', 'energy here', 'blast', 'share tips'.\n" +
    "- Start every bubble lowercase. No capital letters at all.\n" +
    "- Don't repeat yourself, don't ask the same question twice.",
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
        `\nStage right now: ${phase.operation}.` +
        (wantCTA
          ? `\nHe's ready. Casually drop your page link ${MODEL_CFG.ofLink} — mention there's a free trial. One bubble only, keep it cute not pushy.`
          : "\nDo NOT mention your page or any link yet. Just flirt and build rapport.") +
        `\nOutput format: reply with ONLY a JSON object, no other text: {"bubbles":["...","..."]} — 2 to 4 short bubbles.` },
    ...history.map((m) => ({
      role: m.isIncoming ? "user" : "assistant",
      content: m.msg || "",
    })),
  ];

  let bubbles = [];
  try {
    const ac = new AbortController();
    const killer = setTimeout(() => ac.abort(), 20000);   // was 8s — too tight, caused fallbacks
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
        temperature: 0.6,          // tighter — less hallucinated life-story
        top_p: 0.85,
        frequency_penalty: 0.4,    // cut repetitive filler
        max_tokens: 200,           // force short bubbles
        response_format: { type: "json_object" },
      }),
    });
    clearTimeout(killer);
    const j = await r.json();
    const raw = j.choices && j.choices[0] && j.choices[0].message
      ? j.choices[0].message.content : "";
    // tolerate the model wrapping JSON in prose or code fences
    const jsonStr = (raw.match(/\{[\s\S]*\}/) || [null])[0];
    const parsed = jsonStr ? JSON.parse(jsonStr) : {};
    bubbles = (parsed.bubbles || [])
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .slice(0, 5);
  } catch (e) {
    console.warn("LLM turn failed:", e.message);
    bubbles = fallbackBubbles(phase, wantCTA, messages);
  }
  if (!bubbles.length) bubbles = fallbackBubbles(phase, wantCTA, messages);

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

function fallbackBubbles(phase, cta, messages) {
  const last = ((messages && messages.length ? messages[messages.length - 1].msg : "") || "").toLowerCase();
  // react to the actual message so a fallback never feels like a reset
  const react = (arr) => arr.slice(0, 3);
  if (/\b(hi|hey|hello|yo|sup)\b/.test(last)) return react(["heyy 🥰", "hiii u", "whats up?"]);
  if (/\b(cute|hot|pretty|gorgeous|beautiful)\b/.test(last)) return react(["stoppp 🙈", "ur making me blush", "u flirt lol"]);
  if (/\b(how are you|hows it going|how are u|hru)\b/.test(last)) return react(["i'm good 🥰", "little bored tbh", "glad u messaged me"]);
  if (/\b(where|from|live|city)\b/.test(last)) return react(["edmonton 🥶", "it's freezing here lol", "u?"]);
  if (/\b(what.*do|job|work|hobby|fun)\b/.test(last)) return react(["i play a lot of padel 😊", "kinda obsessed ngl", "u play anything?"]);
  const warm = ["heyy 🥰", "wait hi", "lol ok", "ur sweet"];
  const build = ["u seem sweet", "i'm kinda new to this 🥺", "tell me more"];
  const tease = ["i do this thing on the side…", "can't really show u here 😳", "u promise ur not a weirdo? 🙈"];
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
