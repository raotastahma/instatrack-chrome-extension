import { BACKUP_SCHEMA } from "../shared/constants.js";
import { REPORT_GROUPS } from "./analytics.js";

export const CSV_COLUMNS = Object.freeze([
  "row_type",
  "generated_at_iso",
  "previous_snapshot_at_iso",
  "instagram_account",
  "metric_key",
  "metric_value",
  "group_key",
  "username",
  "detected_at_iso",
  "detected_at_epoch"
]);

const OVERVIEW_METRICS = Object.freeze([
  ["followers", (report) => report.counts.followers],
  ["following", (report) => report.counts.following],
  ["following_not_following_back", (report) => report.counts.A],
  ["unfollowed_me", (report) => report.counts.B],
  ["followers_i_dont_follow_back", (report) => report.counts.C],
  ["i_followed", (report) => report.i_followed.length],
  ["i_unfollowed", (report) => report.counts.D],
  ["new_followers", (report) => report.counts.E],
  ["mutual_follows", (report) => report.relationship_breakdown.mutual_follows]
]);
const FORMULA_PREFIX = /^[=+\-@]/;

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const safeText = FORMULA_PREFIX.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safeText) ? `"${safeText.replaceAll('"', '""')}"` : safeText;
}

function csvRow(values) {
  return values.map(csvCell).join(",");
}

export function serializeReportJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function serializeReportCsv(report) {
  const generatedAt = report.generated_at.iso;
  const previousAt = report.previous_snapshot_at?.iso ?? "";
  const account = report.instagram_account;
  const rows = [CSV_COLUMNS.join(",")];

  for (const [metricKey, readMetric] of OVERVIEW_METRICS) {
    rows.push(csvRow(["overview", generatedAt, previousAt, account, metricKey, readMetric(report), "", "", "", ""]));
  }

  for (const groupKey of REPORT_GROUPS) {
    for (const item of report[groupKey]) {
      rows.push(
        csvRow([
          "item",
          generatedAt,
          previousAt,
          account,
          "",
          "",
          groupKey,
          item.username,
          item.detected_at.iso,
          item.detected_at.epoch
        ])
      );
    }
  }

  return `${rows.join("\n")}\n`;
}

export function serializeBackup({ exportedAt, history, report, lastSync }) {
  return `${JSON.stringify(
    {
      schema: BACKUP_SCHEMA,
      exported_at: exportedAt,
      history,
      report,
      last_sync: lastSync
    },
    null,
    2
  )}\n`;
}

export function filenameTimestamp(timestamp) {
  return timestamp.iso.replaceAll("-", "").replaceAll(":", "").replace("T", "-").replace("Z", "");
}
