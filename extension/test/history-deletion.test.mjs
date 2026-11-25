import assert from "node:assert/strict";
import test from "node:test";
import { buildCompletedSync, deleteSuccessfulSync, utcTimestamp } from "../src/domain/analytics.js";
import { createAccountStore } from "../src/background/account-storage.js";
import { createLocalOperationHandlers, commitCompletedSync } from "../src/background/local-operations.js";
import { validateBackup } from "../src/domain/schema.js";

const at = (index) => utcTimestamp(new Date(Date.UTC(2026, 9, 6, 10, index)));
const lists = [
  { followers: ["a", "b"], following: ["b", "c"] },
  { followers: ["a"], following: ["c"] },
  { followers: ["a", "b", "d"], following: ["b", "d", "e"] },
  { followers: ["b", "e"], following: ["c", "e"] }
];
function inputs(sameSecond = false) {
  return lists.map((lists, index) => ({ ...lists, run_id: `sync_${index}`, instagram_account: "owner", started_at: at(sameSecond ? 0 : index), finished_at: at(sameSecond ? 0 : index) }));
}
function build(values) {
  let result = { history: null, report: null };
  for (const value of values) result = buildCompletedSync(result.history, value);
  return result;
}
class Storage {
  values = {};
  async get(keys) { return structuredClone(Object.fromEntries((keys ?? Object.keys(this.values)).filter((key) => key in this.values).map((key) => [key, this.values[key]]))); }
  async set(values) {
    if (this.failBundle && Object.keys(values).some((key) => key.startsWith("instatrack.account."))) throw new Error("disk failure");
    Object.assign(this.values, structuredClone(values));
  }
  async remove(keys) { for (const key of keys) delete this.values[key]; }
}
for (const index of [0, 1, 3]) {
  test(`deleting sync ${index} matches analytics built independently from retained snapshots`, () => {
    const source = inputs();
    const original = build(source);
    const before = structuredClone(original);
    const result = deleteSuccessfulSync(original.history, source[index].run_id, "owner");
    const expected = build(source.filter((_, position) => position !== index));
    assert.deepEqual(result.history, expected.history);
    assert.deepEqual(result.report, expected.report);
    assert.deepEqual(structuredClone(original), before);
    const next = { ...source[3], run_id: "next", finished_at: at(5) };
    assert.deepEqual(buildCompletedSync(result.history, next), buildCompletedSync(expected.history, next));
  });
}
test("deleting the only sync creates empty history and no report", () => {
  const result = deleteSuccessfulSync(build(inputs().slice(0, 1)).history, "sync_0", "owner");
  assert.equal(result.history.last_snapshot, null);
  assert.deepEqual(result.history.sync_points, []);
  assert.deepEqual(result.history.events, []);
  assert.equal(result.report, null);
});
test("same-second runs retain distinct events and support exact deletion", () => {
  const source = inputs(true);
  const original = build(source);
  assert.ok(original.history.events.every((event) => typeof event.run_id === "string"));
  for (const index of [0, 1, 3]) {
    assert.deepEqual(deleteSuccessfulSync(original.history, source[index].run_id, "owner"), {
      history: build(source.filter((_, position) => position !== index)).history,
      report: build(source.filter((_, position) => position !== index)).report
    });
  }
});
test("legacy unbound events are readable and reconstruct distinct timestamps; ambiguous legacy fails", () => {
  const original = build(inputs());
  for (const event of original.history.events) delete event.run_id;
  assert.equal(validateBackup({ schema: "instatrack.backup.v1", exported_at: at(6), history: original.history, report: original.report, last_sync: null }).valid, true);
  assert.deepEqual(deleteSuccessfulSync(original.history, "sync_1", "owner").report, build(inputs().filter((_, index) => index !== 1)).report);
  const ambiguous = build(inputs(true));
  for (const event of ambiguous.history.events) delete event.run_id;
  assert.throws(() => deleteSuccessfulSync(ambiguous.history, "sync_1", "owner"), /verify|ambiguous/i);
  original.history.sync_points[1].followers_count = 999;
  assert.throws(() => deleteSuccessfulSync(original.history, "sync_1", "owner"), /verify/i);
});
test("delete is account-bound, atomic on failure, and preserves other account bundles", async () => {
  const storage = new Storage();
  const store = createAccountStore(storage);
  const owner = store.forAccount("owner");
  for (const input of inputs()) assert.equal((await commitCompletedSync(owner, input)).state, "completed");
  await commitCompletedSync(store.forAccount("other"), { ...inputs()[0], instagram_account: "other" });
  const other = structuredClone(storage.values["instatrack.account.v1.0.other"]);
  const handlers = createLocalOperationHandlers({ adapter: owner, now: () => at(6) });
  const request = { type: "history.deleteSync", request_id: "delete_1", instagram_account: "owner", run_id: "sync_1", confirm: true };
  assert.equal((await handlers.handle({ ...request, instagram_account: "other" })).deleted, false);
  assert.equal((await handlers.handle({ ...request, confirm: false })).deleted, false);
  const before = structuredClone(storage.values);
  storage.failBundle = true;
  assert.equal((await handlers.handle(request)).error.code, "STORAGE_ERROR");
  assert.deepEqual(storage.values, before);
  storage.failBundle = false;
  assert.equal((await handlers.handle(request)).deleted, true);
  assert.deepEqual(storage.values["instatrack.account.v1.0.other"], other);
  assert.deepEqual((await owner.read()).report, build(inputs().filter((_, index) => index !== 1)).report);
});

test("active same-context run for any account and other-context same-account run block deletion", async () => {
  for (const [mode, account] of [["regular", "other"], ["incognito", "owner"]]) {
    const storage = new Storage();
    const store = createAccountStore(storage);
    await commitCompletedSync(store.forAccount("owner"), inputs()[0]);
    const diagnostic = { run_id: "running", state: "running", stage: "preflight", started_at: at(5), finished_at: null,
      instagram_account: account, followers_count: null, following_count: null, duration_ms: null, error: null };
    await createAccountStore(storage, { incognito: mode === "incognito" }).forAccount(account).writeLastSync(diagnostic);
    const before = structuredClone(storage.values);
    const result = await createLocalOperationHandlers({ adapter: store.forAccount("owner"), now: () => at(6) }).handle({
      type: "history.deleteSync", request_id: "delete", instagram_account: "owner", run_id: "sync_0", confirm: true
    });
    assert.equal(result.deleted, false);
    assert.deepEqual(storage.values, before);
  }
});

test("deletion of sole legacy sync masks fallback and clears diagnostics in both contexts", async () => {
  const storage = new Storage();
  const source = build(inputs().slice(0, 1));
  const imported = await commitCompletedSync(createAccountStore(storage, { incognito: true }).forAccount("owner"), inputs()[0]);
  assert.equal(imported.state, "completed");
  storage.values["instatrack.history.v1"] = structuredClone(source.history);
  storage.values["instatrack.report.v1"] = structuredClone(source.report);
  delete storage.values["instatrack.account.v1.0.owner"];
  const store = createAccountStore(storage);
  const owner = store.forAccount("owner");
  const result = await createLocalOperationHandlers({ adapter: owner, now: () => at(6) }).handle({
    type: "history.deleteSync", request_id: "delete", instagram_account: "owner", run_id: "sync_0", confirm: true
  });
  assert.equal(result.deleted, true);
  for (const incognito of [false, true]) assert.equal((await createAccountStore(storage, { incognito }).readLatest()).lastSync, null);
  assert.equal((await store.readLatest()).report, null);
  assert.deepEqual((await owner.read()).history.sync_points, []);
});

test("all deletions in deterministic relationship sequences match retained-snapshot replay", () => {
  let seed = 17;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 16) % 2; };
  const names = ["a", "b", "c", "d", "e", "f"];
  for (let sample = 0; sample < 12; sample += 1) {
    const source = Array.from({ length: 6 }, (_, index) => ({
      run_id: `run_${index}`, instagram_account: "owner", started_at: at(index), finished_at: at(index),
      followers: names.filter(() => random()), following: names.filter(() => random())
    }));
    const original = build(source);
    for (const removed of source) {
      const expected = build(source.filter((point) => point !== removed));
      const actual = deleteSuccessfulSync(original.history, removed.run_id, "owner");
      assert.deepEqual(actual, { history: expected.history, report: expected.report });
    }
  }
});

test("the same relationship event repeated within a second is not deduplicated across runs", () => {
  const source = [[], ["a"], [], ["a"]].map((followers, index) => ({
    followers, following: [], run_id: `run_${index}`, instagram_account: "owner", started_at: at(0), finished_at: at(0)
  }));
  const result = build(source);
  assert.equal(result.history.events.filter((event) => event.type === "follower_gained").length, 2);
  const retained = build(source.filter((_, index) => index !== 2));
  assert.deepEqual(deleteSuccessfulSync(result.history, "run_2", "owner"), { history: retained.history, report: retained.report });
});
