export const TELEMETRY_ENDPOINT = "https://telemetry.example.invalid/api/events";
export const TELEMETRY_KEY = "instatrack.telemetry.v1";
export const TELEMETRY_ACTIONS = Object.freeze([
  "toolbar-open", "stop", "focus-sync", "delete-sync", "show-more-trend", "show-more-report",
  "export-csv", "export-json", "backup-export", "import-backup", "reset", "confirm-import",
  "cancel-import", "confirm-reset", "cancel-reset", "confirm-delete-sync", "cancel-delete-sync",
  "privacy", "contact", "analytics-enable"
]);
export const TELEMETRY_STATUSES = Object.freeze([
  "preflight", "collecting_followers", "collecting_following", "processing", "paused", "resumed",
  "completed", "failed", "interrupted"
]);
export const TELEMETRY_ERRORS = Object.freeze([
  "CURRENT_ACCOUNT_UNAVAILABLE", "NOT_LOGGED_IN", "NOT_INSTAGRAM", "COLLECTION_FAILED",
  "COLLECTION_INTERRUPTED", "STORAGE_ERROR"
]);
export const TERMINAL_STATUSES = Object.freeze(["completed", "failed", "interrupted"]);

export function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function validTelemetryEvent(event, { dashboard = false } = {}) {
  if (!exactKeys(event, ["name", "params"])) return false;
  if (["sync_click", "dashboard_open", "dashboard_first_open", "review_impression", "review_click"].includes(event.name)) {
    return (!dashboard || event.name !== "dashboard_first_open") && exactKeys(event.params, []);
  }
  if (event.name === "button_click") return exactKeys(event.params, ["action"])
    && TELEMETRY_ACTIONS.includes(event.params.action);
  if (dashboard || event.name !== "sync_status" || !exactKeys(event.params, ["status", "error_code"])) return false;
  const { status, error_code: code } = event.params;
  if (!TELEMETRY_STATUSES.includes(status)) return false;
  if (status === "failed") return TELEMETRY_ERRORS.includes(code) && code !== "COLLECTION_INTERRUPTED";
  if (status === "interrupted") return code === "COLLECTION_INTERRUPTED";
  return code === null;
}

export function validTelemetryPayload(body) {
  return exactKeys(body, ["schema_version", "client_id", "session_id", "event"])
    && body.schema_version === 1
    && typeof body.client_id === "string"
    && /^\d{1,10}\.\d{1,10}$/.test(body.client_id)
    && Number.isSafeInteger(body.session_id) && body.session_id > 0
    && validTelemetryEvent(body.event);
}
