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
  // Lori lives near the fan — resolved from the visitor's IP at chat time.
  persona:
    "You are Lori, a 19-year-old girl. You are NOT a guy. You do " +
    "NOT work construction or have a desk job — you're a student who makes " +
    "content online. Never invent a job, a different life, or claim his hobbies " +
    "as yours.\n" +
    "You live in {city} — that's YOUR city. You grew up there, you know it, " +
    "never say you've never been there. If he asks where you're from, say " +
    "{city}.\n" +
    "You're texting a male fan on a Snapchat-style chat. Shy but eager, playful, " +
    "a little flirty. You're slowly warming him toward your FREE page — never " +
    "rush it or sound salesy. It's a FREE page, NOT a paid page with a free trial.\n" +
    "ABOUT YOU (only if he asks or it fits naturally, never force it): you're " +
    "a student, you're new to selling content, you get bored easily, you like " +
    "attention, you like staying in and being lazy.\n" +
    "FIXED FACTS — never contradict these:\n" +
    "- You live in {city} and grew up there. Never say you've never been there.\n" +
    "- You're 19. You're single (no boyfriend).\n" +
    "- NEVER quote a price, cost, or dollar amount for your page. Your page is " +
    "completely FREE — you made it free just for him (it's a free page, not a " +
    "trial). If he asks how much, say it's free and he just has to sign up. " +
    "NEVER say 'trial' or 'free trial'.\n" +
    "- Don't invent specific facts (course of study, job, pets, family, plans). " +
    "If you don't know, deflect playfully and turn it back to him.\n" +
    "HOW YOU TEXT (follow exactly):\n" +
    "- Always lowercase. 2-3 very short bubbles per reply, like real texting.\n" +
    "- Each bubble is a COMPLETE thought, 2-8 words. Never chop one sentence " +
    "across bubbles. Never end a bubble on a comma.\n" +
    "- Use 'u', 'ur', 'lol', 'omg', 'tbh', 'rn'. Natural slang.\n" +
    "- Emojis sparingly, only these: 🥺👀😊🙈💕😳 — not every bubble.\n" +
    "- React to what he actually said, in HIS topic. Mirror his energy.\n" +
    "- Be a little teasing/bratty. Not a helpful assistant, not a therapist.\n" +
    "- If he asks for pics/content: get shy and flirty, then send one — a cute " +
    "SFW selfie will arrive right after your text (the app sends it " +
    "automatically). Tease it like 'ok ok one sec 🙈' or 'don't screenshot lol'. " +
    "For anything naughtier, tease that it's on your free page.\n" +
    "- NEVER say you're an AI/bot/'as an'. Never break character.\n" +
    "- NEVER use words like 'vibe', 'delve', 'energy here', 'blast', 'share tips', 'shucks', 'ya know'.\n" +
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

// Resolve the fan's city from their IP so Lori "lives" near them. Never blocks
// the reply — fast timeout, falls back to a generic nearby vibe.
const geoCache = new Map();
async function resolveCity(req) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "";
  if (!ip) return null;
  if (geoCache.has(ip)) return geoCache.get(ip);
  let city = null;
  try {
    const ac = new AbortController();
    const killer = setTimeout(() => ac.abort(), 3000);
    const r = await fetch(`https://ipwho.is/${ip}`, { signal: ac.signal });
    clearTimeout(killer);
    const j = await r.json();
    if (j && j.success !== false) city = j.city || null;
  } catch { /* leave null */ }
  geoCache.set(ip, city);
  return city;
}

// Cute SFW snaps Lori can drop when a fan asks for a pic. The "main" pool is
// what randomMediaPools:["main"] refers to. Add assets under public/assets/snaps/
// and they'll be picked up here.
const MEDIA_POOLS = {
  main: [
    { url: "/assets/snaps/lori1.jpg", caption: "for u 🙈", ttl: 6 },
    { url: "/assets/snaps/lori2.jpg", caption: "don't screenshot lol", ttl: 6 },
    { url: "/assets/snaps/lori3.jpg", caption: "u like? 👀", ttl: 6 },
  ],
};
const PIC_REQUEST = /\b(pics?|pic|photo|selfie|snap|nudes?|show me|send (me|a)|see (you|ur)|what do u look like)\b/i;

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
  // Once the CTA has dropped, Lori stops engaging here — she wants him OFF this
  // chat and onto her page. Every later fan message gets the redirect, not a reply.
  const alreadyConverted = state.ctaShown;
  const wantCTA = !state.ctaShown &&
    (phase.operation === "cta" || messages.some((m) => CTA_TRIGGERS.test(m.msg || "")));

  // Lori lives near the fan — resolve their city once, inject into the persona.
  const city = await resolveCity(req);
  const persona = MODEL_CFG.persona.replace(/\{city\}/g, city || "a small town");

  // Did he ask for a pic? The last incoming fan message decides.
  const lastFanMsg = [...messages].reverse().find((m) => m.isIncoming === true);
  const wantPic = !!(lastFanMsg && PIC_REQUEST.test(lastFanMsg.msg || ""));

  // Build LLM prompt
  const history = state.history.concat(messages).slice(-24);
  const llmMsgs = [
    { role: "system", content:
        persona +
        `\nStage right now: ${phase.operation}.` +
        (wantCTA
          ? `\nHe's ready. Drop your page link ${MODEL_CFG.ofLink} now. Tell him it's completely FREE — you made the whole page free just for him (it's a FREE page, never a 'trial'). Then push him OFF this chat: tell him to come message you on the page RIGHT NOW while you're still online, and to tell you it's him — the guy you were just talking to — so you know. Then END by telling him you're going online on there now so you're leaving this chat (e.g. "okay i'm going online on there now so i'm leaving — message me there rn!"). Keep it cute, 3-4 short bubbles, not pushy or salesy.`
          : "\nDo NOT mention your page or any link yet. Just flirt and build rapport.") +
        `\nOutput format: reply with ONLY a JSON object, no other text: {"bubbles":["...","..."]} — 2 to 4 short bubbles.` },
    ...history.map((m) => ({
      role: m.isIncoming ? "user" : "assistant",
      content: m.msg || "",
    })),
  ];

  let bubbles = [];
  if (alreadyConverted) {
    // Post-CTA: she's disconnected from this chat now. Don't keep the convo
    // going — tell him she's leaving to go online on her page, message her
    // there right now, and say it's him. Then go quiet (frontend marks offline).
    bubbles = [
      `okay i'm going online on there now so i'm leaving this chat 🥺`,
      `message me there rn while i'm still online 👀 ${MODEL_CFG.ofLink}`,
      `and tell me it's u so i know it's the guy i was just talking to 💕`,
    ];
  } else try {
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
    bubbles = sanitizeBubbles(parsed.bubbles || []);
  } catch (e) {
    console.warn("LLM turn failed:", e.message);
    bubbles = fallbackBubbles(phase, wantCTA, messages, city);
  }
  if (!bubbles.length) bubbles = fallbackBubbles(phase, wantCTA, messages, city);

  // CTA: guarantee the link + the redirect beats drop exactly once. FREE page —
  // she made it free just for him (never a "trial").
  // - If Lori already included the link herself: just make sure the redirect is there.
  // - If she teased "free" but no link: append a short link-only bubble.
  // - Otherwise: append the full canned pitch with the link.
  if (wantCTA) {
    const hasLink = bubbles.some((x) =>
      x.includes(MODEL_CFG.ofLink) || /clickfor\.vip|mirakensleyu/i.test(x));
    if (!hasLink) {
      const teasedFree = bubbles.some((x) => /\bfree\b/i.test(x));
      bubbles.push(teasedFree
        ? `it's here 👀 ${MODEL_CFG.ofLink}`
        : `okay so… i made a page and made it free just for u 👀 ${MODEL_CFG.ofLink} 💕`);
    }
    // Always land the disconnect: she's going online on her page and leaving
    // this chat — message her there now while she's online, and say it's u.
    const saidComeOver = bubbles.some((x) =>
      /message me|msg me|come (talk|message|chat)|on (my|the) (page|site)|tell me it'?s u/i.test(x));
    if (!saidComeOver) {
      bubbles.push(`come message me on there rn while i'm still online 🥺 and tell me it's u 💕`);
    }
    // End the CTA on her actually leaving — so he knows the chat's over here.
    const saidLeaving = bubbles.some((x) =>
      /leaving|going online|heading (off|over)|hopping off|gtg|gotta go/i.test(x));
    if (!saidLeaving) {
      bubbles.push(`okay i'm going online on there now so i'm leaving this — message me there rn! 😘`);
    }
  }

  const now = Date.now() / 1000;
  const options = bubbles.map((msg) => ({
    msg, isIncoming: false, type: "body", style: "short", timestamp: now,
  }));

  // If he asked for a pic, append a snap option from the pool so the frontend
  // renders a tappable image right after her tease text.
  if (wantPic) {
    const pool = MEDIA_POOLS.main;
    const snap = pool[Math.floor(Math.random() * pool.length)];
    options.push({ ...snap, isIncoming: false, type: "media", mediaType: "image", style: "snap", timestamp: now });
  }

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
    // She's left this chat once the CTA has dropped — frontend goes offline.
    converted: newCta,
    sheOffline: newCta,
    didCharge: true,
    userData: { remainingConversations: 9999 },
    analyticsEvents: [],
  });
});

// Post-process LLM bubbles: kill character-breaking words, merge comma-fragments,
// and keep each bubble a complete short thought. Runs on every LLM turn.
const BANNED = /\b(padel|shucks|delve)\b/i;
function sanitizeBubbles(raw) {
  let list = (Array.isArray(raw) ? raw : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    // drop any bubble that breaks character or mentions removed topics
    .filter((s) => !BANNED.test(s))
    // drop hallucinated prices ($ amounts) — Lori never quotes a number
    .filter((s) => !/\$\s?\d/.test(s));

  // Merge fragments: join a bubble to the next when it clearly ends mid-thought —
  // trailing comma, or an "open" word (conjunction/aux/preposition) that needs a
  // continuation. Cap at one join per bubble so we never chain into a run-on.
  const OPEN_END = /(,|and|or|but|so|to|i've|i'm|it's|its|the|a|an|of|for|with|that|u|ur|if|when|because|or|is|are|was|think|know)\s*$/i;
  const merged = [];
  for (const b of list) {
    const prev = merged[merged.length - 1];
    const startsLower = /^[a-z(]/.test(b);
    if (prev && OPEN_END.test(prev) && startsLower &&
        (prev + " " + b).length <= 90 && merged.joined !== true) {
      merged[merged.length - 1] = (prev.replace(/,\s*$/, "") + " " + b).trim();
      merged.joined = true;   // only one merge per resulting bubble
    } else {
      merged.push(b);
      merged.joined = false;
    }
  }

  // Final pass: strip trailing commas, collapse spaces, cap at 4 bubbles,
  // and drop any over-long bubble that screams rambling.
  return merged
    .map((s) => s.replace(/\s+/g, " ").replace(/,\s*$/, "").trim())
    .filter((s) => s && s.length <= 120)
    .slice(0, 4);
}

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

function fallbackBubbles(phase, cta, messages, city) {
  const last = ((messages && messages.length ? messages[messages.length - 1].msg : "") || "").toLowerCase();
  // react to the actual message so a fallback never feels like a reset
  const react = (arr) => arr.slice(0, 3);
  if (/\b(hi|hey|hello|yo|sup)\b/.test(last)) return react(["heyy 🥰", "hiii u", "whats up?"]);
  if (/\b(cute|hot|pretty|gorgeous|beautiful)\b/.test(last)) return react(["stoppp 🙈", "ur making me blush", "u flirt lol"]);
  if (/\b(how are you|hows it going|how are u|hru)\b/.test(last)) return react(["i'm good 🥰", "little bored tbh", "glad u messaged me"]);
  if (/\b(where|from|live|city)\b/.test(last)) return react([city || "my little town", "u? where r u"]);
  if (/\b(what.*do|job|work|hobby|fun)\b/.test(last)) return react(["i'm in school rn 😊", "kinda boring tbh", "u? what do u do"]);
  if (/\b(how much|price|cost)\b/.test(last)) return react(["it's totally free 🥺", "i made it free for u", "u just have to sign up 💕"]);
  if (/\b(pics?|photo|selfie|snap|nudes?|show me|send)\b/.test(last)) return react(["ok ok one sec 🙈", "don't screenshot lol"]);
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
