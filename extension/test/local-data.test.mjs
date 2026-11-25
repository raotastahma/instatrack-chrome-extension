import assert from "node:assert/strict";
import test from "node:test";
import { buildCompletedSync, createEmptyHistory } from "../src/domain/analytics.js";
import { normalizeUsername, normalizeUsernames } from "../src/domain/normalization.js";
import { isLastSync, validateBackup } from "../src/domain/schema.js";
import { CSV_COLUMNS, serializeReportCsv } from "../src/domain/serialization.js";
import { commitCompletedSync, createLocalOperationHandlers } from "../src/background/local-operations.js";
import { createStorageAdapter } from "../src/background/storage-adapter.js";
import { BACKUP_SCHEMA, STORAGE_KEYS, STORAGE_KEY_NAMES } from "../src/shared/constants.js";

const t1 = { iso: "2026-08-08T14:45:13Z", epoch: 1786200313 };
const t2 = { iso: "2026-08-08T14:46:13Z", epoch: 1786200373 };
const t3 = { iso: "2026-08-08T14:47:13Z", epoch: 1786200433 };

function clone(value) {
  return structuredClone(value);
}

class MemoryStorage {
  constructor(values = {}) {
    this.values = clone(values);
    this.getCalls = [];
    this.removeCalls = [];
    this.setCalls = [];
    this.failNextGet = false;
    this.failNextSet = false;
  }

  async get(keys) {
    keys ??= Object.keys(this.values);
    if (this.failNextGet) {
      this.failNextGet = false;
      throw new Error("simulated storage read failure");
    }
    this.getCalls.push([...keys]);
    return Object.fromEntries(keys.filter((key) => Object.hasOwn(this.values, key)).map((key) => [key, clone(this.values[key])]));
  }

  async set(values) {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error("simulated storage failure");
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

function completedInput(overrides = {}) {
  return {
    run_id: "sync_20260808_144513",
    started_at: t1,
    finished_at: t1,
    instagram_account: "@DemoStudio",
    followers: ["Alice", " @bob ", "alice", ""],
    following: ["bob", "@carol"],
    duration_ms: 13_000,
    ...overrides
  };
}

async function commit(adapter, overrides = {}) {
  const result = await commitCompletedSync(adapter, completedInput(overrides));
  assert.equal(result.state, "completed");
  return result;
}

test("username normalization trims, removes one at-sign, lowercases, drops empties, and deduplicates", () => {
  assert.equal(normalizeUsername(" @@Alice "), "@alice");
  assert.equal(normalizeUsername(null), "");
  assert.deepEqual(normalizeUsernames([" @Alice ", "alice", " BOB", "", "  "]), ["alice", "bob"]);
  assert.throws(() => normalizeUsernames(null), /must be an array/);
});

test("completed baseline stores a snapshot, report breakdown, and zero-change sync point without events", async () => {
  const storage = new MemoryStorage();
  const adapter = createStorageAdapter(storage);
  const result = await commit(adapter);
  const state = await adapter.read();

  assert.deepEqual(Object.keys(storage.setCalls[0]).sort(), [...STORAGE_KEY_NAMES].sort());
  assert.equal(storage.setCalls.length, 1, "a completed sync must use one three-key storage write");
  assert.deepEqual(state.history.last_snapshot, {
    taken_at: t1,
    instagram_account: "demostudio",
    followers: ["alice", "bob"],
    following: ["bob", "carol"]
  });
  assert.deepEqual(state.history.events, []);
  assert.deepEqual(result.sync_point.changes, {
    followers_gained: 0,
    followers_lost: 0,
    following_added: 0,
    following_removed: 0
  });
  assert.deepEqual(state.report.relationship_breakdown, {
    mutual_follows: 1,
    following_not_following_back: 1,
    followers_i_dont_follow_back: 1
  });
  assert.deepEqual(state.report.following_not_following_back, [{ username: "carol", detected_at: t1 }]);
  assert.deepEqual(state.report.followers_i_dont_follow_back, [{ username: "alice", detected_at: t1 }]);
  assert.deepEqual(state.report.i_followed, []);
  assert.equal(Object.hasOwn(state.report.counts, "F"), false);
  assert.equal(state.lastSync.state, "completed");
  assert.equal(state.lastSync.stage, "stored");
});

test("changed and unchanged completed syncs append points, retain first A detection, and do not duplicate events", async () => {
  const adapter = createStorageAdapter(new MemoryStorage());
  await commit(adapter);
  const changed = await commit(adapter, {
    run_id: "sync_20260808_144613",
    started_at: t2,
    finished_at: t2,
    followers: ["alice", "dave"],
    following: ["bob", "carol", "erin"]
  });

  assert.deepEqual(changed.report.previous_snapshot_at, t1);
  assert.deepEqual(changed.report.following_not_following_back, [
    { username: "bob", detected_at: t2 },
    { username: "carol", detected_at: t1 },
    { username: "erin", detected_at: t2 }
  ]);
  assert.deepEqual(changed.report.followers_i_dont_follow_back, [
    { username: "alice", detected_at: t1 },
    { username: "dave", detected_at: t2 }
  ]);
  assert.deepEqual(changed.report.unfollowed_me, [{ username: "bob", detected_at: t2 }]);
  assert.deepEqual(changed.report.i_followed, [{ username: "erin", detected_at: t2 }]);
  assert.deepEqual(changed.report.new_followers, [{ username: "dave", detected_at: t2 }]);

  const unchanged = await commit(adapter, {
    run_id: "sync_20260808_144713",
    started_at: t3,
    finished_at: t3,
    followers: ["dave", "alice"],
    following: ["erin", "carol", "bob"]
  });
  const state = await adapter.read();

  assert.equal(state.history.events.length, 3);
  assert.equal(state.history.sync_points.length, 3);
  assert.deepEqual(unchanged.sync_point.changes, {
    followers_gained: 0,
    followers_lost: 0,
    following_added: 0,
    following_removed: 0
  });
  assert.deepEqual(unchanged.report.previous_snapshot_at, t2);
  assert.deepEqual(unchanged.report.following_not_following_back, changed.report.following_not_following_back);
  assert.deepEqual(unchanged.report.followers_i_dont_follow_back, changed.report.followers_i_dont_follow_back);
  assert.deepEqual(unchanged.report.unfollowed_me, changed.report.unfollowed_me);
  assert.deepEqual(unchanged.report.i_followed, changed.report.i_followed);
  assert.deepEqual(unchanged.report.i_unfollowed, changed.report.i_unfollowed);
  assert.deepEqual(unchanged.report.new_followers, changed.report.new_followers);
});

test("event report history retains different usernames with their original detection dates", async () => {
  const adapter = createStorageAdapter(new MemoryStorage());
  await commit(adapter, { followers: ["alice", "bob", "carol"], following: [] });
  await commit(adapter, {
    run_id: "sync_20260808_144613",
    started_at: t2,
    finished_at: t2,
    followers: ["alice", "carol"],
    following: []
  });
  const latest = await commit(adapter, {
    run_id: "sync_20260808_144713",
    started_at: t3,
    finished_at: t3,
    followers: ["alice"],
    following: []
  });

  assert.deepEqual(latest.report.unfollowed_me, [
    { username: "bob", detected_at: t2 },
    { username: "carol", detected_at: t3 }
  ]);
});

test("following-not-following-back re-entry receives a new first-detected timestamp", () => {
  const baseline = buildCompletedSync(null, completedInput({ finished_at: t1 }));
  const left = buildCompletedSync(baseline.history, completedInput({
    run_id: "sync_20260808_144613",
    started_at: t2,
    finished_at: t2,
    followers: ["alice", "carol"],
    following: []
  }));
  const reentered = buildCompletedSync(left.history, completedInput({
    run_id: "sync_20260808_144713",
    started_at: t3,
    finished_at: t3,
    followers: ["alice"],
    following: ["carol"]
  }));

  assert.deepEqual(reentered.report.following_not_following_back, [{ username: "carol", detected_at: t3 }]);
  assert.deepEqual(reentered.history.meta.a_first_detected.carol, t3);
});

test("followers-i-dont-follow-back re-entry receives the new membership detection timestamp", () => {
  const baseline = buildCompletedSync(null, completedInput({ finished_at: t1, followers: ["alice"], following: [] }));
  const left = buildCompletedSync(baseline.history, completedInput({
    run_id: "sync_20260808_144613",
    started_at: t2,
    finished_at: t2,
    followers: ["alice"],
    following: ["alice"]
  }));
  const reentered = buildCompletedSync(left.history, completedInput({
    run_id: "sync_20260808_144713",
    started_at: t3,
    finished_at: t3,
    followers: ["alice"],
    following: []
  }));

  assert.deepEqual(reentered.report.followers_i_dont_follow_back, [{ username: "alice", detected_at: t3 }]);
});

test("prototype-named usernames retain their first-detected timestamp", () => {
  const completed = buildCompletedSync(null, completedInput({ followers: [], following: ["__proto__"] }));

  assert.equal(Object.hasOwn(completed.history.meta.a_first_detected, "__proto__"), true);
  assert.deepEqual(completed.report.following_not_following_back, [{ username: "__proto__", detected_at: t1 }]);
});

test("changed snapshots create every allowed relationship event type", () => {
  const history = createEmptyHistory(t1);
  history.last_snapshot = {
    taken_at: t1,
    instagram_account: "demostudio",
    followers: ["alice"],
    following: ["bob"]
  };
  const built = buildCompletedSync(history, completedInput({
    finished_at: t2,
    followers: ["bob"],
    following: ["alice"]
  }));

  assert.deepEqual(built.history.events, [
    { type: "follower_gained", username: "bob", detected_at: t2, run_id: built.sync_point.run_id },
    { type: "follower_lost", username: "alice", detected_at: t2, run_id: built.sync_point.run_id },
    { type: "following_added", username: "alice", detected_at: t2, run_id: built.sync_point.run_id },
    { type: "following_removed", username: "bob", detected_at: t2, run_id: built.sync_point.run_id }
  ]);
  assert.deepEqual(built.sync_point.changes, {
    followers_gained: 1,
    followers_lost: 1,
    following_added: 1,
    following_removed: 1
  });
});

test("history report groups retain the last event for each username", () => {
  const history = createEmptyHistory(t1);
  history.events = [
    { type: "follower_lost", username: "bob", detected_at: t1 },
    { type: "follower_lost", username: "bob", detected_at: t3 },
    { type: "following_added", username: "erin", detected_at: t2 },
    { type: "following_added", username: "zoe", detected_at: t3 },
    { type: "following_removed", username: "carol", detected_at: t2 },
    { type: "follower_gained", username: "dave", detected_at: t2 }
  ];
  const built = buildCompletedSync(history, completedInput({ followers: ["alice"], following: ["carol"], finished_at: t3 }));

  assert.deepEqual(built.report.unfollowed_me, [{ username: "bob", detected_at: t3 }]);
  assert.deepEqual(built.report.i_followed, [
    { username: "zoe", detected_at: t3 },
    { username: "erin", detected_at: t2 }
  ]);
  assert.deepEqual(built.report.i_unfollowed, [{ username: "carol", detected_at: t2 }]);
  assert.deepEqual(built.report.new_followers, [{ username: "dave", detected_at: t2 }]);
});

test("dashboard state exposes only report, sync points, and last sync from local storage", async () => {
  const storage = new MemoryStorage();
  const adapter = createStorageAdapter(storage);
  await commit(adapter);
  const handlers = createLocalOperationHandlers({ adapter, now: () => t2 });
  const response = await handlers.handle({ type: "dashboard.getState", request_id: "req_state" });

  assert.deepEqual(Object.keys(response), ["type", "request_id", "report", "sync_points", "last_sync"]);
  assert.equal(response.type, "dashboard.state");
  assert.equal(response.request_id, "req_state");
  assert.equal(response.sync_points.length, 1);
  assert.equal(response.report.generated_at.iso, t1.iso);
  assert.equal(response.last_sync.state, "completed");
  assert.deepEqual(storage.getCalls.at(-1), STORAGE_KEY_NAMES);
});

test("report JSON and CSV exports have the exact schema and stable row order", async () => {
  const adapter = createStorageAdapter(new MemoryStorage());
  const completed = await commit(adapter);
  const handlers = createLocalOperationHandlers({ adapter, now: () => t2 });
  const json = await handlers.handle({ type: "report.export", request_id: "req_json", format: "json" });
  const csv = await handlers.handle({ type: "report.export", request_id: "req_csv", format: "csv" });
  const rows = csv.body.trimEnd().split("\n");

  assert.equal(json.filename, "followers-tracker-pro-report-20260808-144513.json");
  assert.equal(json.mime_type, "application/json");
  assert.deepEqual(JSON.parse(json.body), completed.report);
  assert.equal(rows[0], CSV_COLUMNS.join(","));
  assert.deepEqual(
    rows.slice(1, 10).map((row) => row.split(",")[4]),
    [
      "followers",
      "following",
      "following_not_following_back",
      "unfollowed_me",
      "followers_i_dont_follow_back",
      "i_followed",
      "i_unfollowed",
      "new_followers",
      "mutual_follows"
    ]
  );
  assert.deepEqual(rows.slice(10).map((row) => row.split(",")[6]), [
    "following_not_following_back",
    "followers_i_dont_follow_back"
  ]);
  assert.equal(csv.mime_type, "text/csv;charset=utf-8");
  assert.equal(serializeReportCsv(completed.report), csv.body);
});

test("CSV serialization treats raw formula-prefixed cells as text without changing numeric values", () => {
  const completed = buildCompletedSync(null, completedInput({ followers: ["alice"], following: ["bob"] }));
  const rawReport = clone(completed.report);
  rawReport.generated_at = { iso: "=generated", epoch: t1.epoch };
  rawReport.previous_snapshot_at = { iso: "+previous", epoch: t1.epoch };
  rawReport.instagram_account = "-account";
  rawReport.counts.followers = 42;
  rawReport.following_not_following_back[0] = {
    username: "@username",
    detected_at: { iso: "=detected", epoch: 123 }
  };

  const rows = serializeReportCsv(rawReport).trimEnd().split("\n");

  assert.equal(rows[1], "overview,'=generated,'+previous,'-account,followers,42,,,,");
  assert.equal(rows[10], "item,'=generated,'+previous,'-account,,,following_not_following_back,'@username,'=detected,123");
});

test("backup export has only contract keys and import validates before replacing all three keys", async () => {
  const storage = new MemoryStorage();
  const adapter = createStorageAdapter(storage);
  await commit(adapter);
  const handlers = createLocalOperationHandlers({ adapter, now: () => t2 });
  const exported = await handlers.handle({ type: "backup.export", request_id: "req_export" });
  const backup = JSON.parse(exported.body);
  const initialSetCount = storage.setCalls.length;

  assert.deepEqual(Object.keys(backup), ["schema", "exported_at", "history", "report", "last_sync"]);
  assert.equal(backup.schema, BACKUP_SCHEMA);
  assert.equal(validateBackup(backup).valid, true);
  assert.equal(exported.filename, "followers-tracker-pro-backup-20260808-144613.json");

  const unconfirmed = await handlers.handle({ type: "backup.import", request_id: "req_unconfirmed", confirm: false, body: "not json" });
  assert.equal(unconfirmed.error.code, "IMPORT_NOT_CONFIRMED");
  assert.equal(storage.setCalls.length, initialSetCount);

  const invalid = await handlers.handle({
    type: "backup.import",
    request_id: "req_invalid",
    confirm: true,
    body: JSON.stringify({ ...backup, extra: true })
  });
  assert.equal(invalid.error.code, "IMPORT_INVALID");
  assert.equal(storage.setCalls.length, initialSetCount);

  for (const invalidBackup of [
    { ...backup, report: { ...backup.report, instagram_account: "another_account" } },
    { ...backup, report: { ...backup.report, counts: { ...backup.report.counts, A: 999 } } },
    {
      ...backup,
      report: {
        ...backup.report,
        relationship_breakdown: {
          ...backup.report.relationship_breakdown,
          mutual_follows: backup.report.relationship_breakdown.mutual_follows + 1
        }
      }
    }
  ]) {
    assert.equal(validateBackup(invalidBackup).valid, false);
    const rejected = await handlers.handle({
      type: "backup.import",
      request_id: "req_semantic_invalid",
      confirm: true,
      body: JSON.stringify(invalidBackup)
    });
    assert.equal(rejected.error.code, "IMPORT_INVALID");
    assert.equal(storage.setCalls.length, initialSetCount);
  }

  const valid = {
    ...backup,
    report: null,
    last_sync: null
  };
  const imported = await handlers.handle({
    type: "backup.import",
    request_id: "req_valid",
    confirm: true,
    body: JSON.stringify(valid)
  });
  assert.equal(imported.imported, true);
  assert.deepEqual(imported.replaced_keys, STORAGE_KEY_NAMES);
  assert.deepEqual(Object.keys(storage.setCalls.at(-1)).sort(), [...STORAGE_KEY_NAMES].sort());
  assert.equal(storage.values[STORAGE_KEYS.report], null);
  assert.equal(storage.values[STORAGE_KEYS.lastSync], null);
});

test("backup import rejects formula usernames in every stored username field without replacing old data", async () => {
  const sourceStorage = new MemoryStorage();
  const sourceAdapter = createStorageAdapter(sourceStorage);
  await commit(sourceAdapter);
  await commit(sourceAdapter, {
    run_id: "sync_20260808_144613",
    started_at: t2,
    finished_at: t2,
    followers: ["alice", "carol"],
    following: ["carol", "dave"]
  });
  const sourceHandlers = createLocalOperationHandlers({ adapter: sourceAdapter, now: () => t3 });
  const backup = JSON.parse((await sourceHandlers.handle({ type: "backup.export", request_id: "req_formula_source" })).body);
  const formula = "=1+1";
  const usernameMutations = [
    (value) => { value.history.meta.instagram_account = formula; },
    (value) => { value.history.last_snapshot.instagram_account = formula; },
    (value) => { value.history.last_snapshot.followers[0] = formula; },
    (value) => { value.history.last_snapshot.following[0] = formula; },
    (value) => { value.history.events[0].username = formula; },
    (value) => { value.history.sync_points[0].instagram_account = formula; },
    (value) => {
      const [username] = Object.keys(value.history.meta.a_first_detected);
      value.history.meta.a_first_detected = { [formula]: value.history.meta.a_first_detected[username] };
    },
    (value) => { value.report.instagram_account = formula; },
    ...["following_not_following_back", "unfollowed_me", "followers_i_dont_follow_back", "i_followed", "i_unfollowed", "new_followers"]
      .map((group) => (value) => { value.report[group][0].username = formula; }),
    (value) => { value.last_sync.instagram_account = formula; }
  ];

  const targetStorage = new MemoryStorage();
  const targetAdapter = createStorageAdapter(targetStorage);
  await commit(targetAdapter, { instagram_account: "existing.account" });
  const before = clone(targetStorage.values);
  const initialSetCount = targetStorage.setCalls.length;
  const targetHandlers = createLocalOperationHandlers({ adapter: targetAdapter, now: () => t3 });

  for (const mutate of usernameMutations) {
    const maliciousBackup = clone(backup);
    mutate(maliciousBackup);
    const rejected = await targetHandlers.handle({
      type: "backup.import",
      request_id: "req_formula_import",
      confirm: true,
      body: JSON.stringify(maliciousBackup)
    });

    assert.equal(rejected.imported, false);
    assert.equal(rejected.error.code, "IMPORT_INVALID");
    assert.equal(targetStorage.setCalls.length, initialSetCount);
    assert.deepEqual(targetStorage.values, before);
  }

  for (const username of ["+1+1", "-1+1", "@sum(1)", "\t=1+1", "\r=1+1", "\n=1+1", "＝1+1"]) {
    const maliciousBackup = clone(backup);
    maliciousBackup.report.following_not_following_back[0].username = username;
    const rejected = await targetHandlers.handle({
      type: "backup.import",
      request_id: "req_formula_prefix_import",
      confirm: true,
      body: JSON.stringify(maliciousBackup)
    });

    assert.equal(rejected.imported, false);
    assert.equal(rejected.error.code, "IMPORT_INVALID");
    assert.equal(targetStorage.setCalls.length, initialSetCount);
    assert.deepEqual(targetStorage.values, before);
  }
});

test("backup import accepts normalized dotted and underscored usernames", async () => {
  const sourceStorage = new MemoryStorage();
  const sourceAdapter = createStorageAdapter(sourceStorage);
  const source = await commit(sourceAdapter, {
    instagram_account: "Dotted_Name.ig",
    followers: ["first.last", "under_score"],
    following: ["under_score", "other.name"]
  });
  const sourceHandlers = createLocalOperationHandlers({ adapter: sourceAdapter, now: () => t2 });
  const backup = JSON.parse((await sourceHandlers.handle({ type: "backup.export", request_id: "req_valid_source" })).body);
  const targetStorage = new MemoryStorage();
  const targetHandlers = createLocalOperationHandlers({ adapter: createStorageAdapter(targetStorage), now: () => t2 });

  assert.equal(validateBackup(backup).valid, true);
  const imported = await targetHandlers.handle({
    type: "backup.import",
    request_id: "req_valid_import",
    confirm: true,
    body: JSON.stringify(backup)
  });

  assert.equal(imported.imported, true);
  assert.equal(targetStorage.values[STORAGE_KEYS.history].meta.instagram_account, "dotted_name.ig");
  assert.deepEqual(targetStorage.values[STORAGE_KEYS.history].last_snapshot.followers, ["first.last", "under_score"]);
  assert.deepEqual(targetStorage.values[STORAGE_KEYS.history].last_snapshot.following, ["other.name", "under_score"]);
  assert.equal(targetStorage.values[STORAGE_KEYS.report].instagram_account, source.report.instagram_account);
});

test("legacy v1 reports derive I Followed from local history across dashboard, export, and backup import", async () => {
  const sourceStorage = new MemoryStorage();
  const sourceAdapter = createStorageAdapter(sourceStorage);
  await commit(sourceAdapter);
  await commit(sourceAdapter, {
    run_id: "sync_20260808_144613",
    started_at: t2,
    finished_at: t2,
    following: ["bob", "carol", "erin"]
  });
  const sourceState = await sourceAdapter.read();
  const legacyReport = clone(sourceState.report);
  delete legacyReport.i_followed;
  sourceStorage.values[STORAGE_KEYS.report] = legacyReport;
  const sourceHandlers = createLocalOperationHandlers({ adapter: sourceAdapter, now: () => t3 });

  const dashboard = await sourceHandlers.handle({ type: "dashboard.getState", request_id: "req_legacy_dashboard" });
  assert.deepEqual(dashboard.report.i_followed, [{ username: "erin", detected_at: t2 }]);

  const reportExport = await sourceHandlers.handle({ type: "report.export", request_id: "req_legacy_export", format: "json" });
  assert.deepEqual(JSON.parse(reportExport.body).i_followed, [{ username: "erin", detected_at: t2 }]);

  const legacyBackup = {
    schema: BACKUP_SCHEMA,
    exported_at: t3,
    history: sourceState.history,
    report: legacyReport,
    last_sync: sourceState.lastSync
  };
  assert.equal(validateBackup(legacyBackup).valid, true);

  const targetStorage = new MemoryStorage();
  const targetHandlers = createLocalOperationHandlers({ adapter: createStorageAdapter(targetStorage), now: () => t3 });
  const imported = await targetHandlers.handle({
    type: "backup.import",
    request_id: "req_legacy_import",
    confirm: true,
    body: JSON.stringify(legacyBackup)
  });

  assert.equal(imported.imported, true);
  assert.deepEqual(targetStorage.values[STORAGE_KEYS.report].i_followed, [{ username: "erin", detected_at: t2 }]);
});

test("unconfirmed reset writes nothing and confirmed reset deletes only the approved keys", async () => {
  const storage = new MemoryStorage({
    [STORAGE_KEYS.history]: createEmptyHistory(t1),
    [STORAGE_KEYS.report]: null,
    [STORAGE_KEYS.lastSync]: null,
    unrelated: "preserved"
  });
  const handlers = createLocalOperationHandlers({ adapter: createStorageAdapter(storage), now: () => t2 });

  const cancelled = await handlers.handle({ type: "history.reset", request_id: "req_cancel", confirm: false });
  assert.equal(cancelled.error.code, "RESET_NOT_CONFIRMED");
  assert.equal(storage.removeCalls.length, 0);

  const reset = await handlers.handle({ type: "history.reset", request_id: "req_reset", confirm: true });
  assert.equal(reset.reset, true);
  assert.deepEqual(reset.deleted_keys, STORAGE_KEY_NAMES);
  assert.deepEqual(storage.removeCalls, [STORAGE_KEY_NAMES]);
  assert.equal(storage.values.unrelated, "preserved");
});

test("local diagnostics require non-negative values or null and storage failure preserves successful analytics", async () => {
  const storage = new MemoryStorage();
  const adapter = createStorageAdapter(storage);
  await commit(adapter);
  const before = await adapter.read();
  storage.failNextSet = true;

  const failed = await commitCompletedSync(adapter, completedInput({
    run_id: "sync_20260808_144613",
    started_at: t2,
    finished_at: t2,
    duration_ms: 0
  }));
  const after = await adapter.read();
  assert.equal(failed.state, "failed");
  assert.equal(failed.error.code, "STORAGE_ERROR");
  assert.deepEqual(after.history, before.history);
  assert.deepEqual(after.report, before.report);
  assert.equal(after.lastSync.state, "failed");
  assert.equal(after.lastSync.error.code, "STORAGE_ERROR");
  assert.equal(isLastSync({ ...after.lastSync, duration_ms: -1 }), false);
  assert.equal(isLastSync({ ...after.lastSync, followers_count: null, following_count: null, duration_ms: null }), true);
});

test("completed sync read failure preserves analytics and records a local storage diagnostic", async () => {
  const storage = new MemoryStorage();
  const adapter = createStorageAdapter(storage);
  await commit(adapter);
  const before = await adapter.read();
  const initialSetCount = storage.setCalls.length;
  storage.failNextGet = true;

  const failed = await commitCompletedSync(adapter, completedInput({
    run_id: "sync_20260808_144613",
    started_at: t2,
    finished_at: t2
  }));
  const after = await adapter.read();

  assert.equal(failed.state, "failed");
  assert.equal(failed.error.code, "STORAGE_ERROR");
  assert.deepEqual(after.history, before.history);
  assert.deepEqual(after.report, before.report);
  assert.equal(after.lastSync.state, "failed");
  assert.equal(after.lastSync.error.code, "STORAGE_ERROR");
  assert.deepEqual(Object.keys(storage.setCalls.at(-1)), [STORAGE_KEYS.lastSync]);
  assert.equal(storage.setCalls.length, initialSetCount + 1);
});

test("data operations use only the injected local storage adapter", async () => {
  const storage = new MemoryStorage();
  const adapter = createStorageAdapter(storage);
  const handlers = createLocalOperationHandlers({ adapter, now: () => t1 });
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("A local data operation attempted a network request.");
  };

  try {
    assert.equal(handlers.canHandle({ type: "dashboard.getState" }), true);
    assert.equal(handlers.canHandle({ type: "sync.start" }), false);
    await handlers.handle({ type: "dashboard.getState", request_id: "req_local" });
    await handlers.handle({ type: "report.export", request_id: "req_report", format: "json" });
    await handlers.handle({ type: "backup.export", request_id: "req_backup" });
    await handlers.handle({ type: "backup.import", request_id: "req_import", confirm: false, body: "" });
    await handlers.handle({ type: "history.reset", request_id: "req_reset", confirm: false });
  } finally {
    globalThis.fetch = fetchBefore;
  }

  assert.deepEqual(storage.getCalls, [STORAGE_KEY_NAMES, STORAGE_KEY_NAMES, STORAGE_KEY_NAMES]);
});

test("the service worker routes approved local messages asynchronously", async () => {
  const storage = new MemoryStorage();
  let messageListener;
  let tabQueries = 0;
  const chromeBefore = globalThis.chrome;
  globalThis.chrome = {
    action: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener(listener) { messageListener = listener; } }, openOptionsPage() {} },
    storage: { local: storage },
    tabs: {
      query: async () => { tabQueries += 1; return []; },
      sendMessage: async () => { throw new Error("no Instagram tab fixture"); }
    }
  };

  try {
    await import(new URL(`../src/background/service-worker.js?test=${Date.now()}`, import.meta.url));
    const response = await new Promise((resolve) => {
      assert.equal(messageListener({ type: "dashboard.getState", request_id: "req_worker" }, {}, resolve), true);
    });
    assert.equal(response.type, "dashboard.state");
    const progressResponse = await new Promise((resolve) => {
      assert.equal(messageListener(
        { type: "instagram.collectionProgress", run_id: "sync_missing", stage: "collecting_followers" },
        { tab: { id: 7, url: "https://www.instagram.com/" } },
        resolve
      ), true);
    });
    assert.deepEqual(progressResponse, { type: "instagram.collectionProgress.ack", run_id: "sync_missing", accepted: false });
    const invalidStart = await new Promise((resolve) => {
      assert.equal(messageListener({ type: "sync.start" }, {}, resolve), true);
    });
    assert.equal(invalidStart.type, "sync.result");

    storage.values["instatrack.run.v1.regular"] = {
      version: 1, generation: 0, instagram_account: "owner", last_sync: {
      run_id: "sync_route", state: "running", stage: "collecting_followers", started_at: t1, finished_at: null,
      instagram_account: "owner", followers_count: null, following_count: null, duration_ms: null, error: null
    }};
    const stopResponse = await new Promise((resolve) => {
      assert.equal(messageListener({ type: "sync.stop", request_id: "req_stop", run_id: "sync_route" }, {}, resolve), true);
    });
    assert.equal(stopResponse.type, "sync.stop.result");
    assert.equal(stopResponse.stopped, true);
    assert.equal(stopResponse.last_sync.state, "interrupted");
    assert.equal(stopResponse.last_sync.error.message, "Sync stopped by you.");

    const unconfirmedImport = await new Promise((resolve) => {
      assert.equal(messageListener({
        type: "backup.import",
        request_id: "req_import_no",
        confirm: false,
        body: ""
      }, {}, resolve), true);
    });
    assert.equal(unconfirmedImport.type, "backup.import.result");
    assert.equal(unconfirmedImport.imported, false);
    assert.equal(unconfirmedImport.error.code, "IMPORT_NOT_CONFIRMED");

    const beforeUnconfirmedQueries = tabQueries;
    const unconfirmed = await new Promise((resolve) => {
      assert.equal(messageListener({ type: "history.reset", request_id: "req_reset_no", confirm: false }, {}, resolve), true);
    });
    assert.equal(unconfirmed.reset, false);
    assert.equal(tabQueries, beforeUnconfirmedQueries);

    const reset = await new Promise((resolve) => {
      assert.equal(messageListener({ type: "history.reset", request_id: "req_reset_yes", confirm: true }, {}, resolve), true);
    });
    assert.equal(reset.reset, true);
    assert.equal(storage.values["instatrack.run.v1.regular"], undefined);
    assert.equal(storage.values["instatrack.control.v1"].resetting, false);
    assert.equal(storage.values[STORAGE_KEYS.lastSync], undefined);
  } finally {
    globalThis.chrome = chromeBefore;
  }
});
