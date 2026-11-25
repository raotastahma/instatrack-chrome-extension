import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { commitCompletedSync, createLocalOperationHandlers } from "../src/background/local-operations.js";
import { createStorageAdapter } from "../src/background/storage-adapter.js";
import { createSyncOperations, selectInstagramTab } from "../src/background/sync-operations.js";
import { createTelemetry } from "../src/background/telemetry.js";
import { STORAGE_KEYS, STORAGE_KEY_NAMES } from "../src/shared/constants.js";

const extensionRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const contentSource = readFileSync(resolve(extensionRoot, "src/content/instagram.js"), "utf8");
const CONTENT_PROTOCOL_VERSION = 2;
const t1 = { iso: "2026-08-08T14:45:13Z", epoch: 1786200313 };
const t2 = { iso: "2026-08-08T14:46:13Z", epoch: 1786200373 };

test("a failed terminal write cannot consume telemetry for a later successful collector retry", async () => {
  const events = [];
  const telemetry = createTelemetry({ storage: new MemoryStorage(), fetcher: async (_url, request) => {
    events.push(JSON.parse(request.body).event);
    return { ok: true };
  } });
  await telemetry.setConsent(true);
  await telemetry.prepareRun("retry_run", await telemetry.eligibility());
  let state = { history: null, report: null, lastSync: {
    run_id: "retry_run", state: "running", stage: "collecting_followers", started_at: t1, finished_at: null,
    instagram_account: "owner", followers_count: null, following_count: null, duration_ms: null, error: null
  } };
  let writes = 0;
  const adapter = { account: "owner", read: async () => structuredClone(state),
    async writeLastSync(lastSync) {
      if (++writes <= 2) throw new Error("account write unavailable");
      state.lastSync = structuredClone(lastSync);
    },
    async writeState(next) { state = structuredClone(next); }
  };
  const operations = createSyncOperations({ adapter, tabs: { query: async () => [instagramTab(22, 90)] },
    sendMessage: async () => inspection("retry_run", "req_retry", "terminal_pending", "collecting_followers"),
    now: clock(t2), observeSync: telemetry.observe
  });
  const message = terminal("retry_run", "req_retry", collected("retry_run"));
  assert.equal((await operations.handleTerminal(message, sender(22))).accepted, false);
  await telemetry.flush();
  assert.equal(state.lastSync.state, "running");
  assert.deepEqual(events.map((event) => event.params.status), ["preflight"]);
  assert.equal((await operations.handleTerminal(message, sender(22))).accepted, true);
  await telemetry.flush();
  assert.equal(state.lastSync.state, "completed");
  assert.equal(state.report.instagram_account, "owner");
  assert.deepEqual(events.map((event) => event.params.status), ["preflight", "processing", "completed"]);
});

function clone(value) {
  return structuredClone(value);
}

class MemoryStorage {
  constructor(values = {}) {
    this.values = clone(values);
    this.getCalls = [];
    this.removeCalls = [];
    this.setCalls = [];
    this.failNextSet = false;
    this.failSetCount = 0;
  }

  async get(keys) {
    keys ??= Object.keys(this.values);
    this.getCalls.push([...keys]);
    return Object.fromEntries(keys.filter((key) => Object.hasOwn(this.values, key)).map((key) => [key, clone(this.values[key])]));
  }

  async set(values) {
    if (this.failNextSet || this.failSetCount > 0) {
      this.failNextSet = false;
      this.failSetCount = Math.max(0, this.failSetCount - 1);
      throw new Error("storage unavailable");
    }
    this.setCalls.push(clone(values));
    Object.assign(this.values, clone(values));
  }

  async remove(keys) {
    this.removeCalls.push([...keys]);
    for (const key of keys) {
      delete this.values[key];
    }
  }
}

function start(requestId = "req_start") {
  return { type: "sync.start", request_id: requestId, requested_at: t1 };
}

function stop(runId = "sync_fixture", requestId = "req_stop") {
  return { type: "sync.stop", request_id: requestId, run_id: runId };
}

function collected(runId, account = "owner", followers = ["alice", "alice", "bob"], following = ["bob", "carol"]) {
  return {
    type: "instagram.collectRelationships.result",
    run_id: runId,
    state: "completed",
    instagram_account: account,
    followers,
    following,
    error: null
  };
}

function collectionFailure(runId, state = "failed", code = "COLLECTION_FAILED", message = "Collector fixture failed.") {
  return {
    type: "instagram.collectRelationships.result",
    run_id: runId,
    state,
    instagram_account: null,
    followers: null,
    following: null,
    error: { code, message }
  };
}

function clock(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function baseline(adapter, account = "owner") {
  return commitCompletedSync(adapter, {
    run_id: "sync_baseline",
    started_at: t1,
    finished_at: t1,
    instagram_account: account,
    followers: ["alice"],
    following: ["bob"],
    duration_ms: 0
  });
}

function instagramTab(id = 7, lastAccessed = 1) {
  return { id, active: true, lastAccessed, url: "https://www.instagram.com/" };
}

function collectorAccepted(runId, state = "started") {
  return { type: "instagram.collectRelationships.accepted", run_id: runId, state, protocol_version: CONTENT_PROTOCOL_VERSION };
}

function collectorStopped(runId, stopped = true) {
  return { type: "instagram.collectRelationships.stop.result", run_id: runId, stopped, protocol_version: CONTENT_PROTOCOL_VERSION };
}

function terminal(runId, requestId = "req_start", result = collected(runId)) {
  return { type: "instagram.collectionTerminal", run_id: runId, request_id: requestId, result };
}

function sender(tabId = 7) {
  return { tab: instagramTab(tabId) };
}

function inspection(runId, requestId, state = "terminal_pending", stage = "collecting_followers") {
  return {
    type: "instagram.collectRelationships.inspect.result",
    state,
    run_id: runId,
    request_id: requestId,
    started_at: t1,
    stage,
    protocol_version: CONTENT_PROTOCOL_VERSION
  };
}

function idleInspection() {
  return {
    type: "instagram.collectRelationships.inspect.result",
    state: "idle",
    run_id: null,
    request_id: null,
    started_at: null,
    stage: null,
    protocol_version: CONTENT_PROTOCOL_VERSION
  };
}

test("sync selects the deterministic most-recent matching tab", () => {
  const tabs = [
    { id: 1, active: true, lastAccessed: 9, url: "file:local" },
    instagramTab(2, 4),
    { id: 3, active: false, lastAccessed: 8, url: "https://www.instagram.com/explore/" }
  ];
  assert.equal(selectInstagramTab(tabs).id, 3);
  assert.equal(selectInstagramTab([{ id: 4, active: true, url: "file:local" }]), null);
});

test("the service worker starts account-scoped sync in an existing tab without opening any tabs", async () => {
  const storage = new MemoryStorage();
  const messaged = [];
  let listener;
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    action: { onClicked: { addListener() {} } },
    storage: { local: storage },
    runtime: { onMessage: { addListener(callback) { listener = callback; } } },
    tabs: {
      query: async (query) => query.active ? [] : [{ ...instagramTab(91, 100), windowId: 42 }],
      create: async () => assert.fail("Sync must not create Instagram tabs"),
      sendMessage: async (tabId, message) => {
        if (message.type === "instagram.session.get") {
          assert.equal(tabId, 91);
          return { type: "instagram.session", request_id: message.request_id, protocol_version: 2, state: "authenticated", instagram_account: "owner" };
        }
        messaged.push({ tabId, message });
        return collectorAccepted(message.run_id);
      }
    },
  };
  try {
    await import("../src/background/service-worker.js");
    const response = await new Promise((resolve) => listener(start(), { tab: { id: 2, windowId: 42 } }, resolve));
    assert.equal(response.type, "sync.accepted");
    assert.equal(messaged.length, 1);
    assert.equal(messaged[0].tabId, 91);
    assert.equal(messaged[0].message.type, "instagram.collectRelationships.start");
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("sync accepts immediately, prefers focused Instagram, and notifies the dashboard on completion", async () => {
  const storage = new MemoryStorage();
  const calls = [];
  const notifications = [];
  let dashboardActivations = 0;
  const operations = createSyncOperations({
    adapter: createStorageAdapter(storage),
    tabs: { query: async (query) => {
      calls.push(query);
      return query.active ? [instagramTab(22, 90)] : [instagramTab(11, 10), instagramTab(22, 90)];
    } },
    sendMessage: async (tabId, message) => {
      assert.equal(tabId, 22);
      return message.type === "instagram.collectRelationships.start"
        ? collectorAccepted(message.run_id)
        : inspection("sync_fixture", "req_start", "terminal_pending", "preflight");
    },
    broadcast: async (message) => notifications.push(message),
    activateDashboard: async () => { dashboardActivations += 1; },
    now: clock(t1, t2),
    createRunId: () => "sync_fixture"
  });

  const accepted = await operations.start(start());
  assert.deepEqual(accepted, {
    type: "sync.accepted", request_id: "req_start", state: "running", run_id: "sync_fixture", started_at: t1, stage: "preflight", recovered: false
  });
  assert.deepEqual(calls, [{ active: true, lastFocusedWindow: true }]);

  const ack = await operations.handleTerminal(terminal("sync_fixture"), sender(22));
  assert.deepEqual(ack, { type: "instagram.collectionTerminal.ack", run_id: "sync_fixture", accepted: true });
  assert.equal(storage.values[STORAGE_KEYS.history].sync_points.length, 1);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "sync.result");
  assert.equal(notifications[0].state, "completed");
  assert.equal(notifications[0].request_id, "req_start");
  assert.equal(dashboardActivations, 1);
});

test("sync rejects a legacy content script without the protocol handshake", async () => {
  const storage = new MemoryStorage();
  const messages = [];
  const operations = createSyncOperations({
    adapter: createStorageAdapter(storage),
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async (_tabId, message) => {
      messages.push(message);
      return { type: "instagram.collectRelationships.accepted", run_id: message.run_id, state: "started" };
    },
    now: clock(t1, t2),
    createRunId: () => "sync_fixture"
  });

  const response = await operations.start(start());
  assert.equal(messages[0].protocol_version, CONTENT_PROTOCOL_VERSION);
  assert.equal(response.type, "sync.result");
  assert.equal(response.state, "interrupted");
  assert.deepEqual(response.error, {
    code: "COLLECTION_INTERRUPTED",
    message: "Reload the Instagram tab and retry."
  });
});

test("sync falls back to deterministic MRU and rejects stale or wrong-tab progress", async () => {
  const storage = new MemoryStorage();
  const calls = [];
  const operations = createSyncOperations({
    adapter: createStorageAdapter(storage),
    tabs: { query: async (query) => {
      calls.push(query);
      return query.active ? [{ id: 1, active: true, lastAccessed: 99, url: "file:local" }] : [instagramTab(11, 10), instagramTab(22, 90)];
    } },
    sendMessage: async (tabId, message) => {
      assert.equal(tabId, 22);
      return message.type === "instagram.collectRelationships.start"
        ? collectorAccepted(message.run_id)
        : inspection("sync_fixture", "req_start", "running", message.stage);
    },
    now: clock(t1, t2),
    createRunId: () => "sync_fixture"
  });

  await operations.start(start());
  assert.deepEqual(calls, [{ active: true, lastFocusedWindow: true }, {}]);
  assert.equal(await operations.handleProgress({ type: "instagram.collectionProgress", run_id: "sync_old", stage: "collecting_followers" }, sender(22)), false);
  assert.equal(await operations.handleProgress({ type: "instagram.collectionProgress", run_id: "sync_fixture", stage: "collecting_followers" }, sender(8)), false);
  assert.equal(await operations.handleProgress({ type: "instagram.collectionProgress", run_id: "sync_fixture", stage: "collecting_followers" }, sender(22)), true);
  assert.equal(storage.values[STORAGE_KEYS.lastSync].stage, "collecting_followers");
});

test("sync stop quiesces the matching collector, persists one local interruption, and rejects late work", async () => {
  const storage = new MemoryStorage();
  const adapter = createStorageAdapter(storage);
  await baseline(adapter);
  const preservedHistory = clone(storage.values[STORAGE_KEYS.history]);
  const preservedReport = clone(storage.values[STORAGE_KEYS.report]);
  const messages = [];
  const notifications = [];
  const operations = createSyncOperations({
    adapter,
    tabs: { query: async (query) => query.active ? [instagramTab()] : [instagramTab()] },
    sendMessage: async (_tabId, message) => {
      messages.push(message);
      if (message.type === "instagram.collectRelationships.start") {
        return collectorAccepted(message.run_id);
      }
      if (message.type === "instagram.collectRelationships.inspect") {
        return inspection("sync_fixture", "req_start", "running", "preflight");
      }
      if (message.type === "instagram.collectRelationships.stop") {
        assert.deepEqual(message, { type: "instagram.collectRelationships.stop", run_id: "sync_fixture", protocol_version: CONTENT_PROTOCOL_VERSION });
        return collectorStopped("sync_fixture");
      }
      throw new Error(`unexpected message ${message.type}`);
    },
    broadcast: async (message) => notifications.push(message),
    now: clock(t1, t2),
    createRunId: () => "sync_fixture"
  });

  await operations.start(start());
  const response = await operations.stop(stop());
  assert.deepEqual(Object.keys(response), ["type", "request_id", "run_id", "stopped", "last_sync", "error"]);
  assert.equal(response.type, "sync.stop.result");
  assert.equal(response.request_id, "req_stop");
  assert.equal(response.run_id, "sync_fixture");
  assert.equal(response.stopped, true);
  assert.equal(response.last_sync.state, "interrupted");
  assert.equal(response.last_sync.error.code, "COLLECTION_INTERRUPTED");
  assert.equal(response.last_sync.error.message, "Sync stopped by you.");
  assert.equal(response.error, null);
  assert.deepEqual(storage.values[STORAGE_KEYS.history], preservedHistory);
  assert.deepEqual(storage.values[STORAGE_KEYS.report], preservedReport);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "sync.result");
  assert.equal(notifications[0].request_id, "req_stop");
  assert.equal(notifications[0].state, "interrupted");

  const stoppedLastSync = clone(storage.values[STORAGE_KEYS.lastSync]);
  assert.equal(await operations.handleProgress(
    { type: "instagram.collectionProgress", run_id: "sync_fixture", stage: "collecting_followers" },
    sender()
  ), false);
  assert.equal((await operations.handleTerminal(terminal("sync_fixture"), sender())).accepted, true);
  assert.deepEqual(storage.values[STORAGE_KEYS.lastSync], stoppedLastSync);
  assert.deepEqual(storage.values[STORAGE_KEYS.history], preservedHistory);
  assert.deepEqual(storage.values[STORAGE_KEYS.report], preservedReport);
  assert.equal(messages.some((message) => message.type === "instagram.collectRelationships.stop"), true);
});

test("sync stop preserves running state when collector stop cannot be confirmed", async () => {
  const running = {
    run_id: "sync_fixture", state: "running", stage: "collecting_followers", started_at: t1, finished_at: null,
    instagram_account: null, followers_count: null, following_count: null, duration_ms: null, error: null
  };
  const stopOutcomes = [
    { label: "negative acknowledgement", value: collectorStopped("sync_fixture", false) },
    { label: "malformed acknowledgement", value: { stopped: true } },
    { label: "thrown stop", value: new Error("receiver disappeared") }
  ];

  for (const outcome of stopOutcomes) {
    const storage = new MemoryStorage({ [STORAGE_KEYS.lastSync]: running });
    const operations = createSyncOperations({
      adapter: createStorageAdapter(storage),
      tabs: { query: async () => [instagramTab()] },
      sendMessage: async (_tabId, message) => {
        if (message.type === "instagram.collectRelationships.inspect") {
          return inspection("sync_fixture", "req_start", "running", "collecting_followers");
        }
        if (outcome.value instanceof Error) {
          throw outcome.value;
        }
        return outcome.value;
      },
      now: clock(t2)
    });

    const response = await operations.stop(stop());
    assert.deepEqual(Object.keys(response), ["type", "request_id", "run_id", "stopped", "last_sync", "error"], outcome.label);
    assert.equal(response.stopped, false, outcome.label);
    assert.deepEqual(response.last_sync, running, outcome.label);
    assert.deepEqual(response.error, {
      code: "COLLECTION_INTERRUPTED",
      message: "Reload the Instagram tab and retry."
    }, outcome.label);
    assert.deepEqual(storage.values[STORAGE_KEYS.lastSync], running, outcome.label);
    assert.deepEqual(storage.setCalls, [], outcome.label);
  }
});

test("sync stop preserves running state when collector inspection is unavailable", async () => {
  const running = {
    run_id: "sync_fixture", state: "running", stage: "collecting_followers", started_at: t1, finished_at: null,
    instagram_account: null, followers_count: null, following_count: null, duration_ms: null, error: null
  };
  const storage = new MemoryStorage({ [STORAGE_KEYS.lastSync]: running });
  const operations = createSyncOperations({
    adapter: createStorageAdapter(storage),
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async () => { throw new Error("no receiver"); },
    now: clock(t2)
  });

  const response = await operations.stop(stop());
  assert.equal(response.stopped, false);
  assert.deepEqual(response.last_sync, running);
  assert.deepEqual(response.error, {
    code: "COLLECTION_INTERRUPTED",
    message: "Reload the Instagram tab and retry."
  });
  assert.deepEqual(storage.values[STORAGE_KEYS.lastSync], running);
  assert.deepEqual(storage.setCalls, []);
});

test("sync stop rejects a different live collector instead of treating it as an idle target", async () => {
  const running = {
    run_id: "sync_expected", state: "running", stage: "collecting_followers", started_at: t1, finished_at: null,
    instagram_account: null, followers_count: null, following_count: null, duration_ms: null, error: null
  };
  const storage = new MemoryStorage({ [STORAGE_KEYS.lastSync]: running });
  let stopCalls = 0;
  const operations = createSyncOperations({
    adapter: createStorageAdapter(storage),
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async (_tabId, message) => {
      if (message.type === "instagram.collectRelationships.inspect") {
        return inspection("sync_other", "req_other", "running", "collecting_followers");
      }
      stopCalls += 1;
      return collectorStopped("sync_other");
    },
    now: clock(t2)
  });

  const response = await operations.stop(stop("sync_expected"));
  assert.equal(response.stopped, false);
  assert.deepEqual(response.last_sync, running);
  assert.deepEqual(response.error, {
    code: "COLLECTION_INTERRUPTED",
    message: "Reload the Instagram tab and retry."
  });
  assert.equal(stopCalls, 0);
  assert.deepEqual(storage.values[STORAGE_KEYS.lastSync], running);
  assert.deepEqual(storage.setCalls, []);
});

test("stop wins its serialized race with delayed progress and terminal delivery", async () => {
  const storage = new MemoryStorage({
    [STORAGE_KEYS.lastSync]: {
      run_id: "sync_fixture", state: "running", stage: "collecting_followers", started_at: t1, finished_at: null,
      instagram_account: null, followers_count: null, following_count: null, duration_ms: null, error: null
    }
  });
  const stopAck = deferred();
  const notifications = [];
  const operations = createSyncOperations({
    adapter: createStorageAdapter(storage),
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async (_tabId, message) => {
      if (message.type === "instagram.collectRelationships.inspect") {
        return inspection("sync_fixture", "req_start", "running", "collecting_followers");
      }
      if (message.type === "instagram.collectRelationships.stop") {
        return stopAck.promise;
      }
      throw new Error(`unexpected message ${message.type}`);
    },
    broadcast: async (message) => notifications.push(message),
    now: clock(t2)
  });

  const stopping = operations.stop(stop());
  await new Promise((resolve) => setImmediate(resolve));
  const lateProgress = operations.handleProgress(
    { type: "instagram.collectionProgress", run_id: "sync_fixture", stage: "collecting_followers" },
    sender()
  );
  const lateTerminal = operations.handleTerminal(terminal("sync_fixture"), sender());
  stopAck.resolve(collectorStopped("sync_fixture"));

  assert.equal((await stopping).stopped, true);
  assert.equal(await lateProgress, false);
  assert.equal((await lateTerminal).accepted, true);
  assert.equal(storage.values[STORAGE_KEYS.lastSync].state, "interrupted");
  assert.equal(storage.values[STORAGE_KEYS.history], undefined);
  assert.equal(notifications.length, 1);
});

test("stale and repeated stop requests never stop or rewrite a different run", async () => {
  const running = {
    run_id: "sync_new", state: "running", stage: "collecting_following", started_at: t1, finished_at: null,
    instagram_account: null, followers_count: null, following_count: null, duration_ms: null, error: null
  };
  const storage = new MemoryStorage({ [STORAGE_KEYS.lastSync]: running });
  let tabQueries = 0;
  const operations = createSyncOperations({
    adapter: createStorageAdapter(storage),
    tabs: { query: async () => { tabQueries += 1; return []; } },
    sendMessage: async () => { throw new Error("no message expected"); },
    now: clock(t2)
  });

  const stale = await operations.stop(stop("sync_old"));
  assert.equal(stale.stopped, false);
  assert.equal(stale.last_sync.run_id, "sync_new");
  assert.equal(tabQueries, 0);
  assert.deepEqual(storage.values[STORAGE_KEYS.lastSync], running);

  const first = await operations.stop(stop("sync_new", "req_first"));
  const stored = clone(storage.values[STORAGE_KEYS.lastSync]);
  const repeated = await operations.stop(stop("sync_new", "req_second"));
  assert.equal(first.stopped, true);
  assert.equal(repeated.stopped, true);
  assert.deepEqual(repeated.last_sync, stored);
  assert.deepEqual(storage.values[STORAGE_KEYS.lastSync], stored);
});

test("unconfirmed reset has zero collector or storage side effects", async () => {
  const storage = new MemoryStorage();
  const adapter = createStorageAdapter(storage);
  const handlers = createLocalOperationHandlers({ adapter, now: () => t2 });
  let tabQueries = 0;
  const operations = createSyncOperations({
    adapter,
    tabs: { query: async () => { tabQueries += 1; return [instagramTab()]; } },
    sendMessage: async () => { throw new Error("unconfirmed reset must not inspect content"); }
  });

  const response = await operations.reset(
    { type: "history.reset", request_id: "req_reset", confirm: false },
    (message) => handlers.handle(message)
  );
  assert.equal(response.reset, false);
  assert.equal(tabQueries, 0);
  assert.deepEqual(storage.getCalls, []);
  assert.deepEqual(storage.setCalls, []);
  assert.deepEqual(storage.removeCalls, []);
});

test("confirmed reset quiesces an orphan collector even when local storage is empty", async () => {
  const storage = new MemoryStorage();
  const adapter = createStorageAdapter(storage);
  const handlers = createLocalOperationHandlers({ adapter, now: () => t2 });
  const messages = [];
  const operations = createSyncOperations({
    adapter,
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async (_tabId, message) => {
      messages.push(message);
      if (message.type === "instagram.collectRelationships.inspect") {
        return inspection("sync_orphan", "req_orphan", "running", "collecting_followers");
      }
      return collectorStopped("sync_orphan");
    }
  });

  const response = await operations.reset(
    { type: "history.reset", request_id: "req_reset", confirm: true },
    (message) => handlers.handle(message)
  );
  assert.equal(response.reset, true);
  assert.deepEqual(messages.map((message) => message.type), [
    "instagram.collectRelationships.inspect",
    "instagram.collectRelationships.stop"
  ]);
  assert.deepEqual(messages[1], { type: "instagram.collectRelationships.stop", run_id: "sync_orphan", protocol_version: CONTENT_PROTOCOL_VERSION });
  assert.deepEqual(storage.removeCalls, [STORAGE_KEY_NAMES]);
  assert.deepEqual(storage.values, {});
});

test("confirmed reset refuses deletion when collector quiescence is unknown or rejected", async () => {
  for (const outcome of ["inspect throws", "stop rejected"]) {
    const storage = new MemoryStorage({
      [STORAGE_KEYS.lastSync]: {
        run_id: "sync_fixture", state: "running", stage: "collecting_followers", started_at: t1, finished_at: null,
        instagram_account: null, followers_count: null, following_count: null, duration_ms: null, error: null
      }
    });
    const adapter = createStorageAdapter(storage);
    const handlers = createLocalOperationHandlers({ adapter, now: () => t2 });
    const operations = createSyncOperations({
      adapter,
      tabs: { query: async () => [instagramTab()] },
      sendMessage: async (_tabId, message) => {
        if (message.type === "instagram.collectRelationships.inspect") {
          if (outcome === "inspect throws") {
            throw new Error("no receiver");
          }
          return inspection("sync_fixture", "req_start", "running", "collecting_followers");
        }
        return collectorStopped("sync_fixture", false);
      }
    });

    const before = clone(storage.values);
    const response = await operations.reset(
      { type: "history.reset", request_id: "req_reset", confirm: true },
      (message) => handlers.handle(message)
    );
    assert.deepEqual(response, {
      type: "history.reset.result",
      request_id: "req_reset",
      reset: false,
      deleted_keys: [],
      error: { code: "COLLECTION_INTERRUPTED", message: "Reload the Instagram tab and retry." }
    }, outcome);
    assert.deepEqual(storage.values, before, outcome);
    assert.deepEqual(storage.removeCalls, [], outcome);
  }
});

test("confirmed reset stays empty when delayed progress and terminal messages arrive during quiescence", async () => {
  const storage = new MemoryStorage();
  const adapter = createStorageAdapter(storage);
  await baseline(adapter);
  storage.values[STORAGE_KEYS.lastSync] = {
    run_id: "sync_fixture", state: "running", stage: "collecting_followers", started_at: t1, finished_at: null,
    instagram_account: null, followers_count: null, following_count: null, duration_ms: null, error: null
  };
  const handlers = createLocalOperationHandlers({ adapter, now: () => t2 });
  const stopAck = deferred();
  let quiesced = false;
  const operations = createSyncOperations({
    adapter,
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async (_tabId, message) => {
      if (message.type === "instagram.collectRelationships.inspect") {
        return quiesced
          ? idleInspection()
          : inspection("sync_fixture", "req_start", "terminal_pending", "collecting_followers");
      }
      if (message.type === "instagram.collectRelationships.stop") {
        return stopAck.promise;
      }
      throw new Error(`unexpected message ${message.type}`);
    }
  });

  const resetting = operations.reset(
    { type: "history.reset", request_id: "req_reset", confirm: true },
    (message) => handlers.handle(message)
  );
  await new Promise((resolve) => setImmediate(resolve));
  const lateProgress = operations.handleProgress(
    { type: "instagram.collectionProgress", run_id: "sync_fixture", stage: "collecting_followers" },
    sender()
  );
  const lateTerminal = operations.handleTerminal(terminal("sync_fixture"), sender());
  quiesced = true;
  stopAck.resolve(collectorStopped("sync_fixture"));

  assert.equal((await resetting).reset, true);
  assert.equal(await lateProgress, false);
  assert.equal((await lateTerminal).accepted, false);
  assert.deepEqual(storage.values, {});
  assert.deepEqual(storage.removeCalls, [STORAGE_KEY_NAMES]);
});

test("confirmed reset is the final state when an earlier terminal commits first", async () => {
  const storage = new MemoryStorage();
  const adapter = createStorageAdapter(storage);
  await baseline(adapter);
  storage.values[STORAGE_KEYS.lastSync] = {
    run_id: "sync_fixture", state: "running", stage: "collecting_following", started_at: t1, finished_at: null,
    instagram_account: null, followers_count: null, following_count: null, duration_ms: null, error: null
  };
  const handlers = createLocalOperationHandlers({ adapter, now: () => t2 });
  const terminalInspection = deferred();
  let inspections = 0;
  const operations = createSyncOperations({
    adapter,
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async (_tabId, message) => {
      if (message.type !== "instagram.collectRelationships.inspect") {
        throw new Error(`unexpected message ${message.type}`);
      }
      inspections += 1;
      if (inspections === 1) {
        return terminalInspection.promise;
      }
      return idleInspection();
    },
    now: clock(t2)
  });

  const terminalFirst = operations.handleTerminal(terminal("sync_fixture"), sender());
  await new Promise((resolve) => setImmediate(resolve));
  const resetting = operations.reset(
    { type: "history.reset", request_id: "req_reset", confirm: true },
    (message) => handlers.handle(message)
  );
  terminalInspection.resolve(inspection("sync_fixture", "req_start", "terminal_pending", "collecting_following"));

  assert.equal((await terminalFirst).accepted, true);
  assert.equal((await resetting).reset, true);
  assert.deepEqual(storage.values, {});
  assert.deepEqual(storage.removeCalls, [STORAGE_KEY_NAMES]);
});

test("a delayed confirmed import completes before a queued reset, leaving storage empty", async () => {
  const sourceStorage = new MemoryStorage();
  const sourceAdapter = createStorageAdapter(sourceStorage);
  await baseline(sourceAdapter);
  const sourceHandlers = createLocalOperationHandlers({ adapter: sourceAdapter, now: () => t2 });
  const backup = await sourceHandlers.handle({ type: "backup.export", request_id: "req_export" });
  assert.equal(backup.error, null);

  const storage = new MemoryStorage();
  const originalSet = storage.set.bind(storage);
  const importWriteStarted = deferred();
  const releaseImportWrite = deferred();
  let delayed = false;
  storage.set = async (values) => {
    if (!delayed && Object.keys(values).length === 3) {
      delayed = true;
      importWriteStarted.resolve();
      await releaseImportWrite.promise;
    }
    return originalSet(values);
  };
  const adapter = createStorageAdapter(storage);
  const handlers = createLocalOperationHandlers({ adapter, now: () => t2 });
  const operations = createSyncOperations({
    adapter,
    tabs: { query: async () => [] },
    sendMessage: async () => { throw new Error("no collector fixture"); }
  });
  const importMessage = {
    type: "backup.import",
    request_id: "req_import",
    confirm: true,
    body: backup.body
  };

  const importing = operations.local(importMessage, (message) => handlers.handle(message));
  await importWriteStarted.promise;
  let resetSettled = false;
  const resetting = operations.reset(
    { type: "history.reset", request_id: "req_reset", confirm: true },
    (message) => handlers.handle(message)
  ).then((response) => {
    resetSettled = true;
    return response;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resetSettled, false, "reset waits behind the in-flight import write");

  releaseImportWrite.resolve();
  assert.equal((await importing).imported, true);
  assert.equal((await resetting).reset, true);
  assert.deepEqual(storage.values, {});
  assert.deepEqual(storage.removeCalls, [STORAGE_KEY_NAMES]);
});

test("unconfirmed import also waits inside the shared local-operation queue", async () => {
  const storage = new MemoryStorage();
  const adapter = createStorageAdapter(storage);
  const handlers = createLocalOperationHandlers({ adapter, now: () => t2 });
  const release = deferred();
  const operations = createSyncOperations({
    adapter,
    tabs: { query: async () => [] },
    sendMessage: async () => { throw new Error("no collector fixture"); }
  });
  const blocker = operations.local({ type: "queue.block" }, async () => {
    await release.promise;
    return { done: true };
  });
  let importSettled = false;
  const importing = operations.local(
    { type: "backup.import", request_id: "req_unconfirmed", confirm: false, body: "" },
    (message) => handlers.handle(message)
  ).then((response) => {
    importSettled = true;
    return response;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(importSettled, false);
  release.resolve();
  await blocker;
  const response = await importing;
  assert.equal(response.imported, false);
  assert.equal(response.error.code, "IMPORT_NOT_CONFIRMED");
  assert.deepEqual(storage.setCalls, []);
  assert.deepEqual(storage.removeCalls, []);
});

test("restart while running recovers the collector without a second start", async () => {
  const storage = new MemoryStorage();
  const adapter = createStorageAdapter(storage);
  let starts = 0;
  const first = createSyncOperations({
    adapter,
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async (_tabId, message) => {
      if (message.type === "instagram.collectRelationships.start") {
        starts += 1;
        return collectorAccepted(message.run_id);
      }
      throw new Error("unexpected inspect before restart");
    },
    now: clock(t1, t2),
    createRunId: () => "sync_fixture"
  });
  assert.equal((await first.start(start())).state, "running");

  const restarted = createSyncOperations({
    adapter,
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async (_tabId, message) => {
      assert.equal(message.type, "instagram.collectRelationships.inspect");
      return inspection("sync_fixture", "req_start", "running", "collecting_followers");
    },
    now: clock(t2),
    createRunId: () => "second_run"
  });
  const recovered = await restarted.start(start("req_after_restart"));
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.run_id, "sync_fixture");
  assert.equal(starts, 1);
});

test("restart re-dispatches only the same preflight run when no collector is live", async () => {
  const storage = new MemoryStorage({
    [STORAGE_KEYS.lastSync]: {
      run_id: "sync_fixture", state: "running", stage: "preflight", started_at: t1, finished_at: null,
      instagram_account: null, followers_count: null, following_count: null, duration_ms: null, error: null
    }
  });
  const dispatched = [];
  const operations = createSyncOperations({
    adapter: createStorageAdapter(storage),
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async (_tabId, message) => {
      dispatched.push(message);
      return message.type === "instagram.collectRelationships.inspect"
        ? idleInspection()
        : collectorAccepted(message.run_id);
    },
    now: clock(t2)
  });
  const recovered = await operations.start(start("req_after_restart"));
  assert.equal(recovered.run_id, "sync_fixture");
  assert.equal(recovered.recovered, true);
  assert.deepEqual(dispatched.map((message) => message.type), ["instagram.collectRelationships.inspect", "instagram.collectRelationships.start"]);
  assert.equal(dispatched[1].run_id, "sync_fixture");
});

test("duplicate terminal delivery is acknowledged idempotently and commits one sync point", async () => {
  const storage = new MemoryStorage();
  const notifications = [];
  const operations = createSyncOperations({
    adapter: createStorageAdapter(storage),
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async (_tabId, message) => message.type === "instagram.collectRelationships.start"
      ? collectorAccepted(message.run_id)
      : inspection("sync_fixture", "req_start", "terminal_pending", "preflight"),
    broadcast: async (message) => notifications.push(message),
    now: clock(t1, t2),
    createRunId: () => "sync_fixture"
  });
  await operations.start(start());
  const message = terminal("sync_fixture");
  assert.equal((await operations.handleTerminal(message, sender())).accepted, true);
  assert.equal((await operations.handleTerminal(message, sender())).accepted, true);
  assert.equal(storage.values[STORAGE_KEYS.history].sync_points.length, 1);
  assert.equal(notifications.length, 2);
  assert.equal(notifications.every((notice) => notice.type === "sync.result" && notice.state === "completed"), true);
});

test("retained terminal replay enriches a legacy report with I Followed without another sync point", async () => {
  const storage = new MemoryStorage();
  const adapter = createStorageAdapter(storage);
  await baseline(adapter);
  await commitCompletedSync(adapter, {
    run_id: "sync_replay",
    started_at: t1,
    finished_at: t2,
    instagram_account: "owner",
    followers: ["alice"],
    following: ["bob", "erin"],
    duration_ms: 60_000
  });
  delete storage.values[STORAGE_KEYS.report].i_followed;
  const pointCount = storage.values[STORAGE_KEYS.history].sync_points.length;
  const notifications = [];
  const operations = createSyncOperations({
    adapter,
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async () => inspection("sync_replay", "req_replay", "terminal_pending", "stored"),
    broadcast: async (message) => notifications.push(message)
  });

  const ack = await operations.handleTerminal(terminal("sync_replay", "req_replay", collected("sync_replay")), sender());

  assert.equal(ack.accepted, true);
  assert.equal(storage.values[STORAGE_KEYS.history].sync_points.length, pointCount);
  assert.deepEqual(notifications.at(-1).report.i_followed, [{ username: "erin", detected_at: t2 }]);
  assert.equal(Object.hasOwn(notifications.at(-1).report.counts, "F"), false);
});

test("terminal requires matching wrapper/result runs and a live content-script request identity", async () => {
  const storage = new MemoryStorage();
  const notifications = [];
  const operations = createSyncOperations({
    adapter: createStorageAdapter(storage),
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async (_tabId, message) => message.type === "instagram.collectRelationships.start"
      ? collectorAccepted(message.run_id)
      : inspection("sync_fixture", "req_start", "terminal_pending", "preflight"),
    broadcast: async (message) => notifications.push(message),
    now: clock(t1, t2),
    createRunId: () => "sync_fixture"
  });
  await operations.start(start());
  assert.equal((await operations.handleTerminal(terminal("sync_fixture", "req_forged"), sender())).accepted, false);
  assert.equal((await operations.handleTerminal(terminal("sync_fixture", "req_start", collected("other_run")), sender())).accepted, false);
  assert.equal(storage.values[STORAGE_KEYS.lastSync].state, "running");
  assert.equal(storage.values[STORAGE_KEYS.history], undefined);
  assert.deepEqual(notifications, []);
  assert.equal((await operations.handleTerminal(terminal("sync_fixture"), sender())).accepted, true);
});

test("malformed same-run terminal results are rejected before storage access", async () => {
  const storage = new MemoryStorage();
  const operations = createSyncOperations({
    adapter: createStorageAdapter(storage),
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async () => inspection("sync_fixture", "req_start", "terminal_pending", "preflight")
  });
  const malformed = { ...collected("sync_fixture"), followers: null };
  const ack = await operations.handleTerminal(terminal("sync_fixture", "req_start", malformed), sender());
  assert.deepEqual(ack, { type: "instagram.collectionTerminal.ack", run_id: "sync_fixture", accepted: false });
  assert.deepEqual(storage.getCalls, []);
  assert.deepEqual(storage.setCalls, []);
});

test("restarted worker accepts a terminal only from its matching terminal-pending content script", async () => {
  const storage = new MemoryStorage({
    [STORAGE_KEYS.lastSync]: {
      run_id: "sync_fixture", state: "running", stage: "collecting_followers", started_at: t1, finished_at: null,
      instagram_account: null, followers_count: null, following_count: null, duration_ms: null, error: null
    }
  });
  const operations = createSyncOperations({
    adapter: createStorageAdapter(storage),
    tabs: { query: async () => [instagramTab(7), instagramTab(8)] },
    sendMessage: async (tabId) => tabId === 7
      ? inspection("sync_fixture", "req_start")
      : idleInspection(),
    now: clock(t2)
  });
  const message = terminal("sync_fixture");
  assert.equal((await operations.handleTerminal(message, sender(8))).accepted, false);
  assert.equal(storage.values[STORAGE_KEYS.lastSync].state, "running");
  assert.equal((await operations.handleTerminal(message, sender(7))).accepted, true);
  assert.equal(storage.values[STORAGE_KEYS.history].sync_points.length, 1);
});

test("old completed terminal acknowledgements do not broadcast a newer run's report", async () => {
  const storage = new MemoryStorage();
  const adapter = createStorageAdapter(storage);
  await commitCompletedSync(adapter, {
    run_id: "sync_old", started_at: t1, finished_at: t1, instagram_account: "owner", followers: ["alice"], following: ["bob"], duration_ms: 0
  });
  await commitCompletedSync(adapter, {
    run_id: "sync_new", started_at: t2, finished_at: t2, instagram_account: "owner", followers: ["alice", "carol"], following: ["bob"], duration_ms: 0
  });
  const notifications = [];
  const operations = createSyncOperations({
    adapter,
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async () => inspection("sync_old", "req_old", "terminal_pending", "stored"),
    broadcast: async (message) => notifications.push(message),
    now: clock(t2)
  });
  assert.equal((await operations.handleTerminal(terminal("sync_old", "req_old", collected("sync_old")), sender())).accepted, true);
  assert.deepEqual(notifications, []);
  assert.equal(storage.values[STORAGE_KEYS.lastSync].run_id, "sync_new");
});

test("authenticated terminal retries for superseded or reset runs are acknowledged quietly", async () => {
  for (const latest of [
    {
      run_id: "sync_new", state: "running", stage: "collecting_followers", started_at: t2, finished_at: null,
      instagram_account: null, followers_count: null, following_count: null, duration_ms: null, error: null
    },
    null
  ]) {
    const storage = new MemoryStorage(latest ? { [STORAGE_KEYS.lastSync]: latest } : {});
    const notifications = [];
    const operations = createSyncOperations({
      adapter: createStorageAdapter(storage),
      tabs: { query: async () => [instagramTab()] },
      sendMessage: async () => inspection("sync_old", "req_old", "terminal_pending", "collecting_following"),
      broadcast: async (message) => notifications.push(message)
    });
    const before = clone(storage.values);
    assert.equal((await operations.handleTerminal(terminal("sync_old", "req_old", collected("sync_old")), sender())).accepted, true);
    assert.deepEqual(storage.values, before);
    assert.deepEqual(notifications, []);
  }
});

test("progress stages cannot move backwards or skip the followers stage", async () => {
  const storage = new MemoryStorage({
    [STORAGE_KEYS.lastSync]: {
      run_id: "sync_fixture", state: "running", stage: "preflight", started_at: t1, finished_at: null,
      instagram_account: null, followers_count: null, following_count: null, duration_ms: null, error: null
    }
  });
  const operations = createSyncOperations({
    adapter: createStorageAdapter(storage),
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async () => inspection("sync_fixture", "req_start", "running", "collecting_following")
  });
  assert.equal(await operations.handleProgress({ type: "instagram.collectionProgress", run_id: "sync_fixture", stage: "collecting_following" }, sender()), false);
  assert.equal(storage.values[STORAGE_KEYS.lastSync].stage, "preflight");
});

test("progress survives restart only after inspection and durably blocks a later terminal after storage failure", async () => {
  const storage = new MemoryStorage({
    [STORAGE_KEYS.lastSync]: {
      run_id: "sync_fixture", state: "running", stage: "preflight", started_at: t1, finished_at: null,
      instagram_account: null, followers_count: null, following_count: null, duration_ms: null, error: null
    }
  });
  const adapter = createStorageAdapter(storage);
  const resumed = createSyncOperations({
    adapter,
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async () => inspection("sync_fixture", "req_start", "running", "collecting_followers"),
    now: clock(t2)
  });
  assert.equal(await resumed.handleProgress({ type: "instagram.collectionProgress", run_id: "sync_fixture", stage: "collecting_followers" }, sender()), true);
  assert.equal(storage.values[STORAGE_KEYS.lastSync].stage, "collecting_followers");

  const restarted = createSyncOperations({
    adapter,
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async () => inspection("sync_fixture", "req_start", "running", "collecting_following"),
    now: clock(t2)
  });
  storage.failNextSet = true;
  assert.equal(await restarted.handleProgress({ type: "instagram.collectionProgress", run_id: "sync_fixture", stage: "collecting_following" }, sender()), false);
  assert.equal(storage.values[STORAGE_KEYS.lastSync].state, "failed");

  const terminalAfterRestart = createSyncOperations({
    adapter,
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async () => inspection("sync_fixture", "req_start", "terminal_pending", "collecting_following"),
    now: clock(t2)
  });
  assert.equal((await terminalAfterRestart.handleTerminal(terminal("sync_fixture", "req_start", collected("sync_fixture", "owner", ["alice", "bob"], ["carol"])), sender())).accepted, true);
  assert.equal(storage.values[STORAGE_KEYS.history], undefined);
  assert.equal(storage.values[STORAGE_KEYS.lastSync].error.code, "STORAGE_ERROR");
  assert.equal(storage.values[STORAGE_KEYS.lastSync].instagram_account, "owner");
});

test("a storage terminal becomes durable after both progress writes failed", async () => {
  const storage = new MemoryStorage({
    [STORAGE_KEYS.lastSync]: {
      run_id: "sync_fixture", state: "running", stage: "preflight", started_at: t1, finished_at: null,
      instagram_account: null, followers_count: null, following_count: null, duration_ms: null, error: null
    }
  });
  const adapter = createStorageAdapter(storage);
  const progress = createSyncOperations({
    adapter,
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async () => inspection("sync_fixture", "req_start", "running", "collecting_followers"),
    now: clock(t2)
  });
  storage.failSetCount = 2;
  assert.equal(await progress.handleProgress({ type: "instagram.collectionProgress", run_id: "sync_fixture", stage: "collecting_followers" }, sender()), false);
  assert.equal(storage.values[STORAGE_KEYS.lastSync].state, "running");

  const recovered = createSyncOperations({
    adapter,
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async () => inspection("sync_fixture", "req_start", "terminal_pending", "collecting_followers"),
    now: clock(t2)
  });
  assert.equal((await recovered.handleTerminal(terminal("sync_fixture", "req_start", collectionFailure("sync_fixture", "failed", "STORAGE_ERROR")), sender())).accepted, true);
  assert.equal(storage.values[STORAGE_KEYS.lastSync].state, "failed");
  assert.equal(storage.values[STORAGE_KEYS.lastSync].error.code, "STORAGE_ERROR");
  assert.equal(storage.values[STORAGE_KEYS.history], undefined);
});

test("recovery without a live collector interrupts a non-preflight run without restarting it", async () => {
  const storage = new MemoryStorage({
    [STORAGE_KEYS.lastSync]: {
      run_id: "sync_fixture", state: "running", stage: "collecting_followers", started_at: t1, finished_at: null,
      instagram_account: null, followers_count: null, following_count: null, duration_ms: null, error: null
    }
  });
  let starts = 0;
  const operations = createSyncOperations({
    adapter: createStorageAdapter(storage),
    tabs: { query: async () => [instagramTab()] },
    sendMessage: async (_tabId, message) => {
      if (message.type === "instagram.collectRelationships.start") starts += 1;
      return idleInspection();
    },
    now: clock(t2)
  });
  const outcome = await operations.start(start());
  assert.equal(outcome.state, "interrupted");
  assert.equal(starts, 0);
  assert.equal(storage.values[STORAGE_KEYS.lastSync].state, "interrupted");
});

test("storage diagnostics retain known collection values after progress or processing writes fail", async () => {
  for (const failDuringProgress of [true, false]) {
    const storage = new MemoryStorage();
    const operations = createSyncOperations({
      adapter: createStorageAdapter(storage),
      tabs: { query: async () => [instagramTab()] },
      sendMessage: async (_tabId, message) => {
        if (message.type === "instagram.collectRelationships.start") {
          return collectorAccepted(message.run_id);
        }
        if (failDuringProgress && storage.values[STORAGE_KEYS.lastSync]?.state === "running") {
          return inspection("sync_fixture", "req_start", "running", "collecting_followers");
        }
        return inspection("sync_fixture", "req_start", "terminal_pending", failDuringProgress ? "collecting_followers" : "preflight");
      },
      now: clock(t1, t2),
      createRunId: () => "sync_fixture"
    });
    await operations.start(start());
    storage.failNextSet = true;
    if (failDuringProgress) {
      assert.equal(await operations.handleProgress({ type: "instagram.collectionProgress", run_id: "sync_fixture", stage: "collecting_followers" }, sender()), false);
    }
    const ack = await operations.handleTerminal(terminal("sync_fixture", "req_start", collected("sync_fixture", "owner", ["alice", "bob"], ["carol", "dora", "erin"])), sender());
    assert.equal(ack.accepted, true);
    assert.equal(storage.values[STORAGE_KEYS.history], undefined);
    assert.equal(storage.values[STORAGE_KEYS.lastSync].error.code, "STORAGE_ERROR");
    assert.equal(storage.values[STORAGE_KEYS.lastSync].instagram_account, "owner");
    assert.equal(storage.values[STORAGE_KEYS.lastSync].followers_count, 2);
    assert.equal(storage.values[STORAGE_KEYS.lastSync].following_count, 3);
  }
});

test("failed, interrupted, cancelled, and malformed partial terminal results preserve successful analytics", async () => {
  for (const response of [
    collectionFailure("sync_fixture"),
    collectionFailure("sync_fixture", "interrupted", "COLLECTION_INTERRUPTED"),
    collectionFailure("sync_fixture", "interrupted", "COLLECTION_INTERRUPTED", "Sync cancelled by you."),
    { ...collected("sync_fixture"), following: null }
  ]) {
    const storage = new MemoryStorage();
    const adapter = createStorageAdapter(storage);
    await baseline(adapter);
    const before = clone(storage.values);
    const operations = createSyncOperations({
      adapter, tabs: { query: async () => [instagramTab()] }, sendMessage: async (_tabId, message) => message.type === "instagram.collectRelationships.start"
        ? collectorAccepted(message.run_id)
        : inspection("sync_fixture", "req_start", "terminal_pending", "preflight"), now: clock(t1, t2), createRunId: () => "sync_fixture"
    });
    await operations.start(start());
    const acknowledged = await operations.handleTerminal(terminal("sync_fixture", "req_start", response), sender());
    assert.equal(acknowledged.accepted, response.state !== "completed");
    assert.deepEqual(storage.values[STORAGE_KEYS.history], before[STORAGE_KEYS.history]);
    assert.deepEqual(storage.values[STORAGE_KEYS.report], before[STORAGE_KEYS.report]);
  }
});

class FixtureMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.document = null;
  }

  observe(node) {
    this.document = node.document;
    this.document.observers.add(this);
  }

  disconnect() {
    this.document?.observers.delete(this);
  }
}

class FixtureNode {
  constructor(document, attributes = {}) {
    this.document = document;
    this.attributes = { ...attributes };
    this.dataset = {};
    this.style = {};
    this.parentNode = null;
    this.children = [];
    this.textContent = "";
    this.innerText = "";
    this.hidden = false;
  }

  getAttribute(name) {
    return this.attributes[name] ?? "";
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  querySelectorAll(selector) {
    return this.document.querySelectorAll(selector, this);
  }

  get isConnected() {
    return this.parentNode !== null;
  }

  remove() {
    this.document.detach(this);
  }

  replaceChildren(...children) {
    this.children = children;
    children.forEach((child) => {
      child.parentNode = this;
    });
    this.textContent = children.map((child) => child.textContent ?? "").join("");
  }

  click() {
    this.onClick?.();
    this.onclick?.();
  }
}

class FixtureDocument {
  constructor({ loggedOut = false, loginButtonOnly = false, partial = false, interrupt = false, reactRemoval = false, virtualized = false, shortList = false, emptyList = false, localeProfile = false, roleNavigationProfile = false, directOutsideMainProfile = false, approximateCount = false, endBeforeCount = false, hashRelationshipControls = false, nestedDialogClose = false, unavailable = false, sessionChangeAfter = null, sessionChange = "switch", quietList = false } = {}) {
    this.loggedOut = loggedOut || loginButtonOnly;
    this.loginButtonOnly = loginButtonOnly;
    this.partial = partial;
    this.interrupt = interrupt;
    this.reactRemoval = reactRemoval;
    this.virtualized = virtualized;
    this.shortList = shortList;
    this.emptyList = emptyList;
    this.approximateCount = approximateCount;
    this.quietList = quietList || approximateCount;
    this.hidden = false;
    this.eventListeners = new Map();
    this.endBeforeCount = endBeforeCount;
    this.hashRelationshipControls = hashRelationshipControls;
    this.nestedDialogClose = nestedDialogClose;
    this.roleNavigationProfile = roleNavigationProfile;
    this.directOutsideMainProfile = directOutsideMainProfile;
    this.unavailable = unavailable;
    this.sessionChangeAfter = sessionChangeAfter;
    this.sessionChange = sessionChange;
    this.sessionAccount = directOutsideMainProfile ? "demo.studio" : "owner";
    this.profileStatsAccount = null;
    this.profileClicks = 0;
    this.observers = new Set();
    this.notices = [];
    this.noticeQueryCount = 0;
    this.statsVisible = false;
    this.noFollowing = false;
    this.dialog = null;
    this.openCounts = { followers: 0, following: 0 };
    this.body = new FixtureNode(this);
    this.body.prepend = (node) => this.attach(node);
    this.body.insertBefore = (node) => this.attach(node);
    this.nav = new FixtureNode(this);
    this.nav.parentNode = this.body;
    const profileHref = directOutsideMainProfile ? "/demo.studio/" : "/Owner/";
    this.profile = new FixtureNode(this, localeProfile || directOutsideMainProfile ? { href: profileHref } : { href: profileHref, "aria-label": "Profile" });
    this.profileImage = new FixtureNode(this, { alt: "demo.studio's profile picture" });
    this.mainProfileLinks = ["alice", "bob", "carol"].map((username) => new FixtureNode(this, { href: `/${username}/` }));
    this.main = new FixtureNode(this);
    this.main.contains = (node) => this.mainProfileLinks.includes(node);
    this.navigationRoutes = ["search", "create", "notifications"].map((route) => new FixtureNode(this, { href: `/${route}/` }));
    this.postAuthor = new FixtureNode(this, { href: "/post_author/" });
    this.profile.onClick = () => {
      this.profileClicks += 1;
      this.location.href = `https://www.instagram.com/${this.sessionAccount}/`;
      this.statsVisible = true;
      this.profileStatsAccount = this.sessionAccount;
      if (this.sessionChangeAfter === "profile") {
        this.changeSession();
      }
      if (this.reactRemoval) {
        this.notices.forEach((notice) => this.detach(notice));
      }
      this.mutate();
    };
    this.login = new FixtureNode(this, { href: "/accounts/login/" });
    this.loginInput = new FixtureNode(this, { name: "username" });
    this.loginButton = new FixtureNode(this);
    this.loginButton.textContent = "Log in";
  }

  changeSession() {
    if (this.sessionChange === "logout") {
      this.loggedOut = true;
      this.statsVisible = false;
      return;
    }
    if (this.sessionChange === "unavailable") {
      this.unavailable = true;
      this.statsVisible = false;
      return;
    }
    this.sessionAccount = "switched";
    this.profile.attributes.href = "/Switched/";
    this.profileImage.attributes.alt = "switched's profile picture";
  }

  createElement() {
    return new FixtureNode(this);
  }

  addEventListener(type, listener) {
    if (!this.eventListeners.has(type)) this.eventListeners.set(type, new Set());
    this.eventListeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.eventListeners.get(type)?.delete(listener);
  }

  setHidden(hidden) {
    this.hidden = hidden;
    [...(this.eventListeners.get("visibilitychange") ?? [])].forEach((listener) => listener());
  }

  attach(node) {
    if (!this.notices.includes(node)) {
      node.parentNode = this.body;
      this.notices.push(node);
      this.mutate();
    }
  }

  detach(node) {
    const index = this.notices.indexOf(node);
    if (index >= 0) {
      this.notices.splice(index, 1);
      node.parentNode = null;
      this.mutate();
    }
  }

  mutate() {
    [...this.observers].forEach((observer) => observer.callback());
  }

  listControl(kind) {
    const account = this.profileStatsAccount ?? this.sessionAccount;
    const control = new FixtureNode(this, { href: this.hashRelationshipControls ? "#" : `/${account}/${kind}/` });
    control.innerText = `${this.approximateCount ? "1K" : this.emptyList ? 0 : 3} ${kind}`;
    control.onClick = () => {
      if (this.interrupt) {
        this.location.hostname = "example.test";
        this.mutate();
        return;
      }
      this.openDialog(kind);
    };
    return control;
  }

  openDialog(kind) {
    this.openCounts[kind] += 1;
    const dialog = new FixtureNode(this, { role: "dialog" });
    const container = new FixtureNode(this);
    container.clientHeight = this.shortList ? 20 : 10;
    container.scrollHeight = this.shortList ? 20 : 50;
    container.scrollTop = 0;
    const close = new FixtureNode(this, this.nestedDialogClose ? {} : { "aria-label": "Close" });
    const closeLabel = this.nestedDialogClose ? new FixtureNode(this, { "aria-label": "Close" }) : null;
    if (closeLabel) {
      closeLabel.click = undefined;
    }
    close.onClick = () => {
      this.dialog = null;
      if (kind === "followers" && this.partial) {
        this.noFollowing = true;
      }
      if (this.sessionChangeAfter === kind) {
        this.changeSession();
      }
      this.mutate();
    };
    dialog.container = container;
    dialog.close = close;
    dialog.closeLabel = closeLabel;
    dialog.kind = kind;
    const pages = kind === "followers"
      ? [["Alice", "Bob"], ["Bob", "Carol"]]
      : [["bob", "Dora"], ["Dora", "Erin"]];
    dialog.links = (this.emptyList ? [] : (this.virtualized || this.endBeforeCount ? pages[0] : pages.flat()))
      .map((username) => new FixtureNode(this, { href: `/${username}/` }));
    dialog.endMarker = this.endBeforeCount || (!this.quietList && !this.virtualized) ? new FixtureNode(this) : null;
    if (dialog.endMarker) {
      dialog.endMarker.textContent = "End of list";
    }
    if (this.virtualized && !this.emptyList) {
      dialog.nextLinks = pages[1].map((username) => new FixtureNode(this, { href: `/${username}/` }));
    }
    this.dialog = dialog;
    this.onDialogOpened?.(kind);
    this.mutate();
  }

  revealVirtualizedPage() {
    if (!this.dialog?.nextLinks) {
      return;
    }
    this.dialog.links = this.dialog.nextLinks;
    this.dialog.nextLinks = null;
    this.dialog.container.scrollHeight += 20;
    if (!this.quietList) {
      this.dialog.endMarker = new FixtureNode(this);
      this.dialog.endMarker.textContent = "End of list";
    }
    this.mutate();
  }

  querySelectorAll(selector, root = this) {
    if (root !== this) {
      if (root === this.profile && selector === "[aria-label]") {
        return [];
      }
      if (root === this.profile && selector === "img[alt]") {
        return this.directOutsideMainProfile ? [this.profileImage] : [];
      }
      if (selector === "[data-instatrack-sync-cancel]") {
        return root.children.filter((child) => child.dataset.instatrackSyncCancel === "true");
      }
      if (root === this.dialog) {
        if (selector === "*") return [root.container];
        if (selector === "a[href]") return root.links;
        if (selector === "button, [role=button], [aria-label]") return root.closeLabel ? [root.closeLabel, root.close] : [root.close];
        if (selector === "button, [role=button]") return [root.close];
        if (selector === "[role=progressbar], [aria-busy=true], svg[aria-label]") return [];
        if (selector === "[role=status], div, span") return root.endMarker ? [root.endMarker] : [];
      }
      if (root === this.dialog?.close && selector === "[aria-label], [title]") {
        return this.dialog.closeLabel ? [this.dialog.closeLabel] : [];
      }
      return [];
    }
    if (selector === "main" || selector === "main, [role=main], article") return [this.main];
    if (selector === "main, [role=main], article, [role=dialog]") return [this.main, this.dialog].filter(Boolean);
    if (selector === "a[href]") return this.loggedOut || this.unavailable ? [] : this.directOutsideMainProfile ? [this.profile, ...this.mainProfileLinks] : [this.profile, ...this.navigationRoutes, this.postAuthor];
    if (selector === "nav a[href], header nav a[href]") return this.loggedOut || this.unavailable || this.roleNavigationProfile || this.directOutsideMainProfile ? [] : [this.profile];
    if (selector === "nav a[href], [role=navigation] a[href], header nav a[href]") {
      return this.loggedOut || this.unavailable || this.directOutsideMainProfile ? [] : [this.profile, ...this.navigationRoutes];
    }
    if (selector === "nav a[href], [role=navigation] a[href], header a[href]") {
      return this.loggedOut || this.unavailable || this.directOutsideMainProfile ? [] : [this.profile, ...this.navigationRoutes, this.postAuthor];
    }
    if (selector === "a[href], form, input[name=username]") {
      return this.loggedOut ? [this.loginInput] : this.unavailable ? [] : this.directOutsideMainProfile ? [this.profile, ...this.mainProfileLinks] : [this.profile, ...this.navigationRoutes, this.postAuthor];
    }
    if (selector === "a[href], form, button, [role=button], input[name=username]") {
      return this.loggedOut
        ? [this.loginButtonOnly ? this.loginButton : this.loginInput]
        : this.unavailable ? []
        : this.directOutsideMainProfile ? [this.profile, ...this.mainProfileLinks] : [this.profile, ...this.navigationRoutes, this.postAuthor];
    }
    if (selector === "nav") return [this.nav];
    if (selector === "[data-instatrack-sync-notice]") {
      this.noticeQueryCount += 1;
      return [...this.notices];
    }
    if (selector === "div[role=dialog]") return this.dialog ? [this.dialog] : [];
    if (selector === "a[href], button, [role=button]") {
      if (!this.statsVisible) return [this.profile];
      return [this.profile, this.listControl("followers"), ...(this.noFollowing ? [] : [this.listControl("following")])];
    }
    return [];
  }
}

function contentFixture(options = {}) {
  const document = new FixtureDocument(options);
  const frames = [];
  const progress = [];
  const terminalMessages = [];
  const sessionMessages = [];
  const eventListeners = new Map();
  let runtimeListener;
  let terminalFailures = options.terminalFailures ?? 0;
  const environment = {
    document,
    location: {
      hostname: options.hostname ?? "www.instagram.com",
      href: options.directOutsideMainProfile ? "https://www.instagram.com/direct/inbox/" : "https://www.instagram.com/"
    },
    URL,
    Event,
    performance: { now: options.now ?? (() => performance.now()) },
    MutationObserver: FixtureMutationObserver,
    getComputedStyle: () => ({ display: "block", overflowY: "auto", visibility: "visible" }),
    chrome: {
      runtime: {
        onMessage: options.runtimeMessages ? { addListener(listener) { runtimeListener = listener; } } : undefined,
        sendMessage: (message) => {
      if (message.type === "instagram.collectionTerminal") {
        terminalMessages.push(message);
        if (terminalFailures > 0) {
          terminalFailures -= 1;
          return Promise.reject(new Error("worker unavailable"));
        }
        return { type: "instagram.collectionTerminal.ack", run_id: message.run_id, accepted: true };
      }
      if (message.type === "instagram.sessionChanged") {
        sessionMessages.push(message);
        return undefined;
      }
      progress.push(message);
      const response = options.progressResponse?.(message);
      if (response) return response;
      const accepted = options.progressAccepted?.(message) ?? true;
      return { type: "instagram.collectionProgress.ack", run_id: message.run_id, accepted };
        }
      },
      storage: { local: { get() { throw new Error("content session getter must not read storage"); } } }
    },
    setTimeout: options.setTimeout ?? setTimeout,
    clearTimeout: options.clearTimeout ?? clearTimeout,
    addEventListener(type, listener) {
      eventListeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (eventListeners.get(type) === listener) {
        eventListeners.delete(type);
      }
    }
  };
  document.onDialogOpened = (kind) => {
    if (options.removeIncompleteDialog === kind) {
      queueMicrotask(() => {
        document.dialog = null;
        document.mutate();
      });
      return;
    }
    if (!options.virtualized) {
      return;
    }
    if (options.delayedVirtualized) {
      setTimeout(() => document.revealVirtualizedPage(), 20);
    } else {
      queueMicrotask(() => document.revealVirtualizedPage());
    }
  };
  document.location = environment.location;
  environment.globalThis = environment;
  vm.runInNewContext(contentSource, environment);

  return {
    collector: environment.InstatrackContent.createInstagramCollector(environment),
    document,
    frames,
    progress,
    terminalMessages,
    sessionMessages,
    dispatch(type) {
      eventListeners.get(type)?.();
    },
    sendRuntimeMessage(message) {
      return new Promise((resolve) => runtimeListener?.(message, {}, resolve));
    },
    async flushFrames() {
      await new Promise((resolve) => setImmediate(resolve));
      if (options.delayedVirtualized) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  };
}

test("content session getter reports the visible session without navigation, dialogs, or storage", async () => {
  const request = { type: "instagram.session.get", request_id: "req_session", protocol_version: CONTENT_PROTOCOL_VERSION };
  const signedIn = contentFixture({ runtimeMessages: true });
  const initialLocation = signedIn.document.location.href;

  assert.deepEqual(JSON.parse(JSON.stringify(await signedIn.sendRuntimeMessage(request))), {
    type: "instagram.session",
    request_id: "req_session",
    state: "authenticated",
    instagram_account: "owner",
    protocol_version: CONTENT_PROTOCOL_VERSION
  });
  assert.equal(signedIn.document.location.href, initialLocation);
  assert.equal(signedIn.document.profileClicks, 0);
  assert.equal(signedIn.document.statsVisible, false);
  assert.equal(signedIn.document.dialog, null);
  assert.deepEqual(signedIn.sessionMessages, []);

  const loggedOut = contentFixture({ loginButtonOnly: true, runtimeMessages: true });
  assert.deepEqual(JSON.parse(JSON.stringify(await loggedOut.sendRuntimeMessage(request))), {
    type: "instagram.session",
    request_id: "req_session",
    state: "logged_out",
    instagram_account: null,
    protocol_version: CONTENT_PROTOCOL_VERSION
  });

  let expire;
  const unavailable = contentFixture({ unavailable: true, runtimeMessages: true, setTimeout: (callback) => { expire = callback; } });
  const pending = unavailable.sendRuntimeMessage(request);
  expire();
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), {
    type: "instagram.session",
    request_id: "req_session",
    state: "unavailable",
    instagram_account: null,
    protocol_version: CONTENT_PROTOCOL_VERSION
  });
});

test("the sync session handshake waits for Instagram to render and cleans up after responding", async () => {
  const request = { type: "instagram.session.get", request_id: "req_loading", protocol_version: CONTENT_PROTOCOL_VERSION };
  const f = contentFixture({ unavailable: true, runtimeMessages: true });
  let answered = false;
  const pending = f.sendRuntimeMessage(request).then((response) => { answered = true; return response; });
  await f.flushFrames();
  assert.equal(answered, false);
  f.document.unavailable = false;
  f.document.mutate();
  assert.equal((await pending).instagram_account, "owner");
  assert.equal(f.document.profileClicks, 0);
  assert.equal(f.document.dialog, null);
  assert.equal(f.document.notices.length, 0);

  const closed = contentFixture({ unavailable: true, runtimeMessages: true });
  const closing = closed.sendRuntimeMessage(request);
  closed.dispatch("pagehide");
  assert.equal((await closing).state, "unavailable");
});

test("content discards collection data when the pinned session changes, logs out, or becomes unavailable", async () => {
  for (const [sessionChangeAfter, sessionChange] of [
    ["profile", "switch"],
    ["followers", "logout"],
    ["following", "unavailable"]
  ]) {
    const fixture = contentFixture({ shortList: true, sessionChangeAfter, sessionChange,
      ...(sessionChange === "unavailable" ? { setTimeout: (callback) => { queueMicrotask(callback); return 0; } } : {}) });
    const result = await fixture.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: `sync_${sessionChange}` });

    assert.equal(result.state, sessionChange === "unavailable" ? "failed" : "interrupted");
    assert.equal(result.instagram_account, null);
    assert.equal(result.followers, null);
    assert.equal(result.following, null);
    assert.equal(result.error.code, sessionChange === "unavailable" ? "COLLECTION_FAILED" : "COLLECTION_INTERRUPTED");
  }
});

test("content fixture derives only session-owned profile, reads the final virtualized DOM, and cleans one notice", async () => {
  const fixture = contentFixture({ delayedVirtualized: true, localeProfile: true, reactRemoval: true, virtualized: true });
  const request = { type: "instagram.collectRelationships", run_id: "sync_content" };
  const first = fixture.collector.collectRelationships(request);
  const duplicate = fixture.collector.collectRelationships(request);
  assert.equal(first, duplicate);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.document.notices.length, 1);
  assert.equal(fixture.document.notices[0].getAttribute("role"), "status");
  assert.equal(fixture.document.notices[0].children[0].textContent, "Sync in progress. Keep this Instagram tab open and visible until it finishes.");
  fixture.document.mutate();
  assert.equal(fixture.document.notices.length, 1);
  await fixture.flushFrames();
  const result = await first;

  assert.equal(result.state, "completed");
  assert.equal(result.instagram_account, "owner");
  assert.deepEqual(Array.from(result.followers), ["bob", "carol"]);
  assert.deepEqual(Array.from(result.following), ["dora", "erin"]);
  assert.deepEqual(fixture.progress.map((message) => [...Object.keys(message)]), [["type", "run_id", "stage"], ["type", "run_id", "stage"]]);
  assert.deepEqual(fixture.progress.map((message) => message.stage), ["collecting_followers", "collecting_following"]);
  assert.equal(fixture.document.notices.length, 0);
});

test("content notice ignores unrelated mutations, restores after removal, and stop disconnects repair", async () => {
  const fixture = contentFixture({ approximateCount: true });
  const staleNotices = [fixture.document.createElement("div"), fixture.document.createElement("div")];
  staleNotices.forEach((notice) => {
    notice.dataset.instatrackSyncNotice = "true";
    fixture.document.attach(notice);
  });
  const request = {
    type: "instagram.collectRelationships.start",
    run_id: "sync_notice_repair",
    request_id: "req_notice_repair",
    started_at: t1,
    protocol_version: CONTENT_PROTOCOL_VERSION
  };
  await fixture.collector.start(request);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.document.notices.length, 1);
  const notice = fixture.document.notices[0];
  const queriesBeforeMutation = fixture.document.noticeQueryCount;
  fixture.document.mutate();
  assert.equal(fixture.document.notices.length, 1);
  assert.equal(fixture.document.notices[0], notice);
  assert.equal(fixture.document.noticeQueryCount, queriesBeforeMutation);

  fixture.document.detach(notice);
  assert.equal(fixture.document.notices.length, 1);
  assert.equal(fixture.document.notices[0], notice);
  assert.equal(fixture.document.noticeQueryCount, queriesBeforeMutation + 1);

  const stopped = await fixture.collector.stop({
    type: "instagram.collectRelationships.stop",
    run_id: "sync_notice_repair",
    protocol_version: CONTENT_PROTOCOL_VERSION
  });
  assert.equal(stopped.stopped, true);
  assert.equal(fixture.document.observers.size, 0);
  assert.equal(fixture.document.notices.length, 0);
});

test("content opens each relationship once and reads every loaded username once at the explicit end", async () => {
  const fixture = contentFixture({ shortList: true });
  const reads = { followers: 0, following: 0 };
  fixture.document.onDialogOpened = (kind) => {
    for (const link of fixture.document.dialog.links) {
      const getAttribute = link.getAttribute.bind(link);
      link.getAttribute = (name) => {
        if (name === "href") reads[kind] += 1;
        return getAttribute(name);
      };
    }
  };
  const result = await fixture.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: "sync_read_once" });

  assert.equal(result.state, "completed");
  assert.deepEqual(Array.from(result.followers), ["alice", "bob", "carol"]);
  assert.deepEqual(Array.from(result.following), ["bob", "dora", "erin"]);
  assert.deepEqual(fixture.document.openCounts, { followers: 1, following: 1 });
  assert.deepEqual(reads, { followers: 4, following: 4 });
});

test("content finds the unlabeled localized profile inside role navigation without choosing route or post links", async () => {
  const fixture = contentFixture({ localeProfile: true, roleNavigationProfile: true, shortList: true });
  assert.equal(fixture.collector.inspect().state, "idle");
  const result = await fixture.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: "sync_role_navigation" });
  assert.equal(result.state, "completed");
  assert.equal(result.instagram_account, "owner");
});

test("content ignores an external profile-like navigation link before the session profile", async () => {
  const fixture = contentFixture({ shortList: true });
  const originalQuery = fixture.document.querySelectorAll.bind(fixture.document);
  const externalProfile = new FixtureNode(fixture.document, { href: "https://about.instagram.com/blog/", "aria-label": "Profile" });
  let externalClicks = 0;
  externalProfile.onClick = () => {
    externalClicks += 1;
  };
  fixture.document.querySelectorAll = (selector, root = fixture.document) => {
    const values = originalQuery(selector, root);
    return root === fixture.document && selector === "nav a[href], [role=navigation] a[href], header nav a[href]"
      ? [externalProfile, ...values]
      : values;
  };

  await fixture.collector.start({
    type: "instagram.collectRelationships.start",
    run_id: "sync_external_profile",
    request_id: "req_external_profile",
    started_at: t1,
    protocol_version: CONTENT_PROTOCOL_VERSION
  });
  await new Promise((resolve) => setImmediate(resolve));
  const inspection = fixture.collector.inspect();
  if (inspection.state !== "idle") {
    await fixture.collector.stop({
      type: "instagram.collectRelationships.stop",
      run_id: "sync_external_profile",
      protocol_version: CONTENT_PROTOCOL_VERSION
    });
  }

  assert.equal(externalClicks, 0);
  assert.deepEqual(fixture.progress.map((message) => message.stage), ["collecting_followers", "collecting_following"]);
});

test("content uses textual relationship counters when profile links expose hash URLs", async () => {
  const fixture = contentFixture({ hashRelationshipControls: true, shortList: true });
  await fixture.collector.start({
    type: "instagram.collectRelationships.start",
    run_id: "sync_hash_controls",
    request_id: "req_hash_controls",
    started_at: t1,
    protocol_version: CONTENT_PROTOCOL_VERSION
  });
  await new Promise((resolve) => setImmediate(resolve));
  const inspection = fixture.collector.inspect();
  if (inspection.state !== "idle") {
    await fixture.collector.stop({
      type: "instagram.collectRelationships.stop",
      run_id: "sync_hash_controls",
      protocol_version: CONTENT_PROTOCOL_VERSION
    });
  }

  assert.deepEqual(fixture.progress.map((message) => message.stage), ["collecting_followers", "collecting_following"]);
});

test("content clicks the dialog button when its close label is on a nested icon", async () => {
  const fixture = contentFixture({ nestedDialogClose: true, shortList: true });
  const result = await fixture.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: "sync_nested_close" });

  assert.equal(result.state, "completed");
  assert.equal(result.error, null);
  assert.equal(fixture.document.dialog, null);
});

test("content finds its Direct profile outside main while excluding profile-like links inside main", async () => {
  const fixture = contentFixture({ directOutsideMainProfile: true, shortList: true });
  const profileLinks = fixture.document.querySelectorAll("a[href]");
  const main = fixture.document.querySelectorAll("main")[0];
  assert.equal(profileLinks.length, 4);
  assert.equal(profileLinks.every((link) => /^\/[A-Za-z0-9._]+\/$/.test(link.getAttribute("href"))), true);
  assert.equal(profileLinks[0].getAttribute("href"), "/demo.studio/");
  assert.equal(main.contains(profileLinks[0]), false);
  assert.equal(profileLinks.slice(1).every((link) => main.contains(link)), true);
  assert.equal(profileLinks[0].querySelectorAll("img[alt]")[0].getAttribute("alt"), "demo.studio's profile picture");
  assert.equal(fixture.document.querySelectorAll("nav a[href], [role=navigation] a[href], header nav a[href]").length, 0);

  const result = await fixture.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: "sync_direct_outside_main" });
  assert.equal(result.error, null);
  assert.equal(result.state, "completed");
  assert.equal(result.instagram_account, "demo.studio");
});

test("content waits for a delayed virtualized page and reads only its final DOM", async () => {
  const fixture = contentFixture({ delayedVirtualized: true, virtualized: true });
  const pending = fixture.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: "sync_delayed" });
  await new Promise((resolve) => setImmediate(resolve));
  let settled = false;
  pending.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  await fixture.flushFrames();
  const result = await pending;
  assert.deepEqual(Array.from(result.followers), ["bob", "carol"]);
  assert.deepEqual(Array.from(result.following), ["dora", "erin"]);
});

test("content interrupts and cleans up when an observed incomplete relationship dialog disappears", async () => {
  for (const kind of ["followers", "following"]) {
    const fixture = contentFixture({ virtualized: true, removeIncompleteDialog: kind });
    const result = await fixture.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: `sync_dialog_${kind}` });
    assert.deepEqual(Object.keys(result), ["type", "run_id", "state", "instagram_account", "followers", "following", "error"]);
    assert.equal(result.state, "interrupted");
    assert.equal(result.error.code, "COLLECTION_INTERRUPTED");
    assert.equal(result.instagram_account, null);
    assert.equal(result.followers, null);
    assert.equal(result.following, null);
    assert.equal(fixture.document.notices.length, 0);
  }
});

test("content accepts Instagram's explicit end marker even when the visible exact count is unmet", async () => {
  const fixture = contentFixture({ endBeforeCount: true });
  const result = await fixture.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: "sync_explicit_end" });
  assert.equal(result.state, "completed");
  assert.deepEqual(Array.from(result.followers), ["alice", "bob"]);
  assert.deepEqual(Array.from(result.following), ["bob", "dora"]);
});

test("content completes a quiet exact-count list when the visible count exceeds the available accounts", async () => {
  let now = 0;
  const timers = [];
  const fixture = contentFixture({
    quietList: true,
    shortList: true,
    now: () => now,
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      const index = timers.indexOf(timer);
      if (index >= 0) {
        timers.splice(index, 1);
      }
    }
  });
  const querySelectorAll = fixture.document.querySelectorAll.bind(fixture.document);
  fixture.document.querySelectorAll = (selector, root = fixture.document) => {
    const values = querySelectorAll(selector, root);
    return root === fixture.document.dialog && selector === "a[href]" ? values.slice(0, -1) : values;
  };

  const pending = fixture.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: "sync_count_mismatch" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 1);
  while (timers.length) {
    const timer = timers.shift();
    assert.equal(timer.delay, 100);
    now += timer.delay;
    timer.callback();
    await new Promise((resolve) => setImmediate(resolve));
  }

  const result = await pending;
  assert.equal(result.state, "completed");
  assert.deepEqual(Array.from(result.followers), ["alice", "bob"]);
  assert.deepEqual(Array.from(result.following), ["bob", "dora"]);
});

test("content completes an approximate-count list only after the quiet bottom settle window", async () => {
  const fixture = contentFixture({ approximateCount: true });
  const pending = fixture.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: "sync_approximate" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  let settled = false;
  pending.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(settled, false);
  const result = await pending;
  assert.equal(result.state, "completed");
  assert.deepEqual(Array.from(result.followers), ["alice", "bob", "carol"]);
  assert.deepEqual(Array.from(result.following), ["bob", "dora", "erin"]);
});

test("content starts independently, retains its terminal result until acknowledgement, and exposes inspection", async () => {
  const fixture = contentFixture({ virtualized: true });
  const request = {
    type: "instagram.collectRelationships.start",
    run_id: "sync_handoff",
    request_id: "req_handoff",
    started_at: t1,
    protocol_version: CONTENT_PROTOCOL_VERSION
  };
  const accepted = await fixture.collector.start(request);
  assert.deepEqual(JSON.parse(JSON.stringify(accepted)), {
    type: "instagram.collectRelationships.accepted",
    run_id: "sync_handoff",
    state: "started",
    protocol_version: CONTENT_PROTOCOL_VERSION
  });
  assert.equal(fixture.collector.inspect().run_id, "sync_handoff");
  await fixture.flushFrames();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.terminalMessages.length, 1);
  assert.deepEqual(Object.keys(fixture.terminalMessages[0]), ["type", "run_id", "request_id", "result"]);
  assert.equal(fixture.terminalMessages[0].result.state, "completed");
  assert.equal(fixture.collector.inspect().state, "idle");
});

test("content protocol rejects a legacy start before creating an active run", async () => {
  const fixture = contentFixture();
  const response = await fixture.collector.start({
    type: "instagram.collectRelationships.start",
    run_id: "sync_legacy",
    request_id: "req_legacy",
    started_at: t1
  });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    type: "instagram.collectRelationships.accepted",
    run_id: "sync_legacy",
    state: "unsupported_protocol",
    protocol_version: CONTENT_PROTOCOL_VERSION
  });
  assert.equal(fixture.collector.inspect().state, "idle");
  assert.equal(fixture.document.notices.length, 0);
});

test("content stop synchronously quiesces list observation, quiet timers, dialog, notice, and terminal delivery", async () => {
  const activeTimers = new Set();
  const trackedSetTimeout = (callback, delay) => {
    const timer = setTimeout(() => {
      activeTimers.delete(timer);
      callback();
    }, delay);
    activeTimers.add(timer);
    return timer;
  };
  const trackedClearTimeout = (timer) => {
    activeTimers.delete(timer);
    clearTimeout(timer);
  };
  const fixture = contentFixture({
    approximateCount: true,
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout
  });
  const request = {
    type: "instagram.collectRelationships.start",
    run_id: "sync_stop_content",
    request_id: "req_stop_content",
    started_at: t1,
    protocol_version: CONTENT_PROTOCOL_VERSION
  };
  await fixture.collector.start(request);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.collector.inspect().state, "running");
  assert.equal(fixture.document.notices.length, 1);
  assert.notEqual(fixture.document.dialog, null);
  assert.equal(activeTimers.size, 1, "the approximate list has one quiet-bottom timer");
  const observerCount = fixture.document.observers.size;
  assert.equal((await fixture.collector.stop({ type: "instagram.collectRelationships.stop", run_id: "sync_other", protocol_version: CONTENT_PROTOCOL_VERSION })).stopped, false);
  assert.equal((await fixture.collector.stop({ type: "instagram.collectRelationships.stop", run_id: "sync_stop_content", protocol_version: CONTENT_PROTOCOL_VERSION, extra: true })).stopped, false);
  assert.equal(fixture.collector.inspect().run_id, "sync_stop_content");
  assert.equal(fixture.document.observers.size, observerCount);
  assert.equal(fixture.document.notices.length, 1);
  assert.equal(activeTimers.size, 1);
  const response = await fixture.collector.stop({ type: "instagram.collectRelationships.stop", run_id: "sync_stop_content", protocol_version: CONTENT_PROTOCOL_VERSION });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    type: "instagram.collectRelationships.stop.result",
    run_id: "sync_stop_content",
    stopped: true,
    protocol_version: CONTENT_PROTOCOL_VERSION
  });
  assert.equal(fixture.collector.inspect().state, "idle");
  assert.equal(fixture.document.observers.size, 0);
  assert.equal(activeTimers.size, 0);
  assert.equal(fixture.document.notices.length, 0);
  assert.equal(fixture.document.dialog, null);
  assert.equal(fixture.terminalMessages.length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.terminalMessages.length, 0);
});

test("Instagram Cancel retains a cancelled notice and hands off no partial relationship data", async () => {
  const fixture = contentFixture({ approximateCount: true });
  await fixture.collector.start({
    type: "instagram.collectRelationships.start",
    run_id: "sync_cancel_content",
    request_id: "req_cancel_content",
    started_at: t1,
    protocol_version: CONTENT_PROTOCOL_VERSION
  });
  await new Promise((resolve) => setImmediate(resolve));

  const notice = fixture.document.notices[0];
  const cancel = notice.children.find((child) => child.dataset.instatrackSyncCancel === "true");
  assert.equal(cancel?.textContent, "Cancel");
  cancel.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.terminalMessages.length, 1);
  assert.equal(fixture.terminalMessages[0].result.state, "interrupted");
  assert.equal(fixture.terminalMessages[0].result.error.message, "Sync cancelled by you.");
  assert.equal(fixture.terminalMessages[0].result.instagram_account, null);
  assert.equal(fixture.terminalMessages[0].result.followers, null);
  assert.equal(fixture.terminalMessages[0].result.following, null);
  assert.equal(fixture.document.dialog, null);
  assert.equal(fixture.document.notices.length, 1);
  assert.equal(fixture.document.notices[0].textContent, "Sync cancelled. You may close this page.");
  assert.equal(fixture.document.notices[0].children.length, 1);
});

test("content stop clears an unacknowledged retained terminal and its retry timer", async () => {
  const scheduled = new Map();
  let nextTimer = 1;
  const fixture = contentFixture({
    virtualized: true,
    terminalFailures: 1,
    setTimeout: (callback, delay) => {
      const timer = nextTimer++;
      scheduled.set(timer, { callback, delay });
      return timer;
    },
    clearTimeout: (timer) => scheduled.delete(timer)
  });
  await fixture.collector.start({
    type: "instagram.collectRelationships.start",
    run_id: "sync_terminal_stop",
    request_id: "req_terminal_stop",
    started_at: t1,
    protocol_version: CONTENT_PROTOCOL_VERSION
  });
  await fixture.flushFrames();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.collector.inspect().state, "terminal_pending");
  assert.equal(fixture.terminalMessages.length, 1);
  assert.equal([...scheduled.values()].some(({ delay }) => delay === 1_000), true);
  const response = await fixture.collector.stop({ type: "instagram.collectRelationships.stop", run_id: "sync_terminal_stop", protocol_version: CONTENT_PROTOCOL_VERSION });
  assert.equal(response.stopped, true);
  assert.equal(fixture.collector.inspect().state, "idle");
  assert.equal(scheduled.size, 0);
  assert.equal(fixture.document.observers.size, 0);
  assert.equal(fixture.document.notices.length, 0);
  assert.equal(fixture.terminalMessages.length, 1);
});

test("content stops before collection and retains a storage terminal when progress is rejected", async () => {
  const fixture = contentFixture({ progressAccepted: () => false });
  const accepted = await fixture.collector.start({
    type: "instagram.collectRelationships.start",
    run_id: "sync_storage_error",
    request_id: "req_storage_error",
    started_at: t1,
    protocol_version: CONTENT_PROTOCOL_VERSION
  });
  assert.equal(accepted.state, "started");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.progress.length, 1);
  assert.equal(fixture.terminalMessages.length, 1);
  assert.equal(fixture.terminalMessages[0].result.state, "failed");
  assert.equal(fixture.terminalMessages[0].result.error.code, "STORAGE_ERROR");
  assert.equal(fixture.terminalMessages[0].result.followers, null);
  assert.equal(fixture.document.dialog, null);
});

test("content retries an unacknowledged terminal handoff without recollecting", async () => {
  const fixture = contentFixture({
    virtualized: true,
    terminalFailures: 1,
    setTimeout: (callback) => {
      queueMicrotask(callback);
      return 0;
    }
  });
  await fixture.collector.start({
    type: "instagram.collectRelationships.start",
    run_id: "sync_retry",
    request_id: "req_retry",
    started_at: t1,
    protocol_version: CONTENT_PROTOCOL_VERSION
  });
  await fixture.flushFrames();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.terminalMessages.length, 2);
  assert.equal(fixture.terminalMessages[0].run_id, fixture.terminalMessages[1].run_id);
  assert.equal(fixture.collector.inspect().state, "idle");
});

test("content completes short and empty relationship dialogs", async () => {
  const short = contentFixture({ shortList: true });
  const shortPromise = short.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: "sync_short" });
  await short.flushFrames();
  const shortResult = await shortPromise;
  assert.equal(shortResult.state, "completed");
  assert.deepEqual(Array.from(shortResult.followers), ["alice", "bob", "carol"]);

  const empty = contentFixture({ emptyList: true });
  const emptyPromise = empty.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: "sync_empty" });
  await empty.flushFrames();
  const emptyResult = await emptyPromise;
  assert.equal(emptyResult.state, "completed");
  assert.deepEqual(Array.from(emptyResult.followers), []);
  assert.deepEqual(Array.from(emptyResult.following), []);
});

test("content terminal fixtures null both lists for invalid, unavailable, partial, and interrupted collection", async () => {
  const invalid = contentFixture();
  const invalidResult = await invalid.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: "sync_invalid", extra: true });
  assert.equal(invalidResult.error.code, "COLLECTION_FAILED");

  const loggedOut = contentFixture({ loginButtonOnly: true });
  const loginResult = await loggedOut.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: "sync_login" });
  assert.equal(loginResult.error.code, "NOT_LOGGED_IN");
  assert.equal(loginResult.error.message, "Open Instagram in a tab, sign in, and retry");

  const unavailable = contentFixture({ hostname: "example.test" });
  const hostResult = await unavailable.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: "sync_host" });
  assert.equal(hostResult.error.code, "NOT_INSTAGRAM");

  const partial = contentFixture({ partial: true });
  const partialPromise = partial.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: "sync_partial" });
  await partial.flushFrames();
  const partialResult = await partialPromise;
  assert.equal(partialResult.state, "failed");

  const interrupted = contentFixture({ interrupt: true });
  const interruptedPromise = interrupted.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: "sync_interrupted" });
  await interrupted.flushFrames();
  const interruptedResult = await interruptedPromise;
  assert.equal(interruptedResult.state, "interrupted");

  for (const result of [invalidResult, loginResult, hostResult, partialResult, interruptedResult]) {
    assert.equal(result.instagram_account, null);
    assert.equal(result.followers, null);
    assert.equal(result.following, null);
  }
});

test("sync runtime contains no remote client, profile target, numeric account cap, or whole-run watchdog", () => {
  const runtime = `${readFileSync(resolve(extensionRoot, "src/background/sync-operations.js"), "utf8")}\n${contentSource}`;
  assert.doesNotMatch(runtime, /TARGET_PROFILE_URL|target_username|profile_url|demo.studio|fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|api[_-]?key|authorization|https?:\/\/|watchdog/i);
  assert.doesNotMatch(runtime, /for\s*\([^)]*<\s*\d+/);
});

test("account-scoped sync pins its claim owner and rejects another account before the first snapshot", async () => {
  const storage = new MemoryStorage();
  const adapter = createStorageAdapter(storage);
  adapter.account = "owner";
  adapter.claimRun = async (claim) => {
    assert.equal(claim.instagram_account, "owner");
    await adapter.writeLastSync(claim);
    return true;
  };
  const operations = createSyncOperations({
    adapter, tabs: { query: async () => [instagramTab(22, 90)] },
    sendMessage: async (_id, message) => message.type === "instagram.collectRelationships.start"
      ? collectorAccepted(message.run_id) : inspection("sync_fixture", "req_start", "terminal_pending", "preflight"),
    now: clock(t1, t2), createRunId: () => "sync_fixture"
  });
  assert.equal((await operations.start(start())).type, "sync.accepted");
  await operations.handleTerminal(terminal("sync_fixture", "req_start", collected("sync_fixture", "other")), sender(22));
  assert.equal(storage.values[STORAGE_KEYS.history], undefined);
  assert.equal(storage.values[STORAGE_KEYS.lastSync].state, "interrupted");
});

test("closing a tab retires an orphan run but leaves a live collector running", async () => {
  const storage = new MemoryStorage();
  let openTabs = [instagramTab(22, 90)];
  const operations = createSyncOperations({
    adapter: createStorageAdapter(storage), tabs: { query: async () => openTabs },
    sendMessage: async (_id, message) => message.type === "instagram.collectRelationships.start"
      ? collectorAccepted(message.run_id) : inspection("sync_fixture", "req_start", "running", "preflight"),
    now: clock(t1, t2), createRunId: () => "sync_fixture"
  });
  await operations.start(start());
  await operations.reconcileClosedCollector();
  assert.equal(storage.values[STORAGE_KEYS.lastSync].state, "running");
  openTabs = [];
  await operations.reconcileClosedCollector();
  assert.equal(storage.values[STORAGE_KEYS.lastSync].state, "interrupted");
  assert.equal(storage.values[STORAGE_KEYS.history], undefined);
});

function controlledContent(options = {}) {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  const fixture = contentFixture({ ...options,
    now: () => now,
    setTimeout(callback, delay) {
      const id = ++sequence;
      timers.set(id, { callback, at: now + delay * (options.timerDelayMultiplier ?? 1) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  });
  async function advance(ms) {
    const target = now + ms;
    await new Promise((resolve) => setImmediate(resolve));
    let steps = 0;
    while (true) {
      const next = [...timers.entries()].filter(([, value]) => value.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      if (++steps > 10_000) throw new Error("Content timer loop did not settle");
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
    now = target;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { fixture, timers, advance };
}

const contentStart = (run_id) => ({ type: "instagram.collectRelationships.start", run_id,
  request_id: `request_${run_id}`, started_at: t1, protocol_version: CONTENT_PROTOCOL_VERSION });

function localizedContent(labels, invalidStats = undefined) {
  const controlled = controlledContent({ localeProfile: true, hashRelationshipControls: true, shortList: true, quietList: true });
  const { document } = controlled.fixture;
  const node = (queries = {}, attributes = {}) => {
    const element = new FixtureNode(document, attributes);
    element.querySelectorAll = (selector) => queries[selector] ?? [];
    return element;
  };
  const controls = ["followers", "following"].map((kind) => {
    const control = document.listControl(kind);
    control.innerText = `${labels.digits} ${labels[kind]}`;
    const count = node();
    count.textContent = labels.digits;
    control.querySelectorAll = (selector) => selector === "span" ? [count] : [];
    return control;
  });
  const cells = [node(), ...controls.map((control) => node({ "a[href], button, [role=button]": [control] }))];
  const row = node();
  row.replaceChildren(...cells);
  if (invalidStats === "hidden") row.hidden = true;
  if (invalidStats === "extra-cell") row.children.push(node());
  if (invalidStats === "extra-control") cells[1].querySelectorAll = () => [controls[0], controls[1]];
  if (invalidStats === "non-numeric") controls[1].querySelectorAll = () => [];
  const header = node({ "*": invalidStats === "ambiguous" ? [row, row] : [row] });
  const query = document.querySelectorAll.bind(document);
  document.listControl = (kind) => controls[kind === "followers" ? 0 : 1];
  document.querySelectorAll = (selector, root = document) => {
    if (root === document && selector === "main header, [role=main] header") {
      return document.statsVisible && invalidStats !== "outside-header" ? [header] : [];
    }
    return query(selector, root);
  };
  const openProfile = document.profile.onClick;
  document.profile.onClick = () => {
    openProfile();
    if (invalidStats === "other-account") document.location.href = "https://www.instagram.com/other/";
  };
  document.onDialogOpened = () => {
    const dialog = document.dialog;
    dialog.close.attributes["aria-label"] = labels.close;
    const icon = node();
    dialog.close.querySelectorAll = (selector) => selector === "svg" ? [icon] : [];
    const heading = node();
    heading.parentElement = node({ "button, [role=button]": [dialog.close] });
    heading.parentElement.parentElement = dialog;
    const dialogQuery = dialog.querySelectorAll.bind(dialog);
    dialog.querySelectorAll = (selector) => selector === "h1, h2, h3, [role=heading]" ? [heading] : dialogQuery(selector);
  };
  return controlled;
}

test("hash relationship counters and dialog close work without any translated labels", async () => {
  for (const labels of [
    { digits: "434", followers: "подписчики", following: "подписки", close: "Закрыть" },
    { digits: "٤٣٤", followers: "المتابعون", following: "يتابع", close: "إغلاق" },
    { digits: "４３４", followers: "フォロワー", following: "フォロー中", close: "閉じる" },
    { digits: "434", followers: "opaque-a", following: "opaque-b", close: "opaque-c" }
  ]) {
    const { fixture, advance } = localizedContent(labels);
    await fixture.collector.start(contentStart("localized"));
    await advance(7_000);
    assert.equal(fixture.terminalMessages.length, 1, labels.followers);
    const result = fixture.terminalMessages[0].result;
    assert.equal(result.state, "completed", labels.followers);
    assert.deepEqual(Array.from(result.followers), ["alice", "bob", "carol"]);
    assert.deepEqual(Array.from(result.following), ["bob", "dora", "erin"]);
    assert.deepEqual(fixture.document.openCounts, { followers: 1, following: 1 });
    assert.equal(fixture.document.dialog, null);
  }
});

test("localized counters reject ambiguous, hidden, unrelated and other-account statistics", async () => {
  for (const invalidStats of ["ambiguous", "hidden", "extra-cell", "extra-control", "non-numeric", "outside-header", "other-account"]) {
    const { fixture, advance } = localizedContent({ digits: "434", followers: "opaque-a", following: "opaque-b", close: "opaque-c" }, invalidStats);
    await fixture.collector.start(contentStart(`invalid_${invalidStats}`));
    await advance(16_000);
    assert.equal(fixture.terminalMessages[0].result.state, "failed", invalidStats);
    assert.equal(fixture.terminalMessages[0].result.followers, null);
    assert.deepEqual(fixture.document.openCounts, { followers: 0, following: 0 });
  }
});

test("a localized Instagram spinner cannot complete a stalled list", async () => {
  const { fixture, advance } = localizedContent({ digits: "434", followers: "opaque-a", following: "opaque-b", close: "opaque-c" });
  const spinner = new FixtureNode(fixture.document, { "aria-label": "Загрузка...", viewBox: "0 0 100 100" });
  spinner.querySelectorAll = (selector) => selector === "rect[transform]" ? Array.from({ length: 12 }, () => new FixtureNode(fixture.document)) : [];
  const query = fixture.document.querySelectorAll.bind(fixture.document);
  fixture.document.querySelectorAll = (selector, root = fixture.document) => root === fixture.document.dialog && selector === "[role=progressbar], [aria-busy=true], svg[aria-label]"
    ? [spinner] : query(selector, root);
  await fixture.collector.start(contentStart("localized_loader"));
  await advance(7_000);
  assert.equal(fixture.document.openCounts.followers, 1);
  assert.equal(fixture.terminalMessages.length, 0);
  await advance(24_000);
  assert.equal(fixture.terminalMessages[0].result.state, "failed");
  assert.equal(fixture.terminalMessages[0].result.followers, null);
  assert.equal(fixture.document.openCounts.following, 0);
});

test("a localized dialog with ambiguous header icons fails without clicking a relationship button", async () => {
  const { fixture, advance } = localizedContent({ digits: "434", followers: "opaque-a", following: "opaque-b", close: "opaque-c" });
  let otherClicks = 0;
  const opened = fixture.document.onDialogOpened;
  fixture.document.onDialogOpened = () => {
    opened();
    const dialog = fixture.document.dialog;
    const other = new FixtureNode(fixture.document);
    other.onClick = () => { otherClicks += 1; };
    const heading = dialog.querySelectorAll("h1, h2, h3, [role=heading]")[0];
    heading.parentElement.querySelectorAll = (selector) => selector === "button, [role=button]" ? [dialog.close, other] : [];
  };
  await fixture.collector.start(contentStart("ambiguous_close"));
  await advance(7_000);
  assert.equal(fixture.terminalMessages[0].result.state, "failed");
  assert.equal(fixture.terminalMessages[0].result.followers, null);
  assert.equal(fixture.document.openCounts.following, 0);
  assert.equal(otherClicks, 0);
});

test("login buttons with both innerText and textContent identify a logged-out session", async () => {
  const fixture = contentFixture({ loginButtonOnly: true });
  fixture.document.loginButton.innerText = "Log In";
  fixture.document.loginButton.textContent = "Log In";
  const result = await fixture.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: "logged_out_button" });
  assert.equal(result.error.code, "NOT_LOGGED_IN");
  assert.equal(result.followers, null);
});

test("relationship avatars outside main content do not make the session profile ambiguous", async () => {
  const { fixture, advance } = controlledContent({ directOutsideMainProfile: true });
  const relationship = new FixtureNode(fixture.document, { href: "/relationship/" });
  const image = new FixtureNode(fixture.document, { alt: "relationship's profile picture" });
  const query = fixture.document.querySelectorAll.bind(fixture.document);
  fixture.document.querySelectorAll = (selector, root = fixture.document) => {
    if (root === relationship && selector === "img[alt]") return [image];
    const result = query(selector, root);
    return root === fixture.document && selector === "a[href]" && fixture.document.dialog ? [...result, relationship] : result;
  };
  fixture.document.onDialogOpened = () => { fixture.document.dialog.contains = (node) => node === relationship; };
  await fixture.collector.start(contentStart("dialog_session"));
  await advance(500);
  assert.equal(fixture.terminalMessages.length, 1);
  assert.equal(fixture.terminalMessages[0].result.state, "completed");
  assert.equal(fixture.terminalMessages[0].result.instagram_account, "demo.studio");
});

test("Direct session fallback does not read relationship usernames while the list is loading", async () => {
  const { fixture, advance } = controlledContent({ directOutsideMainProfile: true, quietList: true, shortList: true });
  let reads = 0;
  fixture.document.onDialogOpened = () => {
    const dialog = fixture.document.dialog;
    dialog.contains = (node) => dialog.links.includes(node);
    for (const link of dialog.links) {
      const getAttribute = link.getAttribute.bind(link);
      link.getAttribute = (name) => {
        if (name === "href") reads += 1;
        return getAttribute(name);
      };
    }
  };
  const query = fixture.document.querySelectorAll.bind(fixture.document);
  fixture.document.querySelectorAll = (selector, root = fixture.document) => {
    const result = query(selector, root);
    return root === fixture.document && selector === "a[href]"
      ? [...result, ...(fixture.document.dialog?.links ?? [])] : result;
  };
  await fixture.collector.start(contentStart("direct_final_read"));
  await advance(500);
  assert.equal(reads, 0);
  await advance(6_000);
  assert.equal(reads, 8);
  assert.equal(fixture.terminalMessages[0].result.state, "completed");
  assert.deepEqual(Array.from(fixture.terminalMessages[0].result.followers), ["alice", "bob", "carol"]);
});

test("visibility loss during the final progress acknowledgement delays completion until resume", async () => {
  let release;
  const { fixture, advance } = controlledContent({
    progressResponse(message) {
      if (message.paused === false && fixture.document.openCounts.following && !fixture.document.dialog && !release) {
        return new Promise((resolve) => { release = () => resolve({ type: "instagram.collectionProgress.ack", run_id: message.run_id, accepted: true }); });
      }
    }
  });
  fixture.document.onDialogOpened = (kind) => {
    if (kind !== "following") return;
    const close = fixture.document.dialog.close;
    const original = close.onClick;
    close.onClick = () => {
      original();
      fixture.document.setHidden(true);
      fixture.document.setHidden(false);
    };
  };
  await fixture.collector.start(contentStart("final_visibility"));
  await advance(0);
  assert.equal(typeof release, "function");
  fixture.document.setHidden(true);
  release();
  await advance(0);
  assert.equal(fixture.terminalMessages.length, 0);
  fixture.document.setHidden(false);
  await advance(0);
  assert.equal(fixture.terminalMessages[0].result.state, "completed");
});

test("a low profile count never completes before a delayed list page is loaded", async () => {
  const { fixture, advance } = controlledContent({ virtualized: true });
  const listControl = fixture.document.listControl.bind(fixture.document);
  fixture.document.listControl = (kind) => {
    const control = listControl(kind);
    control.innerText = `1 ${kind}`;
    return control;
  };
  fixture.document.onDialogOpened = () => {};
  const pending = fixture.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: "low_count" });
  await advance(800);
  assert.equal(fixture.document.dialog.kind, "followers");
  fixture.document.revealVirtualizedPage();
  await advance(0);
  assert.equal(fixture.document.dialog.kind, "following");
  fixture.document.revealVirtualizedPage();
  await advance(0);
  const result = await pending;
  assert.equal(result.state, "completed");
  assert.deepEqual(Array.from(result.followers), ["bob", "carol"]);
  assert.deepEqual(fixture.document.openCounts, { followers: 1, following: 1 });
});

test("collection pauses at a hidden quiet tail and resumes without a second full pass", async () => {
  const { fixture, timers, advance } = controlledContent({ quietList: true, shortList: true });
  await fixture.collector.start(contentStart("hidden_tail"));
  await advance(500);
  fixture.document.setHidden(true);
  await advance(60_000);
  assert.equal(fixture.terminalMessages.length, 0);
  assert.equal(timers.size, 0);
  assert.equal(fixture.progress.at(-1).paused, true);
  fixture.document.dialog.links.push(new FixtureNode(fixture.document, { href: "/late_account/" }));
  fixture.document.mutate();
  fixture.document.setHidden(false);
  await advance(7_000);
  assert.equal(fixture.terminalMessages.length, 1);
  assert.equal(fixture.terminalMessages[0].result.state, "completed");
  assert.deepEqual(Array.from(fixture.terminalMessages[0].result.followers), ["alice", "bob", "carol", "late_account"]);
  assert.deepEqual(fixture.document.openCounts, { followers: 1, following: 1 });
  assert.equal(fixture.progress.some((message) => message.paused === false), true);
  assert.equal([...fixture.document.eventListeners.values()].every((listeners) => listeners.size === 0), true);
});

test("a hidden preflight waits for visibility and Stop releases every pause listener", async () => {
  const { fixture, advance } = controlledContent();
  fixture.document.setHidden(true);
  await fixture.collector.start(contentStart("hidden_preflight"));
  await advance(60_000);
  assert.equal(fixture.document.profileClicks, 0);
  assert.equal(fixture.progress.at(-1).stage, "preflight");
  assert.equal(fixture.progress.at(-1).paused, true);
  assert.equal((await fixture.collector.stop({ type: "instagram.collectRelationships.stop", run_id: "hidden_preflight", protocol_version: CONTENT_PROTOCOL_VERSION })).stopped, true);
  fixture.document.setHidden(false);
  await advance(0);
  assert.equal(fixture.terminalMessages.length, 0);
  assert.equal(fixture.document.observers.size, 0);
  assert.equal([...fixture.document.eventListeners.values()].every((listeners) => listeners.size === 0), true);
});

test("a transient session navigation gap is awaited instead of reported as an account switch", async () => {
  let gap = false;
  const { fixture, advance } = controlledContent({
    progressAccepted(message) {
      if (!gap && message.stage === "collecting_followers") {
        gap = true;
        fixture.document.unavailable = true;
        fixture.document.mutate();
      }
      return true;
    }
  });
  await fixture.collector.start(contentStart("session_gap"));
  await advance(500);
  assert.equal(fixture.terminalMessages.length, 0);
  assert.equal(fixture.document.openCounts.followers, 0);
  fixture.document.unavailable = false;
  fixture.document.mutate();
  await advance(0);
  assert.equal(fixture.terminalMessages[0].result.state, "completed");
  assert.deepEqual(fixture.document.openCounts, { followers: 1, following: 1 });
});

test("a permanently loading list fails without handing partial relationships to storage", async () => {
  const { fixture, advance } = controlledContent({ quietList: true, shortList: true });
  const query = fixture.document.querySelectorAll.bind(fixture.document);
  fixture.document.querySelectorAll = (selector, root = fixture.document) => (
    root === fixture.document.dialog && selector === "[role=progressbar], [aria-busy=true], svg[aria-label]"
      ? [new FixtureNode(fixture.document, { role: "progressbar" })] : query(selector, root)
  );
  await fixture.collector.start(contentStart("stalled_loader"));
  await advance(31_000);
  const result = fixture.terminalMessages[0].result;
  assert.equal(result.state, "failed");
  assert.equal(result.error.code, "COLLECTION_FAILED");
  assert.equal(result.followers, null);
  assert.equal(result.following, null);
  assert.equal(fixture.document.openCounts.following, 0);
  assert.equal(fixture.document.observers.size, 0);
});

test("a lazy-loading spinner below the viewport does not block scrolling toward the next page", async () => {
  const { fixture, advance } = controlledContent({ virtualized: true });
  fixture.document.onDialogOpened = () => {
    const container = fixture.document.dialog.container;
    let top = 0;
    Object.defineProperty(container, "scrollTop", {
      get() { return top; },
      set(value) {
        top = value;
        if (top > 0) fixture.document.revealVirtualizedPage();
      }
    });
  };
  const query = fixture.document.querySelectorAll.bind(fixture.document);
  fixture.document.querySelectorAll = (selector, root = fixture.document) => (
    root === fixture.document.dialog && selector === "[role=progressbar], [aria-busy=true], svg[aria-label]" && root.nextLinks
      ? [new FixtureNode(fixture.document, { role: "progressbar" })] : query(selector, root)
  );
  await fixture.collector.start(contentStart("lazy_spinner"));
  await advance(500);
  assert.equal(fixture.terminalMessages.length, 1);
  assert.equal(fixture.terminalMessages[0].result.state, "completed");
  assert.deepEqual(Array.from(fixture.terminalMessages[0].result.followers), ["bob", "carol"]);
});

test("usernames wait for the quiet tail and late DOM rows restart settling without height growth", async () => {
  const { fixture, advance } = controlledContent({ quietList: true, shortList: true });
  const reads = [];
  fixture.document.onDialogOpened = (kind) => {
    const link = fixture.document.dialog.links[0];
    const getAttribute = link.getAttribute.bind(link);
    link.getAttribute = (name) => {
      if (name === "href") reads.push(kind);
      return getAttribute(name);
    };
  };
  await fixture.collector.start(contentStart("quiet_final_read"));
  await advance(900);
  assert.deepEqual(reads, []);
  fixture.document.dialog.links.push(new FixtureNode(fixture.document, { href: "/late_account/" }));
  fixture.document.mutate();
  await advance(200);
  assert.deepEqual(reads, []);
  assert.equal(fixture.terminalMessages.length, 0);
  await advance(2_000);
  assert.deepEqual(reads, ["followers", "following"]);
  assert.equal(fixture.terminalMessages[0].result.state, "completed");
  assert.deepEqual(Array.from(fixture.terminalMessages[0].result.followers), ["alice", "bob", "carol", "late_account"]);
});

test("a quiet tail probes immediately and waits once using elapsed time despite delayed callbacks", async () => {
  const { fixture, advance } = controlledContent({ quietList: true, shortList: true, timerDelayMultiplier: 5 });
  let probes = 0;
  fixture.document.onDialogOpened = () => {
    fixture.document.dialog.dispatchEvent = () => { probes += 1; };
  };
  await fixture.collector.start(contentStart("elapsed_quiet"));
  await advance(0);
  assert.equal(probes, 1);
  await advance(999);
  assert.equal(fixture.document.dialog.kind, "followers");
  await advance(1);
  assert.equal(fixture.document.dialog.kind, "following");
  assert.equal(probes, 2);
  await advance(999);
  assert.equal(fixture.terminalMessages.length, 0);
  await advance(1);
  assert.equal(fixture.terminalMessages[0].result.state, "completed");
});

test("loading triggered by the tail probe restarts the single quiet window after late rows arrive", async () => {
  const { fixture, advance } = controlledContent({ quietList: true, shortList: true });
  let loading = false;
  let probed = false;
  const query = fixture.document.querySelectorAll.bind(fixture.document);
  fixture.document.querySelectorAll = (selector, root = fixture.document) => (
    root === fixture.document.dialog && selector === "[role=progressbar], [aria-busy=true], svg[aria-label]" && loading
      ? [new FixtureNode(fixture.document, { role: "progressbar" })] : query(selector, root)
  );
  fixture.document.onDialogOpened = (kind) => {
    fixture.document.dialog.dispatchEvent = () => {
      if (kind === "followers" && !probed) {
        probed = true;
        loading = true;
        fixture.document.mutate();
      }
    };
  };
  await fixture.collector.start(contentStart("probe_loading"));
  await advance(2_000);
  assert.equal(probed, true);
  assert.equal(fixture.document.dialog.kind, "followers");
  fixture.document.dialog.links.push(new FixtureNode(fixture.document, { href: "/late_account/" }));
  loading = false;
  fixture.document.mutate();
  await advance(999);
  assert.equal(fixture.document.dialog.kind, "followers");
  await advance(1);
  assert.equal(fixture.document.dialog.kind, "following");
  await advance(1_000);
  assert.equal(fixture.terminalMessages[0].result.state, "completed");
  assert.deepEqual(Array.from(fixture.terminalMessages[0].result.followers), ["alice", "bob", "carol", "late_account"]);
});

test("a stalled loader times out using elapsed time despite delayed callbacks", async () => {
  const { fixture, advance } = controlledContent({ quietList: true, shortList: true, timerDelayMultiplier: 5 });
  const query = fixture.document.querySelectorAll.bind(fixture.document);
  fixture.document.querySelectorAll = (selector, root = fixture.document) => (
    root === fixture.document.dialog && selector === "[role=progressbar], [aria-busy=true], svg[aria-label]"
      ? [new FixtureNode(fixture.document, { role: "progressbar" })] : query(selector, root)
  );
  await fixture.collector.start(contentStart("elapsed_stall"));
  await advance(29_999);
  assert.equal(fixture.terminalMessages.length, 0);
  await advance(1);
  assert.equal(fixture.terminalMessages[0].result.state, "failed");
  assert.equal(fixture.terminalMessages[0].result.followers, null);
});

test("bottom jumps advance immediately and read all usernames only after the full list loads", async () => {
  const { fixture, advance } = controlledContent({ quietList: true });
  const pageCount = 8;
  const steps = [];
  const usernameReads = { followers: 0, following: 0 };
  fixture.document.onDialogOpened = (kind) => {
    const dialog = fixture.document.dialog;
    let page = 0;
    let top = 0;
    function accountLink(index) {
      const link = new FixtureNode(fixture.document, { href: `/${kind}_${index}/` });
      const getAttribute = link.getAttribute.bind(link);
      link.getAttribute = (name) => {
        if (name === "href") usernameReads[kind] += 1;
        return getAttribute(name);
      };
      return link;
    }
    dialog.links = [accountLink(0)];
    dialog.container.clientHeight = 100;
    dialog.container.scrollHeight = 200;
    Object.defineProperty(dialog.container, "scrollTop", {
      get() { return top; },
      set(value) {
        steps.push({ target: value, height: dialog.container.scrollHeight, reads: usernameReads[kind] });
        top = Math.min(value, dialog.container.scrollHeight - dialog.container.clientHeight);
        if (top + 100 < dialog.container.scrollHeight || page >= pageCount - 1) return;
        page += 1;
        dialog.links.push(accountLink(page));
        dialog.container.scrollHeight += 100;
        if (page === pageCount - 1) {
          dialog.endMarker = new FixtureNode(fixture.document);
          dialog.endMarker.textContent = "End of list";
        }
        fixture.document.mutate();
      }
    });
  };
  const pending = fixture.collector.collectRelationships({ type: "instagram.collectRelationships", run_id: "many_pages" });
  await advance(0);
  assert.deepEqual(fixture.document.openCounts, { followers: 1, following: 1 });
  const result = await pending;
  assert.equal(result.state, "completed");
  assert.deepEqual(Array.from(result.followers), Array.from({ length: pageCount }, (_, i) => `followers_${i}`));
  assert.deepEqual(Array.from(result.following), Array.from({ length: pageCount }, (_, i) => `following_${i}`));
  assert.equal(steps.length, 2 * (pageCount - 1));
  assert.equal(steps.every(({ target, height, reads }) => target === height && reads === 0), true);
  assert.deepEqual(usernameReads, { followers: pageCount, following: pageCount });
  assert.deepEqual(fixture.document.openCounts, { followers: 1, following: 1 });
});
