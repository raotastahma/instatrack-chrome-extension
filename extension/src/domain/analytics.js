import { normalizeUsername, normalizeUsernames } from "./normalization.js";

export const EVENT_TYPES = Object.freeze([
  "follower_gained",
  "follower_lost",
  "following_added",
  "following_removed"
]);

export const REPORT_GROUPS = Object.freeze([
  "following_not_following_back",
  "unfollowed_me",
  "followers_i_dont_follow_back",
  "i_followed",
  "i_unfollowed",
  "new_followers"
]);

const EVENT_TYPES_BY_DELTA = Object.freeze({
  followers_gained: "follower_gained",
  followers_lost: "follower_lost",
  following_added: "following_added",
  following_removed: "following_removed"
});
const C_ENTRY_EVENT_TYPES = new Set(["follower_gained", "following_removed"]);

export function utcTimestamp(date = new Date()) {
  const epoch = Math.floor(date.getTime() / 1000);
  if (!Number.isFinite(epoch)) {
    throw new TypeError("A valid date is required.");
  }

  return {
    iso: new Date(epoch * 1000).toISOString().replace(".000Z", "Z"),
    epoch
  };
}

export function createEmptyHistory(createdAt) {
  return {
    version: 1,
    created_at: createdAt,
    last_snapshot: null,
    events: [],
    sync_points: [],
    meta: {
      instagram_account: null,
      a_first_detected: {}
    }
  };
}

function relationshipsFromSnapshot(snapshot) {
  if (snapshot === null || snapshot === undefined) {
    return null;
  }

  return {
    followers: new Set(snapshot.followers),
    following: new Set(snapshot.following)
  };
}

function asCurrentRelationships(followers, following) {
  return {
    followers: normalizeUsernames(followers),
    following: normalizeUsernames(following)
  };
}

function setDifference(left, right) {
  return [...left].filter((username) => !right.has(username)).sort();
}

export function computeDelta(previousSnapshot, current) {
  const currentFollowers = new Set(current.followers);
  const currentFollowing = new Set(current.following);
  const previous = relationshipsFromSnapshot(previousSnapshot);

  if (previous === null) {
    return {
      is_baseline: true,
      followers_gained: [],
      followers_lost: [],
      following_added: [],
      following_removed: []
    };
  }

  return {
    is_baseline: false,
    followers_gained: setDifference(currentFollowers, previous.followers),
    followers_lost: setDifference(previous.followers, currentFollowers),
    following_added: setDifference(currentFollowing, previous.following),
    following_removed: setDifference(previous.following, currentFollowing)
  };
}

export function deltaCounts(delta) {
  return {
    followers_gained: delta.followers_gained.length,
    followers_lost: delta.followers_lost.length,
    following_added: delta.following_added.length,
    following_removed: delta.following_removed.length
  };
}

function appendEvents(history, delta, detectedAt, runId) {
  if (delta.is_baseline) {
    return;
  }

  for (const [deltaKey, eventType] of Object.entries(EVENT_TYPES_BY_DELTA)) {
    for (const username of delta[deltaKey]) {
      history.events.push({ type: eventType, username, detected_at: detectedAt, run_id: runId });
    }
  }
}

function latestEventItems(events, eventType) {
  const latest = new Map();
  for (const event of events) {
    if (event.type !== eventType) {
      continue;
    }

    const previous = latest.get(event.username);
    if (!previous || event.detected_at.epoch >= previous.epoch) {
      latest.set(event.username, event.detected_at);
    }
  }

  return [...latest.keys()]
    .sort()
    .map((username) => ({ username, detected_at: latest.get(username) }));
}

function recentEventItems(events, eventType) {
  return latestEventItems(events, eventType).sort((left, right) => (
    right.detected_at.epoch - left.detected_at.epoch || left.username.localeCompare(right.username)
  ));
}

export function migrateLegacyReport(report, history) {
  if (!report || typeof report !== "object" || Object.hasOwn(report, "i_followed")) {
    return report;
  }

  return {
    ...report,
    i_followed: recentEventItems(Array.isArray(history?.events) ? history.events : [], "following_added")
  };
}

function buildReport(history, current, generatedAt, instagramAccount) {
  const followers = new Set(current.followers);
  const following = new Set(current.following);
  const followingNotFollowingBack = setDifference(following, followers);
  const firstDetected = Object.create(null);
  const cEntryDetected = new Map();

  for (const username of followingNotFollowingBack) {
    firstDetected[username] = Object.hasOwn(history.meta.a_first_detected, username)
      ? history.meta.a_first_detected[username]
      : generatedAt;
  }
  history.meta.a_first_detected = firstDetected;

  const followersIDontFollowBack = setDifference(followers, following);
  for (const event of history.events) {
    if (!C_ENTRY_EVENT_TYPES.has(event.type)) {
      continue;
    }
    const previous = cEntryDetected.get(event.username);
    if (!previous || event.detected_at.epoch >= previous.epoch) {
      cEntryDetected.set(event.username, event.detected_at);
    }
  }

  const groups = {
    following_not_following_back: followingNotFollowingBack.map((username) => ({
      username,
      detected_at: firstDetected[username]
    })),
    unfollowed_me: latestEventItems(history.events, "follower_lost"),
    followers_i_dont_follow_back: followersIDontFollowBack.map((username) => ({
      username,
      detected_at: cEntryDetected.get(username) ?? history.created_at
    })),
    i_followed: recentEventItems(history.events, "following_added"),
    i_unfollowed: latestEventItems(history.events, "following_removed"),
    new_followers: latestEventItems(history.events, "follower_gained")
  };

  return {
    generated_at: generatedAt,
    previous_snapshot_at: history.last_snapshot?.taken_at ?? null,
    instagram_account: instagramAccount,
    counts: {
      followers: current.followers.length,
      following: current.following.length,
      A: groups.following_not_following_back.length,
      B: groups.unfollowed_me.length,
      C: groups.followers_i_dont_follow_back.length,
      D: groups.i_unfollowed.length,
      E: groups.new_followers.length
    },
    relationship_breakdown: {
      mutual_follows: current.followers.length - followersIDontFollowBack.length,
      following_not_following_back: groups.following_not_following_back.length,
      followers_i_dont_follow_back: groups.followers_i_dont_follow_back.length
    },
    ...groups
  };
}

export function buildCompletedSync(history, input) {
  const takenAt = input.finished_at;
  const instagramAccount = normalizeUsername(input.instagram_account);
  if (!instagramAccount) {
    throw new TypeError("A completed sync requires an Instagram account.");
  }

  const nextHistory = structuredClone(history ?? createEmptyHistory(takenAt));
  const current = asCurrentRelationships(input.followers, input.following);
  const delta = computeDelta(nextHistory.last_snapshot, current);

  nextHistory.meta.instagram_account = instagramAccount;
  appendEvents(nextHistory, delta, takenAt, input.run_id);
  const report = buildReport(nextHistory, current, takenAt, instagramAccount);
  const syncPoint = {
    run_id: input.run_id,
    taken_at: takenAt,
    instagram_account: instagramAccount,
    followers_count: current.followers.length,
    following_count: current.following.length,
    changes: deltaCounts(delta)
  };

  nextHistory.last_snapshot = {
    taken_at: takenAt,
    instagram_account: instagramAccount,
    followers: current.followers,
    following: current.following
  };
  nextHistory.sync_points.push(syncPoint);

  return { history: nextHistory, report, sync_point: syncPoint };
}

export function deleteSuccessfulSync(history, runId, account) {
  const invalid = () => { throw new TypeError("Cannot verify this history for deletion. Its legacy events may be ambiguous or incomplete."); };
  const points = history?.sync_points;
  if (!Array.isArray(points) || !points.length || !history.last_snapshot || history.meta.instagram_account !== account) invalid();
  if (!points.some((point) => point.run_id === runId)) invalid();
  const byRun = new Map(points.map((point, index) => [point.run_id, index]));
  if (byRun.size !== points.length) invalid();
  const deltas = points.map(() => []);
  const countKey = Object.fromEntries(Object.entries(EVENT_TYPES_BY_DELTA).map(([key, type]) => [type, key]));
  const latest = points.at(-1);
  if (history.last_snapshot.instagram_account !== account || history.last_snapshot.taken_at.epoch !== latest.taken_at.epoch) invalid();
  for (const [index, point] of points.entries()) {
    if (point.instagram_account !== account || (index && point.taken_at.epoch < points[index - 1].taken_at.epoch)) invalid();
  }
  for (const event of history.events) {
    const candidates = event.run_id === undefined
      ? points.flatMap((point, index) => point.taken_at.epoch === event.detected_at.epoch && point.changes[countKey[event.type]] > 0 ? [index] : [])
      : [byRun.get(event.run_id)];
    if (candidates.length !== 1 || candidates[0] === undefined) invalid();
    const index = candidates[0];
    if (points[index].taken_at.epoch !== event.detected_at.epoch) invalid();
    deltas[index].push(event);
  }
  for (const [index, events] of deltas.entries()) {
    const seen = new Set();
    for (const event of events) {
      const relationship = event.type.startsWith("follower_") ? "followers" : "following";
      const key = `${relationship}:${event.username}`;
      if (seen.has(key)) invalid();
      seen.add(key);
    }
    for (const [key, type] of Object.entries(EVENT_TYPES_BY_DELTA)) {
      if (points[index].changes[key] !== events.filter((event) => event.type === type).length) invalid();
    }
  }
  if (deltas[0].length) invalid();
  const current = relationshipsFromSnapshot(history.last_snapshot);
  function apply(events, reverse) {
    for (const event of events) {
      const set = event.type.startsWith("follower_") ? current.followers : current.following;
      const added = ["follower_gained", "following_added"].includes(event.type);
      const remove = reverse ? added : !added;
      if (set.has(event.username) !== remove) invalid();
      if (remove) set.delete(event.username);
      else set.add(event.username);
    }
  }
  // Reverse deltas recover the baseline without storing full lists for every sync.
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (current.followers.size !== points[index].followers_count || current.following.size !== points[index].following_count) invalid();
    apply(deltas[index], true);
  }
  const retained = points.filter((point) => point.run_id !== runId);
  let rebuilt = createEmptyHistory(points[0].run_id === runId ? retained[0]?.taken_at ?? history.created_at : history.created_at);
  rebuilt.meta.instagram_account = account;
  let report = null;
  for (const [index, point] of points.entries()) {
    apply(deltas[index], false);
    if (point.run_id === runId) continue;
    const result = buildCompletedSync(rebuilt, {
      run_id: point.run_id, instagram_account: account, finished_at: point.taken_at,
      followers: [...current.followers], following: [...current.following]
    });
    rebuilt = result.history;
    report = result.report;
  }
  return { history: rebuilt, report };
}
