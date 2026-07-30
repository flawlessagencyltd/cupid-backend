const test = require("node:test");
const assert = require("node:assert/strict");
const { isAllowedOrigin } = require("../http");
const { _internal } = require("../tracking");

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
