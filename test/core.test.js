const test = require("node:test");
const assert = require("node:assert/strict");
const { isAllowedOrigin } = require("../http");
const { _internal } = require("../tracking");
const { _internal: chatInternal } = require("../index");

test("production and local origins are allowed", () => {
  assert.equal(isAllowedOrigin("https://chat4free.us"), true);
  assert.equal(isAllowedOrigin("https://cupid-replica1.web.app"), true);
  assert.equal(isAllowedOrigin("http://localhost:5005"), true);
  assert.equal(isAllowedOrigin("https://attacker.example"), false);
});

test("slugs and hosts are normalized safely", () => {
  assert.equal(_internal.slugify("@My IG_account"), "my-ig-account");
  assert.equal(_internal.normalizeHost("https://WWW.Chat4Free.US/path"), "chat4free.us");
  assert.equal(_internal.normalizeHost("not a host"), "");
});

test("automated user agents are flagged", () => {
  const info = _internal.clientInfo("Mozilla/5.0 Playwright HeadlessChrome");
  assert.equal(info.verdict, "flagged");
  assert.ok(info.flags.includes("automated_user_agent"));
});

test("country exclusions are normalized and can use a recovery URL", () => {
  assert.deepEqual(_internal.countryAccess(["gb", "DE"], "GB", "https://example.com/recover"), {
    blocked: true,
    country: "GB",
    reason: "excluded_country",
    recoveryURL: "https://example.com/recover",
  });
  assert.equal(_internal.countryAccess(["GB"], "US").blocked, false);
  assert.equal(_internal.countryAccess(["GB"], "").blocked, false);
});

test("picture questions stay in chat instead of triggering the CTA", () => {
  assert.equal(chatInternal.messageTriggersCTA("why do u need a pic of me?"), false);
  assert.equal(chatInternal.messageRequestsPic("why do u need a pic of me?"), false);
  assert.equal(chatInternal.messageAsksWhyPic("why do u need a pic of me?"), true);
  assert.equal(chatInternal.messageRequestsPic("can u send me a pic?"), true);
  assert.equal(chatInternal.messageDeclinesPic("i dont want to send a pic"), true);
  assert.equal(chatInternal.messageTriggersCTA("what's your onlyfans?"), true);
});

test("split replies remain split without leaving an orphaned second half", () => {
  assert.deepEqual(
    chatInternal.filterNovelBubbles(["i'm scared", "of the really scary ones"], []),
    ["i'm scared", "of the really scary ones"]
  );
  assert.deepEqual(
    chatInternal.filterNovelBubbles(["i'm scared", "of the really scary ones"], ["i'm scared"]),
    []
  );
});
