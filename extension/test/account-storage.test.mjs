import assert from "node:assert/strict";
import test from "node:test";
import { createAccountStore } from "../src/background/account-storage.js";
import { STORAGE_KEYS, STORAGE_KEY_NAMES } from "../src/shared/constants.js";

const t1 = { iso: "2026-09-15T12:00:00Z", epoch: 1789473600 };
const t2 = { iso: "2026-09-15T12:01:00Z", epoch: 1789473660 };
const t3 = { iso: "2026-09-15T12:02:00Z", epoch: 1789473720 };

function clone(value) {
  return structuredClone(value);
}

class MemoryStorage {
  constructor(values = {}) {
    this.values = clone(values);
    this.getCalls = [];
    this.setCalls = [];
    this.removeCalls = [];
  }

  async get(keys) {
    this.getCalls.push(keys === null ? null : [...keys]);
    if (keys === null) {
      return clone(this.values);
    }
    return Object.fromEntries(keys.filter((key) => Object.hasOwn(this.values, key)).map((key) => [key, clone(this.values[key])]));
  }

  async set(values) {
    if (typeof this.beforeSet === "function") {
      await this.beforeSet(values);
    }
    this.setCalls.push(clone(values));
    Object.assign(this.values, clone(values));
    if (typeof this.onSet === "function") {
      await this.onSet(values);
    }
  }

  async remove(keys) {
    this.removeCalls.push([...keys]);
    for (const key of keys) {
      delete this.values[key];
    }
    if (typeof this.onRemove === "function") {
      await this.onRemove(keys);
    }
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function history(account, events = []) {
  return {
    version: 1,
    created_at: t1,
    last_snapshot: { instagram_account: account },
    events: events.map((username) => ({ type: "follower_gained", username, detected_at: t1 })),
    sync_points: [],
    meta: { instagram_account: account, a_first_detected: {} }
  };
}

function report(account) {
  return { instagram_account: account, marker: account };
}

function lastSync(account, runId, state = "completed") {
  return {
    run_id: runId,
    state,
    stage: "preflight",
    started_at: t1,
    finished_at: state === "running" ? null : t2,
    instagram_account: account,
    followers_count: null,
    following_count: null,
    duration_ms: null,
    error: null
  };
}

function accountKey(generation, account) {
  return `instatrack.account.v1.${generation}.${account}`;
}

function runRecord(generation, account, sync) {
  return { version: 1, generation, instagram_account: account, last_sync: sync };
}

function successfulHistory(account, takenAt) {
  return {
    ...history(account, [`${account}_event`]),
    sync_points: [{ instagram_account: account, taken_at: takenAt }]
  };
}

function successfulReport(account, generatedAt) {
  return { ...report(account), generated_at: generatedAt };
}

function bundle(generation, account, takenAt) {
  return {
    version: 1,
    generation,
    instagram_account: account,
    history: successfulHistory(account, takenAt),
    report: successfulReport(account, takenAt),
    last_sync: lastSync(account, `${account}_done`)
  };
}

test("A to B to A preserves separate account baselines and events", async () => {
  const storage = new MemoryStorage();
  const store = createAccountStore(storage);
  const alice = store.forAccount(" @Alice ");
  const bob = store.forAccount("BOB");

  await alice.writeState({ history: history("alice", ["alice_baseline"]), report: report("alice"), lastSync: lastSync("alice", "alice_1") });
  await bob.writeState({ history: history("bob", ["bob_baseline"]), report: report("bob"), lastSync: lastSync("bob", "bob_1") });
  await alice.writeState({ history: history("alice", ["alice_baseline", "alice_event"]), report: report("alice"), lastSync: lastSync("alice", "alice_2") });

  assert.equal(alice.account, "alice");
  assert.deepEqual((await alice.read()).history.events.map((event) => event.username), ["alice_baseline", "alice_event"]);
  assert.deepEqual((await bob.read()).history.events.map((event) => event.username), ["bob_baseline"]);
  assert.ok(Object.hasOwn(storage.values, accountKey(0, "alice")));
  assert.ok(Object.hasOwn(storage.values, accountKey(0, "bob")));
});

test("regular and incognito share one account bundle but retain separate mode runs", async () => {
  const storage = new MemoryStorage();
  const regular = createAccountStore(storage).forAccount("alice");
  const incognitoStore = createAccountStore(storage, { incognito: true });
  const incognito = incognitoStore.forAccount("Alice");

  await regular.writeState({ history: history("alice", ["shared_event"]), report: report("alice"), lastSync: lastSync("alice", "regular_done") });
  assert.deepEqual((await incognito.read()).history.events.map((event) => event.username), ["shared_event"]);

  await incognito.writeLastSync(lastSync("alice", "incognito_running", "running"));
  assert.equal((await regular.read()).lastSync.run_id, "regular_done");
  assert.equal((await incognito.read()).lastSync.run_id, "incognito_running");
  assert.deepEqual(await incognitoStore.readRun(), {
    instagram_account: "alice",
    lastSync: lastSync("alice", "incognito_running", "running")
  });
  assert.equal(Object.keys(storage.values).filter((key) => key === accountKey(0, "alice")).length, 1);
  assert.ok(Object.hasOwn(storage.values, "instatrack.run.v1.regular"));
  assert.ok(Object.hasOwn(storage.values, "instatrack.run.v1.incognito"));
});

test("latest stored success retains its analytics alongside a later failed attempt on another account", async () => {
  const storage = new MemoryStorage();
  const store = createAccountStore(storage);
  const alice = store.forAccount("alice");
  const bob = store.forAccount("bob");
  await alice.writeState({
    history: successfulHistory("alice", t1), report: successfulReport("alice", t1), lastSync: lastSync("alice", "alice_done")
  });
  await bob.writeState({
    history: successfulHistory("bob", t2), report: successfulReport("bob", t2), lastSync: lastSync("bob", "bob_done")
  });
  await alice.writeLastSync(lastSync("alice", "alice_failed", "failed"));

  const latest = await store.readLatest();
  assert.equal(latest.instagram_account, "bob");
  assert.deepEqual(latest.history, successfulHistory("bob", t2));
  assert.equal(latest.lastSync.run_id, "alice_failed");

  await bob.writeLastSync(lastSync("bob", "bob_failed", "failed"));
  assert.equal((await store.readLatest()).lastSync.run_id, "bob_failed");
});

test("first failed and interrupted attempts remain visible without successful history", async () => {
  for (const state of ["failed", "interrupted"]) {
    const store = createAccountStore(new MemoryStorage());
    const diagnostic = lastSync("alice", "first_attempt", state);
    await store.forAccount("alice").writeLastSync(diagnostic);
    assert.deepEqual(await store.readLatest(), { instagram_account: null, history: null, report: null, lastSync: diagnostic });
  }
});

test("newer shared success supersedes the context's older terminal error", async () => {
  const storage = new MemoryStorage();
  const regular = createAccountStore(storage);
  await regular.forAccount("alice").writeLastSync(lastSync("alice", "old_failure", "failed"));
  const success = { ...lastSync("alice", "new_success"), started_at: t3, finished_at: t3 };
  await createAccountStore(storage, { incognito: true }).forAccount("alice").writeState({
    history: successfulHistory("alice", t3), report: successfulReport("alice", t3), lastSync: success
  });
  assert.equal((await regular.readLatest()).lastSync.run_id, "new_success");
  assert.equal((await regular.forAccount("alice").read()).lastSync.run_id, "new_success");
});

test("latest stored success uses eligible legacy data but skips a duplicate account bundle", async () => {
  const storage = new MemoryStorage({
    [accountKey(0, "alice")]: bundle(0, "alice", t1),
    [STORAGE_KEYS.history]: successfulHistory("alice", t3),
    [STORAGE_KEYS.report]: successfulReport("alice", t3),
    [STORAGE_KEYS.lastSync]: lastSync("alice", "legacy_newer")
  });
  const store = createAccountStore(storage);

  const latest = await store.readLatest();
  assert.equal(latest.instagram_account, "alice");
  assert.deepEqual(latest.history, successfulHistory("alice", t1));
  assert.equal(latest.lastSync.run_id, "alice_done");

  const eligibleLegacy = await createAccountStore(new MemoryStorage({
    [accountKey(0, "alice")]: bundle(0, "alice", t1),
    [STORAGE_KEYS.history]: successfulHistory("bob", t2),
    [STORAGE_KEYS.report]: successfulReport("bob", t2),
    [STORAGE_KEYS.lastSync]: lastSync("bob", "legacy_bob")
  })).readLatest();
  assert.equal(eligibleLegacy.instagram_account, "bob");
  assert.deepEqual(eligibleLegacy.history, successfulHistory("bob", t2));

  const noSuccess = await createAccountStore(new MemoryStorage({
    [accountKey(0, "empty")]: {
      version: 1, generation: 0, instagram_account: "empty",
      history: history("empty"), report: report("empty"), last_sync: lastSync("empty", "failed", "failed")
    }
  })).readLatest();
  assert.deepEqual(noSuccess, { instagram_account: null, history: null, report: null, lastSync: null });
});

test("writes reject analytics whose embedded account differs from the selected account", async () => {
  const storage = new MemoryStorage();
  const alice = createAccountStore(storage).forAccount("alice");

  await assert.rejects(
    alice.writeState({ history: history("bob"), report: report("bob"), lastSync: lastSync("bob", "wrong_owner") }),
    /selected Instagram account/
  );
  await assert.rejects(alice.writeLastSync(lastSync("bob", "wrong_owner")), /selected Instagram account/);
  assert.deepEqual(storage.setCalls, []);
});

test("stored bundles and mode runs must retain their normalized matching owners", async () => {
  const storage = new MemoryStorage({
    [accountKey(0, "alice")]: {
      version: 1,
      generation: 0,
      instagram_account: "alice",
      history: history("bob"),
      report: report("alice"),
      last_sync: lastSync("alice", "stored")
    },
    "instatrack.run.v1.regular": {
      version: 1,
      generation: 0,
      instagram_account: "Alice",
      last_sync: lastSync("alice", "wrong_outer")
    }
  });
  const store = createAccountStore(storage);

  await assert.rejects(store.forAccount("alice").read(), /Stored account bundle is invalid/);
  assert.deepEqual(await store.readRun(), { instagram_account: null, lastSync: null });

  storage.values["instatrack.run.v1.regular"] = {
    version: 1,
    generation: 0,
    instagram_account: "alice",
    last_sync: lastSync("bob", "wrong_nested")
  };
  assert.deepEqual(await store.readRun(), { instagram_account: null, lastSync: null });
});

test("account preflight failures persist only in their browser context and cannot become running claims", async () => {
  const storage = new MemoryStorage();
  const regular = createAccountStore(storage);
  const incognito = createAccountStore(storage, { incognito: true });
  const failure = { ...lastSync(null, "preflight_failed", "failed"), error: {
    code: "CURRENT_ACCOUNT_UNAVAILABLE", message: "Receiving end does not exist."
  } };
  await incognito.writeStartFailure(failure);
  assert.deepEqual(await regular.readLatest(), { instagram_account: null, history: null, report: null, lastSync: null });
  assert.deepEqual((await incognito.readLatest()).lastSync, failure);
  assert.deepEqual((await createAccountStore(storage, { incognito: true }).readLatest()).lastSync, failure);
  await assert.rejects(regular.writeStartFailure({ ...failure, state: "running", error: null }), /failed account preflight/);
  storage.values["instatrack.run.v1.regular"] = runRecord(0, null, { ...failure, state: "running", error: null });
  assert.deepEqual(await regular.readRun(), { instagram_account: null, lastSync: null });
});

test("a preflight failure delayed behind reset cannot resurrect its diagnostic", async () => {
  const storage = new MemoryStorage();
  const store = createAccountStore(storage);
  const writeStarted = deferred();
  const releaseWrite = deferred();
  storage.beforeSet = async (values) => {
    if (values["instatrack.run.v1.regular"]) {
      writeStarted.resolve();
      await releaseWrite.promise;
    }
  };
  const pending = store.writeStartFailure({ ...lastSync(null, "late_preflight", "failed"), error: {
    code: "CURRENT_ACCOUNT_UNAVAILABLE", message: "Receiving end does not exist."
  } });
  await writeStarted.promise;
  await store.reset();
  releaseWrite.resolve();
  await assert.rejects(pending, /reset interrupted sync preparation/);
  assert.deepEqual(Object.keys(storage.values), ["instatrack.control.v1"]);
});

test("a mode run retains its wrapper owner when local diagnostics have no account", async () => {
  const storage = new MemoryStorage();
  const store = createAccountStore(storage);
  const alice = store.forAccount("alice");
  const diagnostic = lastSync(null, "storage_failure", "failed");

  await alice.writeLastSync(diagnostic);
  assert.deepEqual(await store.readRun(), { instagram_account: "alice", lastSync: diagnostic });
});

test("a null mode-run diagnostic does not block another context or bypass account selection", async () => {
  const storage = new MemoryStorage({
    "instatrack.run.v1.regular": {
      version: 1,
      generation: 0,
      instagram_account: "alice",
      last_sync: null
    }
  });
  const regularStore = createAccountStore(storage);
  const incognito = createAccountStore(storage, { incognito: true }).forAccount("alice");

  assert.deepEqual(await regularStore.readRun(), { instagram_account: "alice", lastSync: null });
  await assert.doesNotReject(incognito.assertImportAllowed());
  assert.equal(await incognito.claimRun(lastSync("alice", "incognito_run", "running")), true);
});

test("legacy state is a read-only fallback only for its sole matching owner", async () => {
  const legacyHistory = history("alice", ["legacy_event"]);
  const storage = new MemoryStorage({
    [STORAGE_KEYS.history]: legacyHistory,
    [STORAGE_KEYS.report]: report("alice"),
    [STORAGE_KEYS.lastSync]: lastSync("alice", "legacy_done"),
    unrelated: { keep: true }
  });
  const before = clone(storage.values);
  const store = createAccountStore(storage);

  const alice = await store.forAccount("alice").read();
  const bob = await store.forAccount("bob").read();
  assert.deepEqual(alice.history, legacyHistory);
  assert.equal(alice.lastSync.run_id, "legacy_done");
  assert.deepEqual(bob, { history: null, report: null, lastSync: null });
  assert.deepEqual(storage.values, before);
  assert.deepEqual(storage.setCalls, []);
  assert.deepEqual(storage.removeCalls, []);
});

test("per-account import writes leave other account bundles untouched", async () => {
  const storage = new MemoryStorage();
  const store = createAccountStore(storage);
  const alice = store.forAccount("alice");
  const bob = store.forAccount("bob");

  await alice.writeState({ history: history("alice", ["alice_before_import"]), report: report("alice"), lastSync: lastSync("alice", "alice_before") });
  const aliceBefore = clone(storage.values[accountKey(0, "alice")]);
  await bob.writeState({ history: history("bob", ["bob_import"]), report: report("bob"), lastSync: lastSync("bob", "bob_import") });

  assert.deepEqual(storage.values[accountKey(0, "alice")], aliceBefore);
  assert.deepEqual((await alice.read()).history.events.map((event) => event.username), ["alice_before_import"]);
  assert.deepEqual((await bob.read()).history.events.map((event) => event.username), ["bob_import"]);
});

test("full reset fences stale adapters and preserves unrelated storage", async () => {
  const storage = new MemoryStorage({
    [STORAGE_KEYS.history]: history("legacy", ["legacy_event"]),
    [STORAGE_KEYS.report]: report("legacy"),
    [STORAGE_KEYS.lastSync]: lastSync("legacy", "legacy_done"),
    unrelated: { keep: true }
  });
  const regularStore = createAccountStore(storage);
  const incognitoStore = createAccountStore(storage, { incognito: true });
  const alice = regularStore.forAccount("alice");
  const bob = regularStore.forAccount("bob");
  const privateAlice = incognitoStore.forAccount("alice");
  await alice.writeState({ history: history("alice"), report: report("alice"), lastSync: lastSync("alice", "alice_done") });
  await bob.writeState({ history: history("bob"), report: report("bob"), lastSync: lastSync("bob", "bob_done") });
  await privateAlice.writeLastSync(lastSync("alice", "private_running", "running"));

  let reinjected = false;
  storage.onRemove = (keys) => {
    if (reinjected || !keys.includes(accountKey(0, "alice"))) {
      return;
    }
    reinjected = true;
    storage.values[accountKey(0, "alice")] = {
      version: 1,
      generation: 0,
      instagram_account: "alice",
      history: history("alice"),
      report: report("alice"),
      last_sync: lastSync("alice", "raced_old_write")
    };
    storage.values["instatrack.run.v1.regular"] = {
      version: 1,
      generation: 0,
      instagram_account: "alice",
      last_sync: lastSync("alice", "raced_old_write")
    };
  };

  const deleted = await regularStore.reset();
  assert.deepEqual(new Set(deleted), new Set([
    ...STORAGE_KEY_NAMES,
    accountKey(0, "alice"),
    accountKey(0, "bob"),
    "instatrack.run.v1.regular",
    "instatrack.run.v1.incognito"
  ]));
  assert.deepEqual(storage.values.unrelated, { keep: true });
  assert.deepEqual(storage.values["instatrack.control.v1"], { version: 1, generation: 1, resetting: false });
  assert.deepEqual(Object.keys(storage.values).filter((key) => key.startsWith("instatrack.account.v1.") || key.startsWith("instatrack.run.v1.") || STORAGE_KEY_NAMES.includes(key)), []);
  await assert.rejects(alice.writeLastSync(lastSync("alice", "late_write")), /stale after reset/);
  assert.deepEqual(await regularStore.forAccount("alice").read(), { history: null, report: null, lastSync: null });
  assert.equal(storage.removeCalls.length, 2, "the reset fence sweeps writes that raced the first removal");
});

test("a write delayed behind reset cannot resurrect an old-generation bundle or run", async () => {
  const storage = new MemoryStorage();
  const writeStarted = deferred();
  const releaseWrite = deferred();
  let delayAccountWrite = true;
  storage.beforeSet = async (values) => {
    if (delayAccountWrite && Object.keys(values).some((key) => key.startsWith("instatrack.account.v1."))) {
      delayAccountWrite = false;
      writeStarted.resolve();
      await releaseWrite.promise;
    }
  };
  const store = createAccountStore(storage);
  const alice = store.forAccount("alice");
  const pending = alice.writeState({ history: history("alice"), report: report("alice"), lastSync: lastSync("alice", "late_write") });
  await writeStarted.promise;
  await store.reset();
  releaseWrite.resolve();

  await assert.rejects(pending, /stale after reset/);
  assert.deepEqual(Object.keys(storage.values), ["instatrack.control.v1"]);
});

test("a confirmed reset resumes an interrupted reset fence without another generation increment", async () => {
  const storage = new MemoryStorage({
    "instatrack.control.v1": { version: 1, generation: 4, resetting: true },
    [STORAGE_KEYS.history]: history("legacy"),
    [STORAGE_KEYS.report]: report("legacy"),
    [STORAGE_KEYS.lastSync]: lastSync("legacy", "legacy_done"),
    [accountKey(3, "alice")]: {
      version: 1,
      generation: 3,
      instagram_account: "alice",
      history: history("alice"),
      report: report("alice"),
      last_sync: lastSync("alice", "old_run")
    },
    "instatrack.run.v1.regular": {
      version: 1,
      generation: 3,
      instagram_account: "alice",
      last_sync: lastSync("alice", "old_run")
    },
    unrelated: "keep"
  });
  const store = createAccountStore(storage);

  assert.deepEqual(await store.readRun(), { instagram_account: null, lastSync: null });
  const deleted = await store.reset();
  assert.deepEqual(new Set(deleted), new Set([
    ...STORAGE_KEY_NAMES,
    accountKey(3, "alice"),
    "instatrack.run.v1.regular"
  ]));
  assert.deepEqual(storage.values, {
    "instatrack.control.v1": { version: 1, generation: 4, resetting: false },
    unrelated: "keep"
  });
  assert.deepEqual(await store.forAccount("alice").read(), { history: null, report: null, lastSync: null });
});

test("restart reconciliation interrupts both mode runs while preserving account bundles", async () => {
  const regularRunning = {
    ...lastSync("alice", "regular_run", "running"),
    stage: "collecting_followers",
    followers_count: 3,
    following_count: 5,
    duration_ms: null
  };
  const incognitoRunning = {
    ...lastSync("bob", "incognito_run", "running"),
    stage: "processing",
    followers_count: 7,
    following_count: 11,
    duration_ms: null
  };
  const storage = new MemoryStorage({
    [accountKey(0, "alice")]: {
      version: 1, generation: 0, instagram_account: "alice",
      history: history("alice", ["alice_event"]), report: report("alice"), last_sync: lastSync("alice", "alice_done")
    },
    [accountKey(0, "bob")]: {
      version: 1, generation: 0, instagram_account: "bob",
      history: history("bob", ["bob_event"]), report: report("bob"), last_sync: lastSync("bob", "bob_done")
    },
    "instatrack.run.v1.regular": runRecord(0, "alice", regularRunning),
    "instatrack.run.v1.incognito": runRecord(0, "bob", incognitoRunning)
  });
  const bundles = clone({
    alice: storage.values[accountKey(0, "alice")],
    bob: storage.values[accountKey(0, "bob")]
  });

  const interrupted = await createAccountStore(storage).interruptRunsAfterRestart(t2);
  assert.deepEqual(interrupted, ["instatrack.run.v1.regular", "instatrack.run.v1.incognito"]);
  for (const [key, original] of [
    ["instatrack.run.v1.regular", regularRunning],
    ["instatrack.run.v1.incognito", incognitoRunning]
  ]) {
    const actual = storage.values[key].last_sync;
    assert.equal(actual.state, "interrupted");
    assert.equal(actual.stage, original.stage);
    assert.equal(actual.instagram_account, original.instagram_account);
    assert.equal(actual.followers_count, original.followers_count);
    assert.equal(actual.following_count, original.following_count);
    assert.equal(actual.duration_ms, 60_000);
    assert.deepEqual(actual.finished_at, t2);
    assert.deepEqual(actual.error, {
      code: "COLLECTION_INTERRUPTED",
      message: "The browser closed before sync finished. Retry sync."
    });
  }
  assert.deepEqual({
    alice: storage.values[accountKey(0, "alice")],
    bob: storage.values[accountKey(0, "bob")]
  }, bundles);
});

test("restart reconciliation leaves non-running mode records unchanged", async () => {
  const storage = new MemoryStorage({
    "instatrack.run.v1.regular": runRecord(0, "alice", lastSync("alice", "completed_run")),
    "instatrack.run.v1.incognito": runRecord(0, "bob", lastSync("bob", "interrupted_run", "interrupted"))
  });
  const before = clone(storage.values);

  assert.deepEqual(await createAccountStore(storage).interruptRunsAfterRestart(t2), []);
  assert.deepEqual(storage.values, before);
  assert.deepEqual(storage.setCalls, []);
});

test("same-account claims exclude the other browser context and block import", async () => {
  const storage = new MemoryStorage();
  const regularStore = createAccountStore(storage);
  const incognitoStore = createAccountStore(storage, { incognito: true });
  const regular = regularStore.forAccount("alice");
  const incognito = incognitoStore.forAccount("alice");

  assert.equal(await regular.claimRun(lastSync("alice", "regular_run", "running")), true);
  assert.equal(await incognito.claimRun(lastSync("alice", "incognito_run", "running")), false);
  assert.equal((await regular.read()).lastSync.run_id, "regular_run");
  const rejected = await incognito.read();
  assert.equal(rejected.lastSync.state, "failed");
  assert.equal(rejected.lastSync.error.code, "COLLECTION_FAILED");
  await assert.rejects(incognito.assertImportAllowed(), (cause) => cause?.code === "COLLECTION_FAILED");

  const anotherAccount = incognitoStore.forAccount("bob");
  assert.equal(await anotherAccount.claimRun(lastSync("bob", "bob_run", "running")), true);

  const racingStorage = new MemoryStorage();
  const releaseClaimWrites = deferred();
  let publishedClaims = 0;
  racingStorage.onSet = async (values) => {
    if (!Object.values(values).some((value) => value?.last_sync?.state === "running")) {
      return;
    }
    publishedClaims += 1;
    if (publishedClaims === 2) {
      releaseClaimWrites.resolve();
    }
    await releaseClaimWrites.promise;
  };
  const racingRegular = createAccountStore(racingStorage).forAccount("alice");
  const racingIncognito = createAccountStore(racingStorage, { incognito: true }).forAccount("alice");
  const simultaneous = await Promise.all([
    racingRegular.claimRun(lastSync("alice", "regular_race", "running")),
    racingIncognito.claimRun(lastSync("alice", "incognito_race", "running"))
  ]);
  assert.deepEqual(simultaneous, [false, false]);
});
