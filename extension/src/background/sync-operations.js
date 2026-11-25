import { normalizeUsername, normalizeUsernames } from "../domain/normalization.js";
import { isTimestamp } from "../domain/schema.js";
import { commitCompletedSync } from "./local-operations.js";

const PROGRESS_STAGES = new Set(["preflight", "collecting_followers", "collecting_following"]);
const CONTENT_PROTOCOL_VERSION = 2;
const COLLECTION_CODES = new Set([
  "CURRENT_ACCOUNT_UNAVAILABLE",
  "NOT_LOGGED_IN",
  "NOT_INSTAGRAM",
  "COLLECTION_FAILED",
  "COLLECTION_INTERRUPTED",
  "STORAGE_ERROR"
]);
const STOPPED_MESSAGE = "Sync stopped by you.";
const RELOAD_INSTAGRAM_MESSAGE = "Reload the Instagram tab and retry.";

function error(code, message) {
  return { code, message };
}

function timestamp(now) {
  if (typeof now === "function") {
    const value = now();
    if (!isTimestamp(value)) {
      throw new TypeError("Sync timestamps must be UTC second timestamps.");
    }
    return value;
  }

  const date = new Date();
  const epoch = Math.floor(date.getTime() / 1000);
  return { iso: new Date(epoch * 1000).toISOString().replace(".000Z", "Z"), epoch };
}

function durationMs(startedAt, finishedAt) {
  return Math.max(0, (finishedAt.epoch - startedAt.epoch) * 1000);
}

function runningLastSync(runId, startedAt, stage = "preflight") {
  return {
    run_id: runId,
    state: "running",
    stage,
    started_at: startedAt,
    finished_at: null,
    instagram_account: null,
    followers_count: null,
    following_count: null,
    duration_ms: null,
    error: null
  };
}

function terminalLastSync(run, state, finishedAt, operationError, values = {}) {
  return {
    run_id: run.id,
    state,
    stage: run.stage,
    started_at: run.startedAt,
    finished_at: finishedAt,
    instagram_account: values.instagramAccount ?? null,
    followers_count: values.followersCount ?? null,
    following_count: values.followingCount ?? null,
    duration_ms: durationMs(run.startedAt, finishedAt),
    error: operationError
  };
}

function isInstagramTab(tab) {
  try {
    return new URL(tab?.url).hostname.toLowerCase() === "www.instagram.com";
  } catch {
    return false;
  }
}

export function selectInstagramTab(tabs) {
  const matching = tabs.filter(isInstagramTab);
  if (!matching.length) {
    return null;
  }
  return matching.sort((left, right) => (
    (right.lastAccessed - left.lastAccessed) || (left.id - right.id)
  ))[0];
}

export function isStart(message) {
  return Boolean(
    message &&
    Object.keys(message).length === 3 &&
    message.type === "sync.start" &&
    typeof message.request_id === "string" &&
    message.request_id &&
    isTimestamp(message.requested_at)
  );
}

function isStop(message) {
  return Boolean(
    message &&
    Object.keys(message).length === 3 &&
    message.type === "sync.stop" &&
    typeof message.request_id === "string" &&
    message.request_id &&
    typeof message.run_id === "string" &&
    message.run_id
  );
}

function sameTimestamp(left, right) {
  return isTimestamp(left) && isTimestamp(right) && left.iso === right.iso && left.epoch === right.epoch;
}

function hasCollectionResultRun(message, runId) {
  return Boolean(
    message &&
    Object.keys(message).length === 7 &&
    message.type === "instagram.collectRelationships.result" &&
    message.run_id === runId
  );
}

function completedCollection(message, runId) {
  if (
    !message ||
    Object.keys(message).length !== 7 ||
    message.type !== "instagram.collectRelationships.result" ||
    message.run_id !== runId ||
    message.state !== "completed" ||
    message.error !== null ||
    !Array.isArray(message.followers) ||
    !Array.isArray(message.following)
  ) {
    return null;
  }
  const instagramAccount = normalizeUsername(message.instagram_account);
  if (!instagramAccount) {
    return null;
  }
  try {
    return {
      instagramAccount,
      followers: normalizeUsernames(message.followers),
      following: normalizeUsernames(message.following)
    };
  } catch {
    return null;
  }
}

function failedCollection(message, runId) {
  if (
    !message ||
    Object.keys(message).length !== 7 ||
    message.type !== "instagram.collectRelationships.result" ||
    message.run_id !== runId ||
    !["failed", "interrupted"].includes(message.state) ||
    message.instagram_account !== null ||
    message.followers !== null ||
    message.following !== null ||
    !message.error ||
    typeof message.error.message !== "string"
  ) {
    return null;
  }
  const code = COLLECTION_CODES.has(message.error.code)
    ? message.error.code
    : message.state === "interrupted" ? "COLLECTION_INTERRUPTED" : "COLLECTION_FAILED";
  if ((message.state === "interrupted") !== (code === "COLLECTION_INTERRUPTED")) {
    return null;
  }
  return { state: message.state, error: error(code, message.error.message) };
}

function existingAccount(history) {
  return normalizeUsername(history?.last_snapshot?.instagram_account ?? history?.meta?.instagram_account ?? "");
}

function accepted(requestId, run, recovered) {
  return {
    type: "sync.accepted",
    request_id: requestId,
    state: "running",
    run_id: run.id,
    started_at: run.startedAt,
    stage: run.stage,
    recovered
  };
}

function syncResult(requestId, outcome) {
  return { ...outcome, request_id: requestId };
}

function stopResult(message, stopped, lastSync, operationError) {
  return {
    type: "sync.stop.result",
    request_id: message?.request_id ?? null,
    run_id: message?.run_id ?? null,
    stopped,
    last_sync: lastSync,
    error: operationError
  };
}

function isUserStopped(lastSync, runId = lastSync?.run_id) {
  return Boolean(
    lastSync?.run_id === runId &&
    lastSync.state === "interrupted" &&
    lastSync.error?.code === "COLLECTION_INTERRUPTED" &&
    lastSync.error.message === STOPPED_MESSAGE
  );
}

function hasSyncPoint(history, runId) {
  return history?.sync_points?.some((point) => point.run_id === runId) ?? false;
}

function isMonotonicProgressStage(current, next) {
  return current === next ||
    (current === "preflight" && next === "collecting_followers") ||
    (current === "collecting_followers" && next === "collecting_following");
}

function completedFromStoredState(run, state) {
  const syncPoint = state.history.sync_points.find((point) => point.run_id === run.id);
  return {
    type: "sync.result",
    state: "completed",
    run_id: run.id,
    started_at: run.startedAt,
    finished_at: syncPoint.taken_at,
    instagram_account: syncPoint.instagram_account,
    followers_count: syncPoint.followers_count,
    following_count: syncPoint.following_count,
    duration_ms: state.lastSync?.duration_ms ?? durationMs(run.startedAt, syncPoint.taken_at),
    sync_point: syncPoint,
    report: state.report,
    error: null
  };
}

function terminalFromStoredState(lastSync) {
  return {
    type: "sync.result",
    state: lastSync.state,
    run_id: lastSync.run_id,
    started_at: lastSync.started_at,
    finished_at: lastSync.finished_at,
    instagram_account: lastSync.instagram_account,
    followers_count: lastSync.followers_count,
    following_count: lastSync.following_count,
    duration_ms: lastSync.duration_ms,
    sync_point: null,
    report: null,
    error: lastSync.error
  };
}

function isCollectorInspection(response, runId, startedAt, states, stage = undefined) {
  return Boolean(
    response &&
    Object.keys(response).length === 7 &&
    response.type === "instagram.collectRelationships.inspect.result" &&
    response.protocol_version === CONTENT_PROTOCOL_VERSION &&
    states.has(response.state) &&
    response.run_id === runId &&
    typeof response.request_id === "string" &&
    response.request_id &&
    isTimestamp(response.started_at) &&
    (!startedAt || sameTimestamp(response.started_at, startedAt)) &&
    typeof response.stage === "string" &&
    (stage === undefined || response.stage === stage)
  );
}

function isIdleCollectorInspection(response) {
  return Boolean(
    response &&
    Object.keys(response).length === 7 &&
    response.type === "instagram.collectRelationships.inspect.result" &&
    response.state === "idle" &&
    response.run_id === null &&
    response.request_id === null &&
    response.started_at === null &&
    response.stage === null &&
    response.protocol_version === CONTENT_PROTOCOL_VERSION
  );
}

export function createSyncOperations({ adapter, tabs, sendMessage, broadcast = undefined, activateDashboard = undefined, focusTab = undefined, now = undefined, createRunId = undefined, observeSync = undefined, prepareTelemetryRun = undefined }) {
  let serial = Promise.resolve();

  function observe(lastSync) {
    try { Promise.resolve(observeSync?.(lastSync)).catch(() => {}); } catch { /* Analytics cannot affect sync. */ }
  }

  function serialize(operation) {
    const response = serial.then(operation, operation);
    serial = response.catch(() => undefined);
    return response;
  }

  function runId(startedAt) {
    if (typeof createRunId === "function") {
      return createRunId(startedAt);
    }
    const unique = globalThis.crypto?.randomUUID?.().replaceAll("-", "") ?? `${startedAt.epoch}`;
    return `sync_${startedAt.iso.replace(/[^0-9]/g, "")}_${unique}`;
  }

  async function notify(outcome, requestId) {
    if (typeof broadcast !== "function") {
      return;
    }
    try {
      await broadcast(syncResult(requestId, outcome));
    } catch {
      // Dashboard delivery is advisory; the terminal state is already local.
    }
  }

  async function returnToDashboard() {
    if (typeof activateDashboard !== "function") {
      return;
    }
    try {
      await activateDashboard();
    } catch {
      // Returning focus is advisory; the terminal state is already local.
    }
  }

  async function terminal(run, state, operationError, values = {}) {
    const finishedAt = timestamp(now);
    let terminalState = state;
    let terminalError = operationError;
    let lastSync = terminalLastSync(run, terminalState, finishedAt, terminalError, values);
    try {
      await adapter.writeLastSync(lastSync);
    } catch {
      terminalState = "failed";
      terminalError = error("STORAGE_ERROR", "Unable to update local extension storage.");
      lastSync = terminalLastSync(run, terminalState, finishedAt, terminalError, values);
      return {
        persisted: false,
        lastSync,
        outcome: {
          type: "sync.result",
          state: terminalState,
          run_id: run.id,
          started_at: run.startedAt,
          finished_at: finishedAt,
          instagram_account: lastSync.instagram_account,
          followers_count: lastSync.followers_count,
          following_count: lastSync.following_count,
          duration_ms: lastSync.duration_ms,
          sync_point: null,
          report: null,
          error: terminalError
        }
      };
    }
    observe(lastSync);
    return {
      persisted: true,
      lastSync,
      outcome: {
        type: "sync.result",
        state: terminalState,
        run_id: run.id,
        started_at: run.startedAt,
        finished_at: finishedAt,
        instagram_account: lastSync.instagram_account,
        followers_count: lastSync.followers_count,
        following_count: lastSync.following_count,
        duration_ms: lastSync.duration_ms,
        sync_point: null,
        report: null,
        error: terminalError
      }
    };
  }

  async function storageFailure(run, values = {}) {
    return terminal(run, "failed", error("STORAGE_ERROR", "Unable to update local extension storage."), values);
  }

  async function selectedTab(tabId) {
    if (Number.isInteger(tabId)) {
      return (await tabs.query({})).find((tab) => tab.id === tabId && isInstagramTab(tab)) ?? null;
    }
    const focused = await tabs.query({ active: true, lastFocusedWindow: true });
    return focused.find(isInstagramTab) ?? selectInstagramTab(await tabs.query({}));
  }

  function isCollectorAccepted(response, run) {
    return Boolean(
      response &&
      Object.keys(response).length === 4 &&
      response.type === "instagram.collectRelationships.accepted" &&
      response.run_id === run.id &&
      ["started", "already_running", "terminal_pending"].includes(response.state) &&
      response.protocol_version === CONTENT_PROTOCOL_VERSION
    );
  }

  async function launch(run, requestId, tabId) {
    let tab;
    try {
      tab = await selectedTab(tabId);
    } catch {
      return terminal(run, "failed", error("NOT_INSTAGRAM", "Unable to access Instagram tabs. Open Instagram and retry."));
    }
    if (!tab || !Number.isInteger(tab.id)) {
      return terminal(run, "failed", error("NOT_INSTAGRAM", "Open Instagram in a tab, sign in, and retry."));
    }

    try {
      const response = await sendMessage(tab.id, {
        type: "instagram.collectRelationships.start",
        run_id: run.id,
        request_id: requestId,
        started_at: run.startedAt,
        protocol_version: CONTENT_PROTOCOL_VERSION
      });
      if (!isCollectorAccepted(response, run)) {
        return terminal(run, "interrupted", error("COLLECTION_INTERRUPTED", RELOAD_INSTAGRAM_MESSAGE));
      }
    } catch {
      return terminal(run, "interrupted", error("COLLECTION_INTERRUPTED", RELOAD_INSTAGRAM_MESSAGE));
    }

    return null;
  }

  async function inspectRunningCollector(run) {
    const inspected = await Promise.all((await tabs.query({})).filter(isInstagramTab).map(async (tab) => {
      try {
        return { tabId: tab.id, response: await sendMessage(tab.id, {
          type: "instagram.collectRelationships.inspect",
          protocol_version: CONTENT_PROTOCOL_VERSION
        }) };
      } catch {
        return null;
      }
    }));
    return inspected.find((entry) => (
      entry &&
      isCollectorInspection(entry.response, run.id, run.startedAt, new Set(["running", "terminal_pending"]))
    )) ?? null;
  }

  function isCollectorStopped(response, runId) {
    return Boolean(
      response &&
      Object.keys(response).length === 4 &&
      response.type === "instagram.collectRelationships.stop.result" &&
      response.run_id === runId &&
      typeof response.stopped === "boolean" &&
      response.protocol_version === CONTENT_PROTOCOL_VERSION
    );
  }

  async function inspectCollectors() {
    let openTabs;
    try {
      openTabs = await tabs.query({});
    } catch {
      return { confirmed: false, collectors: [] };
    }
    const inspected = await Promise.all(openTabs.filter(isInstagramTab).map(async (tab) => {
      try {
        const response = await sendMessage(tab.id, {
          type: "instagram.collectRelationships.inspect",
          protocol_version: CONTENT_PROTOCOL_VERSION
        });
        if (isIdleCollectorInspection(response)) {
          return { confirmed: true, collector: null };
        }
        if (isCollectorInspection(response, response?.run_id, undefined, new Set(["running", "terminal_pending"]))) {
          return { confirmed: true, collector: { tabId: tab.id, runId: response.run_id } };
        }
        return { confirmed: false, collector: null };
      } catch {
        return { confirmed: false, collector: null };
      }
    }));
    return {
      confirmed: inspected.every((entry) => entry.confirmed),
      collectors: inspected.flatMap((entry) => entry.collector ? [entry.collector] : [])
    };
  }

  async function quiesceCollectors(targetRunId = undefined) {
    const inspected = await inspectCollectors();
    if (!inspected.confirmed) {
      return false;
    }
    if (
      targetRunId !== undefined &&
      inspected.collectors.some(({ runId: collectorRunId }) => collectorRunId !== targetRunId)
    ) {
      return false;
    }
    const collectors = targetRunId === undefined
      ? inspected.collectors
      : inspected.collectors.filter(({ runId: collectorRunId }) => collectorRunId === targetRunId);
    const stopped = await Promise.all(collectors.map(async ({ tabId, runId: collectorRunId }) => {
      try {
        const response = await sendMessage(tabId, {
          type: "instagram.collectRelationships.stop",
          run_id: collectorRunId,
          protocol_version: CONTENT_PROTOCOL_VERSION
        });
        return isCollectorStopped(response, collectorRunId) && response.stopped;
      } catch {
        return false;
      }
    }));
    return stopped.every(Boolean);
  }

  async function inspectSender(tabId, runId, startedAt, states, stage = undefined) {
    try {
      const response = await sendMessage(tabId, {
        type: "instagram.collectRelationships.inspect",
        protocol_version: CONTENT_PROTOCOL_VERSION
      });
      return isCollectorInspection(response, runId, startedAt, states, stage) ? response : null;
    } catch {
      return null;
    }
  }

  async function conclude(run, collection) {
    let state;
    try {
      state = await adapter.read();
    } catch {
      return storageFailure(run);
    }
    if (hasSyncPoint(state.history, run.id)) {
      return { persisted: true, outcome: completedFromStoredState(run, state) };
    }

    const completed = completedCollection(collection, run.id);
    if (!completed) {
      const failed = failedCollection(collection, run.id);
      return failed
        ? terminal(run, failed.state, failed.error)
        : terminal(run, "failed", error("COLLECTION_FAILED", "Sync failed before both followers and following were collected."));
    }

    if (adapter.account && completed.instagramAccount !== adapter.account) {
      return terminal(run, "interrupted", error("COLLECTION_INTERRUPTED", "The Instagram account changed during sync. Retry for the current account."));
    }


    const knownValues = {
      instagramAccount: completed.instagramAccount,
      followersCount: completed.followers.length,
      followingCount: completed.following.length
    };
    run.stage = "processing";
    try {
      await adapter.writeLastSync(runningLastSync(run.id, run.startedAt, run.stage));
      observe(runningLastSync(run.id, run.startedAt, run.stage));
    } catch {
      return storageFailure(run, knownValues);
    }
    if (existingAccount(state.history) && existingAccount(state.history) !== completed.instagramAccount) {
      return terminal(
        run,
        "failed",
        error("COLLECTION_FAILED", "This Instagram account differs from the stored history. Export or reset the existing history before switching accounts."),
        knownValues
      );
    }

    const finishedAt = timestamp(now);
    const committed = await commitCompletedSync(adapter, {
      run_id: run.id,
      started_at: run.startedAt,
      finished_at: finishedAt,
      instagram_account: completed.instagramAccount,
      followers: completed.followers,
      following: completed.following,
      duration_ms: durationMs(run.startedAt, finishedAt)
    });
    if (committed.state !== "completed") {
      return terminal(run, "failed", committed.error, knownValues);
    }
    observe({ run_id: run.id, state: "completed" });
    return {
      persisted: true,
      outcome: {
        type: "sync.result",
        state: "completed",
        run_id: run.id,
        started_at: run.startedAt,
        finished_at: finishedAt,
        instagram_account: committed.sync_point.instagram_account,
        followers_count: committed.sync_point.followers_count,
        following_count: committed.sync_point.following_count,
        duration_ms: durationMs(run.startedAt, finishedAt),
        sync_point: committed.sync_point,
        report: committed.report,
        error: null
      }
    };
  }

  async function begin(message, tabId, telemetryEligible = false) {
    if (!isStart(message)) {
      const startedAt = timestamp(now);
      const concluded = await terminal(
        { id: "sync_invalid", startedAt, stage: "preflight" },
        "failed",
        error("COLLECTION_FAILED", "Sync request is invalid.")
      );
      return syncResult(message?.request_id, concluded.outcome);
    }

    let state;
    try {
      state = await adapter.read();
    } catch {
      const startedAt = timestamp(now);
      const run = { id: runId(startedAt), startedAt, stage: "preflight" };
      try { Promise.resolve(prepareTelemetryRun?.(run.id, telemetryEligible)).catch(() => {}); } catch { /* Analytics is advisory. */ }
      const concluded = await storageFailure(run);
      return syncResult(message.request_id, concluded.outcome);
    }
    const lastSync = state.lastSync;
    if (lastSync?.state === "running") {
      const run = { id: lastSync.run_id, startedAt: lastSync.started_at, stage: lastSync.stage };
      let inspected;
      try {
        inspected = await inspectRunningCollector(run);
      } catch {
        const concluded = await storageFailure(run);
        return syncResult(message.request_id, concluded.outcome);
      }
      if (inspected) {
        run.stage = inspected.response.stage;
        return accepted(message.request_id, run, true);
      }
      if (run.stage === "preflight") {
        const concluded = await launch(run, message.request_id);
        if (concluded) {
          if (concluded.persisted) await notify(concluded.outcome, message.request_id);
          return syncResult(message.request_id, concluded.outcome);
        }
        return accepted(message.request_id, run, true);
      }
      const concluded = await terminal(run, "interrupted", error("COLLECTION_INTERRUPTED", RELOAD_INSTAGRAM_MESSAGE));
      if (concluded.persisted) await notify(concluded.outcome, message.request_id);
      return syncResult(message.request_id, concluded.outcome);
    }

    const startedAt = timestamp(now);
    const run = { id: runId(startedAt), startedAt, stage: "preflight" };
    try { Promise.resolve(prepareTelemetryRun?.(run.id, telemetryEligible)).catch(() => {}); } catch { /* Analytics is advisory. */ }
    try {
      const claim = { ...runningLastSync(run.id, run.startedAt), instagram_account: adapter.account ?? null };
      if (typeof adapter.claimRun === "function") {
        if (!await adapter.claimRun(claim)) {
          const conflict = (await adapter.read()).lastSync;
          observe(conflict);
          return syncResult(message.request_id, terminalFromStoredState(conflict));
        }
      } else {
        await adapter.writeLastSync(claim);
      }
    } catch {
      const concluded = await storageFailure(run);
      return syncResult(message.request_id, concluded.outcome);
    }
    const concluded = await launch(run, message.request_id, tabId);
    if (concluded) {
      if (concluded.persisted) await notify(concluded.outcome, message.request_id);
      return syncResult(message.request_id, concluded.outcome);
    }
    return accepted(message.request_id, run, false);
  }

  async function stopSync(message) {
    if (!isStop(message)) {
      return stopResult(
        message,
        false,
        null,
        error("COLLECTION_FAILED", "Sync stop request is invalid.")
      );
    }

    let state;
    try {
      state = await adapter.read();
    } catch {
      return stopResult(
        message,
        false,
        null,
        error("STORAGE_ERROR", "Unable to read local extension storage.")
      );
    }

    const lastSync = state.lastSync;
    if (isUserStopped(lastSync, message.run_id)) {
      if (!await quiesceCollectors(message.run_id)) {
        return stopResult(message, false, lastSync, error("COLLECTION_INTERRUPTED", RELOAD_INSTAGRAM_MESSAGE));
      }
      return stopResult(message, true, lastSync, null);
    }
    if (lastSync?.state !== "running" || lastSync.run_id !== message.run_id) {
      return stopResult(
        message,
        false,
        lastSync ?? null,
        error("COLLECTION_INTERRUPTED", "That sync is no longer running.")
      );
    }

    const run = {
      id: lastSync.run_id,
      startedAt: lastSync.started_at,
      stage: lastSync.stage
    };
    if (!await quiesceCollectors(run.id)) {
      return stopResult(message, false, lastSync, error("COLLECTION_INTERRUPTED", RELOAD_INSTAGRAM_MESSAGE));
    }
    const concluded = await terminal(
      run,
      "interrupted",
      error("COLLECTION_INTERRUPTED", STOPPED_MESSAGE)
    );
    if (!concluded.persisted) {
      return stopResult(message, false, null, concluded.outcome.error);
    }
    await notify(concluded.outcome, message.request_id);
    return stopResult(message, true, concluded.lastSync, null);
  }

  return {
    canHandle(message) {
      return ["sync.start", "sync.stop", "sync.focus"].includes(message?.type);
    },
    start(message, tabId, telemetryEligible = false) {
      return serialize(() => begin(message, tabId, telemetryEligible));
    },
    stop(message) {
      return serialize(() => stopSync(message));
    },
    focus(message) {
      return serialize(async () => {
        const response = (focused, operationError = null) => ({ type: "sync.focus.result", request_id: message?.request_id ?? null, focused, error: operationError });
        if (!isStop({ ...message, type: "sync.stop" })) return response(false, error("COLLECTION_FAILED", "Sync focus request is invalid."));
        const state = await adapter.read();
        const lastSync = state.lastSync;
        if (lastSync?.state !== "running" || lastSync.run_id !== message.run_id) return response(false, error("COLLECTION_INTERRUPTED", "That sync is no longer running."));
        try {
          const collector = await inspectRunningCollector({ id: lastSync.run_id, startedAt: lastSync.started_at });
          if (!collector || typeof focusTab !== "function") return response(false, error("COLLECTION_INTERRUPTED", RELOAD_INSTAGRAM_MESSAGE));
          await focusTab(collector.tabId);
          return response(true);
        } catch {
          return response(false, error("COLLECTION_INTERRUPTED", RELOAD_INSTAGRAM_MESSAGE));
        }
      });
    },
    reset(message, resetOperation) {
      return serialize(async () => {
        if (message?.confirm === true && !await quiesceCollectors()) {
          return {
            type: "history.reset.result",
            request_id: message?.request_id ?? null,
            reset: false,
            deleted_keys: [],
            error: error("COLLECTION_INTERRUPTED", RELOAD_INSTAGRAM_MESSAGE)
          };
        }
        return resetOperation(message);
      });
    },
    local(message, localOperation) {
      return serialize(() => localOperation(message));
    },
    reconcileClosedCollector() {
      return serialize(async () => {
        const state = await adapter.read();
        if (state.lastSync?.state !== "running") return;
        const run = { id: state.lastSync.run_id, startedAt: state.lastSync.started_at, stage: state.lastSync.stage };
        if (await inspectRunningCollector(run)) return;
        const concluded = await terminal(run, "interrupted", error("COLLECTION_INTERRUPTED", "The Instagram tab closed before sync finished. Open Instagram and retry."));
        if (concluded.persisted) await notify(concluded.outcome, null);
      });
    },
    handleProgress(message, sender) {
      return serialize(async () => {
        if (
          !message ||
          ![3, 4].includes(Object.keys(message).length) ||
          Object.keys(message).some((key) => !["type", "run_id", "stage", "paused"].includes(key)) ||
          (Object.hasOwn(message, "paused") && typeof message.paused !== "boolean") ||
          message.type !== "instagram.collectionProgress" ||
          !PROGRESS_STAGES.has(message.stage) ||
          !isInstagramTab(sender?.tab)
        ) {
          return false;
        }
        let state;
        try {
          state = await adapter.read();
        } catch {
          return false;
        }
        if (state.lastSync?.state !== "running" || state.lastSync.run_id !== message.run_id) {
          return false;
        }
        if (!isMonotonicProgressStage(state.lastSync.stage, message.stage)) {
          return false;
        }
        const inspected = await inspectSender(
          sender.tab.id,
          message.run_id,
          state.lastSync.started_at,
          new Set(["running"]),
          message.stage
        );
        if (!inspected) {
          return false;
        }
        const run = { id: message.run_id, startedAt: state.lastSync.started_at, stage: message.stage };
        try {
          const lastSync = { ...runningLastSync(run.id, run.startedAt, run.stage), instagram_account: adapter.account ?? null, paused: message.paused ?? false };
          await adapter.writeLastSync(lastSync);
          observe(lastSync);
          try {
            await broadcast?.({ type: "sync.progress", run_id: run.id, last_sync: lastSync });
          } catch {
            // Durable state remains authoritative when no dashboard receives the update.
          }
          return true;
        } catch {
          const concluded = await storageFailure(run);
          if (concluded.persisted) {
            await notify(concluded.outcome, inspected.request_id);
          }
          return false;
        }
      });
    },
    handleTerminal(message, sender) {
      return serialize(async () => {
        if (
          !message ||
          Object.keys(message).length !== 4 ||
          message.type !== "instagram.collectionTerminal" ||
          typeof message.run_id !== "string" ||
          !message.run_id ||
          typeof message.request_id !== "string" ||
          !message.request_id ||
          !hasCollectionResultRun(message.result, message.run_id) ||
          !isInstagramTab(sender?.tab)
        ) {
          return { type: "instagram.collectionTerminal.ack", run_id: message?.run_id ?? null, accepted: false };
        }
        const completed = completedCollection(message.result, message.run_id);
        const failed = failedCollection(message.result, message.run_id);
        if (!completed && !failed) {
          return { type: "instagram.collectionTerminal.ack", run_id: message.run_id, accepted: false };
        }

        let state;
        try {
          state = await adapter.read();
        } catch {
          return { type: "instagram.collectionTerminal.ack", run_id: message.run_id, accepted: false };
        }
        if (isUserStopped(state.lastSync, message.run_id)) {
          return { type: "instagram.collectionTerminal.ack", run_id: message.run_id, accepted: true };
        }
        const storageFailureResult = failed?.error.code === "STORAGE_ERROR";
        const inspected = await inspectSender(
          sender.tab.id,
          message.run_id,
          state.lastSync?.run_id === message.run_id ? state.lastSync.started_at : undefined,
          new Set(["terminal_pending"]),
          state.lastSync?.run_id === message.run_id && state.lastSync.state !== "completed" && !storageFailureResult ? state.lastSync.stage : undefined
        );
        if (!inspected || inspected.request_id !== message.request_id) {
          return { type: "instagram.collectionTerminal.ack", run_id: message.run_id, accepted: false };
        }
        const trustedRequestId = inspected.request_id;
        if (hasSyncPoint(state.history, message.run_id)) {
          if (state.lastSync?.run_id === message.run_id && state.lastSync.state === "completed") {
            await notify(completedFromStoredState({ id: message.run_id, startedAt: state.lastSync.started_at }, state), trustedRequestId);
            await returnToDashboard();
          }
          return { type: "instagram.collectionTerminal.ack", run_id: message.run_id, accepted: true };
        }
        if (state.lastSync?.run_id !== message.run_id) {
          return { type: "instagram.collectionTerminal.ack", run_id: message.run_id, accepted: true };
        }
        if (
          state.lastSync?.run_id === message.run_id &&
          ["failed", "interrupted"].includes(state.lastSync.state)
        ) {
          let outcome = terminalFromStoredState(state.lastSync);
          if (completed && state.lastSync.instagram_account === null) {
            const concluded = await terminal(
              {
                id: message.run_id,
                startedAt: state.lastSync.started_at,
                stage: state.lastSync.stage
              },
              "failed",
              state.lastSync.error,
              {
                instagramAccount: completed.instagramAccount,
                followersCount: completed.followers.length,
                followingCount: completed.following.length
              }
            );
            if (!concluded.persisted) {
              return { type: "instagram.collectionTerminal.ack", run_id: message.run_id, accepted: false };
            }
            outcome = concluded.outcome;
          }
          await notify(outcome, trustedRequestId);
          await returnToDashboard();
          return { type: "instagram.collectionTerminal.ack", run_id: message.run_id, accepted: true };
        }
        if (state.lastSync?.state !== "running" || state.lastSync.run_id !== message.run_id) {
          return { type: "instagram.collectionTerminal.ack", run_id: message.run_id, accepted: false };
        }

        const run = {
          id: message.run_id,
          startedAt: state.lastSync.started_at,
          stage: inspected.stage
        };
        const concluded = await conclude(run, message.result);
        if (!concluded.persisted) {
          return { type: "instagram.collectionTerminal.ack", run_id: message.run_id, accepted: false };
        }
        await notify(concluded.outcome, trustedRequestId);
        await returnToDashboard();
        return { type: "instagram.collectionTerminal.ack", run_id: message.run_id, accepted: true };
      });
    }
  };
}
