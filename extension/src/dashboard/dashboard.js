import { isLastSync, isTimestamp, validateBackup } from "../domain/schema.js";
import { EARLY_ACCESS_COPY, REVIEW_DISMISSED_KEY, STORAGE_KEY_NAMES } from "../shared/constants.js";
import { bindTelemetryControls } from "./telemetry-controls.js";
import { TELEMETRY_KEY } from "../shared/telemetry-contract.js";

const REPORT_GROUPS = Object.freeze([
  ["new_followers", "New Followers", "E"],
  ["unfollowed_me", "Unfollowed Me", "B"],
  ["i_followed", "I Followed", null],
  ["i_unfollowed", "I Unfollowed", "D"],
  ["following_not_following_back", "Not Following Back", "A"],
  ["followers_i_dont_follow_back", "Followers I Don't Follow Back", "C"]
]);
const INITIAL_VISIBLE_ROWS = 10;
const EXPAND_ROWS = 100;
const INITIAL_TREND_ROWS = 5;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;"
  })[character]);
}

function instagramAccountLink(username) {
  const account = String(username ?? "");
  const href = `https://www.instagram.com/${encodeURIComponent(account)}/`;
  return `<a class="account-link" href="${href}" target="_blank" rel="noreferrer">@${escapeHtml(account)}</a>`;
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function displayCount(value) {
  return isCount(value) ? new Intl.NumberFormat("en-US").format(value) : "—";
}

function displayDate(timestamp) {
  if (!timestamp?.iso || Number.isNaN(Date.parse(timestamp.iso))) {
    return "Unknown local time";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(timestamp.iso));
}

function displayDuration(durationMs) {
  if (!isCount(durationMs)) {
    return null;
  }

  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }

  return `${Math.round(durationMs / 1000)} sec`;
}

function reportCount(report, key) {
  return isCount(report?.counts?.[key]) ? report.counts[key] : null;
}

function relationshipCount(report, key) {
  return isCount(report?.relationship_breakdown?.[key]) ? report.relationship_breakdown[key] : null;
}

function safeSyncPoints(value) {
  return Array.isArray(value) ? value.filter((point) => point && typeof point === "object") : [];
}

function reportItemEpoch(item) {
  return isCount(item.detected_at?.epoch) ? item.detected_at.epoch : -1;
}

function safeReportItems(report, key) {
  return Array.isArray(report?.[key])
    ? report[key]
      .filter((item) => item && typeof item.username === "string")
      .sort((left, right) => reportItemEpoch(right) - reportItemEpoch(left) || left.username.localeCompare(right.username))
    : [];
}

function reportGroupCount(report, key, countKey) {
  if (!report) {
    return null;
  }
  return countKey ? reportCount(report, countKey) : safeReportItems(report, key).length;
}

function syncLabel(point, index) {
  return point?.taken_at?.iso ? displayDate(point.taken_at) : `Sync ${index + 1}`;
}

function trendCoordinates(points, key, domain, width = 440, height = 168) {
  const values = points.map((point) => isCount(point[key]) ? point[key] : 0);
  const { minimum, maximum } = domain;
  const range = Math.max(1, maximum - minimum);
  const left = 20;
  const right = width - 20;
  const top = 18;
  const bottom = height - 26;

  return values.map((value, index) => ({
    x: left + ((right - left) * index) / Math.max(1, values.length - 1),
    y: bottom - ((value - minimum) / range) * (bottom - top),
    value
  }));
}

function svgLine(coordinates) {
  return coordinates.map((coordinate, index) => `${index ? "L" : "M"}${coordinate.x.toFixed(1)} ${coordinate.y.toFixed(1)}`).join(" ");
}

function trendMarkup(points) {
  if (points.length < 2) {
    const message = points.length === 1
      ? "Trend appears after one more successful sync."
      : "Trend will appear after your first successful sync.";
    return `<div class="chart-empty" data-trend-empty><span aria-hidden="true">↗</span><p>${message}</p></div>`;
  }

  const allValues = points.flatMap((point) => [
    isCount(point.followers_count) ? point.followers_count : 0,
    isCount(point.following_count) ? point.following_count : 0
  ]);
  const domain = { minimum: Math.min(...allValues), maximum: Math.max(...allValues) };
  const followers = trendCoordinates(points, "followers_count", domain);
  const following = trendCoordinates(points, "following_count", domain);
  const marker = (coordinates, color) => coordinates.map((coordinate) => (
    `<circle cx="${coordinate.x.toFixed(1)}" cy="${coordinate.y.toFixed(1)}" r="4" fill="${color}"></circle>`
  )).join("");

  return `
    <div class="trend-legend" aria-label="Trend legend">
      <span><i class="legend-dot followers"></i>Followers</span>
      <span><i class="legend-dot following"></i>Following</span>
    </div>
    <svg class="trend-chart" viewBox="0 0 440 168" role="img" aria-label="Followers and following trend across ${points.length} successful syncs">
      <line x1="20" y1="142" x2="420" y2="142" class="chart-axis"></line>
      <path d="${svgLine(followers)}" class="trend-line followers" fill="none"></path>
      <path d="${svgLine(following)}" class="trend-line following" fill="none"></path>
      ${marker(followers, "#ef665a")}
      ${marker(following, "#236fb8")}
    </svg>
  `;
}

function trendTable(points) {
  if (!points.length) {
    return "";
  }
  const newestFirst = [...points].reverse();
  const visibleCount = Math.min(INITIAL_TREND_ROWS, points.length);
  const remaining = points.length - visibleCount;

  return `
    <div data-trend-values>
      <table class="data-table" id="trend-history">
        <caption>Trend values by successful sync</caption>
        <thead><tr><th scope="col">Sync</th><th scope="col">Followers</th><th scope="col">Following</th><th scope="col">Action</th></tr></thead>
        <tbody>${newestFirst.map((point, index) => `<tr data-trend-row${index >= INITIAL_TREND_ROWS ? " hidden" : ""}><th scope="row">${escapeHtml(syncLabel(point, points.length - index - 1))}</th><td>${displayCount(point.followers_count)}</td><td>${displayCount(point.following_count)}</td><td><button class="button button-danger-outline delete-sync-button" type="button" data-action="delete-sync" data-run-id="${escapeHtml(point.run_id)}" data-account="${escapeHtml(point.instagram_account)}" aria-label="Delete sync from ${escapeHtml(syncLabel(point, points.length - index - 1))}">Delete</button></td></tr>`).join("")}</tbody>
      </table>
      ${remaining ? `
        <div class="report-list-footer">
          <p data-trend-status aria-live="polite">Showing ${displayCount(visibleCount)} of ${displayCount(points.length)}</p>
          <button class="button button-secondary report-more-button" type="button" data-action="show-more-trend" data-trend-total="${points.length}" aria-controls="trend-history" aria-label="Show ${remaining} more sync rows">Show ${remaining} more</button>
        </div>
      ` : ""}
    </div>
  `;
}

function breakdownMarkup(report) {
  const values = [
    ["mutual_follows", "Mutual follows", "mutual"],
    ["following_not_following_back", "Not following back", "not-following"],
    ["followers_i_dont_follow_back", "Followers not followed back", "not-followed"]
  ];
  const countValues = values.map(([key]) => relationshipCount(report, key));
  const total = countValues.every((value) => value !== null) ? countValues.reduce((sum, value) => sum + value, 0) : null;

  if (total === null) {
    return `<div class="chart-empty"><span aria-hidden="true">◒</span><p>Relationship breakdown appears after your first successful sync.</p></div>`;
  }

  return `
    <div class="breakdown-bar" role="img" aria-label="Relationship breakdown">
      ${values.map(([key, label, tone]) => {
        const value = relationshipCount(report, key) ?? 0;
        const width = total ? Math.max((value / total) * 100, value ? 7 : 0) : 0;
        return `<span class="breakdown-segment ${tone}" style="flex-basis:${width}%" title="${escapeHtml(label)}: ${value}"></span>`;
      }).join("")}
    </div>
    <ul class="breakdown-list">
      ${values.map(([key, label, tone]) => `<li><span><i class="legend-dot ${tone}"></i>${escapeHtml(label)}</span><strong>${displayCount(relationshipCount(report, key))}</strong></li>`).join("")}
    </ul>
  `;
}

export function createInitialDashboardState() {
  return {
    instagramAccount: null,
    report: null,
    syncPoints: [],
    lastSync: null,
    feedback: null,
    announcement: "",
    announcementId: 0,
    startPending: false,
    recoveryPending: false,
    stopPending: false,
    focusPending: false,
    dataMutationPending: false,
    resetPending: false
  };
}

export function getSyncPresentation(lastSync, startPending = false, stopPending = false, recoveryPending = false) {
  if (startPending && lastSync?.state !== "running") {
    return {
      kind: "running",
      text: "Starting local sync.",
      alert: null,
      button: "Sync in progress",
      disabled: true
    };
  }

  if (!lastSync?.state) {
    return { kind: "idle", text: "Ready for a local sync.", alert: null, button: "Sync now", disabled: false };
  }

  if (lastSync.state === "running") {
    const stageLabels = {
      preflight: "Preparing local sync",
      collecting_following: "Collecting following",
      processing: "Processing local analytics"
    };
    return {
      kind: "running",
      text: stopPending
        ? "Stopping local sync."
        : recoveryPending
          ? "Recovering the local sync."
        : lastSync.paused
          ? "Sync paused. Return to Instagram to continue."
        : lastSync.stage === "collecting_followers"
          ? "Followers Sync in progress"
          : `${stageLabels[lastSync.stage] ?? "Sync in progress"}.`,
      alert: null,
      button: "Sync in progress",
      disabled: true
    };
  }

  if (lastSync.state === "completed") {
    return {
      kind: "completed",
      text: `Completed locally${lastSync.finished_at ? ` ${displayDate(lastSync.finished_at)}` : ""}.`,
      alert: null,
      button: "Sync now",
      disabled: false
    };
  }

  if (lastSync.state === "interrupted" && lastSync.error?.message === "Sync cancelled by you.") {
    const diagnostics = displayDuration(lastSync.duration_ms) ? ` Duration: ${displayDuration(lastSync.duration_ms)}` : "";
    const finishedAt = lastSync.finished_at ? ` at ${displayDate(lastSync.finished_at)}` : "";
    return {
      kind: "interrupted",
      text: "Sync cancelled. Retry when you are ready.",
      alert: `Sync cancelled${finishedAt}.${diagnostics}`,
      button: "Retry sync",
      disabled: false
    };
  }

  if (lastSync.state === "failed" && ["NOT_LOGGED_IN", "NOT_INSTAGRAM"].includes(lastSync.error?.code)) {
    return {
      kind: "failed",
      text: "Instagram tab required.",
      alert: "Sync failed: Open Instagram in a tab, sign in, and retry",
      button: "Retry sync",
      disabled: false
    };
  }

  if (["failed", "interrupted"].includes(lastSync.state)) {
    const diagnostics = [
      displayDuration(lastSync.duration_ms) ? `Duration: ${displayDuration(lastSync.duration_ms)}` : null,
      isCount(lastSync.followers_count) ? `Followers: ${displayCount(lastSync.followers_count)}` : null,
      isCount(lastSync.following_count) ? `Following: ${displayCount(lastSync.following_count)}` : null
    ].filter(Boolean).join(" · ");
    const heading = lastSync.state === "interrupted" ? "Sync interrupted" : "Sync failed";
    const localError = lastSync.error?.message || "A local sync error occurred.";
    return {
      kind: lastSync.state,
      text: `${heading}. Retry when you are ready.`,
      alert: `${heading}: ${localError}${diagnostics ? ` ${diagnostics}` : ""}`,
      button: "Retry sync",
      disabled: false
    };
  }

  return { kind: "idle", text: "Ready for a local sync.", alert: null, button: "Sync now", disabled: false };
}

function overviewMarkup(report, instagramAccount) {
  const metrics = [
    ["Followers", reportCount(report, "followers")],
    ["Following", reportCount(report, "following")],
    ...REPORT_GROUPS.map(([key, label, countKey]) => [label, reportGroupCount(report, key, countKey)])
  ];
  const primary = metrics.slice(0, 2);
  const secondary = metrics.slice(2);

  return `
    <article class="summary-card">
      <p class="card-kicker">Last synced account</p>
      <div class="summary-values">
        ${primary.map(([label, count]) => `<div><span>${escapeHtml(label)}</span><strong>${displayCount(count)}</strong></div>`).join("")}
      </div>
      <p>${instagramAccount ? instagramAccountLink(instagramAccount) : "Sync to create your first local snapshot."}</p>
    </article>
    <div class="metric-grid">
      ${secondary.map(([label, count]) => `<article class="metric-card"><p>${escapeHtml(label)}</p><strong>${displayCount(count)}</strong></article>`).join("")}
    </div>
  `;
}

function reportsMarkup(report) {
  return REPORT_GROUPS.map(([key, label]) => {
    const items = safeReportItems(report, key);
    const visibleCount = Math.min(INITIAL_VISIBLE_ROWS, items.length);
    const listId = `report-list-${key}`;
    return `
      <article class="report-card">
        <div class="report-card-heading">
          <h3>${escapeHtml(label)}</h3><p>${displayCount(items.length)} usernames</p>
        </div>
        ${items.length ? `
          <ul class="report-list" id="${listId}">${items.map((item, index) => `<li data-report-row${index >= INITIAL_VISIBLE_ROWS ? " hidden" : ""}>${instagramAccountLink(item.username)}<time datetime="${escapeHtml(item.detected_at?.iso ?? "")}">${escapeHtml(displayDate(item.detected_at))}</time></li>`).join("")}</ul>
          ${items.length > INITIAL_VISIBLE_ROWS ? `
            <div class="report-list-footer">
              <p data-report-status aria-live="polite">Showing ${displayCount(visibleCount)} of ${displayCount(items.length)}</p>
              <button class="button button-secondary report-more-button" type="button" data-action="show-more-report" data-report-label="${escapeHtml(label)}" data-report-total="${items.length}" aria-controls="${listId}" aria-label="Show ${Math.min(EXPAND_ROWS, items.length - visibleCount)} more usernames in ${escapeHtml(label)}">Show ${Math.min(EXPAND_ROWS, items.length - visibleCount)} more</button>
            </div>
          ` : ""}
        ` : "<p class=\"empty-report\">No usernames in this group.</p>"}
      </article>
    `;
  }).join("");
}

function toggleAdditionalRows(button, container, total, rowSelector, statusSelector, showLabel, hideLabel, initialRows = INITIAL_VISIBLE_ROWS, expandRows = EXPAND_ROWS) {
  const hiddenRows = [...container.querySelectorAll(`${rowSelector}[hidden]`)];
  if (!hiddenRows.length) {
    const rows = [...container.querySelectorAll(rowSelector)];
    for (const row of rows.slice(initialRows)) {
      row.hidden = true;
    }
    const status = container.querySelector(statusSelector);
    if (status) {
      status.textContent = `Showing ${displayCount(Math.min(initialRows, total))} of ${displayCount(total)}`;
    }
    const nextCount = Math.min(expandRows, Math.max(0, total - initialRows));
    button.textContent = `Show ${nextCount} more`;
    button.setAttribute("aria-label", showLabel(nextCount));
    return true;
  }

  const revealedRows = hiddenRows.slice(0, expandRows);
  for (const row of revealedRows) {
    row.hidden = false;
  }

  const remaining = hiddenRows.length - revealedRows.length;
  const shown = total - remaining;
  const status = container.querySelector(statusSelector);
  if (status) {
    status.textContent = remaining ? `Showing ${displayCount(shown)} of ${displayCount(total)}` : `Showing all ${displayCount(total)}`;
  }

  if (remaining) {
    const nextCount = Math.min(expandRows, remaining);
    button.textContent = `Show ${nextCount} more`;
    button.setAttribute("aria-label", showLabel(nextCount));
  } else {
    button.textContent = "Hide";
    button.setAttribute("aria-label", hideLabel);
  }

  return true;
}

export function expandReportList(button) {
  const card = button?.closest?.(".report-card");
  const total = Number(button?.dataset?.reportTotal);
  if (!card || !Number.isInteger(total) || total < 0) {
    return false;
  }

  const label = button.dataset.reportLabel;
  return toggleAdditionalRows(
    button,
    card,
    total,
    "[data-report-row]",
    "[data-report-status]",
    (count) => `Show ${count} more usernames in ${label}`,
    `Hide extra usernames in ${label}`
  );
}

export function expandTrendList(button) {
  const container = button?.closest?.("[data-trend-values]");
  const total = Number(button?.dataset?.trendTotal);
  if (!container || !Number.isInteger(total) || total < 0) {
    return false;
  }

  return toggleAdditionalRows(
    button,
    container,
    total,
    "[data-trend-row]",
    "[data-trend-status]",
    (count) => `Show ${count} more sync rows`,
    "Hide extra sync rows",
    INITIAL_TREND_ROWS,
    total
  );
}

function dataActionsMarkup(state) {
  const hasReport = Boolean(state.report);
  const hasLocalData = hasReport || state.syncPoints.length > 0 || Boolean(state.lastSync);
  const hasAccount = Boolean(state.instagramAccount);
  const mutationBlocked = state.lastSync?.state === "running" || state.startPending || state.resetPending || state.dataMutationPending;
  const disabled = (value) => value ? "" : " disabled aria-disabled=\"true\"";

  return `
    <div class="data-action-copy">
      <h3>Keep a local copy</h3>
      <p>${hasAccount ? "Report files and backups apply to the Instagram account shown above. Nothing is sent to the developer." : "Sync to create a local account history. Nothing is sent to the developer."}</p>
    </div>
    <div class="data-actions">
      <button class="button button-secondary" type="button" data-action="export-csv"${disabled(hasReport)}>Download report CSV</button>
      <button class="button button-secondary" type="button" data-action="export-json"${disabled(hasReport)}>Download report JSON</button>
      <button class="button button-secondary" type="button" data-action="backup-export"${disabled(hasAccount && hasLocalData)}>Download backup JSON</button>
      <button class="button button-secondary" type="button" data-action="import-backup"${disabled(!mutationBlocked)}>Import backup</button>
      <button class="button button-danger-outline" type="button" data-action="reset"${disabled(!state.resetPending)}>${state.resetPending ? "Resetting…" : "Reset all data"}</button>
    </div>
    ${!hasLocalData ? "<p class=\"data-hint\">No analytics are stored for this account. Reset all data remains available to clear any unfinished local sync.</p>" : ""}
  `;
}

export function renderDashboard(state) {
  const syncPoints = safeSyncPoints(state.syncPoints);
  const report = state.report && typeof state.report === "object" ? state.report : null;
  const instagramAccount = state.instagramAccount ?? null;
  const emptyAnalytics = {
    counts: { followers: 0, following: 0, A: 0, B: 0, C: 0, D: 0, E: 0 },
    relationship_breakdown: {
      mutual_follows: 0,
      following_not_following_back: 0,
      followers_i_dont_follow_back: 0
    }
  };
  const displayedReport = report ?? emptyAnalytics;
  const sync = getSyncPresentation(state.lastSync, state.startPending, state.stopPending, state.recoveryPending);
  const running = state.lastSync?.state === "running";
  const latestSuccess = syncPoints.reduce((latest, point) => (
    isTimestamp(point.taken_at) && (!latest || point.taken_at.epoch > latest.epoch) ? point.taken_at : latest
  ), isTimestamp(report?.generated_at) ? report.generated_at : null);

  return {
    accountMarkup: instagramAccount ? `Instagram account: ${instagramAccountLink(instagramAccount)}` : "Instagram account appears after your first sync.",
    lastSyncTime: latestSuccess
      ? `Latest successful sync: ${displayDate(latestSuccess)}`
      : state.lastSync?.finished_at
        ? `Latest local result: ${displayDate(state.lastSync.finished_at)}`
      : "No sync recorded yet.",
    syncState: `<span class="status-dot ${sync.kind}" aria-hidden="true"></span>${escapeHtml(sync.text)}`,
    reviewPanel: latestSuccess ? '<span class="review-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9Z"/></svg></span><div class="review-copy"><h2>Thank you for using Followers Tracker Pro!</h2><p>If you find it useful, please leave a review on the Chrome Web Store. This means a lot to us.</p></div><a class="button button-primary" href="https://chromewebstore.google.com/detail/instagram-followers-track/bbjpknpklcpjcogdockeodhieaghbbeb/reviews" data-telemetry-action="review" target="_blank" rel="noreferrer">Rate us</a>' : "",
    syncButton: { label: sync.button, disabled: sync.disabled || Boolean(state.resetPending || state.dataMutationPending) },
    focusButton: {
      disabled: Boolean(state.focusPending || state.stopPending || state.recoveryPending || state.resetPending),
      hidden: !running || !state.lastSync.paused
    },
    stopButton: {
      label: state.stopPending ? "Stopping…" : state.recoveryPending ? "Recovering…" : "Stop sync",
      disabled: Boolean(state.stopPending || state.recoveryPending || state.resetPending),
      hidden: !running
    },
    liveMessage: state.feedback?.kind === "success" ? state.feedback.message : state.announcement ?? "",
    liveNoticeKey: state.feedback?.kind === "success" ? `feedback:${state.feedback.id ?? 0}` : `announcement:${state.announcementId ?? 0}`,
    alertMessage: state.feedback?.kind === "error" ? state.feedback.message : sync.alert,
    alertNoticeKey: state.feedback?.kind === "error"
      ? `feedback:${state.feedback.id ?? 0}`
      : `sync:${state.lastSync?.run_id ?? "none"}:${state.lastSync?.state ?? "idle"}:${state.lastSync?.finished_at?.epoch ?? "none"}`,
    overview: overviewMarkup(displayedReport, instagramAccount),
    trend: `<div class="card-header"><div><p class="card-kicker">History</p><h3 id="trend-title">Followers &amp; following trend</h3></div><span class="card-count">${syncPoints.length} sync${syncPoints.length === 1 ? "" : "s"}</span></div>${trendMarkup(syncPoints)}${trendTable(syncPoints)}`,
    breakdown: `<div class="card-header"><div><p class="card-kicker">Current mix</p><h3 id="breakdown-title">Relationship breakdown</h3></div></div>${breakdownMarkup(displayedReport)}`,
    reports: reportsMarkup(displayedReport),
    dataActions: dataActionsMarkup({
      ...state,
      report,
      syncPoints,
      lastSync: state.lastSync,
      resetPending: state.resetPending,
      instagramAccount
    })
  };
}

export function createDomView(
  documentRef,
  { BlobClass = Blob, objectUrls = URL, defer = setTimeout } = {}
) {
  let returnFocus = null;
  let fallbackFocusTarget = null;
  let lastLiveNoticeKey = null;
  let lastAlertNoticeKey = null;
  let reviewDismissed = false;
  let reviewAvailable = false;
  const renderedMarkup = new Map();
  const query = (selector) => documentRef.querySelector(selector);
  const fallbackByDialog = {
    import: "data-management",
    reset: "data-management",
    "delete-sync": "history"
  };

  return {
    setReviewDismissed(dismissed) {
      reviewDismissed = dismissed;
      query("[data-review-panel]").hidden = dismissed || !reviewAvailable;
    },
    render(state) {
      const view = renderDashboard(state);
      query("[data-early-access]").textContent = EARLY_ACCESS_COPY;
      query("[data-account]").innerHTML = view.accountMarkup;
      query("[data-last-sync-time]").textContent = view.lastSyncTime;
      query("[data-sync-state]").innerHTML = view.syncState;
      const reviewPanel = query("[data-review-panel]");
      reviewPanel.innerHTML = view.reviewPanel;
      reviewAvailable = Boolean(view.reviewPanel);
      reviewPanel.hidden = reviewDismissed || !reviewAvailable;
      const syncButton = query('[data-action="sync"]');
      syncButton.textContent = view.syncButton.label;
      syncButton.disabled = view.syncButton.disabled;
      syncButton.setAttribute("aria-disabled", String(view.syncButton.disabled));
      const stopButton = query('[data-action="stop"]');
      stopButton.textContent = view.stopButton.label;
      stopButton.disabled = view.stopButton.disabled;
      stopButton.hidden = view.stopButton.hidden;
      stopButton.setAttribute("aria-disabled", String(view.stopButton.disabled));
      const focusButton = query('[data-action="focus-sync"]');
      focusButton.disabled = view.focusButton.disabled;
      focusButton.hidden = view.focusButton.hidden;
      focusButton.setAttribute("aria-disabled", String(view.focusButton.disabled));
      const liveStatus = query("[data-live-status]");
      liveStatus.className = state.feedback?.kind === "success" ? "live-message" : "live-message visually-hidden";
      if (lastLiveNoticeKey !== view.liveNoticeKey || liveStatus.textContent !== (view.liveMessage ?? "")) {
        liveStatus.replaceChildren(...(view.liveMessage ? [documentRef.createTextNode(view.liveMessage)] : []));
        lastLiveNoticeKey = view.liveNoticeKey;
      }
      const alert = query("[data-alert]");
      if (lastAlertNoticeKey !== view.alertNoticeKey || alert.textContent !== (view.alertMessage ?? "")) {
        alert.replaceChildren(...(view.alertMessage ? [documentRef.createTextNode(view.alertMessage)] : []));
        lastAlertNoticeKey = view.alertNoticeKey;
      }
      for (const [selector, markup] of [
        ["[data-overview]", view.overview],
        ["[data-trend]", view.trend],
        ["[data-breakdown]", view.breakdown],
        ["[data-reports]", view.reports],
        ["[data-data-actions]", view.dataActions]
      ]) {
        if (renderedMarkup.get(selector) !== markup) {
          query(selector).innerHTML = markup;
          renderedMarkup.set(selector, markup);
        }
      }
      for (const button of documentRef.querySelectorAll('[data-action="delete-sync"]')) {
        button.disabled = Boolean(state.lastSync?.state === "running" || state.startPending || state.resetPending || state.dataMutationPending);
        button.setAttribute("aria-disabled", String(button.disabled));
      }
    },
    openDialog(name, trigger, details = null) {
      returnFocus = trigger || documentRef.activeElement;
      fallbackFocusTarget = fallbackByDialog[name] ?? "dashboard";
      if (name === "delete-sync" && details) {
        query("[data-delete-sync-description]").textContent = `Delete the sync from ${displayDate(details.takenAt)} for @${details.instagramAccount}?`;
      }
      const dialog = query(`[data-dialog="${name}"]`);
      if (dialog && !dialog.open) {
        dialog.showModal();
      }
    },
    closeDialog(name) {
      const dialog = query(`[data-dialog="${name}"]`);
      if (dialog?.open) {
        dialog.close();
      }
      if (returnFocus?.isConnected && !returnFocus.disabled) {
        returnFocus.focus();
      } else if (fallbackFocusTarget) {
        this.focusTarget(fallbackFocusTarget);
      }
      returnFocus = null;
      fallbackFocusTarget = null;
    },
    focusTarget(target) {
      query(`[data-focus-target="${target}"]`)?.focus();
    },
    download({ body, filename, mimeType }) {
      const objectUrl = objectUrls.createObjectURL(new BlobClass([body], { type: mimeType }));
      const anchor = documentRef.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      anchor.hidden = true;
      documentRef.body.append(anchor);
      anchor.click();
      anchor.remove();
      defer(() => objectUrls.revokeObjectURL(objectUrl), 0);
    }
  };
}

function nextRequestId() {
  return `dashboard_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function runtimeRequest(runtime, message) {
  try {
    return Promise.resolve(runtime.sendMessage(message));
  } catch (cause) {
    return Promise.reject(cause);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCorrelatedResponse(response, type, requestId) {
  return isObject(response) && response.type === type && response.request_id === requestId;
}

function isDashboardStateResponse(response, requestId) {
  if (!(
    isCorrelatedResponse(response, "dashboard.state", requestId) &&
    (response.report === null || isObject(response.report)) &&
    Array.isArray(response.sync_points) &&
    (response.last_sync === null || isObject(response.last_sync))
  )) {
    return false;
  }

  return (
    Object.hasOwn(response, "instagram_account") &&
    (response.instagram_account === null || (typeof response.instagram_account === "string" && /^[a-z0-9._]+$/.test(response.instagram_account)))
  );
}

function isAcceptedResponse(response, requestId) {
  return (
    isCorrelatedResponse(response, "sync.accepted", requestId) &&
    response.state === "running" &&
    typeof response.run_id === "string" &&
    Boolean(response.run_id) &&
    isTimestamp(response.started_at) &&
    ["preflight", "collecting_followers", "collecting_following", "processing"].includes(response.stage) &&
    typeof response.recovered === "boolean"
  );
}

function isTerminalResult(response, requestId = undefined) {
  return (
    isObject(response) &&
    response.type === "sync.result" &&
    (requestId === undefined || response.request_id === requestId) &&
    typeof response.run_id === "string" &&
    Boolean(response.run_id) &&
    ["completed", "failed", "interrupted"].includes(response.state)
  );
}

function isImmediateTerminalResponse(response, requestId) {
  const nullableCount = (value) => value === null || (Number.isInteger(value) && value >= 0);
  if (
    !isTerminalResult(response, requestId) ||
    !isTimestamp(response.started_at) ||
    !isTimestamp(response.finished_at) ||
    !nullableCount(response.followers_count) ||
    !nullableCount(response.following_count) ||
    !nullableCount(response.duration_ms)
  ) {
    return false;
  }
  if (response.state === "completed") {
    return response.error === null && isObject(response.sync_point) && isObject(response.report);
  }
  return (
    response.sync_point === null &&
    response.report === null &&
    isObject(response.error) &&
    typeof response.error.code === "string" &&
    typeof response.error.message === "string" &&
    Boolean(response.error.message)
  );
}

function isExportResponse(response, type, requestId) {
  return (
    isCorrelatedResponse(response, type, requestId) &&
    ((
      typeof response.filename === "string" &&
      Boolean(response.filename) &&
      typeof response.mime_type === "string" &&
      Boolean(response.mime_type) &&
      typeof response.body === "string" &&
      response.error === null
    ) || (
      response.filename === null &&
      response.mime_type === null &&
      response.body === null &&
      isObject(response.error) &&
      typeof response.error.message === "string"
    ))
  );
}

function isManagedStorageKey(key) {
  return (
    STORAGE_KEY_NAMES.includes(key) ||
    /^(?:instatrack\.run\.v1\.(?:regular|incognito)|instatrack\.account\.v1\.(?:0|[1-9]\d*)\.[a-z0-9._]+)$/.test(key)
  );
}

function areManagedStorageKeys(keys) {
  return (
    Array.isArray(keys) &&
    keys.every((key) => typeof key === "string" && isManagedStorageKey(key)) &&
    new Set(keys).size === keys.length
  );
}

function isImportResponse(response, requestId) {
  return (
    isCorrelatedResponse(response, "backup.import.result", requestId) &&
    typeof response.imported === "boolean" &&
    areManagedStorageKeys(response.replaced_keys) &&
    (response.error === null || (isObject(response.error) && typeof response.error.message === "string"))
  );
}

function isResetResponse(response, requestId) {
  const keys = ["type", "request_id", "reset", "deleted_keys", "error"];
  return (
    isCorrelatedResponse(response, "history.reset.result", requestId) &&
    Object.keys(response).length === keys.length &&
    keys.every((key) => Object.hasOwn(response, key)) &&
    response.reset === true &&
    areManagedStorageKeys(response.deleted_keys) &&
    response.error === null
  );
}

function isRejectedResetResponse(response, requestId) {
  const keys = ["type", "request_id", "reset", "deleted_keys", "error"];
  const errorKeys = ["code", "message"];
  return (
    isCorrelatedResponse(response, "history.reset.result", requestId) &&
    Object.keys(response).length === keys.length &&
    keys.every((key) => Object.hasOwn(response, key)) &&
    response.reset === false &&
    Array.isArray(response.deleted_keys) &&
    response.deleted_keys.length === 0 &&
    isObject(response.error) &&
    Object.keys(response.error).length === errorKeys.length &&
    errorKeys.every((key) => Object.hasOwn(response.error, key)) &&
    typeof response.error.code === "string" &&
    Boolean(response.error.code) &&
    typeof response.error.message === "string" &&
    Boolean(response.error.message)
  );
}

function isStopResponse(response, requestId, runId) {
  const keys = ["type", "request_id", "run_id", "stopped", "last_sync", "error"];
  return (
    isCorrelatedResponse(response, "sync.stop.result", requestId) &&
    Object.keys(response).length === keys.length &&
    keys.every((key) => Object.hasOwn(response, key)) &&
    response.run_id === runId &&
    response.stopped === true &&
    response.error === null &&
    isLastSync(response.last_sync) &&
    response.last_sync.run_id === runId &&
    response.last_sync.state === "interrupted" &&
    isTimestamp(response.last_sync.finished_at)
  );
}

function isRejectedStopResponse(response, requestId, runId) {
  const keys = ["type", "request_id", "run_id", "stopped", "last_sync", "error"];
  const errorKeys = ["code", "message"];
  return (
    isCorrelatedResponse(response, "sync.stop.result", requestId) &&
    Object.keys(response).length === keys.length &&
    keys.every((key) => Object.hasOwn(response, key)) &&
    response.run_id === runId &&
    response.stopped === false &&
    (response.last_sync === null || isLastSync(response.last_sync)) &&
    isObject(response.error) &&
    Object.keys(response.error).length === errorKeys.length &&
    errorKeys.every((key) => Object.hasOwn(response.error, key)) &&
    typeof response.error.code === "string" &&
    Boolean(response.error.code) &&
    typeof response.error.message === "string" &&
    Boolean(response.error.message)
  );
}

function previewTerminal(response, previousLastSync) {
  return {
    run_id: response.run_id,
    state: response.state,
    stage: response.stage ?? previousLastSync?.stage ?? "preflight",
    started_at: response.started_at ?? previousLastSync?.started_at ?? null,
    finished_at: response.finished_at ?? null,
    instagram_account: response.instagram_account ?? null,
    followers_count: response.followers_count ?? null,
    following_count: response.following_count ?? null,
    duration_ms: response.duration_ms ?? null,
    error: response.error ?? null
  };
}

export function createDashboardController({ runtime, view, requestId = nextRequestId, now = () => new Date() }) {
  let state = createInitialDashboardState();
  let pendingImportBody = null;
  let pendingDeletion = null;
  let activeRunId = null;
  let startInFlight = false;
  let stopInFlight = false;
  let resetInFlight = false;
  let recoveryAttempted = false;
  let bufferedTerminal = null;
  let lifecycleGeneration = 0;
  let refreshGeneration = 0;
  let noticeSequence = 0;

  function dataMutationBlocked() {
    return resetInFlight || startInFlight || state.lastSync?.state === "running" || state.dataMutationPending;
  }

  function render() {
    view.render(state);
  }

  function feedback(kind, message, focusTarget = null) {
    noticeSequence += 1;
    state = {
      ...state,
      feedback: { kind, message, id: noticeSequence },
      ...(kind === "error" ? { announcement: "", announcementId: noticeSequence } : {})
    };
    render();
    if (focusTarget) {
      view.focusTarget(focusTarget);
    }
  }

  function applyDashboardState(response, responseRequestId, { preserveFeedback = false, preserveRecoveryPending = false, announceTerminalRunId = null, announceProgressRunId = null } = {}) {
    if (!isDashboardStateResponse(response, responseRequestId)) {
      throw new TypeError("The local dashboard state response was invalid.");
    }
    const shouldAnnounceTerminal = (
      announceTerminalRunId &&
      response.last_sync?.run_id === announceTerminalRunId &&
      ["completed", "failed", "interrupted"].includes(response.last_sync.state)
    );
    const shouldAnnounceProgress = announceProgressRunId === response.last_sync?.run_id && (
      state.lastSync?.stage !== response.last_sync.stage || Boolean(state.lastSync?.paused) !== Boolean(response.last_sync.paused)
    );
    const shouldAnnounce = shouldAnnounceTerminal || shouldAnnounceProgress;
    const announcementId = shouldAnnounce ? ++noticeSequence : state.announcementId;
    state = {
      ...state,
      instagramAccount: response.instagram_account,
      report: response.report,
      syncPoints: safeSyncPoints(response.sync_points),
      lastSync: response.last_sync,
      feedback: preserveFeedback ? state.feedback : null,
      announcement: shouldAnnounce ? getSyncPresentation(response.last_sync).text : state.announcement,
      announcementId,
      startPending: false,
      recoveryPending: preserveRecoveryPending ? state.recoveryPending : false,
      stopPending: false,
      resetPending: false
    };
    activeRunId = response.last_sync?.state === "running" ? response.last_sync.run_id : null;
    render();
  }

  async function refresh(options = {}) {
    const generation = lifecycleGeneration;
    const responseGeneration = ++refreshGeneration;
    const responseRequestId = requestId();
    try {
      const response = await runtimeRequest(runtime, { type: "dashboard.getState", request_id: responseRequestId });
      if (generation !== lifecycleGeneration || responseGeneration !== refreshGeneration) {
        return null;
      }
      applyDashboardState(response, responseRequestId, options);
      return state;
    } catch {
      if (generation !== lifecycleGeneration || responseGeneration !== refreshGeneration) {
        return null;
      }
      feedback("error", "Unable to read local dashboard data.");
      return null;
    }
  }

  async function handleStorageChange(changes, areaName) {
    if (areaName !== "local" || dataMutationBlocked() || !Object.keys(changes).some((key) => (
      key === "instatrack.control.v1" || key.startsWith("instatrack.account.v1.")
    ))) return false;
    if (!await refresh()) return false;
    state = { ...state, announcement: getSyncPresentation(state.lastSync).text, announcementId: ++noticeSequence };
    render();
    return true;
  }

  async function canonicalizeTerminal(runId) {
    const canonical = await refresh({ announceTerminalRunId: runId });
    return Boolean(
      canonical &&
      canonical.lastSync?.run_id === runId &&
      ["completed", "failed", "interrupted"].includes(canonical.lastSync.state)
    );
  }

  async function startSync({ recoveryRunId = null } = {}) {
    const recovering = Boolean(recoveryRunId);
    if (
      startInFlight ||
      stopInFlight ||
      resetInFlight ||
      state.dataMutationPending ||
      (!recovering && state.lastSync?.state === "running") ||
      (recovering && (state.lastSync?.state !== "running" || state.lastSync.run_id !== recoveryRunId))
    ) {
      return false;
    }
    startInFlight = true;
    const operationGeneration = lifecycleGeneration;
    noticeSequence += 1;
    state = {
      ...state,
      startPending: !recovering,
      recoveryPending: recovering,
      feedback: null,
      announcement: recovering
        ? "Recovering the local sync."
        : "Starting local sync.",
      announcementId: noticeSequence
    };
    render();

    const requestedAt = now();
    const syncRequestId = requestId();
    let response;
    try {
      response = await runtimeRequest(runtime, {
        type: "sync.start",
        request_id: syncRequestId,
        requested_at: {
          iso: new Date(Math.floor(requestedAt.getTime() / 1000) * 1000).toISOString().replace(".000Z", "Z"),
          epoch: Math.floor(requestedAt.getTime() / 1000)
        }
      });
    } catch {
      if (operationGeneration !== lifecycleGeneration) {
        return false;
      }
      startInFlight = false;
      state = { ...state, startPending: false, recoveryPending: false };
      feedback("error", "Unable to start a local sync.");
      return false;
    }

    if (operationGeneration !== lifecycleGeneration) {
      return false;
    }

    if (isAcceptedResponse(response, syncRequestId)) {
      if (recovering && response.run_id !== recoveryRunId) {
        startInFlight = false;
        state = { ...state, startPending: false, recoveryPending: false };
        feedback("error", "The local sync recovery response was invalid.");
        return false;
      }
      activeRunId = response.run_id;
      state = {
        ...state,
        lastSync: {
          run_id: response.run_id,
          state: "running",
          stage: response.stage,
          started_at: response.started_at,
          finished_at: null,
          instagram_account: null,
          followers_count: null,
          following_count: null,
          duration_ms: null,
          error: null
        },
        startPending: false,
        recoveryPending: recovering,
        feedback: null
      };
      render();
      const bufferedForRun = bufferedTerminal?.run_id === response.run_id;
      bufferedTerminal = null;
      await refresh({ announceTerminalRunId: response.run_id, preserveRecoveryPending: recovering });
      if (operationGeneration !== lifecycleGeneration) {
        return false;
      }
      if (bufferedForRun && activeRunId === response.run_id) {
        await canonicalizeTerminal(response.run_id);
      }
      startInFlight = false;
      if (state.recoveryPending) {
        state = { ...state, recoveryPending: false };
        render();
      }
      return true;
    }

    if (isImmediateTerminalResponse(response, syncRequestId) && (!recovering || response.run_id === recoveryRunId)) {
      activeRunId = response.run_id;
      noticeSequence += 1;
      state = {
        ...state,
        lastSync: previewTerminal(response, state.lastSync),
        startPending: false,
        recoveryPending: false,
        feedback: null,
        announcement: getSyncPresentation(previewTerminal(response, state.lastSync)).text,
        announcementId: noticeSequence
      };
      render();
      await canonicalizeTerminal(response.run_id);
      if (operationGeneration !== lifecycleGeneration) {
        return false;
      }
      startInFlight = false;
      if (response.error) {
        feedback("error", `Sync ${response.state}: ${response.error.message}`);
      }
      return true;
    }

    startInFlight = false;
    state = { ...state, startPending: false, recoveryPending: false };
    const correlatedError = isObject(response) && response.request_id === syncRequestId && typeof response.error?.message === "string"
      ? response.error.message
      : "Unable to start a local sync.";
    feedback("error", correlatedError);
    return false;
  }

  async function stopSync() {
    const runId = state.lastSync?.state === "running" ? state.lastSync.run_id : null;
    if (!runId || startInFlight || stopInFlight || resetInFlight) {
      return false;
    }

    stopInFlight = true;
    const operationGeneration = lifecycleGeneration;
    noticeSequence += 1;
    state = {
      ...state,
      stopPending: true,
      feedback: null,
      announcement: "Stopping local sync.",
      announcementId: noticeSequence
    };
    render();

    const stopRequestId = requestId();
    let response;
    try {
      response = await runtimeRequest(runtime, {
        type: "sync.stop",
        request_id: stopRequestId,
        run_id: runId
      });
    } catch {
      if (operationGeneration !== lifecycleGeneration) {
        return false;
      }
      stopInFlight = false;
      state = { ...state, stopPending: false };
      feedback("error", "Unable to stop the local sync.", "stop-sync");
      return false;
    }

    if (operationGeneration !== lifecycleGeneration) {
      return false;
    }
    if (!isStopResponse(response, stopRequestId, runId)) {
      stopInFlight = false;
      state = { ...state, stopPending: false };
      if (isRejectedStopResponse(response, stopRequestId, runId)) {
        const canonical = await refresh();
        if (operationGeneration !== lifecycleGeneration) {
          return false;
        }
        const current = canonical ?? state;
        const sameRunStillRunning = current.lastSync?.state === "running" && current.lastSync.run_id === runId;
        feedback("error", response.error.message, sameRunStillRunning ? "stop-sync" : "sync");
        return false;
      }
      feedback("error", "Unable to stop the local sync.", "stop-sync");
      return false;
    }

    stopInFlight = false;
    activeRunId = null;
    bufferedTerminal = null;
    state = {
      ...state,
      lastSync: response.last_sync,
      stopPending: false,
      feedback: null,
      announcement: ""
    };
    feedback("success", "Sync stopped. Existing analytics were kept.", "sync");
    return true;
  }

  async function initialize() {
    const loaded = await refresh();
    if (!loaded) {
      return false;
    }
    if (loaded.lastSync?.state === "running" && !recoveryAttempted) {
      recoveryAttempted = await startSync({ recoveryRunId: loaded.lastSync.run_id });
    }
    return true;
  }

  async function handleRuntimeMessage(message) {
    if (!resetInFlight && message?.type === "sync.progress") {
      if (!activeRunId || message.run_id !== activeRunId || !isLastSync(message.last_sync) || message.last_sync.run_id !== activeRunId || message.last_sync.state !== "running") {
        return false;
      }
      return Boolean(await refresh({ announceProgressRunId: message.run_id, preserveRecoveryPending: true }));
    }
    if (resetInFlight || !isTerminalResult(message)) {
      return false;
    }
    if (state.recoveryPending) {
      bufferedTerminal = message;
      return true;
    }
    if (!activeRunId && startInFlight) {
      bufferedTerminal = message;
      return true;
    }
    if (!activeRunId || message.run_id !== activeRunId) {
      return false;
    }
    return canonicalizeTerminal(message.run_id);
  }

  async function focusSync() {
    if (state.lastSync?.state !== "running" || state.focusPending || state.stopPending || resetInFlight) {
      return false;
    }
    const operationGeneration = lifecycleGeneration;
    const runId = state.lastSync.run_id;
    const focusRequestId = requestId();
    state = { ...state, focusPending: true };
    render();
    let response;
    try {
      response = await runtimeRequest(runtime, { type: "sync.focus", request_id: focusRequestId, run_id: runId });
    } catch {
      response = null;
    }
    if (operationGeneration !== lifecycleGeneration) return false;
    state = { ...state, focusPending: false };
    if (!isCorrelatedResponse(response, "sync.focus.result", focusRequestId) || response.focused !== true || response.error !== null) {
      feedback("error", isCorrelatedResponse(response, "sync.focus.result", focusRequestId)
        ? response.error?.message || "Unable to return to Instagram."
        : "Unable to return to Instagram.");
      return false;
    }
    render();
    return true;
  }

  function openDeleteSync(instagramAccount, runId, trigger) {
    if (dataMutationBlocked() || instagramAccount !== state.instagramAccount) return false;
    const point = state.syncPoints.find((item) => item.run_id === runId && item.instagram_account === instagramAccount);
    if (!point) return false;
    pendingDeletion = { instagramAccount, runId };
    view.openDialog("delete-sync", trigger, { instagramAccount, takenAt: point.taken_at });
    return true;
  }

  async function confirmDeleteSync() {
    const deletion = pendingDeletion;
    cancelDialog("delete-sync");
    if (!deletion || dataMutationBlocked()) return false;
    const operationGeneration = lifecycleGeneration;
    const deleteRequestId = requestId();
    state = { ...state, dataMutationPending: true, feedback: null };
    render();
    let response;
    try {
      response = await runtimeRequest(runtime, {
        type: "history.deleteSync",
        request_id: deleteRequestId,
        instagram_account: deletion.instagramAccount,
        run_id: deletion.runId,
        confirm: true
      });
    } catch {
      response = null;
    }
    if (operationGeneration !== lifecycleGeneration) return false;
    state = { ...state, dataMutationPending: false };
    if (!isCorrelatedResponse(response, "history.deleteSync.result", deleteRequestId) || response.deleted !== true || response.error !== null) {
      feedback("error", isCorrelatedResponse(response, "history.deleteSync.result", deleteRequestId)
        ? response.error?.message || "Unable to delete the local sync."
        : "Unable to delete the local sync.", "history");
      return false;
    }
    const refreshed = await refresh();
    if (!refreshed) return false;
    feedback("success", "Sync deleted. Local analytics recalculated.", "history");
    return true;
  }

  async function exportFile(type, format = undefined) {
    if (!state.instagramAccount || resetInFlight) {
      return false;
    }
    const operationGeneration = lifecycleGeneration;
    const exportRequestId = requestId();
    const message = format
      ? { type, request_id: exportRequestId, format }
      : { type, request_id: exportRequestId };
    let response;
    try {
      response = await runtimeRequest(runtime, message);
    } catch {
      if (operationGeneration !== lifecycleGeneration) {
        return false;
      }
      feedback("error", "Unable to create the local download.", "data-management");
      return false;
    }
    if (operationGeneration !== lifecycleGeneration) {
      return false;
    }
    const expectedType = type === "report.export" ? "report.export.result" : "backup.export.result";
    if (!isExportResponse(response, expectedType, exportRequestId)) {
      feedback("error", "Unable to create the local download.", "data-management");
      return false;
    }
    if (response.error) {
      feedback("error", response.error.message, "data-management");
      return false;
    }
    view.download({ body: response.body, filename: response.filename, mimeType: response.mime_type });
    feedback("success", "Local download created.", "data-management");
    return true;
  }

  async function openImport(file, trigger) {
    if (!file || dataMutationBlocked()) {
      return false;
    }
    const operationGeneration = lifecycleGeneration;
    let body;
    let parsed;
    try {
      body = await file.text();
      if (operationGeneration !== lifecycleGeneration || dataMutationBlocked()) {
        return false;
      }
      parsed = JSON.parse(body);
    } catch {
      if (operationGeneration !== lifecycleGeneration || dataMutationBlocked()) {
        return false;
      }
      feedback("error", "Backup schema is invalid.", "data-management");
      return false;
    }
    const validation = validateBackup(parsed);
    if (!validation.valid) {
      feedback("error", validation.message, "data-management");
      return false;
    }
    if (operationGeneration !== lifecycleGeneration || dataMutationBlocked()) {
      return false;
    }
    pendingImportBody = body;
    view.openDialog("import", trigger);
    return true;
  }

  function cancelDialog(name) {
    if (name === "import") {
      pendingImportBody = null;
    }
    if (name === "delete-sync") pendingDeletion = null;
    view.closeDialog(name);
  }

  async function confirmImport() {
    if (!pendingImportBody || dataMutationBlocked()) {
      cancelDialog("import");
      return false;
    }
    const operationGeneration = lifecycleGeneration;
    const body = pendingImportBody;
    pendingImportBody = null;
    view.closeDialog("import");
    const importRequestId = requestId();
    state = { ...state, dataMutationPending: true };
    render();
    let response;
    try {
      response = await runtimeRequest(runtime, {
        type: "backup.import",
        request_id: importRequestId,
        confirm: true,
        body
      });
    } catch {
      if (operationGeneration !== lifecycleGeneration || resetInFlight) {
        return false;
      }
      state = { ...state, dataMutationPending: false };
      feedback("error", "Unable to replace local backup data.", "data-management");
      return false;
    }
    if (operationGeneration !== lifecycleGeneration || resetInFlight) {
      return false;
    }
    state = { ...state, dataMutationPending: false };
    if (!isImportResponse(response, importRequestId)) {
      feedback("error", "Unable to replace local backup data.", "data-management");
      return false;
    }
    if (!response.imported || response.error) {
      feedback("error", response.error?.message || "Unable to replace local backup data.", "data-management");
      return false;
    }
    noticeSequence += 1;
    state = { ...state, feedback: { kind: "success", message: "Local backup imported.", id: noticeSequence } };
    const refreshed = await refresh({ preserveFeedback: true });
    view.focusTarget("data-management");
    if (!refreshed) {
      return false;
    }
    return true;
  }

  async function confirmReset() {
    if (resetInFlight) {
      return false;
    }
    view.closeDialog("reset");
    resetInFlight = true;
    lifecycleGeneration += 1;
    bufferedTerminal = null;
    state = { ...state, resetPending: true };
    render();

    async function failReset(message) {
      resetInFlight = false;
      startInFlight = false;
      stopInFlight = false;
      state = { ...state, startPending: false, recoveryPending: false, stopPending: false, focusPending: false, dataMutationPending: false, resetPending: false };
      await refresh();
      feedback("error", message, "data-management");
      return false;
    }

    const resetRequestId = requestId();
    let response;
    try {
      response = await runtimeRequest(runtime, {
        type: "history.reset",
        request_id: resetRequestId,
        confirm: true
      });
    } catch {
      return failReset("Unable to reset all local data.");
    }
    if (!isResetResponse(response, resetRequestId)) {
      return failReset(isRejectedResetResponse(response, resetRequestId)
        ? response.error.message
        : "Unable to reset all local data.");
    }

    pendingImportBody = null;
    pendingDeletion = null;
    activeRunId = null;
    startInFlight = false;
    stopInFlight = false;
    resetInFlight = false;
    recoveryAttempted = false;
    bufferedTerminal = null;
    state = createInitialDashboardState();
    feedback("success", "All local data reset.", "data-management");
    return true;
  }

  return {
    getState: () => state,
    render,
    refresh,
    handleStorageChange,
    initialize,
    startSync,
    stopSync,
    focusSync,
    openDeleteSync,
    confirmDeleteSync,
    handleRuntimeMessage,
    exportReportCsv: () => exportFile("report.export", "csv"),
    exportReportJson: () => exportFile("report.export", "json"),
    exportBackup: () => exportFile("backup.export"),
    openImport,
    cancelDialog,
    confirmImport,
    openReset: (trigger) => view.openDialog("reset", trigger),
    confirmReset
  };
}

export function bootstrapDashboard(documentRef, runtime, storage = globalThis.chrome?.storage) {
  const view = createDomView(documentRef);
  const controller = createDashboardController({ runtime, view });
  const fileInput = documentRef.querySelector("[data-import-file]");
  let reviewClicked = false;
  // Keep the prompt hidden until its saved preference is known.
  view.setReviewDismissed(true);
  async function refreshReviewPreference() {
    try {
      const saved = await storage.local.get(REVIEW_DISMISSED_KEY);
      view.setReviewDismissed(reviewClicked || saved[REVIEW_DISMISSED_KEY] === true);
    } catch { view.setReviewDismissed(reviewClicked); }
  }
  async function dismissReviewPrompt() {
    reviewClicked = true;
    view.setReviewDismissed(true);
    try { await storage.local.set({ [REVIEW_DISMISSED_KEY]: true }); }
    catch {
      // Preserve this document's dismissal even if persistence fails; keep Store navigation available.
    }
  }
  refreshReviewPreference();
  const telemetry = bindTelemetryControls(documentRef, runtime, () => controller.startSync());

  documentRef.addEventListener("click", (event) => {
    if (event.target.closest('[data-telemetry-action="review"]')) dismissReviewPrompt();
    const action = event.target.closest("[data-action]");
    if (action?.disabled) {
      return;
    }
    if (action?.dataset.action === "sync") {
      telemetry.sync().catch(() => controller.render());
    }
    if (action?.dataset.action === "stop") {
      controller.stopSync().catch(() => controller.render());
    }
    if (action?.dataset.action === "focus-sync") {
      controller.focusSync().catch(() => controller.render());
    }
    if (action?.dataset.action === "delete-sync") {
      controller.openDeleteSync(action.dataset.account, action.dataset.runId, action);
    }
    if (action?.dataset.action === "export-csv") {
      controller.exportReportCsv().catch(() => controller.render());
    }
    if (action?.dataset.action === "export-json") {
      controller.exportReportJson().catch(() => controller.render());
    }
    if (action?.dataset.action === "backup-export") {
      controller.exportBackup().catch(() => controller.render());
    }
    if (action?.dataset.action === "import-backup") {
      fileInput.click();
    }
    if (action?.dataset.action === "reset") {
      controller.openReset(action);
    }
    if (action?.dataset.action === "show-more-report") {
      expandReportList(action);
    }
    if (action?.dataset.action === "show-more-trend") {
      expandTrendList(action);
    }
  });

  fileInput.addEventListener("change", () => {
    const trigger = documentRef.querySelector('[data-action="import-backup"]');
    controller.openImport(fileInput.files?.[0], trigger).catch(() => controller.render());
    fileInput.value = "";
  });

  for (const dialog of documentRef.querySelectorAll("[data-dialog]")) {
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      controller.cancelDialog(dialog.dataset.dialog);
    });
  }

  documentRef.addEventListener("click", (event) => {
    const cancel = event.target.closest("[data-dialog-cancel]");
    if (cancel) {
      controller.cancelDialog(cancel.dataset.dialogCancel);
    }
    const confirm = event.target.closest("[data-dialog-confirm]");
    if (confirm?.dataset.dialogConfirm === "import") {
      controller.confirmImport().catch(() => controller.render());
    }
    if (confirm?.dataset.dialogConfirm === "reset") {
      controller.confirmReset().catch(() => controller.render());
    }
    if (confirm?.dataset.dialogConfirm === "delete-sync") {
      controller.confirmDeleteSync().catch(() => controller.render());
    }
  });

  const listener = (message) => {
    controller.handleRuntimeMessage(message).catch(() => controller.render());
  };
  runtime.onMessage.addListener(listener);
  storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName === "local" && changes[REVIEW_DISMISSED_KEY]) refreshReviewPreference();
    if (areaName === "local" && changes[TELEMETRY_KEY]) telemetry.refresh();
    return controller.handleStorageChange(changes, areaName).catch(() => controller.render());
  });
  controller.initialize().catch(() => {
    controller.render();
  });
  return controller;
}

if (typeof document !== "undefined" && globalThis.chrome?.runtime) {
  bootstrapDashboard(document, globalThis.chrome.runtime);
}
