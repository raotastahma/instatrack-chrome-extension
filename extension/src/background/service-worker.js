import { createLocalOperationHandlers } from "./local-operations.js";
import { createAccountStore } from "./account-storage.js";
import { createSyncOperations, isStart, selectInstagramTab } from "./sync-operations.js";
import { utcTimestamp } from "../domain/analytics.js";
import { validateBackup } from "../domain/schema.js";
import { createTelemetry } from "./telemetry.js";
import { exactKeys, validTelemetryEvent } from "../shared/telemetry-contract.js";

async function openDashboard(windowId) {
  const url = chrome.runtime.getURL("dashboard/index.html");
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"], windowIds: [windowId] });
  const dashboard = contexts.find((context) => context.documentUrl?.split("#")[0] === url);
  if (dashboard) {
    await chrome.tabs.update(dashboard.tabId, { active: true });
  } else {
    await chrome.tabs.create({ url, windowId, active: true });
  }
}

chrome.action.onClicked.addListener((tab) => {
  telemetry.record({ name: "button_click", params: { action: "toolbar-open" } });
  return openDashboard(tab.windowId);
});

let dashboardTabId = null;
let dashboardWindowId;
const incognito = Boolean(chrome.extension?.inIncognitoContext);
const telemetry = createTelemetry({ storage: chrome.storage.local, incognito });
const accountStore = createAccountStore(chrome.storage.local, { incognito });
const accounts = new Map();
let serial = Promise.resolve();

function serialize(operation) {
  const result = serial.then(operation, operation);
  serial = result.catch(() => undefined);
  return result;
}

function waitForInstagramTab(tab) {
  if (tab.status !== "loading") return Promise.resolve(tab);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(null), 20_000);
    function finish(loaded) {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
      if (loaded && selectInstagramTab([loaded])) resolve(loaded);
      else reject(new Error("Instagram did not finish loading. Check the tab and retry."));
    }
    function updated(id, change, loaded) {
      if (id === tab.id && change.status === "complete") finish(loaded);
    }
    function removed(id) {
      if (id === tab.id) finish(null);
    }
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    // Loading may finish between tab creation and listener registration.
    chrome.tabs.get(tab.id).then((loaded) => {
      if (loaded.status === "complete") finish(loaded);
    }, () => finish(null));
  });
}

async function instagramSession(tab, requestId) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tab.id, { type: "instagram.session.get", request_id: requestId, protocol_version: 2 });
    } catch (cause) {
      if (attempt === 4 || !/Receiving end does not exist|message (?:port|channel) closed/i.test(cause?.message ?? "")) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      tab = await waitForInstagramTab(await chrome.tabs.get(tab.id));
    }
  }
}

async function collectionAccount(requestId) {
  const tabs = (await chrome.tabs.query({})).filter((tab) => Boolean(tab.incognito) === incognito);
  let tab = selectInstagramTab(tabs.filter((item) => item.active && item.windowId === dashboardWindowId)) ?? selectInstagramTab(tabs);
  try {
    if (!tab) tab = await chrome.tabs.create({ url: "https://www.instagram.com/", windowId: dashboardWindowId, active: true });
    if (!tab.active || tab.discarded) tab = await chrome.tabs.update(tab.id, { active: true });
    if (Number.isInteger(tab.windowId)) await chrome.windows?.update(tab.windowId, { focused: true });
    tab = await waitForInstagramTab(tab);
  } catch {
    return { error: { code: "CURRENT_ACCOUNT_UNAVAILABLE", message: "Unable to load Instagram. Check the Instagram tab and retry." } };
  }
  try {
    const response = await instagramSession(tab, requestId);
    if (response?.type === "instagram.session" && Object.keys(response).length === 5 && response.request_id === requestId && response.protocol_version === 2) {
      if (response.state === "authenticated" && typeof response.instagram_account === "string" && /^[a-z0-9._]+$/.test(response.instagram_account)) {
        return { account: response.instagram_account, tabId: tab.id };
      }
      if (response.state === "logged_out" && response.instagram_account === null) return { error: { code: "NOT_LOGGED_IN", message: "Open Instagram in a tab, sign in, and retry" } };
      if (response.state === "unavailable" && response.instagram_account === null) return { error: { code: "CURRENT_ACCOUNT_UNAVAILABLE", message: "Instagram did not identify the signed-in account. Wait for the profile navigation to appear and retry." } };
    }
  } catch (cause) {
    const reason = typeof cause?.message === "string" ? cause.message.slice(0, 240) : "The Instagram message channel is unavailable.";
    return { error: { code: "CURRENT_ACCOUNT_UNAVAILABLE", message: `Unable to connect to Instagram: ${reason} Reload the Instagram tab and retry.` } };
  }
  return { error: { code: "CURRENT_ACCOUNT_UNAVAILABLE", message: "The Instagram extension script returned an invalid session response. Reload the Instagram tab and retry." } };
}

async function activateDashboard() {
  if (Number.isInteger(dashboardTabId)) {
    try {
      await chrome.tabs.update(dashboardTabId, { active: true });
      return;
    } catch {
      dashboardTabId = null;
    }
  }
  if (Number.isInteger(dashboardWindowId)) await openDashboard(dashboardWindowId);
  else await chrome.runtime.openOptionsPage();
}

async function updatePauseBadge(paused) {
  try {
    await chrome.action.setBadgeText?.({ text: paused ? "II" : "" });
  } catch {
    // A toolbar update must not block durable state or dashboard delivery.
  }
}

function forAccount(account) {
  if (!accounts.has(account)) {
    const adapter = accountStore.forAccount(account);
    accounts.set(account, {
      adapter,
      local: createLocalOperationHandlers({ adapter }),
      sync: createSyncOperations({
        adapter,
        observeSync: telemetry.observe,
        prepareTelemetryRun: telemetry.prepareRun,
        tabs: { query: async (query) => (await chrome.tabs.query(query)).filter((tab) => (
          Boolean(tab.incognito) === incognito
        )) },
        sendMessage: (id, message) => chrome.tabs.sendMessage(id, message),
        broadcast: async (message) => {
          await updatePauseBadge(message.type === "sync.progress" && message.last_sync.paused);
          await chrome.runtime.sendMessage(message);
        },
        focusTab: async (id) => {
          const tab = await chrome.tabs.update(id, { active: true });
          if (Number.isInteger(tab.windowId)) await chrome.windows?.update(tab.windowId, { focused: true });
        },
        activateDashboard
      })
    });
  }
  return accounts.get(account);
}

const emptyAdapter = {
  read: async () => ({ history: null, report: null, lastSync: null }),
  reset: () => accountStore.reset(),
  writeLastSync: async () => {}
};
const emptyLocal = createLocalOperationHandlers({ adapter: emptyAdapter });
const emptySync = createSyncOperations({
  adapter: emptyAdapter,
  tabs: { query: async (query) => (await chrome.tabs.query(query)).filter((tab) => (
    Boolean(tab.incognito) === incognito
  )) },
  sendMessage: (id, message) => chrome.tabs.sendMessage(id, message)
});

async function failedStart(message, operationError, telemetryEligible) {
  await updatePauseBadge(false);
  const now = utcTimestamp();
  const lastSync = {
    state: "failed", stage: "preflight",
    run_id: `sync_preflight_${crypto.randomUUID()}`, started_at: now, finished_at: now,
    instagram_account: null, followers_count: null, following_count: null, duration_ms: null,
    error: operationError
  };
  await accountStore.writeStartFailure(lastSync);
  const result = { type: "sync.result", request_id: message.request_id ?? null, ...lastSync, sync_point: null, report: null };
  telemetry.prepareRun(result.run_id, telemetryEligible);
  telemetry.observe(result);
  return result;
}

async function runOperations() {
  const run = await accountStore.readRun();
  return { ...run, operations: run.instagram_account ? forAccount(run.instagram_account) : null };
}

async function handle(message, sender, telemetryEligible = false) {
  const windowId = sender?.tab?.windowId ?? dashboardWindowId;
  if (message.type === "dashboard.getState") {
    const latest = await accountStore.readLatest();
    return {
      type: "dashboard.state", request_id: message.request_id, instagram_account: latest.instagram_account,
      report: latest.report, sync_points: latest.history?.sync_points ?? [],
      last_sync: latest.lastSync
    };
  }
  if (message.type === "sync.start") {
    if (!isStart(message)) return emptySync.start(message);
    dashboardTabId = sender?.tab?.id ?? dashboardTabId;
    dashboardWindowId = windowId;
    const active = await runOperations();
    if (active.lastSync?.state === "running") return active.operations.sync.start(message);
    const selected = await collectionAccount(message.request_id);
    if (selected.error) return failedStart(message, selected.error, telemetryEligible);
    return forAccount(selected.account).sync.start(message, selected.tabId, telemetryEligible);
  }
  if (message.type === "sync.stop") {
    const active = await runOperations();
    return active.operations ? active.operations.sync.stop(message) : {
      type: "sync.stop.result", request_id: message.request_id, run_id: message.run_id,
      stopped: false, last_sync: null, error: { code: "COLLECTION_INTERRUPTED", message: "That sync is no longer running." }
    };
  }
  if (message.type === "sync.focus") {
    const active = await runOperations();
    return active.operations ? active.operations.sync.focus(message) : {
      type: "sync.focus.result", request_id: message.request_id, focused: false,
      error: { code: "COLLECTION_INTERRUPTED", message: "That sync is no longer running." }
    };
  }
  if (message.type === "instagram.collectionProgress" || message.type === "instagram.collectionTerminal") {
    const active = await runOperations();
    const matching = active.lastSync?.run_id === message.run_id
      && Boolean(sender?.tab?.incognito) === incognito;
    if (message.type === "instagram.collectionProgress") {
      return { type: "instagram.collectionProgress.ack", run_id: message.run_id,
        accepted: Boolean(matching && await active.operations.sync.handleProgress(message, sender)) };
    }
    return matching ? active.operations.sync.handleTerminal(message, sender)
      : { type: "instagram.collectionTerminal.ack", run_id: message.run_id, accepted: true };
  }
  if (message.type === "history.reset") {
    const active = message.confirm === true ? await runOperations() : null;
    const result = active?.operations
      ? await active.operations.sync.reset(message, (request) => emptyLocal.handle(request))
      : await emptySync.reset(message, (request) => emptyLocal.handle(request));
    if (result.reset) {
      accounts.clear();
      await updatePauseBadge(false);
    }
    return result;
  }
  if (message.type === "backup.import" && message.confirm !== true) return emptyLocal.handle(message);
  let account = (await accountStore.readLatest()).instagram_account;
  if (message.type === "history.deleteSync") {
    if (account !== message.instagram_account) return {
      type: "history.deleteSync.result", request_id: message.request_id, deleted: false,
      error: { code: "DELETE_INVALID", message: "The selected account changed. Refresh and retry." }
    };
  }
  if (message.type === "backup.import") {
    let backup;
    try { backup = JSON.parse(message.body); } catch { /* Local validation returns the exact import error below. */ }
    if (!validateBackup(backup).valid) return emptyLocal.handle(message);
    account = backup.history.meta.instagram_account ?? backup.history.last_snapshot?.instagram_account
      ?? backup.history.sync_points[0]?.instagram_account ?? backup.report?.instagram_account ?? backup.last_sync?.instagram_account;
    if (!account) return {
      type: "backup.import.result", request_id: message.request_id, imported: false, replaced_keys: [],
      error: { code: "IMPORT_INVALID", message: "The backup does not identify an Instagram account." }
    };
  }
  if (!account) return emptyLocal.handle(message);
  const operations = forAccount(account);
  return operations.sync.local(message, (request) => operations.local.handle(request));
}

const messages = new Set(["dashboard.getState", "sync.start", "sync.stop", "sync.focus", "instagram.collectionProgress",
  "instagram.collectionTerminal", "history.reset", "history.deleteSync", "backup.import", "backup.export", "report.export"]);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (typeof message?.type === "string" && message.type.startsWith("telemetry.")) {
    const trusted = sender?.id === chrome.runtime.id
      && sender?.url?.split(/[?#]/)[0] === chrome.runtime.getURL("dashboard/index.html");
    if (!trusted || typeof message.request_id !== "string" || !message.request_id) return undefined;
    let operation;
    if (message.type === "telemetry.getState" && exactKeys(message, ["type", "request_id"])) operation = telemetry.getState();
    if (message.type === "telemetry.setConsent" && exactKeys(message, ["type", "request_id", "enabled"]) && typeof message.enabled === "boolean") {
      operation = telemetry.setConsent(message.enabled);
    }
    if (message.type === "telemetry.record" && exactKeys(message, ["type", "request_id", "event"]) && validTelemetryEvent(message.event, { dashboard: true })) {
      operation = telemetry.record(message.event).then((accepted) => ({ accepted }));
    }
    if (message.type === "telemetry.record" && !operation) operation = Promise.resolve({ accepted: false });
    if (!operation) return undefined;
    operation.then((value) => sendResponse({ type: message.type === "telemetry.record" ? "telemetry.record.result" : "telemetry.state",
      request_id: message.request_id, ...(value === false ? { consent: "denied", enabled: false, incognito } : value),
      error: value === false ? { code: "STORAGE_ERROR" } : null
    }), () => sendResponse({ type: "telemetry.state", request_id: message.request_id, consent: "denied", enabled: false, incognito,
      error: { code: "STORAGE_ERROR" } }));
    return true;
  }
  if (!messages.has(message?.type)) return undefined;
  let eligible = false;
  const operation = message.type === "dashboard.getState" ? handle(message, sender) : serialize(async () => {
    if (message.type === "sync.start") eligible = await telemetry.eligibility().catch(() => null);
    return handle(message, sender, eligible);
  });
  operation.then(sendResponse, () => {
    if (message.type === "sync.start") {
      const runId = `sync_storage_${crypto.randomUUID()}`;
      telemetry.prepareRun(runId, eligible);
      telemetry.observe({ run_id: runId, state: "failed", error: { code: "STORAGE_ERROR" } });
    }
    sendResponse({
    type: `${message.type}.result`, request_id: message.request_id ?? null,
    error: { code: "STORAGE_ERROR", message: "Unable to read or update local extension storage." }
    });
  });
  return true;
});

chrome.storage.onChanged?.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes["instatrack.control.v1"]) accounts.clear();
});

function reconcileCollector() {
  serialize(async () => {
    const active = await runOperations();
    if (active.lastSync?.state === "running") await active.operations.sync.reconcileClosedCollector();
  }).catch(() => {});
}
chrome.tabs.onRemoved?.addListener(reconcileCollector);
chrome.tabs.onUpdated?.addListener((_tabId, change) => {
  if (change.status === "complete") reconcileCollector();
});
if (!incognito) chrome.runtime.onStartup?.addListener(() => {
  serialize(async () => {
    const active = await accountStore.readRun();
    await accountStore.interruptRunsAfterRestart(utcTimestamp());
    if (active.lastSync?.state === "running") telemetry.observe({ run_id: active.lastSync.run_id,
      state: "interrupted", error: { code: "COLLECTION_INTERRUPTED" } });
    await updatePauseBadge(false);
  }).catch(() => {});
});
