import assert from "node:assert/strict";
import test from "node:test";
import { createTelemetryControls } from "../src/dashboard/telemetry-controls.js";

function fixture({ consent = "unknown", incognito = false, failConsent = false } = {}) {
  const events = [];
  let starts = 0;
  let opened = false;
  let errors = 0;
  const requests = [];
  const controls = createTelemetryControls({
    runtime: { async sendMessage(message) {
      requests.push(message);
      if (message.type === "telemetry.setConsent") {
        if (failConsent) return { request_id: message.request_id, error: { code: "STORAGE_ERROR" } };
        consent = message.enabled ? "granted" : "denied";
      }
      if (message.type === "telemetry.record") {
        if (consent === "granted" && !incognito) events.push(message.event);
        return { type: "telemetry.record.result", request_id: message.request_id, accepted: consent === "granted", error: null };
      }
      return { type: "telemetry.state", request_id: message.request_id, consent,
        enabled: consent === "granted" && !incognito, incognito, error: null };
    } },
    view: { render() {}, open() { opened = true; }, close() { opened = false; }, error() { errors += 1; } },
    startSync: async () => { starts += 1; }
  });
  return { controls, events, requests, get starts() { return starts; }, get opened() { return opened; }, get errors() { return errors; } };
}

test("first opening prompts before any Sync; consent alone never starts sync or counts a conversion", async () => {
  const f = fixture();
  await f.controls.initialize();
  assert.equal(f.opened, true);
  assert.equal(f.starts, 0);
  assert.equal(f.events.length, 0);
  await f.controls.choose(true);
  assert.equal(f.starts, 0);
  assert.equal(f.events.filter((event) => event.name === "sync_click").length, 0);
  assert.equal(f.opened, false);
  await f.controls.sync();
  assert.equal(f.starts, 1);
  assert.equal(f.events.filter((event) => event.name === "sync_click").length, 1);
});

test("saved consent and incognito do not prompt on opening", async () => {
  for (const options of [{ consent: "granted" }, { consent: "denied" }, { incognito: true }]) {
    const f = fixture(options);
    await f.controls.initialize();
    assert.equal(f.opened, false);
    assert.equal(f.starts, 0);
    assert.equal(f.requests.some((request) => request.type === "telemetry.setConsent"), false);
  }
});

test("decline persists across opening; dismiss stays unknown; later Sync does not prompt", async () => {
  for (const choice of ["decline", "dismiss", "incognito"]) {
    const f = fixture({ incognito: choice === "incognito" });
    await f.controls.initialize();
    if (choice === "decline") await f.controls.choose(false);
    if (choice === "dismiss") await f.controls.dismiss();
    assert.equal(f.opened, false, choice);
    assert.equal(f.starts, 0, choice);
    await f.controls.sync();
    assert.equal(f.opened, false, choice);
    assert.equal(f.starts, 1, choice);
    assert.equal(f.events.length, 0, choice);
    if (choice === "dismiss") assert.equal(f.requests.some((request) => request.type === "telemetry.setConsent"), false);
    await f.controls.initialize();
    assert.equal(f.opened, choice === "dismiss", choice);
  }
});

test("failed consent persistence does not block sync or produce a conversion", async () => {
  const f = fixture({ failConsent: true });
  await f.controls.initialize();
  await f.controls.choose(true);
  assert.equal(f.errors, 1);
  assert.equal(f.opened, false);
  assert.equal(f.starts, 0);
  await f.controls.sync();
  assert.equal(f.starts, 1);
  assert.equal(f.events.length, 0);
});

test("button events use a fixed action; opt-out sends no action or later event", async () => {
  const f = fixture({ consent: "granted" });
  await f.controls.refresh();
  f.controls.recordAction("export-csv");
  f.controls.recordAction("private_username");
  await f.controls.change();
  f.controls.recordAction("export-csv");
  await Promise.resolve();
  assert.deepEqual(f.events, [{ name: "button_click", params: { action: "export-csv" } }]);
});
