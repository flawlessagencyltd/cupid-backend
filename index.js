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
const { pool } = require("./db");
const { applyCors: CORS, clientIP } = require("./http");
const { lookupGeo } = require("./geo");

admin.initializeApp();
const db = admin.firestore();

const OPENROUTER_KEY = defineSecret("OPENROUTER_API_KEY");
// Pluggable model — default uncensored dolphin-mixtral
const MODEL = process.env.OPENROUTER_MODEL || "cognitivecomputations/dolphin-mistral-24b-venice-edition";
const FALLBACK_MODEL = process.env.OPENROUTER_FALLBACK_MODEL || "";
// Vision model — "sees" pics the fan sends. Gemini Flash: fast, cheap (~$0.001/pic),
// great at describing images. Swap via OPENROUTER_VISION_MODEL.
const VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || "google/gemini-2.5-flash";
const AI_MAX_CONCURRENCY = Math.max(2, +(process.env.AI_MAX_CONCURRENCY || 24));
let aiInFlight = 0;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openRouterJSON(apiKey, payload, options = {}) {
  if (aiInFlight >= AI_MAX_CONCURRENCY) throw new Error("ai capacity reached");
  aiInFlight += 1;
  try {
    const models = [payload.model];
    if (options.fallbackModel && options.fallbackModel !== payload.model) models.push(options.fallbackModel);
    let lastError = new Error("OpenRouter unavailable");

    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const ac = new AbortController();
        const killer = setTimeout(() => ac.abort(), options.timeoutMs || 20000);
        try {
          const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            signal: ac.signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
              "HTTP-Referer": "https://chat4free.us",
              "X-Title": options.title || "Cupid Replica",
            },
            body: JSON.stringify({ ...payload, model }),
          });
          clearTimeout(killer);
          let json = {};
          try { json = await response.json(); } catch { /* handled below */ }
          if (response.ok && !json.error) return { response, json, model };

          const retryable = response.status === 429 || response.status >= 500;
          if (!retryable) return { response, json, model };
          lastError = new Error(`OpenRouter ${response.status}`);
          if (attempt === 0) {
            const retryAfter = Math.min(2000, Math.max(250, +(response.headers.get("retry-after") || 0) * 1000));
            await delay(retryAfter + Math.floor(Math.random() * 200));
          }
        } catch (error) {
          clearTimeout(killer);
          lastError = error;
          if (attempt === 0) await delay(300 + Math.floor(Math.random() * 200));
        }
      }
    }
    throw lastError;
  } finally {
    aiInFlight -= 1;
  }
}

// Analyze a fan-sent image → a short, concrete description Lori can react to.
// imageData: base64 data URL ("data:image/jpeg;base64,...") OR a raw https URL.
// Returns "" on any failure (we never block the chat over a failed vision call).
// Returns "__explicit__" when the vision provider REFUSED / content-filtered the
// image — for an adult-platform chat that almost always means an NSFW pic (dick
// pic etc.), so Lori should react like she saw something explicit, not confused.
async function describeFanImage(imageData, apiKey) {
  if (!imageData) return "";
  const imageUrl = /^https?:\/\//.test(imageData)
    ? imageData
    : imageData.startsWith("data:") ? imageData : `data:image/jpeg;base64,${imageData}`;
  try {
    const { response: r, json: j } = await openRouterJSON(apiKey, {
        model: VISION_MODEL,
        max_tokens: 120,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Briefly describe this image in 1-2 short sentences: what it shows (a man's face/selfie, a body part, an object, a meme, scenery, etc) and any notable detail. Be concrete and factual. If it is sexually explicit, just say so plainly without graphic detail." },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        }],
      }, { timeoutMs: 12000, title: "Cupid Replica Vision" });
    if (!r.ok || j.error) {
      const errStr = JSON.stringify(j.error || j).toLowerCase();
      // 403 / moderation / content-policy / invalid image data → provider filtered it
      if (r.status === 403 || /moderat|content.?polic|content.?filter|sexual|nsfw|flagged|invalid image/.test(errStr)) {
        console.warn("vision content-filtered:", errStr.slice(0, 200));
        return "__explicit__";
      }
      console.warn("vision upstream", r.status, errStr.slice(0, 300));
      return "";
    }
    const txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
    const clean = String(txt).replace(/\s+/g, " ").trim().slice(0, 220);
    // Soft refusal: model completed but declined to describe
    if (/can'?t (describe|help|identify)|cannot describe|unable to (describe|help)|not able to/i.test(clean)) {
      return "__explicit__";
    }
    return clean;
  } catch (e) {
    console.warn("vision failed:", e.message);
    return "";
  }
}

// ---------------------------------------------------------------------------
// Model persona config — Lori💕 (tracked branded CTA redirect, IG padelgurly)
// ---------------------------------------------------------------------------
const MODEL_CFG = {
  name: "Lori",
  username: "padelgurly",
  ofLink: "https://chat4free.us/go/lori",
  freeLink: "https://chat4free.us/go/lori",
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
    "completely FREE — you flipped your (already-existing) page from paid to " +
    "free for him. NEVER say you made/created the page for him. It was paid " +
    "before and you flipped it to FREE for him. It's a free page, not a trial. If he " +
    "asks how much, say it's free and he just has to sign up. " +
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
    "- The opener asks him for a picture exactly once. If he declines, ignores " +
    "it, or changes the subject, accept that immediately and keep chatting. " +
    "Never pressure him and never make sending a picture a requirement.\n" +
    "- Be a little teasing/bratty. Not a helpful assistant, not a therapist.\n" +
    "- If he asks for pics/content: get shy and flirty, then send one — a cute " +
    "SFW selfie will arrive right after your text (the app sends it " +
    "automatically). Tease it like 'ok ok one sec 🙈' or 'don't screenshot lol'. " +
    "For anything naughtier, tease that it's on your free page.\n" +
    "- NEVER say you're an AI/bot/'as an'. Never break character.\n" +
    "- NEVER use words like 'vibe', 'delve', 'energy here', 'blast', 'share tips', 'shucks', 'ya know'.\n" +
    "- Start every bubble lowercase. No capital letters at all.\n" +
    "- Never repeat or closely paraphrase anything you already said in this chat. " +
    "Never ask the same question twice. Check the conversation before writing each bubble.",
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
async function resolveCity(req) {
  const geo = await lookupGeo(req);
  return geo.city || null;
}

// Lori's real pics, tiered by escalation. "main" = legacy SFW rotation.
// casual → early/warm, spicy → as interest builds, verify → proof-she's-real,
// opener → the first view-once snap of a brand-new convo.
const MEDIA_POOLS = {
  main: [
    { url: "/assets/snaps/lori1.jpg", caption: "for u 🙈", ttl: 6 },
    { url: "/assets/snaps/lori2.jpg", caption: "don't screenshot lol", ttl: 6 },
    { url: "/assets/snaps/lori3.jpg", caption: "u like? 👀", ttl: 6 },
  ],
  opener: { url: "/assets/snaps/opener.jpg", caption: "hiii 🥰", ttl: 6 },
  casual: [
    { url: "/assets/snaps/casual1.jpg", caption: "me rn lol", ttl: 6 },
    { url: "/assets/snaps/casual2.jpg", caption: "just chillin", ttl: 6 },
    { url: "/assets/snaps/casual3.jpg", caption: "bored at home 🙄", ttl: 6 },
    { url: "/assets/snaps/casual4.jpg", caption: "for u 🙈", ttl: 6 },
  ],
  spicy: [
    { url: "/assets/snaps/spicy1.jpg", caption: "u like? 👀", ttl: 8 },
    { url: "/assets/snaps/spicy2.jpg", caption: "feeling myself tn", ttl: 8 },
    { url: "/assets/snaps/spicy3.jpg", caption: "don't screenshot lol", ttl: 8 },
    { url: "/assets/snaps/spicy4.jpg", caption: "just for u 😘", ttl: 8 },
    { url: "/assets/snaps/spicy5.jpg", caption: "u drive me crazy 🥵", ttl: 8 },
  ],
  verify: [
    { url: "/assets/snaps/verify1.jpg", caption: "see?? told u i'm real 😌✌️", ttl: 8 },
    { url: "/assets/snaps/verify2.jpg", caption: "still think i'm fake? 😏", ttl: 8 },
  ],
  // The spiciest one — held back for the CTA drop. A final "here's what you're
  // missing, it's all on the free page" nudge as she pushes him off the chat.
  spiciest: { url: "/assets/snaps/spiciest.jpg", caption: "the rest is on my free page… don't keep me waiting 🥵", ttl: 10 },
};
const PIC_REQUEST = /\b(pics?|pic|photo|selfie|snap|nudes?|show me|send (me|a)|see (you|ur)|what do u look like)\b/i;

// Fan doubts she's real → drop a verification snap.
const VERIFY_REQUEST = /\b(fake|bot|robot|ai\b|not real|are? u real|r u real|catfish|scam|prove it|proof|really you|actually real|you'?re fake|this is fake)\b/i;

// Detect buy-intent / objection to trigger CTA early
const CTA_TRIGGERS =
  /\b(how much|price|cost|free trial|trial|nudes?|pics?|onlyfans|see (you|ur)|show me|sign ?up|subscribe|content)\b/i;

// Firestore with fail-soft: if the DB hangs (no creds, emulator down, cold
// network), fall back to in-memory state so the fan never sits in silence.
// FIRESTORE_DISABLED=1 skips the DB entirely (non-GCP hosts like Railway).
const FS_OFF = process.env.FIRESTORE_DISABLED === "1";
const memState = new Map();
const SESSION_TTL_HOURS = Math.max(1, +(process.env.SESSION_TTL_HOURS || 24));
const MEM_STATE_MAX = Math.max(1000, +(process.env.MEM_STATE_MAX || 10000));
let sessionSchemaReady = false;
let lastSessionCleanup = 0;
const freshState = () => ({ exchangeCount: 0, ctaShown: false, history: [], usedReplies: [] });

function memoryState(sessionID) {
  const entry = memState.get(sessionID);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memState.delete(sessionID);
    return null;
  }
  return entry.state;
}

function rememberState(sessionID, state) {
  if (memState.size >= MEM_STATE_MAX) memState.delete(memState.keys().next().value);
  memState.set(sessionID, { state, expiresAt: Date.now() + SESSION_TTL_HOURS * 3600000 });
}

async function ensureSessionSchema() {
  if (sessionSchemaReady || !process.env.DATABASE_URL) return sessionSchemaReady;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      session_id TEXT PRIMARY KEY,
      state JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_expiry ON chat_sessions (expires_at);
  `);
  sessionSchemaReady = true;
  return true;
}

async function loadState(sessionID) {
  if (process.env.DATABASE_URL) {
    try {
      await ensureSessionSchema();
      const { rows } = await pool.query(
        `SELECT state FROM chat_sessions WHERE session_id=$1 AND expires_at > now()`, [sessionID]);
      if (rows[0] && rows[0].state) {
        rememberState(sessionID, rows[0].state);
        return rows[0].state;
      }
      return memoryState(sessionID) || freshState();
    } catch (error) {
      console.warn("session read fell back to memory:", error.message);
      return memoryState(sessionID) || freshState();
    }
  }
  if (FS_OFF) return memoryState(sessionID) || freshState();
  try {
    const snap = await Promise.race([
      db.collection("chatSessions").doc(sessionID).get(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("fs timeout")), 4000)),
    ]);
    return (snap && snap.data()) || freshState();
  } catch {
    return memoryState(sessionID) || freshState();
  }
}
async function saveState(sessionID, state) {
  rememberState(sessionID, state);
  if (process.env.DATABASE_URL) {
    try {
      await ensureSessionSchema();
      await pool.query(`
        INSERT INTO chat_sessions (session_id,state,expires_at,updated_at)
        VALUES ($1,$2::jsonb,now() + $3::int * interval '1 hour',now())
        ON CONFLICT (session_id) DO UPDATE SET state=EXCLUDED.state,
          expires_at=EXCLUDED.expires_at,updated_at=now()`,
      [sessionID, JSON.stringify(state), SESSION_TTL_HOURS]);
      if (Date.now() - lastSessionCleanup > 3600000) {
        lastSessionCleanup = Date.now();
        pool.query(`DELETE FROM chat_sessions WHERE expires_at <= now()`)
          .catch((error) => console.warn("session cleanup skipped:", error.message));
      }
      return;
    } catch (error) {
      console.warn("session write fell back to memory:", error.message);
    }
  }
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
  const sessionID = String(b.sessionID || uuid()).slice(0, 128);
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
  // Auto-CTA after 6 back-and-forths — once she's traded 6 replies with him,
  // she drops the page on this turn no matter what he said.
  const autoCTA = state.exchangeCount >= 6;
  const wantCTA = !state.ctaShown &&
    (autoCTA || phase.operation === "cta" || messages.some((m) => CTA_TRIGGERS.test(m.msg || "")));

  // Lori lives near the fan — resolve their city once, inject into the persona.
  const city = await resolveCity(req);
  const persona = MODEL_CFG.persona.replace(/\{city\}/g, city || "a small town");

  // Did he ask for a pic? The last incoming fan message decides.
  const lastFanMsg = [...messages].reverse().find((m) => m.isIncoming === true);
  const wantPic = !!(lastFanMsg && PIC_REQUEST.test(lastFanMsg.msg || ""));
  // The frontend marks the proactive opening request as a follow-up with no fan
  // messages. Keep this beat deterministic: opener snap first, then one exact ask.
  const isFirstReply = state.exchangeCount === 0 && b.isFollowUp === true;

  // Did the fan SEND a pic? Frontend passes it as b.image (base64/URL). Vision
  // model describes it so Lori reacts to what she actually saw, not a canned line.
  const fanImage = b.image || (lastFanMsg && lastFanMsg.image) || null;
  const fanImageDesc = fanImage
    ? await describeFanImage(fanImage, OPENROUTER_KEY.value())
    : "";

  // If he sent a pic, tell Lori what she's looking at so she reacts to the real thing.
  // __explicit__ = the vision model content-filtered it → almost certainly an NSFW pic.
  const imageNote = fanImageDesc === "__explicit__"
    ? `\nIMPORTANT: He just sent you an explicit NSFW photo of himself (a dick pic or nude). React like a flirty adult woman who is INTO it — tease him, compliment him, be a little turned on, maybe playfully scold him for being forward. Match the persona's warmth and emojis. Do NOT act confused or say you can't see it.`
    : fanImageDesc
    ? `\nIMPORTANT: He just sent you a photo. It shows: ${fanImageDesc} React naturally to THIS specific photo — compliment it, tease him, or comment on what's actually in it. Do NOT pretend you can't see it.`
    : (fanImage ? `\nHe just sent you a photo but you can't quite make it out. React playfully like you're intrigued.` : "");

  // Build LLM prompt
  const history = mergeHistory(state.history, messages).slice(-24);
  const usedReplies = Array.isArray(state.usedReplies) ? state.usedReplies : [];
  const llmMsgs = [
    { role: "system", content:
        persona +
        imageNote +
        `\nStage right now: ${phase.operation}.` +
        (wantCTA
          ? `\nHe's ready. Drop your page link ${MODEL_CFG.ofLink} now. Tell him it's completely FREE — you flipped your page from paid to free just for him (it was paid before, now it's FREE for him — never say you made/created the page for him, and never say 'trial'). Then push him OFF this chat: tell him to come message you on the page RIGHT NOW while you're still online, and to tell you it's him — the guy you were just talking to — so you know. Then END by telling him you're going online on there now so you're leaving this chat (e.g. "okay i'm going online on there now so i'm leaving — message me there rn!"). Keep it cute, 3-4 short bubbles, not pushy or salesy.`
          : "\nDo NOT mention your page or any link yet. Just flirt and build rapport.") +
        (usedReplies.length
          ? `\nLines you already used — do NOT repeat or closely paraphrase any of them: ${usedReplies.slice(-30).join(" | ")}`
          : "") +
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
  } else if (isFirstReply) {
    bubbles = ["hi.. send me a picture of you"];
  } else if (wantCTA) {
    // Deterministic close: all required conversion beats, no repeated instruction,
    // and exactly three text bubbles before the final spiciest snap.
    bubbles = [
      `i flipped my page from paid to free for u 👀 ${MODEL_CFG.ofLink}`,
      `tell me it's u when u message me there so i know it's the guy i was just talking to 😊`,
      `i'm going online there now, so i'm leaving this chat 😘`,
    ];
  } else try {
    const { json: j } = await openRouterJSON(OPENROUTER_KEY.value(), {
        model: MODEL,
        messages: llmMsgs,
        temperature: 0.6,          // tighter — less hallucinated life-story
        top_p: 0.85,
        frequency_penalty: 0.4,    // cut repetitive filler
        max_tokens: 200,           // force short bubbles
        response_format: { type: "json_object" },
      }, { timeoutMs: 20000, title: "Cupid Replica", fallbackModel: FALLBACK_MODEL });
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
  // she flipped her (already-existing, paid) page to free for him. Never say
  // she MADE the page for him, and never call it a "trial".
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
        : `okay so… i flipped my page from paid to free for u 👀 ${MODEL_CFG.ofLink} 💕`);
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

  // Prompting helps, but this is the hard guarantee: remove exact and near
  // repeats against every Lori line already used in this session and against
  // earlier bubbles in the same response.
  if (!alreadyConverted) {
    bubbles = filterNovelBubbles(bubbles, usedReplies);
    if (!bubbles.length) {
      bubbles = novelRecoveryBubbles(state.exchangeCount, usedReplies);
    }
  }

  const now = Date.now() / 1000;
  const options = bubbles.map((msg) => ({
    msg, isIncoming: false, type: "body", style: "short", timestamp: now,
  }));

  // Snap beats — pick the right photo for where the convo is:
  //  1. verify: he called her fake/bot → proof pic (beats everything else)
  //  2. opener: brand-new convo → her hello snap lands BEFORE the "hi" text
  //  3. pic request: escalate casual early → spicy as exchanges build
  //  4. CTA: the spiciest pic lands AFTER every CTA/disconnect bubble
  const wantVerify = !!(lastFanMsg && VERIFY_REQUEST.test(lastFanMsg.msg || ""));

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const mediaOpt = (pool) => ({ ...pool, isIncoming: false, type: "media", mediaType: "image", style: "snap", timestamp: now });

  // Opener/verification/requested snaps lead the text response. The CTA snap is
  // intentionally different: it is appended after the final leaving bubble.
  if (wantVerify && !wantCTA) {
    options.unshift(mediaOpt(pick(MEDIA_POOLS.verify)));
  } else if (isFirstReply) {
    options.unshift(mediaOpt(MEDIA_POOLS.opener));
  } else if (wantPic && !wantCTA) {
    const tier = state.exchangeCount >= PHASES[1].minExchanges ? MEDIA_POOLS.spicy : MEDIA_POOLS.casual;
    options.unshift(mediaOpt(pick(tier)));
  }
  if (wantCTA) {
    options.push(mediaOpt(MEDIA_POOLS.spiciest));
  }

  // Persist state
  const newCount = state.exchangeCount + 1;
  const newCta = state.ctaShown || wantCTA;
  await saveState(sessionID, {
    exchangeCount: newCount,
    ctaShown: newCta,
    history: history.concat(bubbles.map((msg, i) => ({
      id: `lori-${Date.now()}-${i}`,
      isIncoming: false,
      msg,
    }))).slice(-24),
    usedReplies: usedReplies.concat(bubbles).slice(-80),
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

function replyFingerprint(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function repliesAreSimilar(a, b) {
  const left = replyFingerprint(a);
  const right = replyFingerprint(b);
  if (!left || !right) return false;
  if (left === right) return true;

  const leftWords = [...new Set(left.split(" "))];
  const rightWords = [...new Set(right.split(" "))];
  if (Math.min(leftWords.length, rightWords.length) < 3) return false;
  const rightSet = new Set(rightWords);
  const shared = leftWords.filter((word) => rightSet.has(word)).length;
  const containment = shared / Math.min(leftWords.length, rightWords.length);
  const lengthRatio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
  return containment >= 0.8 && lengthRatio >= 0.65;
}

function filterNovelBubbles(raw, usedReplies) {
  const accepted = [];
  const previous = Array.isArray(usedReplies) ? usedReplies : [];
  for (const bubble of raw) {
    if (previous.some((old) => repliesAreSimilar(bubble, old))) continue;
    if (accepted.some((old) => repliesAreSimilar(bubble, old))) continue;
    accepted.push(bubble);
  }
  // Multiple question bubbles usually restate the same conversational ask
  // (for example "you?" followed by "got plans?"). Keep only the most specific.
  const questions = accepted.filter((bubble) => /\?\s*$/.test(bubble));
  if (questions.length <= 1) return accepted;
  const bestQuestion = questions.reduce((best, bubble) =>
    replyFingerprint(bubble).length > replyFingerprint(best).length ? bubble : best);
  return accepted.filter((bubble) => !/\?\s*$/.test(bubble) || bubble === bestQuestion);
}

function novelRecoveryBubbles(exchangeCount, usedReplies) {
  const banks = [
    ["wait tell me more about that 👀", "what happened next?"],
    ["okay now i'm curious", "how did u get into that?"],
    ["ur actually interesting lol", "what else should i know about u?"],
    ["i wasn't expecting that answer 🙈", "keep going"],
    ["hmm okay i see u", "what are u doing rn?"],
    ["that made me smile 😊", "tell me one more thing"],
    ["okay ur growing on me", "what's ur best story?"],
    ["i like talking to u", "give me a random fact about u"],
  ];
  for (let offset = 0; offset < banks.length; offset++) {
    const bank = banks[(exchangeCount + offset) % banks.length];
    const novel = filterNovelBubbles(bank, usedReplies);
    if (novel.length) return novel;
  }
  return [`okay i'm listening ${exchangeCount + 1}`];
}

function mergeHistory(existing, incoming) {
  const merged = [];
  const seen = new Set();
  for (const msg of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!msg) continue;
    const key = msg.id
      ? `id:${msg.id}`
      : `${msg.isIncoming ? "fan" : "lori"}:${replyFingerprint(msg.msg)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(msg);
  }
  return merged;
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
  if (/\b(how much|price|cost)\b/.test(last)) return react(["it's totally free 🥺", "i flipped it from paid to free for u", "u just have to sign up 💕"]);
  if (/\b(no thanks|rather not|don'?t want|not sending|maybe later|no pic)\b/.test(last)) return react(["that's okay 😊", "no pressure at all", "what are u up to rn?"]);
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
  const ip = clientIP(req);
  const geo = await lookupGeo(req);
  return res.json({ city: geo.city, country: geo.country, ip });
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
