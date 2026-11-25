import assert from "node:assert/strict";
import test from "node:test";
import { createTelemetry } from "../src/background/telemetry.js";
import { TELEMETRY_KEY, TELEMETRY_STATUSES, validTelemetryPayload } from "../src/shared/telemetry-contract.js";

function fixture(options = {}) {
  const values = {};
  const sent = [];
  let time = 1_792_000_000_000;
  const storage = {
    async get(keys) { return Object.fromEntries(keys.filter((key) => key in values).map((key) => [key, structuredClone(values[key])])); },
    async set(next) { Object.assign(values, structuredClone(next)); }
  };
  const deps = { storage, now: () => time, fetcher: async (url, request) => {
    sent.push({ url, ...request, body: JSON.parse(request.body) });
    return { ok: true };
  }, ...options };
  return { values, sent, deps, create: () => createTelemetry(deps), advance(ms) { time += ms; } };
}

test("no request or installation identity exists before opt-in, after refusal, or in Incognito", async () => {
  for (const incognito of [false, true]) {
    const f = fixture({ incognito });
    const telemetry = f.create();
    assert.equal(await telemetry.record({ name: "sync_click", params: {} }), false);
    await telemetry.prepareRun("run", f.values[TELEMETRY_KEY]?.client_id);
    await telemetry.observe({ run_id: "run", state: "failed", error: { code: "NOT_LOGGED_IN" } });
    await telemetry.setConsent(false);
    assert.equal((await telemetry.getState()).enabled, false);
    assert.equal(f.sent.length, 0);
    if (incognito) {
      await telemetry.setConsent(true);
      assert.deepEqual(f.values, {});
    } else assert.equal(f.values[TELEMETRY_KEY].client_id, null);
  }
});

test("strict payload rejects account data, freeform labels and unknown error codes at every level", async () => {
  const f = fixture();
  const telemetry = f.create();
  await telemetry.setConsent(true);
  assert.equal(await telemetry.record({ name: "button_click", params: { action: "export-csv", username: "private_account" } }), false);
  assert.equal(await telemetry.record({ name: "button_click", params: { action: "private_account" } }), false);
  assert.equal(await telemetry.record({ name: "sync_status", params: { status: "completed", error_code: null } }), false);
  await telemetry.record({ name: "sync_click", params: {} });
  assert.equal(f.sent.length, 1);
  const body = f.sent[0].body;
  assert.equal(validTelemetryPayload(body), true);
  assert.equal(validTelemetryPayload({ ...body, instagram_account: "private" }), false);
  assert.equal(validTelemetryPayload({ ...body, event: { ...body.event, extra: "private" } }), false);
  assert.equal(validTelemetryPayload({ ...body, event: { name: "sync_status", params: { status: "failed", error_code: "private_error" } } }), false);
  assert.equal(f.sent[0].credentials, "omit");
  assert.equal(f.sent[0].redirect, "error");
});

test("sync stages, pause/resume and first terminal are claimed once across a worker restart", async () => {
  const f = fixture();
  let telemetry = f.create();
  await telemetry.setConsent(true);
  await telemetry.prepareRun("private_run", f.values[TELEMETRY_KEY]?.client_id);
  for (const stage of ["collecting_followers", "collecting_followers", "collecting_following"]) {
    await telemetry.observe({ run_id: "private_run", state: "running", stage, instagram_account: "secret", followers_count: 123 });
  }
  await telemetry.observe({ run_id: "private_run", state: "running", stage: "collecting_following", paused: true });
  await telemetry.observe({ run_id: "private_run", state: "running", stage: "collecting_following", paused: false });
  telemetry = f.create();
  await telemetry.prepareRun("private_run", f.values[TELEMETRY_KEY]?.client_id);
  await telemetry.observe({ run_id: "private_run", state: "running", stage: "processing" });
  await telemetry.observe({ run_id: "unrelated", state: "completed" });
  await telemetry.observe({ run_id: "private_run", state: "completed" });
  await telemetry.observe({ run_id: "private_run", state: "failed", error: { code: "COLLECTION_FAILED", message: "secret" } });
  assert.deepEqual(f.sent.map((request) => request.body.event.params.status),
    ["preflight", "collecting_followers", "collecting_following", "paused", "resumed", "processing", "completed"]);
  const serialized = JSON.stringify(f.sent.map((request) => request.body));
  for (const privateValue of ["private_run", "secret", "followers_count", "instagram_account", "message"]) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
});

test("all defined failure codes and interruption are countable without raw error text", async () => {
  const f = fixture();
  const telemetry = f.create();
  await telemetry.setConsent(true);
  const codes = ["CURRENT_ACCOUNT_UNAVAILABLE", "NOT_LOGGED_IN", "NOT_INSTAGRAM", "COLLECTION_FAILED", "STORAGE_ERROR", "COLLECTION_INTERRUPTED"];
  for (const code of codes) {
    await telemetry.prepareRun(code, f.values[TELEMETRY_KEY]?.client_id);
    await telemetry.observe({ run_id: code, state: code === "COLLECTION_INTERRUPTED" ? "interrupted" : "failed",
      error: { code, message: "private text" } });
  }
  assert.deepEqual(f.sent.filter((request) => request.body.event.params.error_code).map((request) => request.body.event.params.error_code), codes);
});

test("dashboard first-open is once per consenting installation and repeat opens reuse the identity", async () => {
  const f = fixture();
  let telemetry = f.create();
  await telemetry.setConsent(true);
  await telemetry.record({ name: "dashboard_open", params: {} });
  const firstId = f.values[TELEMETRY_KEY].client_id;
  telemetry = f.create();
  await telemetry.record({ name: "dashboard_open", params: {} });
  await telemetry.record({ name: "review_impression", params: {} });
  await telemetry.record({ name: "review_click", params: {} });
  assert.deepEqual(f.sent.map((request) => request.body.event.name),
    ["dashboard_first_open", "dashboard_open", "dashboard_open", "review_impression", "review_click"]);
  assert.equal(f.sent.every((request) => request.body.client_id === firstId), true);
  const session = f.sent[0].body.session_id;
  f.advance(31 * 60 * 1000);
  await telemetry.record({ name: "dashboard_open", params: {} });
  assert.notEqual(f.sent.at(-1).body.session_id, session);
  await telemetry.setConsent(false);
  await telemetry.setConsent(true);
  await telemetry.record({ name: "dashboard_open", params: {} });
  assert.notEqual(f.values[TELEMETRY_KEY].client_id, firstId);
  assert.equal(f.sent.at(-2).body.event.name, "dashboard_first_open");
});

test("granting consent never enrolls a previously unmeasured run; invalid stored consent fails closed", async () => {
  const f = fixture();
  const telemetry = f.create();
  await telemetry.prepareRun("old", false);
  await telemetry.setConsent(true);
  await telemetry.observe({ run_id: "old", state: "completed" });
  assert.equal(f.sent.length, 0);
  f.values[TELEMETRY_KEY].client_id = "instagram_username";
  assert.equal((await telemetry.getState()).enabled, false);
  await telemetry.record({ name: "sync_click", params: {} });
  assert.equal(f.sent.length, 0);
});

test("revocation aborts outstanding requests and prevents queued and future event delivery", async () => {
  let aborted = false;
  const f = fixture({ fetcher: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
  }) });
  const telemetry = f.create();
  await telemetry.setConsent(true);
  await telemetry.record({ name: "sync_click", params: {} });
  const queued = telemetry.record({ name: "sync_click", params: {} });
  await telemetry.setConsent(false);
  await queued;
  assert.equal(aborted, true);
  assert.deepEqual(f.values[TELEMETRY_KEY], { version: 1, consent: "denied", client_id: null, session: null, first_dashboard_open: false, run: null });
  assert.equal(await telemetry.record({ name: "sync_click", params: {} }), false);
});

test("storage and network failures do not escape into sync callers", async () => {
  const f = fixture({ fetcher: async () => { throw new Error("network unavailable"); } });
  const telemetry = f.create();
  await telemetry.setConsent(true);
  assert.equal(await telemetry.record({ name: "sync_click", params: {} }), true);
  f.deps.storage.set = async () => { throw new Error("storage unavailable"); };
  assert.equal(await telemetry.prepareRun("failed", f.values[TELEMETRY_KEY]?.client_id), false);
  assert.equal(TELEMETRY_STATUSES.includes("processing"), true);
});

test("an old enable write cannot undo a newer opt-out even if saving the opt-out fails", async () => {
  const f = fixture();
  const telemetry = f.create();
  await telemetry.setConsent(true);
  const write = f.deps.storage.set;
  let release;
  let started;
  const paused = new Promise((resolve) => { started = resolve; });
  f.deps.storage.set = async (value) => {
    if (value[TELEMETRY_KEY].consent === "granted") {
      started();
      await new Promise((resolve) => { release = resolve; });
      await write(value);
    } else throw new Error("denied write failed");
  };
  const enabling = telemetry.setConsent(true);
  await paused;
  const disabling = telemetry.setConsent(false);
  release();
  await Promise.all([enabling, disabling]);
  assert.equal((await telemetry.getState()).enabled, false);
  assert.equal(await telemetry.record({ name: "sync_click", params: {} }), false);
  assert.equal(f.sent.length, 0);
});

test("a run waiting during opt-out/regrant cannot enroll under the replacement identity", async () => {
  const f = fixture();
  const telemetry = f.create();
  await telemetry.setConsent(true);
  const eligibility = await telemetry.eligibility();
  await telemetry.setConsent(false);
  await telemetry.setConsent(true);
  await telemetry.prepareRun("waiting", eligibility);
  await telemetry.observe({ run_id: "waiting", state: "completed" });
  assert.equal(f.sent.length, 0);
});
