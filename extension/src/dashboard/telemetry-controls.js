import { TELEMETRY_ACTIONS } from "../shared/telemetry-contract.js";

export function createTelemetryControls({ runtime, view, startSync, requestId = () => crypto.randomUUID() }) {
  let busy = false;
  let state = { consent: "unknown", enabled: false, incognito: false };

  async function request(type, values = {}) {
    const id = requestId();
    const response = await runtime.sendMessage({ type, request_id: id, ...values });
    if (response?.request_id !== id || response.error) throw new Error("Analytics settings unavailable.");
    return response;
  }

  async function refresh() {
    try {
      state = await request("telemetry.getState");
      view.render(state);
    } catch { view.error(); }
    return state;
  }

  function record(name, params = {}) {
    if (!state.enabled) return Promise.resolve(false);
    return request("telemetry.record", { event: { name, params } }).catch(() => false);
  }

  async function sync() {
    if (busy) return;
    busy = true;
    try {
      await refresh();
      record("sync_click");
      await startSync();
    } finally { busy = false; }
  }

  async function choose(enabled) {
    if (busy) return;
    busy = true;
    try {
      state = await request("telemetry.setConsent", { enabled });
      view.render(state);
      view.close();
      if (state.enabled) record("button_click", { action: "analytics-enable" });
    } catch {
      view.error();
      view.close();
    } finally { busy = false; }
  }

  return { refresh, sync, choose, record,
    async initialize() {
      await refresh();
      if (!state.incognito && state.consent === "unknown") view.open();
    },
    dismiss() { view.close(); },
    recordAction(action) {
      if (TELEMETRY_ACTIONS.includes(action)) record("button_click", { action });
    },
    change() {
      if (state.enabled) return choose(false);
      view.open();
    }
  };
}

export function bindTelemetryControls(documentRef, runtime, startSync) {
  const dialog = documentRef.querySelector("[data-analytics-dialog]");
  const toggle = documentRef.querySelector("[data-analytics-toggle]");
  const label = documentRef.querySelector("[data-analytics-status]");
  const reviewPanel = documentRef.querySelector("[data-review-panel]");
  let dashboardRecorded = false;
  let reviewRecorded = false;
  let reviewVisible = false;
  let measurementEnabled = false;

  function trackViews() {
    if (!measurementEnabled || documentRef.visibilityState === "hidden" || documentRef.querySelector("dialog[open]")) return;
    if (!dashboardRecorded) {
      dashboardRecorded = true;
      controls.record("dashboard_open").then((result) => { if (!result?.accepted) dashboardRecorded = false; });
    }
    if (!reviewRecorded && reviewVisible && !reviewPanel.hidden) {
      reviewRecorded = true;
      controls.record("review_impression").then((result) => { if (!result?.accepted) reviewRecorded = false; });
    }
  }
  const controls = createTelemetryControls({ runtime, startSync, view: {
    open() { if (!dialog.open) dialog.showModal(); },
    close() { dialog.close(); trackViews(); },
    render(state) {
      measurementEnabled = state.enabled;
      label.textContent = state.incognito ? "Usage analytics is disabled in Incognito."
        : `Optional usage analytics: ${state.enabled ? "on" : "off"}.`;
      toggle.hidden = state.incognito;
      toggle.textContent = state.enabled ? "Turn off analytics" : "Manage analytics";
      if (state.enabled) trackViews();
    },
    error() { label.textContent = "Unable to update analytics settings. Sync is still available."; }
  } });
  const observer = new documentRef.defaultView.IntersectionObserver(([entry]) => {
    reviewVisible = entry.isIntersecting && entry.intersectionRatio >= 0.5;
    trackViews();
  }, { threshold: 0.5 });
  observer.observe(reviewPanel);
  documentRef.addEventListener("visibilitychange", trackViews);
  toggle.addEventListener("click", () => controls.change());
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); controls.dismiss(); });
  documentRef.addEventListener("click", (event) => {
    const choice = event.target.closest("[data-analytics-choice]");
    if (choice) controls.choose(choice.dataset.analyticsChoice === "allow");
    const action = event.target.closest("[data-action], [data-dialog-confirm], [data-dialog-cancel], [data-telemetry-action]");
    if (!action || action.disabled) return;
    const name = action.dataset.telemetryAction ?? action.dataset.action
      ?? (action.dataset.dialogConfirm ? `confirm-${action.dataset.dialogConfirm}` : `cancel-${action.dataset.dialogCancel}`);
    if (name === "review") controls.record("review_click");
    else controls.recordAction(name);
  });
  controls.initialize();
  return controls;
}
