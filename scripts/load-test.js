#!/usr/bin/env node

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.replace(/^--/, "").split("=");
  return [key, value.join("=") || true];
}));

const base = String(args.base || "https://backend-production-38317.up.railway.app").replace(/\/$/, "");
const rps = Math.min(100, Math.max(1, +(args.rps || 5)));
const seconds = Math.min(600, Math.max(1, +(args.seconds || 15)));
const mode = args.mode === "opener" ? "opener" : "read";
const total = rps * seconds;
const latencies = [];
const statuses = new Map();
let errors = 0;

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]);
}

async function readRequest(index) {
  const paths = [
    "/health",
    "/api/config",
    "/api/link-config?slug=lori&domain=chat4free.us",
  ];
  return fetch(base + paths[index % paths.length], {
    headers: { Origin: "https://chat4free.us", "User-Agent": "CupidCapacityProbe/1.0" },
  });
}

async function openerRequest(index) {
  const configResponse = await fetch(base + "/api/config", {
    headers: { Origin: "https://chat4free.us", "User-Agent": "CupidCapacityProbe/1.0" },
  });
  if (!configResponse.ok) return configResponse;
  const cfg = await configResponse.json();
  const sessionID = `${cfg.sessionID}-load-${index}`.slice(0, 128);
  return fetch(base + "/api/chat", {
    method: "POST",
    headers: {
      Origin: "https://chat4free.us",
      "Content-Type": "application/json",
      "User-Agent": "CupidCapacityProbe/1.0",
    },
    body: JSON.stringify({
      sessionID,
      linkID: cfg.linkID,
      isFollowUp: true,
      messages: [],
      recipient: { id: sessionID },
      browserLanguageCode: "en",
      analyticsContext: {},
      zzz: { ...cfg.featureFlags, deviceInfo: { phoneType: "ios" } },
    }),
  });
}

async function runOne(index) {
  const started = performance.now();
  try {
    const response = mode === "opener" ? await openerRequest(index) : await readRequest(index);
    await response.arrayBuffer();
    const status = response.status;
    statuses.set(status, (statuses.get(status) || 0) + 1);
    if (status >= 400) errors += 1;
  } catch {
    errors += 1;
    statuses.set("network_error", (statuses.get("network_error") || 0) + 1);
  } finally {
    latencies.push(performance.now() - started);
  }
}

(async () => {
  const started = performance.now();
  const tasks = [];
  for (let index = 0; index < total; index += 1) {
    const due = index * (1000 / rps);
    tasks.push(new Promise((resolve) => setTimeout(() => runOne(index).then(resolve), due)));
  }
  await Promise.all(tasks);
  const elapsedSeconds = (performance.now() - started) / 1000;
  const summary = {
    base, mode, requestedRps: rps, seconds, requests: total,
    achievedRps: +(total / elapsedSeconds).toFixed(2),
    statusCounts: Object.fromEntries(statuses),
    errors,
    errorRatePercent: +(100 * errors / total).toFixed(2),
    latencyMs: {
      p50: percentile(latencies, 0.50),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: Math.round(Math.max(...latencies, 0)),
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.errorRatePercent > 1) process.exitCode = 1;
})();
