import { BACKUP_SCHEMA } from "../shared/constants.js";
import { EVENT_TYPES, migrateLegacyReport, REPORT_GROUPS } from "./analytics.js";

const LAST_SYNC_STATES = new Set(["running", "completed", "failed", "interrupted"]);
const LAST_SYNC_STAGES = new Set([
  "preflight",
  "collecting_followers",
  "collecting_following",
  "processing",
  "stored",
  "exporting",
  "importing",
  "resetting"
]);
const ERROR_CODES = new Set([
  "COLLECTION_FAILED",
  "CURRENT_ACCOUNT_UNAVAILABLE",
  "NOT_LOGGED_IN",
  "NOT_INSTAGRAM",
  "STORAGE_ERROR",
  "COLLECTION_INTERRUPTED",
  "RESET_NOT_CONFIRMED",
  "IMPORT_NOT_CONFIRMED",
  "IMPORT_INVALID",
  "EXPORT_FAILED"
]);
const FAILED_ERROR_CODES = new Set([
  "COLLECTION_FAILED",
  "CURRENT_ACCOUNT_UNAVAILABLE",
  "NOT_LOGGED_IN",
  "NOT_INSTAGRAM",
  "STORAGE_ERROR"
]);
const USERNAME_PATTERN = /^[a-z0-9._]+$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isNormalizedUsername(value) {
  return typeof value === "string" && USERNAME_PATTERN.test(value);
}

function isNullableNormalizedUsername(value) {
  return value === null || isNormalizedUsername(value);
}

export function isTimestamp(value) {
  return (
    hasExactKeys(value, ["iso", "epoch"]) &&
    typeof value.iso === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.iso) &&
    Number.isInteger(value.epoch) &&
    value.epoch >= 0 &&
    !Number.isNaN(Date.parse(value.iso)) &&
    Math.floor(Date.parse(value.iso) / 1000) === value.epoch &&
    new Date(Date.parse(value.iso)).toISOString().replace(".000Z", "Z") === value.iso
  );
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isNullableNonNegativeInteger(value) {
  return value === null || isNonNegativeInteger(value);
}

function isErrorEnvelope(value) {
  return (
    hasExactKeys(value, ["code", "message"]) &&
    ERROR_CODES.has(value.code) &&
    typeof value.message === "string" &&
    Boolean(value.message)
  );
}

function isUsernameList(value) {
  return Array.isArray(value) && new Set(value).size === value.length && value.every(isNormalizedUsername);
}

function isSnapshot(value) {
  return (
    hasExactKeys(value, ["taken_at", "instagram_account", "followers", "following"]) &&
    isTimestamp(value.taken_at) &&
    isNullableNormalizedUsername(value.instagram_account) &&
    isUsernameList(value.followers) &&
    isUsernameList(value.following)
  );
}

function isEvent(value) {
  return (
    (hasExactKeys(value, ["type", "username", "detected_at"]) ||
      (hasExactKeys(value, ["type", "username", "detected_at", "run_id"]) && typeof value.run_id === "string" && Boolean(value.run_id))) &&
    EVENT_TYPES.includes(value.type) &&
    isNormalizedUsername(value.username) &&
    isTimestamp(value.detected_at)
  );
}

function isSyncPoint(value) {
  return (
    hasExactKeys(value, ["run_id", "taken_at", "instagram_account", "followers_count", "following_count", "changes"]) &&
    typeof value.run_id === "string" &&
    Boolean(value.run_id) &&
    isTimestamp(value.taken_at) &&
    isNormalizedUsername(value.instagram_account) &&
    isNonNegativeInteger(value.followers_count) &&
    isNonNegativeInteger(value.following_count) &&
    hasExactKeys(value.changes, ["followers_gained", "followers_lost", "following_added", "following_removed"]) &&
    Object.values(value.changes).every(isNonNegativeInteger)
  );
}

export function isHistory(value) {
  return (
    hasExactKeys(value, ["version", "created_at", "last_snapshot", "events", "sync_points", "meta"]) &&
    value.version === 1 &&
    isTimestamp(value.created_at) &&
    (value.last_snapshot === null || isSnapshot(value.last_snapshot)) &&
    Array.isArray(value.events) &&
    value.events.every(isEvent) &&
    Array.isArray(value.sync_points) &&
    value.sync_points.every(isSyncPoint) &&
    hasExactKeys(value.meta, ["instagram_account", "a_first_detected"]) &&
    isNullableNormalizedUsername(value.meta.instagram_account) &&
    isObject(value.meta.a_first_detected) &&
    Object.entries(value.meta.a_first_detected).every(([username, timestamp]) => isNormalizedUsername(username) && isTimestamp(timestamp))
  );
}

function isReportItem(value) {
  return hasExactKeys(value, ["username", "detected_at"]) && isNormalizedUsername(value.username) && isTimestamp(value.detected_at);
}

export function isReport(value) {
  return (
    hasExactKeys(value, [
      "generated_at",
      "previous_snapshot_at",
      "instagram_account",
      "counts",
      "relationship_breakdown",
      ...REPORT_GROUPS
    ]) &&
    isTimestamp(value.generated_at) &&
    (value.previous_snapshot_at === null || isTimestamp(value.previous_snapshot_at)) &&
    isNormalizedUsername(value.instagram_account) &&
    hasExactKeys(value.counts, ["followers", "following", "A", "B", "C", "D", "E"]) &&
    Object.values(value.counts).every(isNonNegativeInteger) &&
    hasExactKeys(value.relationship_breakdown, [
      "mutual_follows",
      "following_not_following_back",
      "followers_i_dont_follow_back"
    ]) &&
    Object.values(value.relationship_breakdown).every(isNonNegativeInteger) &&
    REPORT_GROUPS.every((group) => Array.isArray(value[group]) && value[group].every(isReportItem))
  );
}

function hasConsistentReportCounts(report) {
  return (
    report.counts.A === report.following_not_following_back.length &&
    report.counts.B === report.unfollowed_me.length &&
    report.counts.C === report.followers_i_dont_follow_back.length &&
    report.counts.D === report.i_unfollowed.length &&
    report.counts.E === report.new_followers.length &&
    report.relationship_breakdown.following_not_following_back === report.counts.A &&
    report.relationship_breakdown.followers_i_dont_follow_back === report.counts.C &&
    report.relationship_breakdown.mutual_follows === report.counts.followers - report.counts.C &&
    report.relationship_breakdown.mutual_follows === report.counts.following - report.counts.A
  );
}

function hasConsistentBackupAccounts({ history, report, last_sync: lastSync }) {
  const accounts = [
    history.meta.instagram_account,
    history.last_snapshot?.instagram_account,
    ...history.sync_points.map((syncPoint) => syncPoint.instagram_account),
    report?.instagram_account ?? null,
    lastSync?.instagram_account ?? null
  ].filter((account) => account !== null);

  return new Set(accounts).size <= 1;
}

export function isLastSync(value) {
  return (
    hasExactKeys(value, [
      "run_id",
      "state",
      "stage",
      "started_at",
      "finished_at",
      "instagram_account",
      "followers_count",
      "following_count",
      "duration_ms",
      "error",
      ...(Object.hasOwn(value ?? {}, "paused") ? ["paused"] : [])
    ]) &&
    (!Object.hasOwn(value, "paused") || typeof value.paused === "boolean") &&
    typeof value.run_id === "string" &&
    Boolean(value.run_id) &&
    LAST_SYNC_STATES.has(value.state) &&
    LAST_SYNC_STAGES.has(value.stage) &&
    isTimestamp(value.started_at) &&
    (value.finished_at === null || isTimestamp(value.finished_at)) &&
    isNullableNormalizedUsername(value.instagram_account) &&
    isNullableNonNegativeInteger(value.followers_count) &&
    isNullableNonNegativeInteger(value.following_count) &&
    isNullableNonNegativeInteger(value.duration_ms) &&
    (value.error === null || isErrorEnvelope(value.error)) &&
    (value.state !== "failed" || (value.error !== null && FAILED_ERROR_CODES.has(value.error.code))) &&
    (value.state !== "interrupted" || (value.error !== null && value.error.code === "COLLECTION_INTERRUPTED")) &&
    (["failed", "interrupted"].includes(value.state) || value.error === null)
  );
}

export function validateBackup(value) {
  if (!hasExactKeys(value, ["schema", "exported_at", "history", "report", "last_sync"])) {
    return { valid: false, message: "Backup schema is invalid." };
  }
  if (value.schema !== BACKUP_SCHEMA || !isTimestamp(value.exported_at) || !isHistory(value.history)) {
    return { valid: false, message: "Backup schema is invalid." };
  }
  const report = migrateLegacyReport(value.report, value.history);
  if (report !== null && !isReport(report)) {
    return { valid: false, message: "Backup report is invalid." };
  }
  if (value.last_sync !== null && !isLastSync(value.last_sync)) {
    return { valid: false, message: "Backup last sync is invalid." };
  }
  if (!hasConsistentBackupAccounts(value)) {
    return { valid: false, message: "Backup accounts are inconsistent." };
  }
  if (report !== null && !hasConsistentReportCounts(report)) {
    return { valid: false, message: "Backup report is inconsistent." };
  }

  return { valid: true };
}
