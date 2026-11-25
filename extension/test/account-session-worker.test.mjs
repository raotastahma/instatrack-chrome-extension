import assert from "node:assert/strict";
import test from "node:test";
import { buildCompletedSync } from "../src/domain/analytics.js";
import { createDashboardController } from "../src/dashboard/dashboard.js";
import { STORAGE_KEYS } from "../src/shared/constants.js";
import { TELEMETRY_KEY } from "../src/shared/telemetry-contract.js";

const takenAt = { iso: "2026-08-08T14:45:13Z", epoch: 1786200313 };
function saved(account, following) {
  const result = buildCompletedSync(null, {
    run_id: `sync_${account}`, started_at: takenAt, finished_at: takenAt,
    instagram_account: account, followers: ["follower"], following
  });
  return { [STORAGE_KEYS.history]: result.history, [STORAGE_KEYS.report]: result.report };
}

async function fixture({ incognito = false, values = saved("alice", ["one", "two"]) } = {}) {
  let listener;
  const previousChrome = globalThis.chrome;
  const f = { values, tabQueries: 0, tabs: [], created: [], sent: [], activated: [], focused: [], badges: [], broadcasts: [], sessionState: "authenticated" };
  const updated = new Set();
  const removed = new Set();
  f.onUpdated = (...args) => updated.forEach((fn) => fn(...args));
  f.onRemoved = (...args) => removed.forEach((fn) => fn(...args));
  globalThis.chrome = {
    extension: { inIncognitoContext: incognito },
    action: { onClicked: { addListener() {} }, setBadgeText: async (value) => f.badges.push(value.text) },
    runtime: { id: "bbjpknpklcpjcogdockeodhieaghbbeb", getURL: (path) => `chrome-extension://bbjpknpklcpjcogdockeodhieaghbbeb/${path}`,
      onMessage: { addListener(fn) { listener = fn; } }, sendMessage: async (message) => f.broadcasts.push(message) },
    windows: { update: async (id, properties) => f.focused.push({ id, ...properties }) },
    storage: {
      local: {
        get: async (keys) => Object.fromEntries((keys ?? Object.keys(values)).filter((key) => key in values).map((key) => [key, structuredClone(values[key])])),
        set: async (next) => Object.assign(values, structuredClone(next)),
        remove: async (keys) => keys.forEach((key) => delete values[key])
      }
    },
    tabs: {
      onUpdated: { addListener: (fn) => updated.add(fn), removeListener: (fn) => updated.delete(fn) },
      onRemoved: { addListener: (fn) => removed.add(fn), removeListener: (fn) => removed.delete(fn) },
      query: async () => { f.tabQueries += 1; return f.tabs; },
      update: async (id, properties) => {
        f.activated.push({ id, ...properties });
        const tab = f.tabs.find((tab) => tab.id === id);
        if (!tab) throw new Error("Tab closed");
        Object.assign(tab, properties);
        return tab;
      },
      get: async (id) => {
        const tab = f.tabs.find((tab) => tab.id === id);
        if (!tab) throw new Error("Tab closed");
        return tab;
      },
      create: async (properties) => {
        f.created.push(properties);
        const tab = { id: 10, incognito, status: "loading", ...properties };
        f.tabs.push(tab);
        return tab;
      },
      sendMessage: async (tabId, message) => {
        f.sent.push({ tabId, ...message });
        if (message.type === "instagram.session.get") {
          f.afterSession?.();
          return { type: "instagram.session", request_id: message.request_id, state: f.sessionState,
            instagram_account: f.sessionState === "authenticated" ? "alice" : null, protocol_version: 2 };
        }
        if (message.type === "instagram.collectRelationships.start") {
          f.collector = { type: "instagram.collectRelationships.inspect.result", state: "running", run_id: message.run_id,
            request_id: message.request_id, started_at: message.started_at, stage: "preflight", protocol_version: 2 };
          return { type: "instagram.collectRelationships.accepted", run_id: message.run_id, state: "started", protocol_version: 2 };
        }
        if (message.type === "instagram.collectRelationships.inspect") return f.collector ?? null;
        if (message.type === "instagram.collectRelationships.stop") {
          f.collector = { type: "instagram.collectRelationships.inspect.result", state: "idle", run_id: null,
            request_id: null, started_at: null, stage: null, protocol_version: 2 };
          return { type: "instagram.collectRelationships.stop.result", run_id: message.run_id, stopped: true, protocol_version: 2 };
        }
        return null;
      }
    }
  };
  await import(`../src/background/service-worker.js?account-worker=${crypto.randomUUID()}`);
  f.request = (type, extra = {}) => new Promise((resolve) => {
    listener({ type, request_id: crypto.randomUUID(), ...extra }, { id: "bbjpknpklcpjcogdockeodhieaghbbeb",
      url: "chrome-extension://bbjpknpklcpjcogdockeodhieaghbbeb/dashboard/index.html", tab: { id: 1, windowId: 42, incognito } },
      (response) => setImmediate(() => resolve(response)));
  });
  f.rawMessage = listener;
  f.content = (message) => new Promise((resolve) => listener(message, { tab: f.tabs[0] }, resolve));
  f.restore = () => { globalThis.chrome = previousChrome; };
  return f;
}

test("only the exact dashboard can set telemetry consent or submit fixed UI events", async () => {
  const f = await fixture();
  try {
    let replied = false;
    const request = { type: "telemetry.setConsent", request_id: "untrusted", enabled: true };
    assert.equal(f.rawMessage(request, { id: "bbjpknpklcpjcogdockeodhieaghbbeb", url: "https://www.instagram.com/" }, () => { replied = true; }), undefined);
    assert.equal(f.rawMessage(request, { id: "another-extension", url: "chrome-extension://bbjpknpklcpjcogdockeodhieaghbbeb/dashboard/index.html" }, () => { replied = true; }), undefined);
    assert.equal(replied, false);
    assert.equal(f.values[TELEMETRY_KEY], undefined);
    assert.equal((await f.request("telemetry.setConsent", { enabled: true })).enabled, true);
    const forged = await f.request("telemetry.record", { event: { name: "sync_status", params: { status: "completed", error_code: null } } });
    assert.equal(forged.accepted, false);
    const privateField = await f.request("telemetry.record", { event: { name: "button_click", params: { action: "export-csv", account: "alice" } } });
    assert.equal(privateField.accepted, false);
    assert.equal((await f.request("telemetry.setConsent", { enabled: false })).enabled, false);
    assert.equal(f.values[TELEMETRY_KEY].client_id, null);
  } finally { f.restore(); }
});

test("an Incognito dashboard cannot enable analytics or create an installation identifier", async () => {
  const f = await fixture({ incognito: true });
  try {
    const result = await f.request("telemetry.setConsent", { enabled: true });
    assert.equal(result.incognito, true);
    assert.equal(result.enabled, false);
    assert.equal(f.values[TELEMETRY_KEY], undefined);
  } finally { f.restore(); }
});

test("normal and incognito dashboards read the last stored account without inspecting Instagram", async () => {
  for (const incognito of [false, true]) {
    const f = await fixture({ incognito });
    try {
      const state = await f.request("dashboard.getState");
      assert.equal(state.instagram_account, "alice");
      assert.equal(state.report.instagram_account, "alice");
      assert.equal(state.sync_points.length, 1);
      assert.equal(Object.hasOwn(state, "session_state"), false);
      const exported = await f.request("report.export", { format: "json" });
      assert.equal(exported.error, null);
      assert.equal(JSON.parse(exported.body).instagram_account, "alice");
      assert.equal(f.tabQueries, 0);
      assert.deepEqual(f.created, []);
      assert.deepEqual(f.sent, []);
    } finally { f.restore(); }
  }
});

test("manual Sync activates Instagram; durable preflight pause broadcasts and focused return targets only its collector", async () => {
  const f = await fixture({ values: {} });
  try {
    f.tabs.push({ id: 10, url: "https://www.instagram.com/", status: "complete", active: false, windowId: 45 });
    const accepted = await f.request("sync.start", { requested_at: takenAt });
    assert.equal(accepted.type, "sync.accepted");
    assert.deepEqual(f.activated, [{ id: 10, active: true }]);
    assert.deepEqual(f.focused, [{ id: 45, focused: true }]);
    const progress = { type: "instagram.collectionProgress", run_id: accepted.run_id, stage: "preflight", paused: true };
    assert.equal((await f.content(progress)).accepted, true);
    const durable = f.values["instatrack.run.v1.regular"].last_sync;
    assert.equal(durable.paused, true);
    assert.deepEqual(f.broadcasts.at(-1), { type: "sync.progress", run_id: accepted.run_id, last_sync: durable });
    assert.equal(f.badges.at(-1), "II");
    assert.equal((await f.request("dashboard.getState")).last_sync.paused, true);
    assert.equal((await f.request("sync.focus", { run_id: "wrong" })).focused, false);
    assert.equal(f.activated.length, 1);
    assert.equal((await f.request("sync.focus", { run_id: accepted.run_id })).focused, true);
    assert.equal(f.activated.at(-1).id, 10);
    assert.equal((await f.content({ ...progress, paused: "true" })).accepted, false);
    assert.equal((await f.content({ ...progress, paused: false })).accepted, true);
    assert.equal(f.badges.at(-1), "");
    await f.content(progress);
    assert.equal((await f.request("sync.stop", { run_id: accepted.run_id })).stopped, true);
    assert.equal(f.badges.at(-1), "");
    const stopped = await f.request("dashboard.getState");
    assert.equal(stopped.last_sync.state, "interrupted");
    assert.equal(stopped.report, null);
    assert.equal((await f.content(progress)).accepted, false);
  } finally { f.restore(); }
});

test("import for another account cannot orphan an active same-context collector", async () => {
  const f = await fixture();
  try {
    const backup = await f.request("backup.export");
    f.values["instatrack.run.v1.regular"] = {
      version: 1, generation: 0, instagram_account: "bob", last_sync: {
        run_id: "bob_running", state: "running", stage: "collecting_followers", started_at: takenAt, finished_at: null,
        instagram_account: "bob", followers_count: null, following_count: null, duration_ms: null, error: null
      }
    };
    const before = structuredClone(f.values);
    const imported = await f.request("backup.import", { confirm: true, body: backup.body });
    assert.equal(imported.imported, false);
    assert.equal(imported.error.code, "IMPORT_INVALID");
    assert.deepEqual(structuredClone(f.values), before);
    assert.equal(f.tabQueries, 0);
  } finally { f.restore(); }
});

test("without completed syncs the dashboard stays empty and never opens Instagram", async () => {
  const f = await fixture({ values: {} });
  try {
    const state = await f.request("dashboard.getState");
    assert.equal(state.instagram_account, null);
    assert.equal(state.report, null);
    assert.equal(state.last_sync, null);
    assert.deepEqual(state.sync_points, []);
    assert.equal(f.tabQueries, 0);
    assert.deepEqual(f.created, []);
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.values, {});
  } finally { f.restore(); }
});

test("Sync opens a missing Instagram tab in the calling window and waits for loading before collection", async () => {
  for (const incognito of [false, true]) {
    const f = await fixture({ incognito });
    try {
      const pending = f.request("sync.start", { requested_at: takenAt });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(f.created, [{ url: "https://www.instagram.com/", windowId: 42, active: true }]);
      assert.deepEqual(f.sent, [], "session must not be inspected before the new tab loads");
      f.tabs[0].status = "complete";
      f.onUpdated(10, { status: "complete" }, f.tabs[0]);
      const sync = await pending;
      assert.equal(sync.type, "sync.accepted");
      assert.deepEqual(f.sent.slice(0, 2).map(({ tabId, type }) => ({ tabId, type })), [
        { tabId: 10, type: "instagram.session.get" },
        { tabId: 10, type: "instagram.collectRelationships.start" }
      ]);
      assert.equal(f.values[STORAGE_KEYS.history].sync_points.length, 1, "preflight must preserve successful history");
    } finally { f.restore(); }
  }
});

test("invalid Sync requests never open Instagram or inspect its account", async () => {
  const f = await fixture();
  try {
    const sync = await f.request("sync.start", { requested_at: takenAt, target_account: "other" });
    assert.equal(sync.state, "failed");
    assert.equal(sync.error.code, "COLLECTION_FAILED");
    assert.equal(f.tabQueries, 0);
    assert.deepEqual(f.created, []);
    assert.deepEqual(f.sent, []);
  } finally { f.restore(); }
});

test("Sync reuses the existing tab without a retry delay and launches in the same tab that supplied the account", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture();
  try {
    f.tabs.push({ id: 10, url: "https://www.instagram.com/", status: "complete", active: true, windowId: 42 });
    f.afterSession = () => {
      f.tabs[0].active = false;
      f.tabs.unshift({ id: 11, url: "https://www.instagram.com/", status: "complete", active: true, lastAccessed: Date.now() });
    };
    assert.equal((await f.request("sync.start", { requested_at: takenAt })).type, "sync.accepted");
    assert.deepEqual(f.created, []);
    assert.equal(f.sent.find((message) => message.type === "instagram.collectRelationships.start").tabId, 10);
  } finally { f.restore(); }
});

for (const transportError of ["Could not establish connection. Receiving end does not exist.", "The message port closed before a response was received."]) {
  test(`one Sync recovers from ${transportError} without duplicating collection`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = await fixture();
    try {
      f.tabs.push({ id: 10, url: "https://www.instagram.com/", status: "complete", active: true, windowId: 42 });
      const send = chrome.tabs.sendMessage;
      let attempts = 0;
      chrome.tabs.sendMessage = async (id, message) => {
        if (message.type === "instagram.session.get" && ++attempts < 3) {
          throw new Error(transportError);
        }
        return send(id, message);
      };
      const pending = f.request("sync.start", { requested_at: takenAt });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(attempts, 1);
      t.mock.timers.tick(250);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(attempts, 2);
      t.mock.timers.tick(500);
      const sync = await pending;
      assert.equal(sync.type, "sync.accepted");
      assert.equal(attempts, 3);
      assert.equal(f.sent.filter(({ type }) => type === "instagram.collectRelationships.start").length, 1);
      assert.deepEqual(f.created, []);
      assert.equal(f.values[STORAGE_KEYS.history].sync_points.length, 1);
    } finally { f.restore(); }
  });
}

test("closing Instagram during a retry stops preparation without launching collection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture();
  try {
    f.tabs.push({ id: 10, url: "https://www.instagram.com/", status: "complete" });
    let attempts = 0;
    chrome.tabs.sendMessage = async () => {
      attempts += 1;
      throw new Error("Could not establish connection. Receiving end does not exist.");
    };
    const pending = f.request("sync.start", { requested_at: takenAt });
    await new Promise((resolve) => setImmediate(resolve));
    f.tabs.length = 0;
    t.mock.timers.tick(250);
    const sync = await pending;
    assert.equal(attempts, 1);
    assert.equal(sync.state, "failed");
    assert.match(sync.error.message, /Tab closed/);
    assert.equal(f.collector, undefined);
  } finally { f.restore(); }
});

test("receiver retries are bounded and the failure survives dashboard and worker reloads", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture();
  try {
    f.tabs.push({ id: 10, url: "https://www.instagram.com/", status: "complete" });
    let attempts = 0;
    chrome.tabs.sendMessage = async () => {
      attempts += 1;
      throw new Error("Could not establish connection. Receiving end does not exist.");
    };
    const before = structuredClone(f.values);
    const pending = f.request("sync.start", { requested_at: takenAt });
    await new Promise((resolve) => setImmediate(resolve));
    for (const delay of [250, 500, 1000, 2000]) {
      t.mock.timers.tick(delay);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const sync = await pending;
    assert.equal(attempts, 5);
    assert.equal(sync.state, "failed");
    assert.match(sync.error.message, /Receiving end does not exist/);
    assert.deepEqual(structuredClone(f.values[STORAGE_KEYS.history]), before[STORAGE_KEYS.history]);
    assert.deepEqual(structuredClone(f.values[STORAGE_KEYS.report]), before[STORAGE_KEYS.report]);
    assert.equal((await f.request("dashboard.getState")).last_sync.run_id, sync.run_id);
    const restarted = await fixture({ values: f.values });
    try {
      const state = await restarted.request("dashboard.getState");
      assert.equal(state.last_sync.run_id, sync.run_id);
      assert.equal(state.last_sync.error.message, sync.error.message);
      assert.deepEqual(state.report, before[STORAGE_KEYS.report]);
      const reset = await restarted.request("history.reset", { confirm: true });
      assert.equal(reset.reset, true);
      assert.equal((await restarted.request("dashboard.getState")).last_sync, null);
    } finally { restarted.restore(); }
  } finally { f.restore(); }
});

test("unrelated messaging errors are not retried", async () => {
  const f = await fixture();
  try {
    f.tabs.push({ id: 10, url: "https://www.instagram.com/", status: "complete" });
    let attempts = 0;
    chrome.tabs.sendMessage = async () => { attempts += 1; throw new Error("Access denied"); };
    const sync = await f.request("sync.start", { requested_at: takenAt });
    assert.equal(attempts, 1);
    assert.equal(sync.state, "failed");
    assert.match(sync.error.message, /Access denied/);
  } finally { f.restore(); }
});

test("closing the newly opened tab ends preflight without changing saved analytics", async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.values);
    const pending = f.request("sync.start", { requested_at: takenAt });
    await new Promise((resolve) => setImmediate(resolve));
    f.tabs.length = 0;
    f.onRemoved(10);
    const sync = await pending;
    assert.equal(sync.state, "failed");
    assert.equal(sync.error.code, "CURRENT_ACCOUNT_UNAVAILABLE");
    assert.deepEqual(structuredClone(f.values), { ...before, "instatrack.run.v1.regular": {
      version: 1, generation: 0, instagram_account: null, last_sync: (await f.request("dashboard.getState")).last_sync
    } });
  } finally { f.restore(); }
});

test("a stalled Instagram load fails promptly and a retry reuses the tab", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture();
  try {
    const pending = f.request("sync.start", { requested_at: takenAt });
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(20_000);
    const sync = await pending;
    assert.equal(sync.state, "failed");
    assert.equal(sync.error.code, "CURRENT_ACCOUNT_UNAVAILABLE");
    assert.deepEqual(f.sent, []);
    f.tabs[0].status = "complete";
    assert.equal((await f.request("sync.start", { requested_at: takenAt })).type, "sync.accepted");
    assert.equal(f.created.length, 1);
    const duplicate = await f.request("sync.start", { requested_at: takenAt });
    assert.equal(duplicate.recovered, true);
    assert.equal(f.sent.filter(({ type }) => type === "instagram.collectRelationships.start").length, 1);
  } finally { f.restore(); }
});

test("a logged-out existing Instagram tab fails without creating another tab or changing saved analytics", async () => {
  const f = await fixture();
  try {
    f.tabs.push({ id: 10, url: "https://www.instagram.com/accounts/login/", status: "complete" });
    f.sessionState = "logged_out";
    const before = structuredClone(f.values);
    const sync = await f.request("sync.start", { requested_at: takenAt });
    assert.equal(sync.error.code, "NOT_LOGGED_IN");
    assert.equal(sync.duration_ms, null);
    assert.deepEqual(f.created, []);
    assert.equal(f.sent.length, 1, "logged-out responses must not be retried");
    assert.deepEqual(structuredClone(f.values), { ...before, "instatrack.run.v1.regular": {
      version: 1, generation: 0, instagram_account: null, last_sync: (await f.request("dashboard.getState")).last_sync
    } });
  } finally { f.restore(); }
});

test("recovering a persisted run never opens Instagram or separately checks the account", async () => {
  const f = await fixture();
  try {
    f.values["instatrack.run.v1.regular"] = {
      version: 1, generation: 0, instagram_account: "alice", last_sync: {
        run_id: "sync_abandoned", state: "running", stage: "collecting_followers", started_at: takenAt, finished_at: null,
        instagram_account: "alice", followers_count: null, following_count: null, duration_ms: null, error: null
      }
    };
    const sync = await f.request("sync.start", { requested_at: takenAt });
    assert.equal(sync.state, "interrupted");
    assert.equal(sync.run_id, "sync_abandoned");
    assert.deepEqual(f.created, []);
    assert.deepEqual(f.sent, []);
  } finally { f.restore(); }
});

test("backup restores its own account without checking a browser login and refuses an active matching run", async () => {
  const f = await fixture();
  try {
    const backup = await f.request("backup.export");
    assert.equal(backup.error, null);
    const before = structuredClone(f.values);
    f.values["instatrack.run.v1.incognito"] = {
      version: 1, generation: 0, instagram_account: "alice", last_sync: {
        run_id: "sync_busy", state: "running", stage: "collecting_followers", started_at: takenAt, finished_at: null,
        instagram_account: "alice", followers_count: null, following_count: null, duration_ms: null, error: null
      }
    };
    const busy = await f.request("backup.import", { confirm: true, body: backup.body });
    assert.equal(busy.imported, false);
    assert.equal(busy.error.code, "IMPORT_INVALID");
    assert.deepEqual(structuredClone(f.values[STORAGE_KEYS.history]), before[STORAGE_KEYS.history]);
    for (const key of Object.keys(f.values)) delete f.values[key];
    const imported = await f.request("backup.import", { confirm: true, body: backup.body });
    assert.equal(imported.imported, true);
    assert.ok(imported.replaced_keys.includes("instatrack.account.v1.0.alice"));
    assert.equal((await f.request("dashboard.getState")).report.instagram_account, "alice");
    assert.equal(f.tabQueries, 0);
  } finally { f.restore(); }
});

test("restoring a running backup preserves analytics and requires a new manual Sync after dashboard reload", async () => {
  for (const incognito of [false, true]) {
    const f = await fixture({ incognito });
    try {
      const runKey = `instatrack.run.v1.${incognito ? "incognito" : "regular"}`;
      f.values[runKey] = {
        version: 1, generation: 0, instagram_account: "alice", last_sync: {
          run_id: "sync_backed_up", state: "running", stage: "preflight", started_at: takenAt, finished_at: null,
          instagram_account: "alice", followers_count: null, following_count: null, duration_ms: null, error: null
        }
      };
      const exported = await f.request("backup.export");
      const backup = JSON.parse(exported.body);
      assert.equal(backup.last_sync.state, "running");
      for (const key of Object.keys(f.values)) delete f.values[key];
      f.tabs.push({ id: 10, incognito, url: "https://www.instagram.com/", status: "complete", active: true, windowId: 42 });
      f.collector = { type: "instagram.collectRelationships.inspect.result", state: "idle", run_id: null,
        request_id: null, started_at: null, stage: null, protocol_version: 2 };

      assert.equal((await f.request("backup.import", { confirm: true, body: exported.body })).imported, true);
      const requests = [];
      const dashboard = createDashboardController({
        runtime: { sendMessage: (message) => { requests.push(message.type); return f.request(message.type, message); } },
        view: { render() {}, focusTarget() {} }
      });
      await dashboard.initialize();
      assert.deepEqual(requests, ["dashboard.getState"], "restored diagnostics must not trigger automatic recovery");
      assert.equal(f.tabQueries, 0);
      assert.deepEqual(f.sent, []);
      assert.deepEqual(f.created, []);
      const restored = f.values["instatrack.account.v1.0.alice"];
      assert.deepEqual(restored.history, backup.history);
      assert.deepEqual(restored.report, backup.report);
      assert.equal(restored.last_sync.state, "interrupted");
      assert.equal(restored.last_sync.error.code, "COLLECTION_INTERRUPTED");
      assert.equal(restored.last_sync.duration_ms, null);
      assert.ok(restored.last_sync.finished_at);
      assert.deepEqual(f.values[runKey].last_sync, restored.last_sync);

      assert.equal(await dashboard.startSync(), true);
      assert.equal(f.sent.filter(({ type }) => type === "instagram.collectRelationships.start").length, 1);
    } finally { f.restore(); }
  }
});

test("page loading never checks Instagram while idle and retires only an abandoned active collection", async () => {
  const f = await fixture();
  try {
    f.onUpdated(10, { status: "complete" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.tabQueries, 0);
    f.values["instatrack.run.v1.regular"] = {
      version: 1, generation: 0, instagram_account: "alice", last_sync: {
        run_id: "sync_navigated", state: "running", stage: "collecting_followers", started_at: takenAt, finished_at: null,
        instagram_account: "alice", followers_count: null, following_count: null, duration_ms: null, error: null
      }
    };
    f.onUpdated(10, { status: "complete" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.values["instatrack.run.v1.regular"].last_sync.state, "interrupted");
    assert.equal(f.values[STORAGE_KEYS.report].instagram_account, "alice");
  } finally { f.restore(); }
});
