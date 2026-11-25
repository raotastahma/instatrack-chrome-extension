import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { buildCompletedSync } from "../src/domain/analytics.js";
import {
  bootstrapDashboard,
  createDashboardController,
  createDomView,
  createInitialDashboardState,
  expandTrendList,
  expandReportList,
  getSyncPresentation,
  renderDashboard
} from "../src/dashboard/dashboard.js";
import { BACKUP_SCHEMA, EARLY_ACCESS_COPY, STORAGE_KEY_NAMES } from "../src/shared/constants.js";

const t1 = { iso: "2026-08-08T14:45:13Z", epoch: 1786200313 };
const t2 = { iso: "2026-08-08T14:46:13Z", epoch: 1786200373 };
const t3 = { iso: "2026-08-08T14:47:13Z", epoch: 1786200433 };
const dashboardSource = readFileSync(resolve("src/dashboard/dashboard.js"), "utf8");
const dashboardShell = readFileSync(resolve("dashboard/index.html"), "utf8");
const dashboardStyles = readFileSync(resolve("src/dashboard/dashboard.css"), "utf8");

function completed(input = {}) {
  return buildCompletedSync(null, {
    run_id: "sync_1",
    started_at: t1,
    finished_at: t1,
    instagram_account: "local_account",
    followers: ["alice", "bob", "dave"],
    following: ["alice", "carol"],
    duration_ms: 1000,
    ...input
  });
}

function populatedState(lastSync = null) {
  const first = completed();
  const second = completed({
    run_id: "sync_2",
    started_at: t2,
    finished_at: t2,
    followers: ["alice", "erin", "frank"],
    following: ["alice", "carol", "gina"]
  });
  second.sync_point.changes = {
    followers_gained: 2,
    followers_lost: 1,
    following_added: 3,
    following_removed: 4
  };
  return {
    instagram_account: "local_account",
    report: second.report,
    sync_points: [first.sync_point, second.sync_point],
    last_sync: lastSync
  };
}

function response(state, requestId) {
  return {
    type: "dashboard.state",
    request_id: requestId,
    ...state
  };
}

function dashboardState(input = {}) {
  return {
    ...createInitialDashboardState(),
    instagramAccount: "local_account",
    ...input
  };
}

function accountState(instagramAccount, { analytics = true, lastSync = null } = {}) {
  const local = populatedState(lastSync);
  return {
    instagram_account: instagramAccount,
    report: analytics ? { ...local.report, instagram_account: instagramAccount } : null,
    sync_points: analytics ? local.sync_points.map((point) => ({ ...point, instagram_account: instagramAccount })) : [],
    last_sync: lastSync
  };
}

function emptyState() {
  return {
    instagram_account: null,
    report: null,
    sync_points: [],
    last_sync: null
  };
}

function immediateFailure(requestId, runId, message, state = "failed") {
  return {
    type: "sync.result",
    request_id: requestId,
    run_id: runId,
    state,
    stage: "preflight",
    started_at: t3,
    finished_at: t3,
    instagram_account: null,
    followers_count: null,
    following_count: null,
    duration_ms: 0,
    sync_point: null,
    report: null,
    error: {
      code: state === "interrupted" ? "COLLECTION_INTERRUPTED" : "NOT_INSTAGRAM",
      message
    }
  };
}

function interruptedLastSync(runId = "run_42") {
  return {
    run_id: runId,
    state: "interrupted",
    stage: "collecting_followers",
    started_at: t2,
    finished_at: t3,
    instagram_account: null,
    followers_count: null,
    following_count: null,
    duration_ms: 60_000,
    error: {
      code: "COLLECTION_INTERRUPTED",
      message: "Sync stopped by the user."
    }
  };
}

function createView() {
  return {
    closed: [],
    dialogs: [],
    downloads: [],
    focused: [],
    renders: [],
    render(state) {
      this.renders.push(structuredClone(state));
    },
    openDialog(name, trigger) {
      this.dialogs.push({ name, trigger });
    },
    closeDialog(name) {
      this.closed.push(name);
    },
    focusTarget(target) {
      this.focused.push(target);
    },
    download(file) {
      this.downloads.push(file);
    }
  };
}

function createRuntime(handler) {
  return {
    calls: [],
    sendMessage(message) {
      this.calls.push(structuredClone(message));
      return handler(message);
    }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createDashboardDocumentFixture() {
  const regionMutations = { live: [], alert: [] };
  const documentListeners = new Map();
  const documentRef = { activeElement: null, visibilityState: "visible",
    defaultView: { IntersectionObserver: class { observe() {} } } };

  function createNode(name, { dataActions = false, region = null, tagName = "DIV" } = {}) {
    let text = "";
    return {
      dataset: {},
      disabled: false,
      hidden: false,
      isConnected: true,
      tagName,
      get textContent() {
        return text;
      },
      set textContent(value) {
        text = value == null ? "" : String(value);
        if (region) regionMutations[region].push(text);
      },
      set innerHTML(value) {
        this.html = String(value);
        if (dataActions && documentRef.activeElement?.dataset?.exportAction) {
          documentRef.activeElement.isConnected = false;
          documentRef.activeElement = documentRef.body;
        }
      },
      append(child) {
        child.isConnected = true;
      },
      addEventListener() {},
      click() {},
      focus() {
        documentRef.activeElement = this;
      },
      getClientRects() {
        return this.hidden ? [] : [{ width: 1, height: 1 }];
      },
      remove() {
        this.isConnected = false;
      },
      replaceChildren(...children) {
        text = children.map((child) => child.textContent ?? "").join("");
        if (region) regionMutations[region].push(text);
      },
      setAttribute(attribute, value) {
        this[attribute] = String(value);
      },
      name
    };
  }

  const stopButton = createNode("stop", { tagName: "BUTTON" });
  const syncButton = createNode("sync", { tagName: "BUTTON" });
  const focusButton = createNode("focus", { tagName: "BUTTON" });
  const nodes = new Map([
    ["[data-early-access]", createNode("early-access")],
    ["[data-account]", createNode("account")],
    ["[data-last-sync-time]", createNode("last-sync-time")],
    ["[data-sync-state]", createNode("sync-state")],
    ["[data-review-panel]", createNode("review-panel")],
    ["[data-analytics-dialog]", createNode("analytics-dialog")],
    ["[data-analytics-toggle]", createNode("analytics-toggle")],
    ["[data-analytics-status]", createNode("analytics-status")],
    ['[data-action="sync"]', syncButton],
    ['[data-action="stop"]', stopButton],
    ['[data-action="focus-sync"]', focusButton],
    ['[data-focus-target="stop-sync"]', stopButton],
    ['[data-focus-target="sync"]', syncButton],
    ["[data-live-status]", createNode("live", { region: "live" })],
    ["[data-alert]", createNode("alert", { region: "alert" })],
    ["[data-overview]", createNode("overview")],
    ["[data-trend]", createNode("trend")],
    ["[data-breakdown]", createNode("breakdown")],
    ["[data-reports]", createNode("reports")],
    ["[data-data-actions]", createNode("data-actions", { dataActions: true })],
    ["[data-import-file]", createNode("import-file", { tagName: "INPUT" })],
    ['[data-focus-target="data-management"]', createNode("data-management", { tagName: "H2" })]
  ]);
  documentRef.body = createNode("body", { tagName: "BODY" });
  documentRef.activeElement = documentRef.body;
  documentRef.createElement = (tagName) => createNode(tagName, { tagName: tagName.toUpperCase() });
  documentRef.createTextNode = (value) => ({ textContent: String(value) });
  documentRef.querySelector = (selector) => nodes.get(selector) ?? null;
  documentRef.querySelectorAll = () => [];
  documentRef.addEventListener = (type, listener) => {
    const listeners = documentListeners.get(type) ?? [];
    listeners.push(listener);
    documentListeners.set(type, listeners);
  };

  return {
    documentRef,
    documentListeners,
    focusExportAction() {
      const action = createNode("export-action", { tagName: "BUTTON" });
      action.dataset.exportAction = "true";
      action.focus();
      return action;
    },
    regionMutations,
    stopButton,
    syncButton,
    stableTarget: nodes.get('[data-focus-target="data-management"]')
  };
}

test("an open dashboard refreshes another context's saved sync without Reload", async () => {
  let canonical = populatedState(interruptedLastSync());
  const runtime = createRuntime((message) => response(canonical, message.request_id));
  runtime.onMessage = { addListener() {} };
  let changed;
  const storage = { onChanged: { addListener(listener) { changed = listener; } } };
  const fixture = createDashboardDocumentFixture();
  const controller = bootstrapDashboard(fixture.documentRef, runtime, storage);
  await controller.refresh();
  assert.equal(controller.getState().lastSync.state, "interrupted");
  canonical = populatedState({ ...interruptedLastSync("incognito_success"), state: "completed", stage: "stored",
    instagram_account: "local_account", followers_count: 3, following_count: 3, error: null });
  assert.equal(typeof changed, "function", "the open dashboard must observe saved account changes");
  const calls = runtime.calls.length;
  await changed({ unrelated: { newValue: true } }, "local");
  await changed({ "instatrack.account.v1.0.local_account": {} }, "sync");
  assert.equal(runtime.calls.length, calls);
  await changed({ "instatrack.account.v1.0.local_account": { newValue: {} } }, "local");
  assert.equal(controller.getState().lastSync.run_id, "incognito_success");
  assert.equal(controller.getState().lastSync.state, "completed");
  assert.deepEqual(controller.getState().syncPoints, canonical.sync_points);
  assert.equal(renderDashboard(controller.getState()).liveMessage, getSyncPresentation(canonical.last_sync).text);
  canonical = populatedState({ ...interruptedLastSync("own_active"), state: "running",
    instagram_account: "local_account", finished_at: null, duration_ms: null, error: null });
  await controller.refresh();
  const activeCalls = runtime.calls.length;
  canonical = populatedState();
  await changed({ "instatrack.account.v1.0.local_account": { newValue: {} } }, "local");
  assert.equal(runtime.calls.length, activeCalls, "an external save must not disrupt this dashboard's active sync");
  assert.equal(controller.getState().lastSync.run_id, "own_active");
});

test("Rate us dismisses the prompt across renders and dashboard openings without telemetry consent", async () => {
  const key = "instatrack.reviewDismissed.v1";
  const values = {};
  const listeners = [];
  const storage = { local: {
    async get() { return { ...values }; },
    async set(next) {
      Object.assign(values, next);
      listeners.forEach((listener) => listener({ [key]: { newValue: values[key] } }, "local"));
    }
  }, onChanged: { addListener(listener) { listeners.push(listener); } } };
  const runtime = createRuntime((message) => response(populatedState(interruptedLastSync()), message.request_id));
  runtime.onMessage = { addListener() {} };
  const first = createDashboardDocumentFixture();
  const controller = bootstrapDashboard(first.documentRef, runtime, storage);
  await controller.refresh();
  const panel = first.documentRef.querySelector("[data-review-panel]");
  assert.equal(panel.hidden, false);
  const other = createDashboardDocumentFixture();
  const otherController = bootstrapDashboard(other.documentRef, runtime, storage);
  await otherController.refresh();
  for (const handler of first.documentListeners.get("click")) {
    handler({ target: { closest(selector) {
      return selector === '[data-telemetry-action="review"]' ? {} : null;
    } } });
  }
  await controller.refresh();
  assert.equal(values[key], true);
  assert.equal(panel.hidden, true, "rerenders must keep the prompt hidden");
  assert.equal(other.documentRef.querySelector("[data-review-panel]").hidden, true, "other open dashboards update too");
  assert.equal(runtime.calls.some((message) => message.type === "telemetry.record"), false);
  const second = createDashboardDocumentFixture();
  const reopened = bootstrapDashboard(second.documentRef, runtime, storage);
  await reopened.refresh();
  assert.equal(second.documentRef.querySelector("[data-review-panel]").hidden, true);
  assert.equal(runtime.calls.some((message) => message.type === "telemetry.setConsent"), false);
});

test("a delayed preference read cannot show the review prompt again after Rate us", async () => {
  const read = deferred();
  const storage = { local: { get: () => read.promise, async set() {} } };
  const runtime = createRuntime((message) => response(populatedState(interruptedLastSync()), message.request_id));
  runtime.onMessage = { addListener() {} };
  const fixture = createDashboardDocumentFixture();
  const controller = bootstrapDashboard(fixture.documentRef, runtime, storage);
  await controller.refresh();
  const panel = fixture.documentRef.querySelector("[data-review-panel]");
  assert.equal(panel.hidden, true, "no prompt flash while loading the preference");
  for (const handler of fixture.documentListeners.get("click")) {
    handler({ target: { closest(selector) {
      return selector === '[data-telemetry-action="review"]' ? {} : null;
    } } });
  }
  read.resolve({});
  await controller.refresh();
  assert.equal(panel.hidden, true);
});

test("a repeat sync keeps the latest successful timestamp and first-sync backup stays disabled", () => {
  const running = { ...interruptedLastSync(), state: "running", finished_at: null, error: null };
  const stored = populatedState(running);
  const view = renderDashboard(dashboardState({ report: stored.report, syncPoints: stored.sync_points, lastSync: running }));
  assert.match(view.lastSyncTime, /^Latest successful sync:/);
  assert.doesNotMatch(view.lastSyncTime, /No sync recorded/);
  const first = renderDashboard({ ...createInitialDashboardState(), lastSync: running });
  assert.match(first.dataActions, /data-action="backup-export" disabled/);
  assert.match(first.dataActions, /data-action="import-backup" disabled/);
});

test("pause presentation offers Return to Instagram and keeps Stop available", () => {
  const paused = { ...interruptedLastSync(), state: "running", finished_at: null, error: null, paused: true };
  const view = renderDashboard(dashboardState({ lastSync: paused }));
  assert.match(view.syncState, /Sync paused\. Return to Instagram to continue\./);
  assert.equal(view.focusButton.hidden, false);
  assert.equal(view.stopButton.hidden, false);
  assert.equal(view.stopButton.disabled, false);
  assert.equal(renderDashboard(dashboardState({ lastSync: { ...paused, paused: false } })).focusButton.hidden, true);
});

test("matching progress refreshes canonical stages and pause without accepting other runs", async () => {
  let running = { ...interruptedLastSync(), state: "running", finished_at: null, error: null };
  const runtime = createRuntime((message) => response(populatedState(running), message.request_id));
  const controller = createDashboardController({ runtime, view: createView() });
  await controller.refresh();
  running = { ...running, stage: "collecting_following", paused: true };
  assert.equal(await controller.handleRuntimeMessage({ type: "sync.progress", run_id: "other", last_sync: running }), false);
  assert.equal(runtime.calls.length, 1);
  assert.equal(await controller.handleRuntimeMessage({ type: "sync.progress", run_id: running.run_id, last_sync: running }), true);
  assert.equal(controller.getState().lastSync.stage, "collecting_following");
  assert.equal(controller.getState().lastSync.paused, true);
  assert.equal(controller.getState().report.instagram_account, "local_account");
  assert.equal(renderDashboard(controller.getState()).liveMessage, "Sync paused. Return to Instagram to continue.");
});

test("Return to Instagram sends the running ID and handles focus rejection without changing analytics", async () => {
  for (const outcome of ["success", "rejected", "uncorrelated", "transport"]) {
    const running = { ...interruptedLastSync(), state: "running", finished_at: null, error: null, paused: true };
    const runtime = createRuntime((message) => {
      if (message.type === "dashboard.getState") return response(populatedState(running), message.request_id);
      assert.deepEqual(message, { type: "sync.focus", request_id: "focus_request", run_id: running.run_id });
      if (outcome === "transport") throw new Error("worker unavailable");
      return {
        type: "sync.focus.result",
        request_id: outcome === "uncorrelated" ? "other" : message.request_id,
        focused: outcome !== "rejected",
        error: outcome === "rejected" ? { code: "COLLECTION_INTERRUPTED", message: "The Instagram tab is no longer available." } : null
      };
    });
    const controller = createDashboardController({ runtime, view: createView(), requestId: () => "focus_request" });
    assert.equal(await controller.focusSync(), false);
    await controller.refresh();
    assert.equal(await controller.focusSync(), outcome === "success");
    assert.equal(controller.getState().syncPoints.length, 2);
    assert.equal(controller.getState().focusPending, false);
    if (outcome === "rejected") assert.equal(renderDashboard(controller.getState()).alertMessage, "The Instagram tab is no longer available.");
  }
});

test("per-sync deletion requires confirmation, pins the account and refreshes retained analytics", async () => {
  let stored = populatedState();
  const retained = { ...stored, sync_points: stored.sync_points.slice(1) };
  const runtime = createRuntime((message) => {
    if (message.type === "dashboard.getState") return response(stored, message.request_id);
    assert.deepEqual(message, { type: "history.deleteSync", request_id: "delete_request", instagram_account: "local_account", run_id: "sync_1", confirm: true });
    stored = retained;
    return { type: "history.deleteSync.result", request_id: message.request_id, deleted: true, error: null };
  });
  const view = createView();
  const controller = createDashboardController({ runtime, view, requestId: () => "delete_request" });
  await controller.refresh();
  assert.equal(controller.openDeleteSync("other_account", "sync_1", "delete"), false);
  assert.equal(controller.openDeleteSync("local_account", "missing", "delete"), false);
  assert.equal(controller.openDeleteSync("local_account", "sync_1", "delete"), true);
  controller.cancelDialog("delete-sync");
  assert.equal(await controller.confirmDeleteSync(), false);
  assert.equal(runtime.calls.length, 1);
  assert.equal(controller.openDeleteSync("local_account", "sync_1", "delete"), true);
  assert.equal(await controller.confirmDeleteSync(), true);
  assert.deepEqual(controller.getState().syncPoints, retained.sync_points);
  assert.equal(view.focused.at(-1), "history");
  assert.match(renderDashboard(controller.getState()).liveMessage, /Sync deleted/);
});

test("per-sync deletion failures preserve analytics and release the controls", async () => {
  for (const outcome of ["rejected", "uncorrelated", "transport"]) {
    const stored = populatedState();
    const runtime = createRuntime((message) => {
      if (message.type === "dashboard.getState") return response(stored, message.request_id);
      if (outcome === "transport") throw new Error("worker unavailable");
      return { type: "history.deleteSync.result", request_id: outcome === "uncorrelated" ? "other" : message.request_id, deleted: false, error: { code: "STORAGE_ERROR", message: "Unable to save local history." } };
    });
    const controller = createDashboardController({ runtime, view: createView() });
    await controller.refresh();
    controller.openDeleteSync("local_account", "sync_1", "delete");
    assert.equal(await controller.confirmDeleteSync(), false);
    assert.deepEqual(controller.getState().syncPoints, stored.sync_points);
    assert.equal(controller.getState().dataMutationPending, false);
    assert.equal(runtime.calls.filter((message) => message.type === "dashboard.getState").length, 1);
    if (outcome === "rejected") assert.equal(renderDashboard(controller.getState()).alertMessage, "Unable to save local history.");
  }
});

test("active Sync blocks import and deletion, including confirmations and a pending file read", async () => {
  let stored = populatedState();
  const runtime = createRuntime((message) => {
    assert.equal(message.type, "dashboard.getState");
    return response(stored, message.request_id);
  });
  const controller = createDashboardController({ runtime, view: createView() });
  const local = completed();
  const backup = JSON.stringify({ schema: BACKUP_SCHEMA, exported_at: t2, history: local.history, report: local.report, last_sync: null });
  await controller.refresh();
  await controller.openImport({ text: async () => backup }, "import");
  controller.openDeleteSync("local_account", "sync_1", "delete");
  const reading = deferred();
  const opening = controller.openImport({ text: () => reading.promise }, "import");
  stored = { ...stored, last_sync: { ...interruptedLastSync(), state: "running", finished_at: null, error: null } };
  await controller.refresh();
  reading.resolve(backup);
  assert.equal(await opening, false);
  assert.equal(await controller.confirmImport(), false);
  assert.equal(await controller.confirmDeleteSync(), false);
  assert.equal(controller.openDeleteSync("local_account", "sync_1", "delete"), false);
  assert.equal(await controller.openImport({ text: async () => backup }, "import"), false);
  assert.match(renderDashboard(controller.getState()).dataActions, /data-action="import-backup" disabled/);
});

test("canonical first failure remains visible with empty or previous successful analytics", async () => {
  for (const analytics of [false, true]) {
    const lastSync = { ...interruptedLastSync(), instagram_account: "new_account" };
    const canonical = { ...(analytics ? populatedState() : emptyState()), last_sync: lastSync };
    const controller = createDashboardController({ runtime: createRuntime((message) => response(canonical, message.request_id)), view: createView() });
    await controller.refresh();
    const view = renderDashboard(controller.getState());
    assert.match(view.alertMessage, /Sync interrupted/);
    assert.equal(view.syncButton.label, "Retry sync");
    assert.equal(controller.getState().syncPoints.length, analytics ? 2 : 0);
    assert.equal(controller.getState().instagramAccount, analytics ? "local_account" : null);
  }
});

test("unchanged analytics retain expanded DOM across download feedback and progress refresh", async () => {
  const fixture = createDashboardDocumentFixture();
  const stored = populatedState();
  const runtime = createRuntime((message) => message.type === "dashboard.getState"
    ? response(structuredClone(stored), message.request_id)
    : exportOutcome(exportOperations.find((operation) => operation.requestType === message.type), message, "success"));
  const controller = createDashboardController({
    runtime,
    view: createDomView(fixture.documentRef, {
      objectUrls: { createObjectURL: () => "blob:local", revokeObjectURL() {} },
      defer: (callback) => callback()
    })
  });
  await controller.refresh();
  const reports = fixture.documentRef.querySelector("[data-reports]");
  const trend = fixture.documentRef.querySelector("[data-trend]");
  // A rerender replaces the rows and their expanded state, just as innerHTML does in Chrome.
  reports.html = "expanded report rows";
  trend.html = "expanded history rows";
  for (const operation of exportOperations) {
    await controller[operation.method]();
    assert.equal(reports.html, "expanded report rows");
    assert.equal(trend.html, "expanded history rows");
  }
  await controller.refresh();
  assert.equal(reports.html, "expanded report rows");
  assert.equal(trend.html, "expanded history rows");
});

const exportOperations = [
  { label: "CSV", method: "exportReportCsv", requestType: "report.export", responseType: "report.export.result", filename: "report.csv", mimeType: "text/csv" },
  { label: "JSON", method: "exportReportJson", requestType: "report.export", responseType: "report.export.result", filename: "report.json", mimeType: "application/json" },
  { label: "backup", method: "exportBackup", requestType: "backup.export", responseType: "backup.export.result", filename: "backup.json", mimeType: "application/json" }
];

function exportOutcome(operation, message, outcome) {
  if (outcome === "transport") {
    throw new Error("temporary local export failure");
  }
  if (outcome === "invalid-type") {
    return { type: "wrong.export.result", request_id: message.request_id };
  }
  if (outcome === "invalid-request") {
    return { type: operation.responseType, request_id: `${message.request_id}_wrong` };
  }
  if (outcome === "worker-error") {
    return {
      type: operation.responseType,
      request_id: message.request_id,
      filename: null,
      mime_type: null,
      body: null,
      error: { code: "STORAGE_ERROR", message: "Local export failed." }
    };
  }
  return {
    type: operation.responseType,
    request_id: message.request_id,
    filename: operation.filename,
    mime_type: operation.mimeType,
    body: "local export",
    error: null
  };
}

test("dashboard renders exact local-only copy, semantic sections, all report groups, and no storage labels", () => {
  const empty = renderDashboard(createInitialDashboardState());
  const one = renderDashboard({
    ...createInitialDashboardState(),
    instagramAccount: "local_account",
    syncPoints: [populatedState().sync_points[0]]
  });
  const full = renderDashboard({
    instagramAccount: "local_account",
    report: populatedState().report,
    syncPoints: populatedState().sync_points,
    lastSync: null,
    feedback: null
  });

  assert.equal(EARLY_ACCESS_COPY, "Free during early access");
  assert.match(dashboardShell, />Free during early access<\/p>/);
  assert.match(dashboardShell, /Instagram usernames, relationship lists and reports stay in this browser\./);
  assert.match(dashboardShell, /data-analytics-dialog/);
  assert.match(dashboardShell, /Questions and suggestions:.*mailto:support@example\.invalid/);
  assert.match(dashboardShell, /<p class="sync-description">Sync your logged-in Instagram account\.<\/p>/);
  assert.match(dashboardShell, /<p class="sync-title" id="sync-title">No Instagram password required<\/p>/);
  assert.doesNotMatch(dashboardShell, /Manual collection/i);
  assert.match(dashboardShell, /data-action="sync" data-focus-target="sync"/);
  assert.match(dashboardShell, /data-action="stop"[\s\S]*hidden>Stop sync<\/button>/);
  assert.match(dashboardShell, /Reset all local data\?/);
  assert.match(dashboardShell, /This stops any active sync and permanently removes/);
  assert.match(dashboardShell, /Downloaded CSV and JSON files stay on your device\. Your usage analytics preference is kept; change it in the dashboard footer\. This action cannot be undone\./);
  assert.match(dashboardShell, /Overview[\s\S]*Analytics[\s\S]*Reports[\s\S]*Data management/);
  assert.match(empty.trend, /Trend will appear after your first successful sync\./);
  assert.match(one.trend, /Trend appears after one more successful sync\./);
  assert.match(full.trend, /Followers &amp; following trend/);
  assert.match(full.breakdown, /Mutual follows[\s\S]*Not following back[\s\S]*Followers not followed back/);
  assert.doesNotMatch(full.breakdown, /Relationship breakdown values|breakdown-table/);
  assert.equal((full.reports.match(/No usernames in this group\./g) ?? []).length, 4);
  assert.match(full.reports, /@carol/);
  assert.match(full.overview, /New Followers[\s\S]*Unfollowed Me[\s\S]*I Followed[\s\S]*I Unfollowed/);
  assert.match(full.reports, /New Followers[\s\S]*Unfollowed Me[\s\S]*I Followed[\s\S]*I Unfollowed[\s\S]*Not Following Back[\s\S]*Followers I Don&#39;t Follow Back/);
  assert.match(dashboardShell, /Detected between syncs, not the exact Instagram event time\./);
  assert.equal((dashboardShell.match(/Detected between syncs, not the exact Instagram event time\./g) ?? []).length, 1);
  assert.doesNotMatch(dashboardShell, /When a change was found|data-dialog="detection"/);
  assert.doesNotMatch(full.reports, /data-action="detection-info"|info-button/);
  assert.doesNotMatch(full.overview, />\s*[A-E]\s*</, "dashboard output must not expose storage count labels");
});

test("all six detected-change groups initially show at most ten rows and reveal one hundred per action", () => {
  const items = Array.from({ length: 215 }, (_, index) => ({
    username: `account_${String(index).padStart(3, "0")}`,
    detected_at: t3
  }));
  const report = {
    ...populatedState().report,
    following_not_following_back: items,
    unfollowed_me: items,
    followers_i_dont_follow_back: items,
    i_followed: items,
    i_unfollowed: items,
    new_followers: items
  };
  const markup = renderDashboard({
    ...createInitialDashboardState(),
    instagramAccount: "local_account",
    report
  }).reports;

  assert.equal((markup.match(/<article class="report-card">/g) ?? []).length, 6);
  assert.equal((markup.match(/<li data-report-row>/g) ?? []).length, 60);
  assert.equal((markup.match(/<li data-report-row hidden>/g) ?? []).length, 1_230);
  assert.equal((markup.match(/data-action="show-more-report"/g) ?? []).length, 6);
  assert.equal((markup.match(/>Show 100 more<\/button>/g) ?? []).length, 6);

  const rows = Array.from({ length: 215 }, (_, index) => ({ hidden: index >= 10 }));
  const status = { textContent: "Showing 10 of 215" };
  const attributes = {};
  const card = {
    querySelector(selector) {
      return selector === "[data-report-status]" ? status : null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-report-row][hidden]") {
        return rows.filter((row) => row.hidden);
      }
      assert.equal(selector, "[data-report-row]");
      return rows;
    }
  };
  const button = {
    dataset: { reportLabel: "I Followed", reportTotal: "215" },
    disabled: false,
    textContent: "Show 100 more",
    closest(selector) {
      return selector === ".report-card" ? card : null;
    },
    setAttribute(name, value) {
      attributes[name] = String(value);
    }
  };

  assert.equal(expandReportList(button), true);
  assert.equal(rows.filter((row) => !row.hidden).length, 110);
  assert.equal(status.textContent, "Showing 110 of 215");
  assert.equal(button.textContent, "Show 100 more");

  assert.equal(expandReportList(button), true);
  assert.equal(rows.filter((row) => !row.hidden).length, 210);
  assert.equal(status.textContent, "Showing 210 of 215");
  assert.equal(button.textContent, "Show 5 more");

  assert.equal(expandReportList(button), true);
  assert.equal(rows.filter((row) => !row.hidden).length, 215);
  assert.equal(status.textContent, "Showing all 215");
  assert.equal(button.textContent, "Hide");
  assert.equal(button.disabled, false);
  assert.equal(attributes["aria-label"], "Hide extra usernames in I Followed");

  assert.equal(expandReportList(button), true);
  assert.equal(rows.filter((row) => !row.hidden).length, 10);
  assert.equal(status.textContent, "Showing 10 of 215");
  assert.equal(button.textContent, "Show 100 more");
  assert.equal(attributes["aria-label"], "Show 100 more usernames in I Followed");
});

test("all six detected-change groups show newest accounts first", () => {
  const items = [
    { username: "oldest", detected_at: t1 },
    { username: "zulu", detected_at: t3 },
    { username: "middle", detected_at: t2 },
    { username: "alpha", detected_at: t3 }
  ];
  const report = {
    ...populatedState().report,
    following_not_following_back: items,
    unfollowed_me: items,
    followers_i_dont_follow_back: items,
    i_followed: items,
    i_unfollowed: items,
    new_followers: items
  };
  const cards = renderDashboard({
    ...createInitialDashboardState(),
    instagramAccount: "local_account",
    report
  }).reports
    .split('<article class="report-card">')
    .slice(1);

  assert.equal(cards.length, 6);
  for (const card of cards) {
    const usernames = [...card.matchAll(/class="account-link"[^>]*>@([^<]+)<\/a>/g)].map((match) => match[1]);
    assert.deepEqual(usernames, ["alpha", "zulu", "middle", "oldest"]);
  }
});

test("every dashboard account links directly to its Instagram profile without tracking parameters", () => {
  const state = populatedState();
  const rendered = renderDashboard(dashboardState({
    report: state.report,
    syncPoints: state.sync_points,
    lastSync: state.last_sync,
    feedback: null
  }));
  const markup = [rendered.accountMarkup, rendered.overview, rendered.reports].join("\n");
  const links = [...markup.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);

  assert.equal(links.length > 2, true);
  assert.equal(links.every((href) => /^https:\/\/www\.instagram\.com\/[a-z0-9._]+\/$/.test(href)), true);
  assert.equal(links.every((href) => !href.includes("?") && !href.includes("#")), true);
  assert.match(rendered.accountMarkup, /Instagram account: <a[^>]+>@local_account<\/a>/);
  assert.match(rendered.overview, /<a[^>]+>@local_account<\/a>/);
  assert.match(rendered.reports, /<a[^>]+>@carol<\/a>/);
});

test("overview preserves whole words and gives the metric cards more width", () => {
  assert.match(dashboardStyles, /\.overview-grid\s*\{[^}]*grid-template-columns:\s*minmax\(240px, 0\.8fr\) minmax\(0, 2\.2fr\)/s);
  assert.match(dashboardStyles, /\.metric-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(120px, 1fr\)\)/s);
  assert.match(dashboardStyles, /\.overview-grid[^\{]*\{[^}]*overflow-wrap:\s*normal/s);
  assert.match(dashboardStyles, /\.overview-grid[^\{]*\{[^}]*word-break:\s*normal/s);
});

test("analytics contains only the trend and relationship cards", () => {
  assert.equal((dashboardShell.match(/<article class="analytics-card /g) ?? []).length, 2);
  assert.doesNotMatch(dashboardShell, /data-changes|changes-card/);
  assert.equal(Object.hasOwn(renderDashboard(createInitialDashboardState()), "changes"), false);
});

test("short trend history shows all successful local sync points without an expansion button", () => {
  for (const count of [0, 1, 5]) {
    const points = Array.from({ length: count }, () => populatedState().sync_points[0]);
    const markup = renderDashboard({
      ...createInitialDashboardState(),
      instagramAccount: "local_account",
      syncPoints: points
    }).trend;
    assert.equal((markup.match(/<tr data-trend-row>/g) ?? []).length, count);
    assert.doesNotMatch(markup, /data-action="show-more-trend"|data-trend-row hidden/);
  }
});

test("trend shares one vertical domain", () => {
  const points = [
    { ...populatedState().sync_points[0], followers_count: 1000, following_count: 10 },
    { ...populatedState().sync_points[1], followers_count: 1001, following_count: 20 }
  ];
  const rendered = renderDashboard(dashboardState({ report: populatedState().report, syncPoints: points, lastSync: null, feedback: null }));
  const paths = [...rendered.trend.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]);

  assert.equal(paths.length, 2);
  assert.notEqual(paths[0], paths[1], "followers and following must not each consume the full chart height");
});

test("trend shows the latest five syncs and expands or collapses the remaining history", () => {
  const points = Array.from({ length: 13 }, (_, index) => {
    const epoch = t1.epoch + index * 60;
    const takenAt = { iso: new Date(epoch * 1000).toISOString().replace(".000Z", "Z"), epoch };
    return {
      ...populatedState().sync_points[index % 2],
      run_id: `history_${index}`,
      taken_at: takenAt,
      followers_count: 1000 + index,
      following_count: 2000 + index
    };
  });
  const markup = renderDashboard(dashboardState({ report: populatedState().report, syncPoints: points, lastSync: null, feedback: null })).trend;

  assert.equal((markup.match(/<tr data-trend-row>/g) ?? []).length, 5);
  assert.equal((markup.match(/<tr data-trend-row hidden>/g) ?? []).length, 8);
  assert.match(markup, /Showing 5 of 13/);
  const visibleFollowers = [...markup.matchAll(/<tr data-trend-row><th[^>]*>[^<]*<\/th><td>([^<]*)<\/td>/g)].map((match) => match[1]);
  assert.deepEqual(visibleFollowers, ["1,012", "1,011", "1,010", "1,009", "1,008"]);
  assert.equal(points[0].run_id, "history_0", "rendering must preserve chronological chart data");
  assert.match(markup, /trend across 13 successful syncs/);
  assert.match(markup, /data-action="show-more-trend"[\s\S]*>Show 8 more<\/button>/);

  const rows = Array.from({ length: 13 }, (_, index) => ({ hidden: index >= 5 }));
  const status = { textContent: "Showing 5 of 13" };
  const attributes = {};
  const container = {
    querySelector(selector) {
      return selector === "[data-trend-status]" ? status : null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-trend-row][hidden]") {
        return rows.filter((row) => row.hidden);
      }
      assert.equal(selector, "[data-trend-row]");
      return rows;
    }
  };
  const button = {
    dataset: { trendTotal: "13" },
    disabled: false,
    textContent: "Show 8 more",
    closest(selector) {
      return selector === "[data-trend-values]" ? container : null;
    },
    setAttribute(name, value) {
      attributes[name] = String(value);
    }
  };

  assert.equal(expandTrendList(button), true);
  assert.equal(rows.filter((row) => !row.hidden).length, 13);
  assert.equal(status.textContent, "Showing all 13");
  assert.equal(button.textContent, "Hide");
  assert.equal(attributes["aria-label"], "Hide extra sync rows");
  assert.equal(expandTrendList(button), true);
  assert.equal(rows.filter((row) => !row.hidden).length, 5);
  assert.equal(status.textContent, "Showing 5 of 13");
  assert.equal(button.textContent, "Show 8 more");
  assert.equal(attributes["aria-label"], "Show 8 more sync rows");
});

test("failed and interrupted sync presentation retains exact local diagnostics and a retry", () => {
  const failed = getSyncPresentation({
    state: "failed",
    duration_ms: 8000,
    followers_count: 12,
    following_count: 11,
    error: { message: "The Instagram tab is no longer available." }
  });
  const interrupted = getSyncPresentation({
    state: "interrupted",
    duration_ms: null,
    followers_count: null,
    following_count: null,
    error: { message: "Collection stopped before both lists completed." }
  });

  assert.equal(failed.button, "Retry sync");
  assert.equal(failed.alert, "Sync failed: The Instagram tab is no longer available. Duration: 8 sec · Followers: 12 · Following: 11");
  assert.equal(interrupted.button, "Retry sync");
  assert.equal(interrupted.alert, "Sync interrupted: Collection stopped before both lists completed.");
});

test("Instagram-tab sync presentation preserves the worker's exact retry copy", () => {
  const requiredTab = getSyncPresentation({
    state: "failed",
    duration_ms: 1000,
    followers_count: null,
    following_count: null,
    error: { code: "NOT_LOGGED_IN", message: "Open Instagram in a tab, sign in, and retry" }
  });

  assert.equal(requiredTab.text, "Instagram tab required.");
  assert.equal(requiredTab.alert, "Sync failed: Open Instagram in a tab, sign in, and retry");
  assert.equal(requiredTab.button, "Retry sync");
});

test("dashboard starts from stored history with zeroes, Sync, import, and reset available", async () => {
  const rendered = renderDashboard(createInitialDashboardState());
  assert.equal(rendered.accountMarkup, "Instagram account appears after your first sync.");
  assert.match(rendered.overview, /Followers<\/span><strong>0<\/strong>/);
  assert.match(rendered.overview, /Following<\/span><strong>0<\/strong>/);
  assert.equal(rendered.syncButton.disabled, false);
  assert.match(rendered.dataActions, /data-action="export-csv" disabled/);
  assert.match(rendered.dataActions, /data-action="backup-export" disabled/);
  assert.doesNotMatch(rendered.dataActions, /data-action="import-backup" disabled/);
  assert.doesNotMatch(rendered.dataActions, /data-action="reset" disabled/);

  const backup = JSON.stringify({ schema: BACKUP_SCHEMA, exported_at: t2, history: completed().history, report: completed().report, last_sync: null });
  const view = createView();
  const controller = createDashboardController({ runtime: createRuntime(() => { throw new Error("No request expected"); }), view });
  assert.equal(await controller.openImport({ text: async () => backup }, "import"), true);
  assert.deepEqual(view.dialogs, [{ name: "import", trigger: "import" }]);
});

test("dashboard state displays the last successfully synced account history", async () => {
  const controller = createDashboardController({
    runtime: createRuntime((message) => response(accountState("account_a"), message.request_id)),
    view: createView(),
    requestId: () => "stored_state"
  });

  await controller.refresh();
  assert.equal(controller.getState().instagramAccount, "account_a");
  assert.equal(controller.getState().report.instagram_account, "account_a");
  assert.equal(controller.getState().syncPoints.length, 2);
});

test("an existing-tab failure keeps the worker's exact retry feedback", async () => {
  const runtime = createRuntime((message) => {
    if (message.type === "dashboard.getState") {
      return response(emptyState(), message.request_id);
    }
    if (message.type === "sync.start") {
      return {
        ...immediateFailure(message.request_id, "tab_required_run", "Open Instagram in a tab, sign in, and retry"),
        duration_ms: null,
        error: { code: "NOT_LOGGED_IN", message: "Open Instagram in a tab, sign in, and retry" }
      };
    }
    throw new Error(`Unexpected message ${message.type}`);
  });
  const controller = createDashboardController({ runtime, view: createView(), requestId: () => "login_required" });

  await controller.refresh();
  assert.equal(await controller.startSync(), true);
  assert.equal(renderDashboard(controller.getState()).alertMessage, "Sync failed: Open Instagram in a tab, sign in, and retry");
});

test("an unsaved Instagram loading failure remains visible after refreshing successful history", async () => {
  const runtime = createRuntime((message) => message.type === "dashboard.getState"
    ? response(populatedState(), message.request_id)
    : { ...immediateFailure(message.request_id, "loading_failed", "Unable to load Instagram. Check the Instagram tab and retry."),
      error: { code: "CURRENT_ACCOUNT_UNAVAILABLE", message: "Unable to load Instagram. Check the Instagram tab and retry." } });
  const controller = createDashboardController({ runtime, view: createView(), requestId: () => "loading_failed" });
  await controller.refresh();
  assert.equal(await controller.startSync(), true);
  assert.match(renderDashboard(controller.getState()).alertMessage, /Sync failed: Unable to load Instagram/);
  assert.equal(controller.getState().syncPoints.length, 2);
});

test("the newest stored-history refresh wins when an older response arrives late", async () => {
  const first = deferred();
  const second = deferred();
  let reads = 0;
  const controller = createDashboardController({
    runtime: createRuntime((message) => {
      reads += 1;
      return reads === 1 ? first.promise : second.promise;
    }),
    view: createView(),
    requestId: () => `refresh_${reads}`
  });

  const olderRefresh = controller.refresh();
  const newerRefresh = controller.refresh();
  second.resolve(response(emptyState(), "refresh_1"));
  await newerRefresh;
  first.resolve(response(accountState("account_a"), "refresh_0"));
  assert.equal(await olderRefresh, null);
  assert.equal(controller.getState().instagramAccount, null);
  assert.equal(controller.getState().report, null);
});

test("cancelled sync presentation reports cancellation time and duration", () => {
  const cancelled = getSyncPresentation({
    ...interruptedLastSync("run_cancelled"),
    finished_at: t3,
    duration_ms: 120_000,
    error: { code: "COLLECTION_INTERRUPTED", message: "Sync cancelled by you." }
  });

  assert.equal(cancelled.text, "Sync cancelled. Retry when you are ready.");
  assert.match(cancelled.alert, /^Sync cancelled at .+\. Duration: 120 sec$/);
  assert.equal(cancelled.button, "Retry sync");
});

test("running sync exposes a separate accessible stop action and pending stop state", () => {
  const running = {
    ...interruptedLastSync("run_stop_ui"),
    state: "running",
    finished_at: null,
    duration_ms: null,
    error: null
  };
  const visible = renderDashboard(dashboardState({ lastSync: running }));
  const pending = renderDashboard(dashboardState({ lastSync: running, stopPending: true }));

  assert.deepEqual(visible.stopButton, { label: "Stop sync", disabled: false, hidden: false });
  assert.equal(visible.syncButton.disabled, true);
  assert.deepEqual(pending.stopButton, { label: "Stopping…", disabled: true, hidden: false });
  assert.match(pending.syncState, /Stopping local sync/);
});

test("stop sends one exact run-correlated request and applies only an exact interrupted success", async () => {
  const running = {
    ...interruptedLastSync("run_stop"),
    state: "running",
    finished_at: null,
    duration_ms: null,
    error: null
  };
  const stopResponse = deferred();
  const runtime = createRuntime((message) => {
    if (message.type === "dashboard.getState") {
      return response(populatedState(running), message.request_id);
    }
    if (message.type === "sync.stop") {
      return stopResponse.promise;
    }
    throw new Error(`Unexpected message ${message.type}`);
  });
  const fixture = createDashboardDocumentFixture();
  const view = createDomView(fixture.documentRef);
  const controller = createDashboardController({ runtime, view, requestId: () => "stop_request" });
  await controller.refresh();

  const stopping = controller.stopSync();
  assert.deepEqual(runtime.calls.at(-1), { type: "sync.stop", request_id: "stop_request", run_id: "run_stop" });
  assert.equal(await controller.stopSync(), false, "a pending stop suppresses duplicate requests");
  assert.equal(renderDashboard(controller.getState()).stopButton.disabled, true);
  stopResponse.resolve({
    type: "sync.stop.result",
    request_id: "stop_request",
    run_id: "run_stop",
    stopped: true,
    last_sync: interruptedLastSync("run_stop"),
    error: null
  });

  assert.equal(await stopping, true);
  assert.equal(runtime.calls.filter((message) => message.type === "sync.stop").length, 1);
  assert.equal(controller.getState().lastSync.state, "interrupted");
  assert.equal(renderDashboard(controller.getState()).stopButton.hidden, true);
  assert.equal(renderDashboard(controller.getState()).liveMessage, "Sync stopped. Existing analytics were kept.");
  assert.equal(fixture.documentRef.activeElement, fixture.syncButton);
  assert.equal(fixture.syncButton.tagName, "BUTTON");
  assert.equal(fixture.syncButton.textContent, "Retry sync");
  assert.equal(fixture.syncButton.disabled, false);
});

test("every stop failure preserves the running state, re-enables Stop, and restores its focus", async () => {
  for (const outcome of ["transport", "wrong-run", "extra-key", "worker-error"]) {
    const running = {
      ...interruptedLastSync("run_stop_failure"),
      state: "running",
      finished_at: null,
      duration_ms: null,
      error: null
    };
    const fixture = createDashboardDocumentFixture();
    const runtime = createRuntime((message) => {
      if (message.type === "dashboard.getState") {
        return response(populatedState(running), message.request_id);
      }
      if (outcome === "transport") {
        throw new Error("stop transport failed");
      }
      const base = {
        type: "sync.stop.result",
        request_id: message.request_id,
        run_id: outcome === "wrong-run" ? "another_run" : running.run_id,
        stopped: outcome !== "worker-error",
        last_sync: interruptedLastSync(running.run_id),
        error: outcome === "worker-error" ? { code: "STOP_FAILED", message: "The collector could not be stopped." } : null
      };
      return outcome === "extra-key" ? { ...base, unexpected: true } : base;
    });
    const controller = createDashboardController({
      runtime,
      view: createDomView(fixture.documentRef),
      requestId: () => `stop_${outcome}`
    });
    await controller.refresh();

    assert.equal(await controller.stopSync(), false, outcome);
    assert.equal(controller.getState().lastSync.state, "running", outcome);
    assert.equal(fixture.stopButton.hidden, false, outcome);
    assert.equal(fixture.stopButton.disabled, false, outcome);
    assert.equal(fixture.documentRef.activeElement, fixture.stopButton, outcome);
    assert.equal(fixture.regionMutations.alert.at(-1), outcome === "worker-error" ? "The collector could not be stopped." : "Unable to stop the local sync.");
  }
});

test("a correlated rejected stop canonicalizes a terminal that won first and focuses the actionable sync button", async () => {
  const running = {
    ...interruptedLastSync("terminal_won"),
    state: "running",
    finished_at: null,
    duration_ms: null,
    error: null
  };
  const completedLastSync = {
    run_id: running.run_id,
    state: "completed",
    stage: "stored",
    started_at: running.started_at,
    finished_at: t3,
    instagram_account: "local_account",
    followers_count: 3,
    following_count: 2,
    duration_ms: 60_000,
    error: null
  };
  let current = populatedState(running);
  const runtime = createRuntime((message) => {
    if (message.type === "dashboard.getState") {
      return response(current, message.request_id);
    }
    if (message.type === "sync.stop") {
      current = { ...current, last_sync: completedLastSync };
      return {
        type: "sync.stop.result",
        request_id: message.request_id,
        run_id: message.run_id,
        stopped: false,
        last_sync: completedLastSync,
        error: { code: "COLLECTION_INTERRUPTED", message: "That sync is no longer running." }
      };
    }
    throw new Error(`Unexpected message ${message.type}`);
  });
  const fixture = createDashboardDocumentFixture();
  const controller = createDashboardController({ runtime, view: createDomView(fixture.documentRef), requestId: () => "terminal_stop" });
  await controller.refresh();

  assert.equal(await controller.stopSync(), false);
  assert.equal(runtime.calls.filter((message) => message.type === "dashboard.getState").length, 2, "rejected stop must refresh canonical state");
  assert.equal(controller.getState().lastSync.state, "completed");
  assert.equal(fixture.stopButton.hidden, true);
  assert.equal(fixture.syncButton.textContent, "Sync now");
  assert.equal(fixture.syncButton.disabled, false);
  assert.equal(fixture.documentRef.activeElement, fixture.syncButton);
  assert.equal(fixture.regionMutations.alert.at(-1), "That sync is no longer running.");
});

test("running prevents duplicate starts and matching terminal broadcasts refresh by run ID without requiring request ID", async () => {
  const startState = populatedState();
  let current = { ...startState, last_sync: null };
  const runtime = createRuntime((message) => {
    if (message.type === "dashboard.getState") {
      return response(current, message.request_id);
    }
    if (message.type === "sync.start") {
      current = {
        ...startState,
        last_sync: {
          run_id: "run_42",
          state: "running",
          stage: "preflight",
          started_at: t3,
          finished_at: null,
          instagram_account: null,
          followers_count: null,
          following_count: null,
          duration_ms: null,
          error: null
        }
      };
      return { type: "sync.accepted", request_id: message.request_id, state: "running", run_id: "run_42", started_at: t3, stage: "preflight", recovered: false };
    }
    throw new Error(`Unexpected message ${message.type}`);
  });
  const view = createView();
  const controller = createDashboardController({ runtime, view, requestId: () => "request_id", now: () => new Date(t3.iso) });

  await controller.refresh();
  assert.equal(await controller.startSync(), true);
  assert.match(renderDashboard(controller.getState()).liveMessage, /Starting local sync/);
  assert.equal(await controller.startSync(), false);
  assert.equal(runtime.calls.filter((message) => message.type === "sync.start").length, 1);
  assert.equal(controller.getState().report.instagram_account, startState.report.instagram_account, "running preserves prior analytics");
  assert.equal(await controller.handleRuntimeMessage({ type: "sync.result", run_id: "different_run", request_id: "request_id", state: "completed" }), false);

  current = {
    ...startState,
    last_sync: {
      run_id: "run_42",
      state: "completed",
      stage: "stored",
      started_at: t3,
      finished_at: t3,
      instagram_account: "local_account",
      followers_count: 3,
      following_count: 2,
      duration_ms: 0,
      error: null
    }
  };
  assert.equal(await controller.handleRuntimeMessage({ type: "sync.result", run_id: "run_42", request_id: "unrelated_terminal_id", state: "completed" }), true);
  assert.equal(runtime.calls.filter((message) => message.type === "dashboard.getState").length, 3, "accepted and terminal results trigger local state refreshes");
  assert.equal(controller.getState().lastSync.state, "completed");
  const completedView = renderDashboard(controller.getState());
  assert.match(completedView.liveMessage, /Completed locally/);
  assert.match(completedView.syncState, /Completed locally/);
  assert.match(completedView.reviewPanel, /Thank you for using Followers Tracker Pro/);
  assert.match(completedView.reviewPanel, /href="https:\/\/chromewebstore\.google\.com\/detail\/instagram-followers-track\/bbjpknpklcpjcogdockeodhieaghbbeb\/reviews" data-telemetry-action="review" target="_blank" rel="noreferrer">Rate us<\/a>/);
  assert.equal(renderDashboard(createInitialDashboardState()).reviewPanel, "");
});

test("review prompt stays visible after a successful sync during later runs and errors", () => {
  const local = populatedState();
  const state = dashboardState({ report: local.report, syncPoints: local.sync_points });
  const markup = renderDashboard(state).reviewPanel;
  assert.match(markup, /Thank you for using Followers Tracker Pro!/);
  assert.match(markup, /If you find it useful, please leave a review on the Chrome Web Store\. This means a lot to us\./);
  assert.equal(renderDashboard({ ...state, startPending: true }).reviewPanel, markup);
  const errorState = { ...state, feedback: { kind: "error", message: "Unable to save local history." } };
  assert.equal(renderDashboard(errorState).alertMessage, "Unable to save local history.");
  assert.equal(renderDashboard(errorState).reviewPanel, markup);
  assert.equal(renderDashboard({ ...state, report: null }).reviewPanel, markup);
});

test("start locks before the response and sends exactly one request for concurrent calls", async () => {
  const accepted = deferred();
  const state = populatedState();
  const runtime = createRuntime((message) => {
    if (message.type === "dashboard.getState") {
      return response({ ...state, last_sync: null }, message.request_id);
    }
    if (message.type === "sync.start") {
      return accepted.promise;
    }
    throw new Error(`Unexpected message ${message.type}`);
  });
  const view = createView();
  const controller = createDashboardController({ runtime, view, requestId: () => "request_id", now: () => new Date(t3.iso) });
  await controller.refresh();

  const first = controller.startSync();
  const second = controller.startSync();
  assert.equal(runtime.calls.filter((message) => message.type === "sync.start").length, 1);
  assert.equal(renderDashboard(view.renders.at(-1)).syncButton.disabled, true);
  accepted.resolve({ type: "sync.accepted", request_id: "request_id", state: "running", run_id: "run_lock", started_at: t3, stage: "preflight", recovered: false });
  assert.equal(await first, true);
  assert.equal(await second, false);
});

test("bootstrap recovers one persisted running run with one sync start and canonical terminal state", async () => {
  const preserved = populatedState();
  const running = {
    run_id: "durable_run",
    state: "running",
    stage: "collecting_followers",
    started_at: t2,
    finished_at: null,
    instagram_account: null,
    followers_count: null,
    following_count: null,
    duration_ms: null,
    error: null
  };
  let current = { ...preserved, last_sync: running };
  const runtime = createRuntime((message) => {
    if (message.type === "dashboard.getState") {
      return response(current, message.request_id);
    }
    if (message.type === "sync.start") {
      current = {
        ...preserved,
        last_sync: {
          ...running,
          state: "interrupted",
          finished_at: t3,
          duration_ms: 60_000,
          error: { message: "Instagram collection was interrupted before both lists completed." }
        }
      };
      return immediateFailure(
        message.request_id,
        "durable_run",
        "Instagram collection was interrupted before both lists completed.",
        "interrupted"
      );
    }
    throw new Error(`Unexpected message ${message.type}`);
  });
  const controller = createDashboardController({ runtime, view: createView(), requestId: () => "request_id", now: () => new Date(t3.iso) });

  await controller.initialize();
  await controller.initialize();
  assert.equal(runtime.calls.filter((message) => message.type === "sync.start").length, 1);
  assert.equal(controller.getState().lastSync.state, "interrupted");
  assert.equal(controller.getState().report.instagram_account, preserved.report.instagram_account);
});

test("bootstrap accepts one live-collector recovery for the same durable run", async () => {
  const preserved = populatedState();
  const running = {
    run_id: "live_durable_run",
    state: "running",
    stage: "collecting_following",
    started_at: t2,
    finished_at: null,
    instagram_account: null,
    followers_count: null,
    following_count: null,
    duration_ms: null,
    error: null
  };
  const current = { ...preserved, last_sync: running };
  const runtime = createRuntime((message) => {
    if (message.type === "dashboard.getState") {
      return response(current, message.request_id);
    }
    if (message.type === "sync.start") {
      return {
        type: "sync.accepted",
        request_id: message.request_id,
        state: "running",
        run_id: running.run_id,
        started_at: running.started_at,
        stage: running.stage,
        recovered: true
      };
    }
    throw new Error(`Unexpected message ${message.type}`);
  });
  const controller = createDashboardController({ runtime, view: createView(), requestId: () => "request_id", now: () => new Date(t3.iso) });

  await controller.initialize();
  await controller.initialize();
  assert.equal(runtime.calls.filter((message) => message.type === "sync.start").length, 1);
  assert.equal(controller.getState().lastSync.run_id, running.run_id);
  assert.equal(controller.getState().lastSync.state, "running");
});

test("slow bootstrap recovery visibly disables Stop until the recovered run is ready", async () => {
  const running = {
    ...interruptedLastSync("slow_recovery"),
    state: "running",
    stage: "collecting_following",
    finished_at: null,
    duration_ms: null,
    error: null
  };
  const accepted = deferred();
  const current = populatedState(running);
  const runtime = createRuntime((message) => {
    if (message.type === "dashboard.getState") {
      return response(current, message.request_id);
    }
    if (message.type === "sync.start") {
      return accepted.promise;
    }
    throw new Error(`Unexpected message ${message.type}`);
  });
  const controller = createDashboardController({ runtime, view: createView(), requestId: () => "recovery_request", now: () => new Date(t3.iso) });

  const initializing = controller.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  const recovering = renderDashboard(controller.getState());
  assert.equal(controller.getState().recoveryPending, true);
  assert.deepEqual(recovering.stopButton, { label: "Recovering…", disabled: true, hidden: false });
  assert.match(recovering.syncState, /Recovering the local sync/);
  assert.equal(await controller.stopSync(), false);
  assert.equal(runtime.calls.some((message) => message.type === "sync.stop"), false);

  accepted.resolve({
    type: "sync.accepted",
    request_id: "recovery_request",
    state: "running",
    run_id: running.run_id,
    started_at: running.started_at,
    stage: running.stage,
    recovered: true
  });
  assert.equal(await initializing, true);
  assert.equal(controller.getState().recoveryPending, false);
  assert.deepEqual(renderDashboard(controller.getState()).stopButton, { label: "Stop sync", disabled: false, hidden: false });
});

test("rejected and invalid bootstrap recovery responses retry only on a later initialize", async () => {
  for (const firstOutcome of ["rejected", "invalid"]) {
    const preserved = populatedState();
    const running = {
      run_id: `retry_${firstOutcome}`,
      state: "running",
      stage: "collecting_following",
      started_at: t2,
      finished_at: null,
      instagram_account: null,
      followers_count: null,
      following_count: null,
      duration_ms: null,
      error: null
    };
    let starts = 0;
    const runtime = createRuntime((message) => {
      if (message.type === "dashboard.getState") {
        return response({ ...preserved, last_sync: running }, message.request_id);
      }
      if (message.type === "sync.start") {
        starts += 1;
        if (starts === 1 && firstOutcome === "rejected") {
          throw new Error("temporary local recovery failure");
        }
        if (starts === 1) {
          return { type: "sync.accepted", request_id: `${message.request_id}_wrong`, state: "running", run_id: running.run_id, started_at: t2, stage: running.stage, recovered: true };
        }
        return { type: "sync.accepted", request_id: message.request_id, state: "running", run_id: running.run_id, started_at: t2, stage: running.stage, recovered: true };
      }
      throw new Error(`Unexpected message ${message.type}`);
    });
    const controller = createDashboardController({ runtime, view: createView(), requestId: () => "request", now: () => new Date(t3.iso) });

    assert.equal(await controller.initialize(), true);
    assert.equal(starts, 1, "one initialize must not spin a recovery retry loop");
    assert.equal(controller.getState().lastSync.state, "running");
    assert.equal(controller.getState().feedback.kind, "error");
    assert.equal(controller.getState().announcement, "", "failed recovery must clear its stale polite announcement");
    assert.equal(renderDashboard(controller.getState()).syncButton.disabled, true);
    assert.equal(await controller.startSync(), false, "ordinary starts remain blocked while the durable run is running");
    assert.equal(starts, 1);
    assert.equal(await controller.initialize(), true);
    assert.equal(starts, 2, "a later initialize retries recovery without a reload");
    assert.equal(await controller.initialize(), true);
    assert.equal(starts, 2, "accepted recovery is not retried again");
  }
});

test("immediate and terminal-before-accepted results always converge through dashboard state", async () => {
  const preserved = populatedState();
  let current = { ...preserved, last_sync: null };
  let controller;
  const runtime = createRuntime(async (message) => {
    if (message.type === "dashboard.getState") {
      return response(current, message.request_id);
    }
    if (message.type === "sync.start") {
      current = {
        ...preserved,
        last_sync: {
          run_id: "race_run",
          state: "failed",
          stage: "preflight",
          started_at: t3,
          finished_at: t3,
          instagram_account: null,
          followers_count: null,
          following_count: null,
          duration_ms: 0,
          error: { message: "No Instagram tab is available." }
        }
      };
      await controller.handleRuntimeMessage({ type: "sync.result", request_id: "broadcast_id", run_id: "race_run", state: "failed" });
      return { type: "sync.accepted", request_id: message.request_id, state: "running", run_id: "race_run", started_at: t3, stage: "preflight", recovered: false };
    }
    throw new Error(`Unexpected message ${message.type}`);
  });
  controller = createDashboardController({ runtime, view: createView(), requestId: () => "request_id", now: () => new Date(t3.iso) });
  await controller.refresh();
  assert.equal(await controller.startSync(), true);
  assert.equal(controller.getState().lastSync.state, "failed");

  const immediateRuntime = createRuntime((message) => {
    if (message.type === "dashboard.getState") {
      return response(current, message.request_id);
    }
    return immediateFailure(message.request_id, "race_run", "Immediate local failure.");
  });
  const immediate = createDashboardController({ runtime: immediateRuntime, view: createView(), requestId: () => "request_id", now: () => new Date(t3.iso) });
  current = { ...preserved, last_sync: null };
  await immediate.refresh();
  current = {
    ...preserved,
    last_sync: {
      run_id: "race_run",
      state: "failed",
      stage: "preflight",
      started_at: t3,
      finished_at: t3,
      instagram_account: null,
      followers_count: null,
      following_count: null,
      duration_ms: 0,
      error: { message: "Immediate local failure." }
    }
  };
  assert.equal(await immediate.startSync(), true);
  assert.equal(immediate.getState().lastSync.state, "failed");
});

test("matching terminal replay retries a failed canonical read without losing run correlation", async () => {
  const preserved = populatedState();
  const running = {
    run_id: "replay_run",
    state: "running",
    stage: "collecting_following",
    started_at: t2,
    finished_at: null,
    instagram_account: null,
    followers_count: null,
    following_count: null,
    duration_ms: null,
    error: null
  };
  let reads = 0;
  let terminal = false;
  const runtime = createRuntime((message) => {
    if (message.type !== "dashboard.getState") {
      throw new Error(`Unexpected message ${message.type}`);
    }
    reads += 1;
    if (reads === 2) {
      throw new Error("temporary read failure");
    }
    return response({
      ...preserved,
      last_sync: terminal ? { ...running, state: "completed", stage: "stored", finished_at: t3, error: null } : running
    }, message.request_id);
  });
  const controller = createDashboardController({ runtime, view: createView(), requestId: () => "request_id" });
  await controller.refresh();
  terminal = true;
  assert.equal(await controller.handleRuntimeMessage({ type: "sync.result", run_id: "replay_run", state: "completed" }), false);
  assert.equal(controller.getState().lastSync.state, "running");
  assert.equal(await controller.handleRuntimeMessage({ type: "sync.result", run_id: "replay_run", state: "completed" }), true);
  assert.equal(controller.getState().lastSync.state, "completed");
});

test("failed and interrupted terminal refreshes preserve existing analytics", async () => {
  for (const terminalState of ["failed", "interrupted"]) {
    const preserved = populatedState();
    let current = {
      ...preserved,
      last_sync: {
        run_id: "run_preserve",
        state: "running",
        stage: "collecting_followers",
        started_at: t2,
        finished_at: null,
        instagram_account: null,
        followers_count: null,
        following_count: null,
        duration_ms: null,
        error: null
      }
    };
    const runtime = createRuntime((message) => response(current, message.request_id));
    const controller = createDashboardController({ runtime, view: createView(), requestId: () => "request" });
    await controller.refresh();
    current = {
      ...preserved,
      last_sync: {
        ...current.last_sync,
        state: terminalState,
        finished_at: t3,
        duration_ms: 1000,
        error: { message: `${terminalState} local error` }
      }
    };
    await controller.handleRuntimeMessage({ type: "sync.result", run_id: "run_preserve", request_id: "not-needed", state: terminalState });
    assert.equal(controller.getState().report.instagram_account, preserved.report.instagram_account);
    assert.equal(controller.getState().syncPoints.length, preserved.sync_points.length);
    assert.equal(controller.getState().lastSync.state, terminalState);
  }
});

test("report and backup downloads use local message bodies", async () => {
  const state = populatedState();
  const runtime = createRuntime((message) => {
    if (message.type === "dashboard.getState") {
      return response(state, message.request_id);
    }
    if (message.type === "report.export") {
      return { type: "report.export.result", request_id: message.request_id, filename: `report.${message.format}`, mime_type: "text/plain", body: "local report", error: null };
    }
    if (message.type === "backup.export") {
      return { type: "backup.export.result", request_id: message.request_id, filename: "backup.json", mime_type: "application/json", body: "local backup", error: null };
    }
    throw new Error(`Unexpected message ${message.type}`);
  });
  const view = createView();
  const controller = createDashboardController({ runtime, view, requestId: () => "request" });

  await controller.refresh();
  assert.equal(await controller.exportReportCsv(), true);
  assert.equal(await controller.exportReportJson(), true);
  assert.equal(await controller.exportBackup(), true);
  assert.deepEqual(view.downloads.map((file) => file.filename), ["report.csv", "report.json", "backup.json"]);
  assert.deepEqual(runtime.calls.filter((message) => message.type === "report.export").map((message) => message.format), ["csv", "json"]);
});

test("every export outcome restores controller focus to stable data management", async () => {
  for (const operation of exportOperations) {
    for (const outcome of ["success", "transport", "invalid-type", "invalid-request", "worker-error"]) {
      const state = populatedState();
      const runtime = createRuntime((message) => {
        if (message.type === "dashboard.getState") {
          return response(state, message.request_id);
        }
        assert.equal(message.type, operation.requestType);
        return exportOutcome(operation, message, outcome);
      });
      const view = createView();
      const controller = createDashboardController({ runtime, view, requestId: () => "request" });
      await controller.refresh();

      assert.equal(await controller[operation.method](), outcome === "success", `${operation.label} ${outcome}`);
      assert.equal(view.focused.at(-1), "data-management", `${operation.label} ${outcome} must restore stable focus`);
    }
  }
});

test("sync announcements remain accessible without duplicating visible status, while action feedback stays visible", () => {
  const fixture = createDashboardDocumentFixture();
  const view = createDomView(fixture.documentRef);
  const state = { ...createInitialDashboardState(), announcement: "Completed locally.", announcementId: 1 };
  view.render(state);
  const liveStatus = fixture.documentRef.querySelector("[data-live-status]");
  assert.equal(liveStatus.textContent, state.announcement);
  assert.equal(liveStatus.className, "live-message visually-hidden");
  view.render({ ...state, feedback: { kind: "success", message: "Local download created.", id: 2 } });
  assert.equal(liveStatus.textContent, "Local download created.");
  assert.equal(liveStatus.className, "live-message");
});

test("DOM export matrix leaves visible connected focus and re-arms identical live and alert notices", async () => {
  for (const operation of exportOperations) {
    for (const outcome of ["success", "transport", "invalid-type", "invalid-request", "worker-error"]) {
      const state = populatedState();
      const fixture = createDashboardDocumentFixture();
      const runtime = createRuntime((message) => {
        if (message.type === "dashboard.getState") {
          return response(state, message.request_id);
        }
        return exportOutcome(operation, message, outcome);
      });
      const view = createDomView(fixture.documentRef, {
        BlobClass: Blob,
        objectUrls: { createObjectURL: () => "blob:local", revokeObjectURL() {} },
        defer: (callback) => callback()
      });
      const controller = createDashboardController({ runtime, view, requestId: () => "request" });
      await controller.refresh();
      const exportAction = fixture.focusExportAction();

      assert.equal(await controller[operation.method](), outcome === "success", `${operation.label} ${outcome}`);
      assert.equal(exportAction.isConnected, true, "download feedback preserves existing controls and analytics DOM");
      assert.equal(fixture.documentRef.activeElement, fixture.stableTarget);
      assert.equal(fixture.stableTarget.isConnected, true);
      assert.equal(fixture.stableTarget.getClientRects().length > 0, true);
    }
  }

  const successFixture = createDashboardDocumentFixture();
  const successRuntime = createRuntime((message) => {
    if (message.type === "dashboard.getState") return response(populatedState(), message.request_id);
    const operation = message.format === "csv" ? exportOperations[0] : exportOperations[1];
    return exportOutcome(operation, message, "success");
  });
  const successController = createDashboardController({
    runtime: successRuntime,
    view: createDomView(successFixture.documentRef, {
      BlobClass: Blob,
      objectUrls: { createObjectURL: () => "blob:local", revokeObjectURL() {} },
      defer: (callback) => callback()
    }),
    requestId: () => "request"
  });
  await successController.refresh();
  successFixture.focusExportAction();
  await successController.exportReportCsv();
  successFixture.focusExportAction();
  await successController.exportReportJson();
  assert.equal(successFixture.regionMutations.live.filter((message) => message === "Local download created.").length, 2);

  const errorFixture = createDashboardDocumentFixture();
  const errorRuntime = createRuntime((message) => {
    if (message.type === "dashboard.getState") return response(populatedState(), message.request_id);
    return exportOutcome(exportOperations[2], message, "worker-error");
  });
  const errorController = createDashboardController({
    runtime: errorRuntime,
    view: createDomView(errorFixture.documentRef, {
      BlobClass: Blob,
      objectUrls: { createObjectURL: () => "blob:local", revokeObjectURL() {} },
      defer: (callback) => callback()
    }),
    requestId: () => "request"
  });
  await errorController.refresh();
  errorFixture.focusExportAction();
  await errorController.exportBackup();
  errorFixture.focusExportAction();
  await errorController.exportBackup();
  assert.equal(errorFixture.regionMutations.alert.filter((message) => message === "Local export failed.").length, 2);
});

test("every request-response operation rejects a wrong type or request ID", async () => {
  const local = completed();
  const backup = {
    schema: BACKUP_SCHEMA,
    exported_at: t2,
    history: local.history,
    report: local.report,
    last_sync: null
  };
  const state = populatedState();
  const wrongState = createDashboardController({
    runtime: createRuntime((message) => response(state, `${message.request_id}_wrong`)),
    view: createView(),
    requestId: () => "request"
  });
  assert.equal(await wrongState.refresh(), null);

  const view = createView();
  const runtime = createRuntime((message) => {
    if (message.type === "dashboard.getState") {
      return response(state, message.request_id);
    }
    if (message.type === "sync.start") {
      return { type: "sync.accepted", request_id: "another_request", state: "running", run_id: "wrong", started_at: t3, stage: "preflight", recovered: false };
    }
    if (message.type === "report.export") {
      return { type: "backup.export.result", request_id: message.request_id, filename: "wrong.json", mime_type: "application/json", body: "wrong body", error: null };
    }
    if (message.type === "backup.export") {
      return { type: "report.export.result", request_id: message.request_id, filename: "wrong.json", mime_type: "application/json", body: "wrong body", error: null };
    }
    if (message.type === "backup.import") {
      return { type: "history.reset.result", request_id: message.request_id, reset: true, deleted_keys: [...STORAGE_KEY_NAMES], error: null };
    }
    if (message.type === "history.reset") {
      return {
        type: "backup.import.result",
        request_id: message.request_id,
        imported: true,
        replaced_keys: ["instatrack.account.v1.7.local_account", "instatrack.run.v1.regular"],
        error: null
      };
    }
    throw new Error(`Unexpected message ${message.type}`);
  });
  const controller = createDashboardController({ runtime, view, requestId: () => "request", now: () => new Date(t3.iso) });
  await controller.refresh();
  assert.equal(await controller.startSync(), false);
  assert.equal(await controller.exportReportJson(), false);
  assert.equal(await controller.exportBackup(), false);
  assert.equal(view.downloads.length, 0);
  await controller.openImport({ text: async () => JSON.stringify(backup) }, "import-trigger");
  assert.equal(await controller.confirmImport(), false);
  controller.openReset("reset-trigger");
  assert.equal(await controller.confirmReset(), false);
  assert.equal(view.focused.at(-1), "data-management");
});

test("reset all data stays available when empty while backup still requires local data", () => {
  const empty = renderDashboard(createInitialDashboardState());
  const rendered = renderDashboard({
    ...createInitialDashboardState(),
    instagramAccount: "local_account",
    lastSync: {
      run_id: "failed_first_run",
      state: "failed",
      stage: "preflight",
      started_at: t1,
      finished_at: t1,
      instagram_account: null,
      followers_count: null,
      following_count: null,
      duration_ms: 0,
      error: { message: "No Instagram tab is available." }
    }
  });

  assert.match(empty.dataActions, /data-action="reset">Reset all data/);
  assert.doesNotMatch(empty.dataActions, /data-action="reset" disabled/);
  assert.match(empty.dataActions, /data-action="backup-export" disabled/);
  assert.match(empty.dataActions, /clear any unfinished local sync/);
  assert.match(rendered.dataActions, /data-action="backup-export">/);
  assert.match(rendered.dataActions, /data-action="reset">Reset all data/);
  assert.doesNotMatch(rendered.dataActions, /data-action="(?:backup-export|reset)" disabled/);
});

test("DOM view downloads through a Blob URL and cleans the temporary anchor and URL", async () => {
  const calls = [];
  const anchor = {
    click() { calls.push("click"); },
    remove() { calls.push("remove"); }
  };
  let createdBlob;
  const view = createDomView(
    {
      body: { append(node) { assert.equal(node, anchor); calls.push("append"); } },
      createElement(tag) { assert.equal(tag, "a"); return anchor; },
      querySelector() { return null; }
    },
    {
      BlobClass: Blob,
      objectUrls: {
        createObjectURL(blob) { createdBlob = blob; calls.push("create"); return "blob:local-download"; },
        revokeObjectURL(url) { assert.equal(url, "blob:local-download"); calls.push("revoke"); }
      },
      defer(callback, delay) { assert.equal(delay, 0); calls.push("defer"); callback(); }
    }
  );

  view.download({ body: "local body", filename: "report.json", mimeType: "application/json" });
  assert.equal(anchor.href, "blob:local-download");
  assert.equal(anchor.download, "report.json");
  assert.equal(await createdBlob.text(), "local body");
  assert.deepEqual(calls, ["create", "append", "click", "remove", "defer", "revoke"]);
});

test("DOM dialog close uses stable data management when rerender disconnects its opener", () => {
  let focused = null;
  const fallback = { focus() { focused = "data-management"; } };
  const dialog = {
    open: false,
    showModal() { this.open = true; },
    close() { this.open = false; }
  };
  const documentFixture = {
    activeElement: null,
    querySelector(selector) {
      if (selector === '[data-dialog="import"]') return dialog;
      if (selector === '[data-focus-target="data-management"]') return fallback;
      return null;
    }
  };
  const view = createDomView(documentFixture);
  const opener = { isConnected: false, disabled: false, focus() { focused = "opener"; } };

  view.openDialog("import", opener);
  view.closeDialog("import");
  assert.equal(focused, "data-management");
});

test("backup import validates before confirmation, cancellation preserves state, and confirmed import is revalidated by the worker", async () => {
  const imported = completed();
  const backup = {
    schema: BACKUP_SCHEMA,
    exported_at: t2,
    history: imported.history,
    report: imported.report,
    last_sync: null
  };
  const before = populatedState();
  let state = before;
  const runtime = createRuntime((message) => {
    if (message.type === "dashboard.getState") {
      return response(state, message.request_id);
    }
    if (message.type === "backup.import") {
      assert.equal(message.confirm, true);
      assert.equal(message.body, JSON.stringify(backup));
      state = { instagram_account: imported.report.instagram_account, report: imported.report, sync_points: imported.history.sync_points, last_sync: null };
      return { type: "backup.import.result", request_id: message.request_id, imported: true, replaced_keys: [], error: null };
    }
    throw new Error(`Unexpected message ${message.type}`);
  });
  const view = createView();
  const controller = createDashboardController({ runtime, view, requestId: () => "request" });
  await controller.refresh();

  assert.equal(await controller.openImport({ text: async () => "not json" }, "import-trigger"), false);
  assert.equal(view.dialogs.length, 0);
  assert.equal(controller.getState().report.instagram_account, before.report.instagram_account);
  assert.equal(view.focused.at(-1), "data-management");

  assert.equal(await controller.openImport({ text: async () => JSON.stringify(backup) }, "import-trigger"), true);
  assert.deepEqual(view.dialogs, [{ name: "import", trigger: "import-trigger" }]);
  controller.cancelDialog("import");
  assert.equal(await controller.confirmImport(), false, "cancelled import does not send a replacement message");
  assert.equal(runtime.calls.filter((message) => message.type === "backup.import").length, 0);
  assert.equal(controller.getState().report.instagram_account, before.report.instagram_account);

  await controller.openImport({ text: async () => JSON.stringify(backup) }, "import-trigger");
  assert.equal(await controller.confirmImport(), true);
  assert.equal(runtime.calls.filter((message) => message.type === "backup.import").length, 1);
  assert.equal(controller.getState().report.instagram_account, imported.report.instagram_account);
  assert.deepEqual(view.focused.at(-1), "data-management");
});

test("a file read completed after reset cannot open the import dialog or replace reset feedback", async () => {
  const imported = completed();
  const backup = {
    schema: BACKUP_SCHEMA,
    exported_at: t2,
    history: imported.history,
    report: imported.report,
    last_sync: null
  };
  const fileText = deferred();
  const resetResponse = deferred();
  const before = populatedState();
  const runtime = createRuntime((message) => {
    if (message.type === "dashboard.getState") {
      return response(before, message.request_id);
    }
    if (message.type === "history.reset") {
      return resetResponse.promise;
    }
    throw new Error(`Unexpected message ${message.type}`);
  });
  let sequence = 0;
  const view = createView();
  const controller = createDashboardController({ runtime, view, requestId: () => `request_${++sequence}` });
  await controller.refresh();

  const opening = controller.openImport({ text: () => fileText.promise }, "import-trigger");
  const resetting = controller.confirmReset();
  assert.match(renderDashboard(controller.getState()).dataActions, /data-action="import-backup" disabled aria-disabled="true"/);
  resetResponse.resolve({ type: "history.reset.result", request_id: "request_2", reset: true, deleted_keys: [...STORAGE_KEY_NAMES], error: null });
  assert.equal(await resetting, true);
  fileText.resolve(JSON.stringify(backup));

  assert.equal(await opening, false);
  assert.equal(view.dialogs.some((dialog) => dialog.name === "import"), false);
  assert.equal(controller.getState().report, null);
  assert.equal(renderDashboard(controller.getState()).liveMessage, "All local data reset.");
});

test("an import response completed after reset cannot refresh or replace the empty controller state", async () => {
  const imported = completed();
  const backup = {
    schema: BACKUP_SCHEMA,
    exported_at: t2,
    history: imported.history,
    report: imported.report,
    last_sync: null
  };
  const importResponse = deferred();
  let current = populatedState();
  const runtime = createRuntime((message) => {
    if (message.type === "dashboard.getState") {
      return response(current, message.request_id);
    }
    if (message.type === "backup.import") {
      return importResponse.promise;
    }
    if (message.type === "history.reset") {
      current = { report: null, sync_points: [], last_sync: null };
      return { type: "history.reset.result", request_id: message.request_id, reset: true, deleted_keys: [...STORAGE_KEY_NAMES], error: null };
    }
    throw new Error(`Unexpected message ${message.type}`);
  });
  let sequence = 0;
  const view = createView();
  const controller = createDashboardController({ runtime, view, requestId: () => `request_${++sequence}` });
  await controller.refresh();
  await controller.openImport({ text: async () => JSON.stringify(backup) }, "import-trigger");

  const importing = controller.confirmImport();
  assert.equal(runtime.calls.filter((message) => message.type === "backup.import").length, 1);
  assert.equal(await controller.confirmReset(), true);
  importResponse.resolve({ type: "backup.import.result", request_id: "request_2", imported: true, replaced_keys: [...STORAGE_KEY_NAMES], error: null });

  assert.equal(await importing, false);
  assert.equal(runtime.calls.filter((message) => message.type === "dashboard.getState").length, 1, "stale import must not refresh");
  assert.equal(controller.getState().report, null);
  assert.equal(renderDashboard(controller.getState()).liveMessage, "All local data reset.");
  assert.equal(view.focused.includes("data-management"), true);
});

test("reset all data requires confirmation, stays atomic, and returns focus after success", async () => {
  const before = populatedState();
  const runtime = createRuntime((message) => {
    if (message.type === "dashboard.getState") {
      return response(before, message.request_id);
    }
    if (message.type === "history.reset") {
      assert.equal(message.confirm, true);
      return {
        type: "history.reset.result",
        request_id: message.request_id,
        reset: true,
        deleted_keys: [
          ...STORAGE_KEY_NAMES,
          "instatrack.account.v1.7.account_a",
          "instatrack.account.v1.7.account_b",
          "instatrack.run.v1.regular",
          "instatrack.run.v1.incognito"
        ],
        error: null
      };
    }
    throw new Error(`Unexpected message ${message.type}`);
  });
  const view = createView();
  const controller = createDashboardController({ runtime, view, requestId: () => "request" });
  await controller.refresh();
  controller.openReset("reset-trigger");
  controller.cancelDialog("reset");
  assert.equal(runtime.calls.filter((message) => message.type === "history.reset").length, 0);
  assert.equal(controller.getState().report.instagram_account, before.report.instagram_account);
  controller.openReset("reset-trigger");
  assert.equal(await controller.confirmReset(), true);
  assert.deepEqual(runtime.calls.filter((message) => message.type === "history.reset"), [
    { type: "history.reset", request_id: "request", confirm: true }
  ]);
  assert.equal(runtime.calls.some((message) => message.type === "sync.stop"), false, "reset must remain one worker-owned atomic operation");
  assert.equal(controller.getState().report, null);
  assert.equal(controller.getState().syncPoints.length, 0);
  assert.equal(renderDashboard(controller.getState()).liveMessage, "All local data reset.");
  assert.deepEqual(view.focused.at(-1), "data-management");
});

test("reset rejects extra fields and unmanaged or duplicated deleted keys", async () => {
  const variants = {
    "extra field": { deleted_keys: [...STORAGE_KEY_NAMES], unexpected: true },
    "unmanaged key": { deleted_keys: [...STORAGE_KEY_NAMES, "instatrack.unapproved"] },
    "duplicate key": { deleted_keys: [...STORAGE_KEY_NAMES, STORAGE_KEY_NAMES[0]] },
    "malformed account key": { deleted_keys: ["instatrack.account.v1.-1.account_a"] }
  };

  for (const [label, variant] of Object.entries(variants)) {
    const before = populatedState();
    const runtime = createRuntime((message) => {
      if (message.type === "dashboard.getState") {
        return response(before, message.request_id);
      }
      if (message.type === "history.reset") {
        return {
          type: "history.reset.result",
          request_id: message.request_id,
          reset: true,
          error: null,
          ...variant
        };
      }
      throw new Error(`Unexpected message ${message.type}`);
    });
    const view = createView();
    const controller = createDashboardController({ runtime, view, requestId: () => `reset_${label}` });
    await controller.refresh();

    assert.equal(await controller.confirmReset(), false, label);
    assert.equal(controller.getState().report.instagram_account, before.report.instagram_account, label);
    assert.equal(renderDashboard(controller.getState()).alertMessage, "Unable to reset all local data.", label);
    assert.equal(view.focused.at(-1), "data-management", label);
  }
});

test("reset surfaces an exact correlated collector-quiescence error", async () => {
  const before = populatedState({
    run_id: "sync_running", state: "running", stage: "collecting_followers", started_at: t2, finished_at: null,
    instagram_account: null, followers_count: null, following_count: null, duration_ms: null, error: null
  });
  const runtime = createRuntime((message) => {
    if (message.type === "dashboard.getState") {
      return response(before, message.request_id);
    }
    if (message.type === "history.reset") {
      return {
        type: "history.reset.result",
        request_id: message.request_id,
        reset: false,
        deleted_keys: [],
        error: { code: "COLLECTION_INTERRUPTED", message: "Reload the Instagram tab and retry." }
      };
    }
    throw new Error(`Unexpected message ${message.type}`);
  });
  const view = createView();
  const controller = createDashboardController({ runtime, view, requestId: () => "req_reset" });
  await controller.refresh();

  assert.equal(await controller.confirmReset(), false);
  assert.equal(renderDashboard(controller.getState()).alertMessage, "Reload the Instagram tab and retry.");
  assert.equal(view.focused.at(-1), "data-management");
});

test("successful reset clears pending import and invalidates stale start and terminal correlation", async () => {
  const local = completed();
  const backup = {
    schema: BACKUP_SCHEMA,
    exported_at: t2,
    history: local.history,
    report: local.report,
    last_sync: null
  };
  const firstStart = deferred();
  let current = { ...populatedState(), last_sync: null };
  let starts = 0;
  const runtime = createRuntime((message) => {
    if (message.type === "dashboard.getState") {
      return response(current, message.request_id);
    }
    if (message.type === "sync.start") {
      starts += 1;
      if (starts === 1) {
        return firstStart.promise;
      }
      current = {
        report: null,
        sync_points: [],
        last_sync: {
          ...interruptedLastSync("fresh_run"),
          state: "running",
          stage: "preflight",
          finished_at: null,
          duration_ms: null,
          error: null
        }
      };
      return { type: "sync.accepted", request_id: message.request_id, state: "running", run_id: "fresh_run", started_at: t3, stage: "preflight", recovered: false };
    }
    if (message.type === "history.reset") {
      current = { report: null, sync_points: [], last_sync: null };
      return { type: "history.reset.result", request_id: message.request_id, reset: true, deleted_keys: [...STORAGE_KEY_NAMES], error: null };
    }
    if (message.type === "backup.import") {
      throw new Error("a reset backup must not remain pending");
    }
    throw new Error(`Unexpected message ${message.type}`);
  });
  let sequence = 0;
  const controller = createDashboardController({
    runtime,
    view: createView(),
    requestId: () => `request_${++sequence}`,
    now: () => new Date(t3.iso)
  });
  await controller.refresh();
  await controller.openImport({ text: async () => JSON.stringify(backup) }, "import-trigger");
  const staleStart = controller.startSync();
  assert.equal(await controller.handleRuntimeMessage({ type: "sync.result", run_id: "stale_run", state: "completed" }), true, "pre-accept terminal is buffered before reset");

  controller.openReset("reset-trigger");
  assert.equal(await controller.confirmReset(), true);
  firstStart.resolve({ type: "sync.accepted", request_id: "request_2", state: "running", run_id: "stale_run", started_at: t3, stage: "preflight", recovered: false });
  assert.equal(await staleStart, false);
  assert.equal(await controller.handleRuntimeMessage({ type: "sync.result", run_id: "stale_run", state: "completed" }), false);
  assert.equal(await controller.confirmImport(), false);
  assert.equal(runtime.calls.filter((message) => message.type === "backup.import").length, 0);
  assert.equal(controller.getState().lastSync, null);

  assert.equal(await controller.startSync(), true, "reset clears the pending-start lock for a fresh sync");
  assert.equal(controller.getState().lastSync.run_id, "fresh_run");
});

test("successful reset invalidates an in-flight stop and releases its lock", async () => {
  const running = {
    ...interruptedLastSync("old_run"),
    state: "running",
    finished_at: null,
    duration_ms: null,
    error: null
  };
  const staleStop = deferred();
  let current = populatedState(running);
  let stops = 0;
  const runtime = createRuntime((message) => {
    if (message.type === "dashboard.getState") {
      return response(current, message.request_id);
    }
    if (message.type === "sync.stop") {
      stops += 1;
      if (stops === 1) {
        return staleStop.promise;
      }
      const stopped = interruptedLastSync(message.run_id);
      current = { ...current, last_sync: stopped };
      return { type: "sync.stop.result", request_id: message.request_id, run_id: message.run_id, stopped: true, last_sync: stopped, error: null };
    }
    if (message.type === "history.reset") {
      current = { report: null, sync_points: [], last_sync: null };
      return { type: "history.reset.result", request_id: message.request_id, reset: true, deleted_keys: [...STORAGE_KEY_NAMES], error: null };
    }
    throw new Error(`Unexpected message ${message.type}`);
  });
  let sequence = 0;
  const controller = createDashboardController({ runtime, view: createView(), requestId: () => `request_${++sequence}` });
  await controller.refresh();

  const oldStop = controller.stopSync();
  controller.openReset("reset-trigger");
  assert.equal(await controller.confirmReset(), true);
  staleStop.resolve({ type: "sync.stop.result", request_id: "request_2", run_id: "old_run", stopped: true, last_sync: interruptedLastSync("old_run"), error: null });
  assert.equal(await oldStop, false);
  assert.equal(controller.getState().lastSync, null);

  current = {
    instagram_account: "local_account",
    report: null,
    sync_points: [],
    last_sync: { ...running, run_id: "fresh_stop_run" }
  };
  await controller.refresh();
  assert.equal(await controller.stopSync(), true, "reset releases the old stop lock");
  assert.equal(controller.getState().lastSync.run_id, "fresh_stop_run");
  assert.equal(controller.getState().lastSync.state, "interrupted");
});

test("dashboard source is local-message-only and uses no direct storage or remote client", () => {
  assert.doesNotMatch(dashboardSource, /chrome\.storage/);
  assert.doesNotMatch(dashboardSource, /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bsendBeacon\s*\(/);
  assert.doesNotMatch(dashboardSource, /identity|email|quota|plan|entitlement|checkout|payment|paid|billing/i);
  assert.match(dashboardSource, /validateBackup/);
  assert.match(dashboardSource, /message\.run_id !== activeRunId/);
  assert.doesNotMatch(dashboardSource, /request_id !== activeRunId/);
});
