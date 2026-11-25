import { buildCompletedSync, createEmptyHistory, deleteSuccessfulSync, utcTimestamp } from "../domain/analytics.js";
import { isHistory, isLastSync, isReport, isTimestamp, validateBackup } from "../domain/schema.js";
import { filenameTimestamp, serializeBackup, serializeReportCsv, serializeReportJson } from "../domain/serialization.js";
import { STORAGE_KEY_NAMES } from "../shared/constants.js";

function error(code, message) {
  return { code, message };
}

function operationTimestamp(now) {
  const timestamp = typeof now === "function" ? now() : utcTimestamp();
  if (!isTimestamp(timestamp)) {
    throw new TypeError("Operation timestamps must be UTC second timestamps.");
  }
  return timestamp;
}

function completedLastSync(input, syncPoint) {
  const lastSync = {
    run_id: input.run_id,
    state: "completed",
    stage: "stored",
    started_at: input.started_at,
    finished_at: input.finished_at,
    instagram_account: syncPoint.instagram_account,
    followers_count: syncPoint.followers_count,
    following_count: syncPoint.following_count,
    duration_ms: input.duration_ms ?? null,
    error: null
  };
  if (!isLastSync(lastSync)) {
    throw new TypeError("Completed sync diagnostics are invalid.");
  }
  return lastSync;
}

function storageFailureLastSync(input, syncPoint) {
  const lastSync = {
    run_id: input.run_id,
    state: "failed",
    stage: "processing",
    started_at: input.started_at,
    finished_at: input.finished_at,
    instagram_account: syncPoint.instagram_account,
    followers_count: syncPoint.followers_count,
    following_count: syncPoint.following_count,
    duration_ms: input.duration_ms ?? null,
    error: error("STORAGE_ERROR", "Unable to store completed sync locally.")
  };
  return lastSync;
}

async function recordOperationStorageFailure(adapter, { runId, stage, timestamp }) {
  const lastSync = {
    run_id: runId,
    state: "failed",
    stage,
    started_at: timestamp,
    finished_at: timestamp,
    instagram_account: null,
    followers_count: null,
    following_count: null,
    duration_ms: null,
    error: error("STORAGE_ERROR", "Unable to update local extension storage.")
  };
  try {
    await adapter.writeLastSync(lastSync);
  } catch {
    // The original storage error also prevents recording its local diagnostic.
  }
}

export async function commitCompletedSync(adapter, input) {
  if (!isTimestamp(input.started_at) || !isTimestamp(input.finished_at)) {
    throw new TypeError("Completed sync timestamps are required.");
  }

  let current;
  try {
    current = await adapter.read();
  } catch (cause) {
    await recordOperationStorageFailure(adapter, {
      runId: input.run_id,
      stage: "processing",
      timestamp: input.finished_at
    });
    return {
      state: "failed",
      report: null,
      sync_point: null,
      error: error("STORAGE_ERROR", "Unable to store completed sync locally."),
      cause
    };
  }
  const completed = buildCompletedSync(current.history, input);
  const lastSync = completedLastSync(input, completed.sync_point);

  try {
    await adapter.writeState({ history: completed.history, report: completed.report, lastSync });
  } catch (cause) {
    const failedLastSync = storageFailureLastSync(input, completed.sync_point);
    try {
      await adapter.writeLastSync(failedLastSync);
    } catch {
      // Storage is unavailable; prior history and report were never mutated in memory.
    }
    return {
      state: "failed",
      report: null,
      sync_point: null,
      error: error("STORAGE_ERROR", "Unable to store completed sync locally."),
      cause
    };
  }

  return {
    state: "completed",
    history: completed.history,
    report: completed.report,
    sync_point: completed.sync_point,
    last_sync: lastSync,
    error: null
  };
}

export function createLocalOperationHandlers({ adapter, now = undefined }) {
  async function getDashboardState(message) {
    const state = await adapter.read();
    return {
      type: "dashboard.state",
      request_id: message.request_id,
      report: state.report,
      sync_points: state.history?.sync_points ?? [],
      last_sync: state.lastSync
    };
  }

  async function exportReport(message) {
    let state;
    try {
      state = await adapter.read();
    } catch {
      return {
        type: "report.export.result",
        request_id: message.request_id,
        filename: null,
        mime_type: null,
        body: null,
        error: error("EXPORT_FAILED", "Unable to read the stored report.")
      };
    }
    const report = state.report;
    if (!isReport(report) || !["json", "csv"].includes(message.format)) {
      return {
        type: "report.export.result",
        request_id: message.request_id,
        filename: null,
        mime_type: null,
        body: null,
        error: error("EXPORT_FAILED", "A stored report and supported export format are required.")
      };
    }

    const json = message.format === "json";
    return {
      type: "report.export.result",
      request_id: message.request_id,
      filename: `followers-tracker-pro-report-${filenameTimestamp(report.generated_at)}.${json ? "json" : "csv"}`,
      mime_type: json ? "application/json" : "text/csv;charset=utf-8",
      body: json ? serializeReportJson(report) : serializeReportCsv(report),
      error: null
    };
  }

  async function exportBackup(message) {
    let state;
    try {
      state = await adapter.read();
    } catch {
      return {
        type: "backup.export.result",
        request_id: message.request_id,
        filename: null,
        mime_type: null,
        body: null,
        error: error("EXPORT_FAILED", "Unable to read local backup data.")
      };
    }
    const exportedAt = operationTimestamp(now);
    const history = state.history ?? createEmptyHistory(exportedAt);
    return {
      type: "backup.export.result",
      request_id: message.request_id,
      filename: `followers-tracker-pro-backup-${filenameTimestamp(exportedAt)}.json`,
      mime_type: "application/json",
      body: serializeBackup({ exportedAt, history, report: state.report, lastSync: state.lastSync }),
      error: null
    };
  }

  async function importBackup(message) {
    if (message.confirm !== true) {
      return {
        type: "backup.import.result",
        request_id: message.request_id,
        imported: false,
        replaced_keys: [],
        error: error("IMPORT_NOT_CONFIRMED", "Backup import was not confirmed.")
      };
    }

    let backup;
    try {
      backup = JSON.parse(message.body);
    } catch {
      return {
        type: "backup.import.result",
        request_id: message.request_id,
        imported: false,
        replaced_keys: [],
        error: error("IMPORT_INVALID", "Backup schema is invalid.")
      };
    }

    const validation = validateBackup(backup);
    if (!validation.valid) {
      return {
        type: "backup.import.result",
        request_id: message.request_id,
        imported: false,
        replaced_keys: [],
        error: error("IMPORT_INVALID", validation.message)
      };
    }

    const backupAccount = backup.history.meta.instagram_account ?? backup.history.last_snapshot?.instagram_account
      ?? backup.history.sync_points[0]?.instagram_account ?? backup.report?.instagram_account ?? backup.last_sync?.instagram_account;
    if (adapter.account && backupAccount && backupAccount !== adapter.account) {
      return {
        type: "backup.import.result", request_id: message.request_id, imported: false, replaced_keys: [],
        error: error("IMPORT_INVALID", "This backup belongs to a different Instagram account.")
      };
    }
    if (typeof adapter.assertImportAllowed === "function") {
      try {
        await adapter.assertImportAllowed();
        const startedAt = operationTimestamp(now);
        const claimed = await adapter.claimRun({
          run_id: message.request_id, state: "running", stage: "importing", started_at: startedAt, finished_at: null,
          instagram_account: adapter.account, followers_count: null, following_count: null, duration_ms: null, error: null
        });
        if (!claimed) throw new Error("A sync for this Instagram account is already running in another browser context.");
      } catch (cause) {
        return {
          type: "backup.import.result", request_id: message.request_id, imported: false, replaced_keys: [],
          error: error("IMPORT_INVALID", cause.message)
        };
      }
    }

    try {
      const lastSync = backup.last_sync?.state === "running" ? {
        ...backup.last_sync,
        ...(Object.hasOwn(backup.last_sync, "paused") ? { paused: false } : {}),
        state: "interrupted",
        finished_at: operationTimestamp(now),
        duration_ms: null,
        error: error("COLLECTION_INTERRUPTED", "This backup contains an unfinished sync. Start a new sync to update analytics.")
      } : backup.last_sync;
      await adapter.writeState({
        history: backup.history,
        report: backup.report,
        lastSync
      });
    } catch {
      await recordOperationStorageFailure(adapter, {
        runId: message.request_id || "backup_import",
        stage: "importing",
        timestamp: operationTimestamp(now)
      });
      return {
        type: "backup.import.result",
        request_id: message.request_id,
        imported: false,
        replaced_keys: [],
        error: error("STORAGE_ERROR", "Unable to replace local backup data.")
      };
    }

    return {
      type: "backup.import.result",
      request_id: message.request_id,
      imported: true,
      replaced_keys: [...(adapter.storageKeys ?? STORAGE_KEY_NAMES)],
      error: null
    };
  }

  async function resetHistory(message) {
    if (message.confirm !== true) {
      return {
        type: "history.reset.result",
        request_id: message.request_id,
        reset: false,
        deleted_keys: [],
        error: error("RESET_NOT_CONFIRMED", "History reset was not confirmed.")
      };
    }

    let deletedKeys;
    try {
      deletedKeys = await adapter.reset();
    } catch {
      await recordOperationStorageFailure(adapter, {
        runId: message.request_id || "history_reset",
        stage: "resetting",
        timestamp: operationTimestamp(now)
      });
      return {
        type: "history.reset.result",
        request_id: message.request_id,
        reset: false,
        deleted_keys: [],
        error: error("STORAGE_ERROR", "Unable to reset local history.")
      };
    }

    return {
      type: "history.reset.result",
      request_id: message.request_id,
      reset: true,
      deleted_keys: deletedKeys ?? [...STORAGE_KEY_NAMES],
      error: null
    };
  }

  async function deleteSync(message) {
    const response = (deleted, operationError = null) => ({
      type: "history.deleteSync.result", request_id: message.request_id ?? null, deleted, error: operationError
    });
    if (message.confirm !== true) return response(false, error("DELETE_NOT_CONFIRMED", "Sync deletion was not confirmed."));
    if (Object.keys(message).length !== 5 || typeof message.request_id !== "string" || !message.request_id ||
      typeof message.run_id !== "string" || !message.run_id || message.instagram_account !== adapter.account) {
      return response(false, error("DELETE_INVALID", "The selected account and sync are required."));
    }
    function rebuild(state) {
      if (!isHistory(state.history)) throw new TypeError("Cannot verify this history for deletion.");
      const rebuilt = deleteSuccessfulSync(state.history, message.run_id, message.instagram_account);
      const point = rebuilt.history.sync_points.at(-1);
      return { ...rebuilt, lastSync: point ? completedLastSync({
        run_id: point.run_id, started_at: point.taken_at, finished_at: point.taken_at
      }, point) : null };
    }
    try {
      if (typeof adapter.updateHistory === "function") {
        await adapter.updateHistory(rebuild, operationTimestamp(now), `delete_${message.request_id}`);
      } else {
        const state = await adapter.read();
        if (state.lastSync?.state === "running") return response(false, error("COLLECTION_FAILED", "Stop the running sync before deleting history."));
        await adapter.writeState(rebuild(state));
      }
      return response(true);
    } catch (cause) {
      return response(false, error(cause instanceof TypeError ? "DELETE_INVALID" : cause.code === "COLLECTION_FAILED" ? cause.code : "STORAGE_ERROR",
        cause instanceof TypeError || cause.code === "COLLECTION_FAILED" ? cause.message : "Unable to delete this sync from local storage."));
    }
  }

  const handlers = {
    "dashboard.getState": getDashboardState,
    "report.export": exportReport,
    "backup.export": exportBackup,
    "backup.import": importBackup,
    "history.reset": resetHistory,
    "history.deleteSync": deleteSync
  };

  return {
    canHandle(message) {
      return Boolean(message && handlers[message.type]);
    },
    async handle(message) {
      const handler = handlers[message?.type];
      return handler ? handler(message) : null;
    }
  };
}
