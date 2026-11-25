import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { buildCompletedSync, utcTimestamp } from "../extension/src/domain/analytics.js";
import { validateBackup } from "../extension/src/domain/schema.js";
import { serializeBackup, serializeReportCsv } from "../extension/src/domain/serialization.js";

// All input handles are fictional. No browser, cookies, storage or network is used.
const fixture = JSON.parse(readFileSync(new URL("./account-lists.json", import.meta.url), "utf8"));
let completed;
for (const [index, sync] of fixture.syncs.entries()) {
  completed = buildCompletedSync(completed?.history, {
    run_id: `demo_sync_${index + 1}`,
    instagram_account: fixture.instagram_account,
    finished_at: utcTimestamp(new Date(sync.at)),
    followers: sync.followers,
    following: sync.following
  });
}
assert.deepEqual(completed.report.unfollowed_me.map(row => row.username), ["demo.brook"]);
assert.deepEqual(completed.report.new_followers.map(row => row.username), ["demo.ellis"]);
assert.deepEqual(completed.report.i_unfollowed.map(row => row.username), ["demo.casey"]);
const backup = serializeBackup({ exportedAt: utcTimestamp(new Date(fixture.syncs.at(-1).at)),
  history: completed.history, report: completed.report, lastSync: null });
validateBackup(JSON.parse(backup));
writeFileSync(new URL("./synthetic-backup.json", import.meta.url), backup);
writeFileSync(new URL("./synthetic-report.csv", import.meta.url), serializeReportCsv(completed.report));
console.log("Offline demo passed: synthetic relationship changes, backup validation and CSV export.");
