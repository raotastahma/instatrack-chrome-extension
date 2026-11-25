// Synthetic browser fixture. This file is excluded from the extension package.
import { createTelemetry } from "../src/background/telemetry.js";
import { buildCompletedSync } from "../src/domain/analytics.js";
const values = {};
const changed = [];
const listeners = [];
const events = [];
const time = Math.floor(Date.now() / 1000);
const stamp = { iso: new Date(time * 1000).toISOString().replace(".000Z", "Z"), epoch: time };
const completed = buildCompletedSync(null, { run_id: "synthetic_baseline", started_at: stamp, finished_at: stamp,
  instagram_account: "demo_account", followers: ["demo_one", "demo_two"], following: ["demo_two", "demo_three"] });
let lastSync = { run_id: "synthetic_baseline", state: "completed", stage: "stored", started_at: stamp, finished_at: stamp,
  instagram_account: "demo_account", followers_count: 2, following_count: 2, duration_ms: 0, error: null };
const storage = {
  async get(keys) { return Object.fromEntries((typeof keys === "string" ? [keys] : keys).filter((key) => key in values).map((key) => [key, structuredClone(values[key])])); },
  async set(next) {
    Object.assign(values, structuredClone(next));
    queueMicrotask(() => changed.forEach((listener) => listener(Object.fromEntries(Object.entries(next).map(([key, newValue]) => [key, { newValue }])), "local")));
  }
};
const telemetry = createTelemetry({ storage, incognito: location.search.includes("incognito"), fetcher: async (_url, request) => {
  events.push(JSON.parse(request.body).event);
  document.querySelector("[data-qa-events]").textContent = JSON.stringify(events);
  return { ok: true };
} });
const runtime = {
  onMessage: { addListener(listener) { listeners.push(listener); } },
  async sendMessage(message) {
    const base = { request_id: message.request_id, error: null };
    if (message.type === "telemetry.getState") return { ...base, type: "telemetry.state", ...await telemetry.getState() };
    if (message.type === "telemetry.setConsent") return { ...base, type: "telemetry.state", ...await telemetry.setConsent(message.enabled) };
    if (message.type === "telemetry.record") return { ...base, type: "telemetry.record.result", accepted: await telemetry.record(message.event) };
    if (message.type === "dashboard.getState") return { type: "dashboard.state", request_id: message.request_id,
      instagram_account: "demo_account", report: completed.report, sync_points: completed.history.sync_points, last_sync: lastSync };
    if (message.type === "sync.start") {
      const id = `synthetic_${crypto.randomUUID()}`;
      await telemetry.prepareRun(id, await telemetry.eligibility());
      lastSync = { ...lastSync, run_id: id, state: "running", stage: "preflight", finished_at: null, duration_ms: null };
      for (const [index, stage] of ["collecting_followers", "collecting_following", "processing"].entries()) {
        setTimeout(async () => {
          lastSync = { ...lastSync, stage };
          await telemetry.observe(lastSync);
          listeners.forEach((listener) => listener({ type: "sync.progress", run_id: id, last_sync: lastSync }));
        }, (index + 1) * 200);
      }
      setTimeout(async () => {
        lastSync = { ...lastSync, state: "completed", stage: "stored", finished_at: stamp, duration_ms: 0 };
        await telemetry.observe(lastSync);
        listeners.forEach((listener) => listener({ type: "sync.result", run_id: id, state: "completed" }));
      }, 900);
      return { type: "sync.accepted", state: "running", request_id: message.request_id, run_id: id, started_at: stamp,
        stage: "preflight", recovered: false };
    }
    return null;
  }
};
globalThis.chrome = { runtime, storage: { local: storage, onChanged: { addListener(listener) { changed.push(listener); } } } };
await import("../src/dashboard/dashboard.js");
