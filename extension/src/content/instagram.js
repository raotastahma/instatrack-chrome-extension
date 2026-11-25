"use strict";

(() => {
  const NOTICE_ID = "instatrack-sync-notice";
  const NOTICE_TEXT = "Sync in progress. Keep this Instagram tab open and visible until it finishes.";
  const CONTENT_PROTOCOL_VERSION = 2;
  const USERNAME_PATH = /^\/([A-Za-z0-9._]+)\/?$/;
  const RESERVED_NAV_PATHS = new Set(["about", "accounts", "create", "developer", "direct", "emails", "explore", "home", "legal", "notifications", "press", "privacy", "reels", "search", "stories"]);
  const SCROLL_TICK_MS = 100;
  const QUIET_BOTTOM_SETTLE_MS = 1_000;
  const NO_PROGRESS_LIMIT_MS = 30_000;
  const STOPPED_MESSAGE = "Sync stopped by you.";
  const CANCELLED_MESSAGE = "Sync cancelled by you.";
  const CANCELLED_NOTICE_TEXT = "Sync cancelled. You may close this page.";
  const noticeObservers = new WeakMap();

  function normalizedUsername(value) {
    if (typeof value !== "string") {
      return "";
    }

    const trimmed = value.trim();
    const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
    return /^[a-z0-9._]+$/i.test(withoutAt) ? withoutAt.toLowerCase() : "";
  }

  function elements(root, selector) {
    return root?.querySelectorAll ? [...root.querySelectorAll(selector)] : [];
  }

  function attribute(element, name) {
    return element?.getAttribute?.(name) ?? "";
  }

  function isVisible(environment, element) {
    if (!element || element.hidden || attribute(element, "aria-hidden") === "true") {
      return false;
    }

    const style = environment.getComputedStyle?.(element);
    return !style || (style.display !== "none" && style.visibility !== "hidden");
  }

  function pathnameFor(environment, href) {
    try {
      return new environment.URL(href, environment.location?.href).pathname;
    } catch {
      return href;
    }
  }

  function usernameFromProfileLink(environment, link) {
    const match = pathnameFor(environment, attribute(link, "href")).match(USERNAME_PATH);
    return match ? normalizedUsername(match[1]) : "";
  }

  function isSameOriginLink(environment, link) {
    try {
      const page = new environment.URL(environment.location?.href);
      return new environment.URL(attribute(link, "href"), page).origin === page.origin;
    } catch {
      return false;
    }
  }

  function avatarNamesAccount(environment, link) {
    const account = usernameFromProfileLink(environment, link);
    if (!account) {
      return false;
    }
    const escaped = account.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const accountToken = new RegExp(`(^|[^a-z0-9._])${escaped}(?=$|[^a-z0-9._])`, "i");
    return elements(link, "img[alt]").some((image) => accountToken.test(attribute(image, "alt")));
  }

  function isOutsideMainContent(environment, link) {
    return !elements(environment.document, "main, [role=main], article, [role=dialog]").some((container) => container.contains?.(link));
  }

  function isSessionProfileLink(environment, link) {
    const label = [
      attribute(link, "aria-label"),
      attribute(link, "title"),
      ...elements(link, "[aria-label]").map((element) => attribute(element, "aria-label"))
    ].join(" ");

    return isVisible(environment, link)
      && isSameOriginLink(environment, link)
      && /\bprofile\b/i.test(label)
      && Boolean(usernameFromProfileLink(environment, link));
  }

  function findSessionProfile(environment) {
    const links = new Set(elements(environment.document, "nav a[href], [role=navigation] a[href], header nav a[href]"));
    for (const link of links) {
      if (isSessionProfileLink(environment, link)) {
        return { account: usernameFromProfileLink(environment, link), link };
      }
    }
    const localeIndependent = [...links].filter((link) => {
      const account = usernameFromProfileLink(environment, link);
      return isVisible(environment, link)
        && isSameOriginLink(environment, link)
        && account
        && !RESERVED_NAV_PATHS.has(account);
    });
    if (localeIndependent.length === 1) {
      return { account: usernameFromProfileLink(environment, localeIndependent[0]), link: localeIndependent[0] };
    }
    const outsideMain = elements(environment.document, "a[href]").filter((link) => {
      if (!isOutsideMainContent(environment, link)) return false;
      const account = usernameFromProfileLink(environment, link);
      return isVisible(environment, link)
        && account
        && !RESERVED_NAV_PATHS.has(account)
        && isSameOriginLink(environment, link)
        && avatarNamesAccount(environment, link);
    });
    if (outsideMain.length === 1) {
      return { account: usernameFromProfileLink(environment, outsideMain[0]), link: outsideMain[0] };
    }
    return null;
  }

  function isInstagramDocument(environment) {
    return environment.location?.hostname?.toLowerCase() === "www.instagram.com";
  }

  function isLoginPage(environment) {
    return elements(environment.document, "a[href], form, button, [role=button], input[name=username]").some((element) => {
      const href = attribute(element, "href");
      const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      return href.includes("accounts/login") || attribute(element, "name") === "username" || /^(log in|sign up)$/i.test(text);
    });
  }

  function currentSession(environment) {
    if (!isInstagramDocument(environment)) {
      return { state: "unavailable", instagram_account: null };
    }

    const profile = findSessionProfile(environment);
    if (profile) {
      return { state: "authenticated", instagram_account: profile.account };
    }
    return {
      state: isLoginPage(environment) ? "logged_out" : "unavailable",
      instagram_account: null
    };
  }

  function sessionResponse(environment, request) {
    const session = currentSession(environment);
    return {
      type: "instagram.session",
      request_id: request.request_id,
      state: session.state,
      instagram_account: session.instagram_account,
      protocol_version: CONTENT_PROTOCOL_VERSION
    };
  }

  function waitForSession(environment, request) {
    const response = sessionResponse(environment, request);
    if (response.state !== "unavailable") return Promise.resolve(response);
    return new Promise((resolve) => {
      const observer = new environment.MutationObserver(check);
      const timeout = environment.setTimeout(finish, 15_000);
      function finish() {
        environment.clearTimeout(timeout);
        observer.disconnect();
        environment.removeEventListener("pagehide", finish);
        resolve(sessionResponse(environment, request));
      }
      function check() {
        if (currentSession(environment).state !== "unavailable") finish();
      }
      observer.observe(environment.document.body, { childList: true, subtree: true, attributes: true });
      environment.addEventListener("pagehide", finish);
      check();
    });
  }

  function isPinnedSession(environment, instagramAccount) {
    const session = currentSession(environment);
    return session.state === "authenticated" && session.instagram_account === instagramAccount;
  }

  function requirePinnedSession(environment, instagramAccount, cancellation) {
    return waitForPage(environment, () => {
      const session = currentSession(environment);
      if (session.state === "unavailable") return false;
      if (!isPinnedSession(environment, instagramAccount)) {
        throw collectionError("COLLECTION_INTERRUPTED", "Instagram collection was interrupted because the active account changed.", "interrupted");
      }
      return true;
    }, cancellation);
  }

  function showNotice(environment, onCancel = undefined) {
    const document = environment.document;
    let notice = null;

    function placeNotice() {
      const notices = elements(document, "[data-instatrack-sync-notice]");
      const attachedNotice = notices.shift();
      notice = attachedNotice ?? notice ?? document.createElement("div");
      notices.forEach((extra) => extra.remove());

      notice.id = NOTICE_ID;
      notice.dataset.instatrackSyncNotice = "true";
      notice.setAttribute("role", "status");
      notice.setAttribute("aria-live", "polite");
      notice.style.cssText = "background:#fff4cc;color:#241a00;font:600 14px/1.4 system-ui,sans-serif;padding:12px 16px;text-align:center;position:sticky;top:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;gap:12px;";
      if (!attachedNotice) {
        const navigation = elements(document, "nav").find((element) => isVisible(environment, element));
        if (navigation?.parentNode) {
          navigation.parentNode.insertBefore(notice, navigation);
        } else {
          document.body.prepend(notice);
        }
      }
      const cancel = elements(notice, "[data-instatrack-sync-cancel]")[0];
      const hasCancel = typeof onCancel === "function";
      if (notice.dataset.instatrackSyncState !== "running" || Boolean(cancel) !== hasCancel) {
        const message = document.createElement("span");
        message.textContent = NOTICE_TEXT;
        const children = [message];
        if (hasCancel) {
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.instatrackSyncCancel = "true";
          button.textContent = "Cancel";
          button.style.cssText = "background:#241a00;color:#fff;border:0;border-radius:8px;cursor:pointer;font:700 14px/1 system-ui,sans-serif;min-height:36px;padding:0 14px;";
          button.onclick = onCancel;
          children.push(button);
        }
        notice.dataset.instatrackSyncState = "running";
        notice.replaceChildren(...children);
      } else if (cancel) {
        cancel.onclick = onCancel;
      }
      return notice;
    }

    const observer = noticeObservers.get(document);
    if (!observer && environment.MutationObserver) {
      const repair = new environment.MutationObserver(() => {
        if (!notice?.isConnected) {
          placeNotice();
        }
      });
      repair.observe(document.body, { childList: true, subtree: true });
      noticeObservers.set(document, repair);
    }
    return placeNotice();
  }

  function showCancelledNotice(environment) {
    const document = environment.document;
    noticeObservers.get(document)?.disconnect();
    noticeObservers.delete(document);
    const notice = elements(document, "[data-instatrack-sync-notice]")[0];
    if (!notice) {
      return;
    }
    const message = document.createElement("span");
    message.textContent = CANCELLED_NOTICE_TEXT;
    notice.dataset.instatrackSyncState = "cancelled";
    notice.replaceChildren(message);
  }

  function removeNotice(environment) {
    noticeObservers.get(environment.document)?.disconnect();
    noticeObservers.delete(environment.document);
    elements(environment.document, "[data-instatrack-sync-notice]").forEach((notice) => notice.remove());
  }

  function collectionError(code, message, state = "failed") {
    const error = new Error(message);
    error.code = code;
    error.state = state;
    return error;
  }

  function createCancellationToken() {
    let reason = null;
    const listeners = new Set();

    return {
      cancel(cause) {
        if (reason) {
          return;
        }
        reason = cause;
        [...listeners].forEach((listener) => listener(reason));
        listeners.clear();
      },
      throwIfCancelled() {
        if (reason) {
          throw reason;
        }
      },
      subscribe(listener) {
        if (reason) {
          listener(reason);
          return () => {};
        }
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };
  }

  function waitForPage(environment, ready, cancellation, action = undefined) {
    cancellation?.throwIfCancelled();
    if (!action && !environment.document.hidden && ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let finished = false;
      let timer = null;
      let waitingMs = 0;
      let unsubscribe = () => {};
      const observer = new environment.MutationObserver(check);
      function finish(cause) {
        if (finished) return;
        finished = true;
        environment.clearTimeout(timer);
        observer.disconnect();
        environment.document.removeEventListener?.("visibilitychange", check);
        unsubscribe();
        cause ? reject(cause) : resolve();
      }
      function check() {
        if (finished || environment.document.hidden) return;
        try {
          cancellation?.throwIfCancelled();
          if (ready()) finish();
        } catch (cause) { finish(cause); }
      }
      function tick() {
        if (!environment.document.hidden) waitingMs += 250;
        check();
        if (finished) return;
        if (waitingMs >= 15_000) {
          finish(collectionError("COLLECTION_FAILED", "Instagram did not become ready. Check the tab and retry."));
          return;
        }
        timer = environment.setTimeout(tick, 250);
      }
      observer.observe(environment.document.body, { childList: true, subtree: true, attributes: true });
      environment.document.addEventListener?.("visibilitychange", check);
      unsubscribe = cancellation?.subscribe(finish) ?? unsubscribe;
      if (!finished) {
        try { action?.(); check(); } catch (cause) { finish(cause); }
      }
      if (!finished) timer = environment.setTimeout(tick, 250);
    });
  }

  function dialogCloseControl(environment, dialog) {
    const heading = elements(dialog, "h1, h2, h3, [role=heading]")[0];
    for (let header = heading?.parentElement; header && header !== dialog; header = header.parentElement) {
      const buttons = elements(header, "button, [role=button]").filter((button) => isVisible(environment, button));
      if (buttons.length === 1 && elements(buttons[0], "svg").length && !elements(header, "a[href]").length) {
        return buttons[0];
      }
    }
    return elements(dialog, "button, [role=button]").find((element) => {
      const label = [
        attribute(element, "aria-label"),
        attribute(element, "title"),
        element.innerText ?? element.textContent ?? "",
        ...elements(element, "[aria-label], [title]").flatMap((nested) => [attribute(nested, "aria-label"), attribute(nested, "title")])
      ].join(" ");
      return typeof element.click === "function" && /close|dismiss/i.test(label);
    }) ?? null;
  }

  function dismissCurrentDialog(environment) {
    const dialog = currentDialog(environment);
    const close = dialog && dialogCloseControl(environment, dialog);
    close?.click();
  }

  function relationshipControl(environment, kind, instagramAccount) {
    const controls = elements(environment.document, "a[href], button, [role=button]");
    const direct = controls.find((element) => isVisible(environment, element) && (instagramAccount
      ? pathnameFor(environment, attribute(element, "href")) === `/${instagramAccount}/${kind}/`
      : pathnameFor(environment, attribute(element, "href")).endsWith(`/${kind}/`)));
    if (direct) return direct;
    const onAccountProfile = pathnameFor(environment, environment.location?.href) === `/${instagramAccount}/`;
    if (onAccountProfile) {
      const rows = elements(environment.document, "main header, [role=main] header")
        .filter((header) => isVisible(environment, header))
        .flatMap((header) => elements(header, "*"))
        .filter((row) => isVisible(environment, row) && row.children?.length === 3)
        .map((row) => [...row.children].map((cell) => isVisible(environment, cell) ? elements(cell, "a[href], button, [role=button]").filter((control) => isVisible(environment, control)) : []))
        .filter(([posts, followers, following]) => posts.length === 0 && [followers, following].every((cell) => cell.length === 1
          && attribute(cell[0], "href") === "#"
          && elements(cell[0], "span").some((span) => !span.children.length && /\p{N}/u.test(span.textContent ?? ""))));
      if (rows.length === 1) return rows[0][kind === "followers" ? 1 : 2][0];
    }
    return controls.find((element) => {
      if (!isVisible(environment, element)) {
        return false;
      }
      const href = pathnameFor(environment, attribute(element, "href"));
      const text = `${element.innerText ?? element.textContent ?? ""}`.replace(/\s+/g, " ").trim().toLowerCase();
      const textMatches = text === kind || text.endsWith(` ${kind}`);
      if (!instagramAccount) {
        return href.endsWith(`/${kind}/`) || textMatches;
      }
      return href === `/${instagramAccount}/${kind}/` || (onAccountProfile && textMatches);
    });
  }

  function currentDialog(environment) {
    return elements(environment.document, "div[role=dialog]").find((dialog) => isVisible(environment, dialog)) ?? null;
  }

  function scrollContainer(environment, dialog) {
    const scroller = [dialog, ...elements(dialog, "*")]
      .filter((element) => Number.isFinite(element.scrollHeight) && Number.isFinite(element.clientHeight) && element.scrollHeight > element.clientHeight)
      .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))
      .find((element) => {
        const overflowY = environment.getComputedStyle?.(element)?.overflowY ?? "auto";
        return overflowY === "auto" || overflowY === "scroll";
      });
    return scroller ?? dialog;
  }

  function usernamesInDialog(environment, dialog) {
    const usernames = new Set();
    elements(dialog, "a[href]").forEach((link) => {
      const match = pathnameFor(environment, attribute(link, "href")).match(USERNAME_PATH);
      const username = match ? normalizedUsername(match[1]) : "";
      if (username) {
        usernames.add(username);
      }
    });
    return usernames;
  }

  function hasLoader(dialog) {
    return elements(dialog, "[role=progressbar], [aria-busy=true], svg[aria-label]").some((element) => {
      const label = attribute(element, "aria-label");
      return attribute(element, "role") === "progressbar" || attribute(element, "aria-busy") === "true" || /load|progress/i.test(label)
        || (attribute(element, "viewBox") === "0 0 100 100" && elements(element, "rect[transform]").length === 12);
    });
  }

  function isAtBottom(container) {
    if (!Number.isFinite(container.scrollHeight) || !Number.isFinite(container.clientHeight)) {
      return true;
    }
    return container.scrollTop + container.clientHeight >= container.scrollHeight;
  }

  function hasEndOfList(dialog) {
    return elements(dialog, "[role=status], div, span").some((element) => /^(end of list|no more accounts)$/i.test(`${element.textContent ?? ""}`.trim()));
  }

  function profileStatsReady(environment, instagramAccount) {
    return Boolean(
      relationshipControl(environment, "followers", instagramAccount) &&
      relationshipControl(environment, "following", instagramAccount)
    );
  }

  async function openOwnProfile(environment, profile, cancellation = undefined) {
    await waitForPage(environment, () => true, cancellation);
    if (profileStatsReady(environment, profile.account)) return;
    return waitForPage(environment, () => {
      if (!isInstagramDocument(environment)) {
        throw collectionError("COLLECTION_INTERRUPTED", "Instagram collection was interrupted before both lists completed.", "interrupted");
      }
      const session = currentSession(environment);
      if (session.state === "logged_out" || (session.state === "authenticated" && session.instagram_account !== profile.account)) {
        throw collectionError("COLLECTION_INTERRUPTED", "Instagram collection was interrupted because the active account changed.", "interrupted");
      }
      return profileStatsReady(environment, profile.account);
    }, cancellation, () => profile.link.click());
  }

  async function closeDialog(environment, cancellation = undefined) {
    await waitForPage(environment, () => true, cancellation);
    const dialog = currentDialog(environment);
    if (!dialog) return;
    const close = dialogCloseControl(environment, dialog);
    if (!close) throw collectionError("COLLECTION_FAILED", "Instagram followers list cannot be closed.");
    return waitForPage(environment, () => !currentDialog(environment), cancellation, () => close.click());
  }

  async function collectRelationship(environment, kind, instagramAccount, cancellation = undefined) {
    await requirePinnedSession(environment, instagramAccount, cancellation);
    const control = relationshipControl(environment, kind, instagramAccount);
    if (!control) throw collectionError("COLLECTION_FAILED", `Instagram ${kind} control is unavailable.`);

    return new Promise((resolve, reject) => {
      let finished = false;
      let dialogObserved = false;
      let timer = null;
      let signature = null;
      let lastProgressAt = environment.performance.now();
      let quietSince = null;
      let tailProbed = false;
      let unsubscribe = () => {};
      const observer = new environment.MutationObserver(() => inspect());

      function finish(cause) {
        if (finished) return;
        finished = true;
        environment.clearTimeout(timer);
        observer.disconnect();
        environment.document.removeEventListener?.("visibilitychange", visibilityChanged);
        unsubscribe();
        cause ? reject(cause) : resolve([...usernamesInDialog(environment, currentDialog(environment))].sort());
      }

      function schedule() {
        if (finished || environment.document.hidden || timer !== null) return;
        timer = environment.setTimeout(() => {
          timer = null;
          inspect();
          schedule();
        }, SCROLL_TICK_MS);
      }

      function visibilityChanged() {
        environment.clearTimeout(timer);
        timer = null;
        // A hidden page cannot establish a quiet tail or consume the loading timeout.
        quietSince = null;
        lastProgressAt = environment.performance.now();
        tailProbed = false;
        if (!environment.document.hidden) { inspect(); schedule(); }
      }

      function inspect() {
        if (finished || environment.document.hidden) return;
        try {
          cancellation?.throwIfCancelled();
          if (!isInstagramDocument(environment)) {
            throw collectionError("COLLECTION_INTERRUPTED", "Instagram collection was interrupted before both lists completed.", "interrupted");
          }
          const session = currentSession(environment);
          if (session.state === "logged_out" || (session.state === "authenticated" && session.instagram_account !== instagramAccount)) {
            throw collectionError("COLLECTION_INTERRUPTED", "Instagram collection was interrupted because the active account changed.", "interrupted");
          }
          const dialog = currentDialog(environment);
          if (!dialog && dialogObserved) {
            throw collectionError("COLLECTION_INTERRUPTED", "Instagram collection was interrupted before both lists completed.", "interrupted");
          }
          if (session.state !== "unavailable" && dialog) {
            dialogObserved = true;
            const container = scrollContainer(environment, dialog);
            if (!container) throw collectionError("COLLECTION_FAILED", `Instagram ${kind} list cannot be read.`);
            const observed = `${container.scrollHeight}:${container.scrollTop}:${elements(dialog, "a[href]").length}`;
            if (observed !== signature) {
              signature = observed;
              lastProgressAt = environment.performance.now();
              quietSince = null;
              tailProbed = false;
            }

            const loading = hasLoader(dialog);
            if (!loading && hasEndOfList(dialog)) { finish(); return; }
            if (!isAtBottom(container)) {
              quietSince = null;
              // shortcut: the final read requires retained DOM rows; use overlapping steps with accumulation for virtualized lists.
              container.scrollTop = container.scrollHeight;
            } else if (loading) {
              quietSince = null;
              tailProbed = false;
            } else if (!tailProbed) {
              tailProbed = true;
              // Re-trigger the current tail, then wait once for loading to settle.
              const bottom = Math.max(0, container.scrollHeight - container.clientHeight);
              container.scrollTop = Math.max(0, bottom - 1);
              container.scrollTop = bottom;
              container.dispatchEvent?.(new environment.Event("scroll", { bubbles: true }));
              signature = `${container.scrollHeight}:${container.scrollTop}:${elements(dialog, "a[href]").length}`;
              quietSince = environment.performance.now();
            } else if (quietSince !== null && environment.performance.now() - quietSince >= QUIET_BOTTOM_SETTLE_MS) {
              finish(); return;
            }
          }
          if (environment.performance.now() - lastProgressAt >= NO_PROGRESS_LIMIT_MS) {
            throw collectionError("COLLECTION_FAILED", "Instagram stopped loading the list. Previous analytics were kept. Retry sync.");
          }
        } catch (cause) { finish(cause); }
      }

      observer.observe(environment.document.body, { childList: true, subtree: true, attributes: true });
      environment.document.addEventListener?.("visibilitychange", visibilityChanged);
      unsubscribe = cancellation?.subscribe(finish) ?? unsubscribe;
      if (!finished) { control.click(); inspect(); schedule(); }
    });
  }

  function result(runId, state, instagramAccount, followers, following, error) {
    return {
      type: "instagram.collectRelationships.result",
      run_id: runId,
      state,
      instagram_account: instagramAccount,
      followers,
      following,
      error
    };
  }

  function sendProgress(environment, runId, stage, paused = undefined) {
    const sendMessage = environment.chrome?.runtime?.sendMessage;
    if (typeof sendMessage !== "function") {
      return Promise.resolve(false);
    }
    try {
      return Promise.resolve(sendMessage({ type: "instagram.collectionProgress", run_id: runId, stage,
        ...(paused === undefined ? {} : { paused }) })).then((response) => (
        Boolean(
          response &&
          Object.keys(response).length === 3 &&
          response.type === "instagram.collectionProgress.ack" &&
          response.run_id === runId &&
          response.accepted === true
        )
      ), () => false);
    } catch {
      return Promise.resolve(false);
    }
  }

  function createInstagramCollector(environment = globalThis) {
    let inFlight = null;
    let activeRun = null;
    let terminalRetry = null;

    async function runCollection(request, onStage = undefined, cancellation = createCancellationToken()) {
      let cancelled = false;
      let stage = "preflight";
      let listening = false;
      let visibilityPending = Promise.resolve();
      function visibilityChanged() {
        if (!listening) return;
        const paused = Boolean(environment.document.hidden);
        const observedStage = stage;
        visibilityPending = visibilityPending.then(async () => {
          if (!listening) return;
          if (!await sendProgress(environment, request.run_id, observedStage, paused)) {
            cancellation.cancel(collectionError("STORAGE_ERROR", "Unable to update local extension storage."));
          }
        });
      }
      async function advance(nextStage) {
        await visibilityPending;
        cancellation.throwIfCancelled();
        stage = nextStage;
        onStage?.(stage);
        if (!await sendProgress(environment, request.run_id, stage)) {
          throw collectionError("STORAGE_ERROR", "Unable to update local extension storage.");
        }
      }
      showNotice(environment, cancellation ? () => {
        if (cancelled) {
          return;
        }
        cancelled = true;
        cancellation.cancel(collectionError("COLLECTION_INTERRUPTED", CANCELLED_MESSAGE, "interrupted"));
        dismissCurrentDialog(environment);
        showCancelledNotice(environment);
      } : undefined);
      try {
        cancellation?.throwIfCancelled();
        if (!request || Object.keys(request).length !== 2 || request.type !== "instagram.collectRelationships" || typeof request.run_id !== "string" || !request.run_id) {
          return result(request?.run_id ?? null, "failed", null, null, null, { code: "COLLECTION_FAILED", message: "Instagram collection request is invalid." });
        }
        if (!isInstagramDocument(environment)) {
          return result(request.run_id, "failed", null, null, null, { code: "NOT_INSTAGRAM", message: "Open Instagram before starting sync." });
        }

        listening = true;
        environment.document.addEventListener?.("visibilitychange", visibilityChanged);
        if (environment.document.hidden) visibilityChanged();
        await waitForPage(environment, () => true, cancellation);
        await visibilityPending;

        const initialSession = currentSession(environment);
        if (initialSession.state !== "authenticated") {
          const code = initialSession.state === "logged_out" ? "NOT_LOGGED_IN" : "CURRENT_ACCOUNT_UNAVAILABLE";
          const message = code === "NOT_LOGGED_IN" ? "Open Instagram in a tab, sign in, and retry" : "The active Instagram account is unavailable.";
          return result(request.run_id, "failed", null, null, null, { code, message });
        }
        const profile = findSessionProfile(environment);
        if (!profile || profile.account !== initialSession.instagram_account) {
          return result(request.run_id, "failed", null, null, null, { code: "CURRENT_ACCOUNT_UNAVAILABLE", message: "The active Instagram account is unavailable." });
        }

        await openOwnProfile(environment, profile, cancellation);
        cancellation?.throwIfCancelled();
        await requirePinnedSession(environment, initialSession.instagram_account, cancellation);
        await advance("collecting_followers");
        cancellation?.throwIfCancelled();
        await requirePinnedSession(environment, initialSession.instagram_account, cancellation);
        const followers = await collectRelationship(environment, "followers", initialSession.instagram_account, cancellation);
        await closeDialog(environment, cancellation);
        cancellation?.throwIfCancelled();
        await requirePinnedSession(environment, initialSession.instagram_account, cancellation);
        await advance("collecting_following");
        cancellation?.throwIfCancelled();
        await requirePinnedSession(environment, initialSession.instagram_account, cancellation);
        const following = await collectRelationship(environment, "following", initialSession.instagram_account, cancellation);
        await closeDialog(environment, cancellation);
        cancellation?.throwIfCancelled();
        for (;;) {
          await requirePinnedSession(environment, initialSession.instagram_account, cancellation);
          const pending = visibilityPending;
          await pending;
          cancellation.throwIfCancelled();
          if (!environment.document.hidden && pending === visibilityPending) break;
        }
        return result(request.run_id, "completed", initialSession.instagram_account, followers, following, null);
      } catch (cause) {
        const state = cause?.state === "interrupted" ? "interrupted" : "failed";
        const code = cause?.code ?? (state === "interrupted" ? "COLLECTION_INTERRUPTED" : "COLLECTION_FAILED");
        const message = cause?.message ?? "Sync failed before both followers and following were collected.";
        return result(request?.run_id ?? null, state, null, null, null, { code, message });
      } finally {
        listening = false;
        environment.document.removeEventListener?.("visibilitychange", visibilityChanged);
        if (!cancelled) {
          removeNotice(environment);
        }
      }
    }

    function collectRelationships(request) {
      if (inFlight) {
        return inFlight;
      }
      inFlight = runCollection(request).finally(() => {
        inFlight = null;
      });
      return inFlight;
    }

    function accepted(runId, state) {
      return {
        type: "instagram.collectRelationships.accepted",
        run_id: runId,
        state,
        protocol_version: CONTENT_PROTOCOL_VERSION
      };
    }

    function stopped(runId, didStop) {
      return {
        type: "instagram.collectRelationships.stop.result",
        run_id: runId,
        stopped: didStop,
        protocol_version: CONTENT_PROTOCOL_VERSION
      };
    }

    function inspect() {
      if (!activeRun) {
        return {
          type: "instagram.collectRelationships.inspect.result",
          state: "idle",
          run_id: null,
          request_id: null,
          started_at: null,
          stage: null,
          protocol_version: CONTENT_PROTOCOL_VERSION
        };
      }
      return {
        type: "instagram.collectRelationships.inspect.result",
        state: activeRun.state,
        run_id: activeRun.runId,
        request_id: activeRun.requestId,
        started_at: activeRun.startedAt,
        stage: activeRun.stage,
        protocol_version: CONTENT_PROTOCOL_VERSION
      };
    }

    function acknowledge(response, run) {
      return Boolean(
        response &&
        Object.keys(response).length === 3 &&
        response.type === "instagram.collectionTerminal.ack" &&
        response.run_id === run.runId &&
        response.accepted === true
      );
    }

    function deliverTerminal(run) {
      if (activeRun !== run || run.state !== "terminal_pending") {
        return;
      }
      const message = {
        type: "instagram.collectionTerminal",
        run_id: run.runId,
        request_id: run.requestId,
        result: run.result
      };
      let sent;
      try {
        sent = environment.chrome?.runtime?.sendMessage?.(message);
      } catch {
        sent = Promise.reject();
      }
      Promise.resolve(sent).then((response) => {
        if (acknowledge(response, run) && activeRun === run) {
          activeRun = null;
          terminalRetry = null;
          return;
        }
        if (activeRun === run) {
          terminalRetry = environment.setTimeout?.(() => deliverTerminal(run), 1_000);
        }
      }, () => {
        if (activeRun === run) {
          terminalRetry = environment.setTimeout?.(() => deliverTerminal(run), 1_000);
        }
      });
    }

    function start(request) {
      if (
        !request ||
        Object.keys(request).length !== 5 ||
        request.type !== "instagram.collectRelationships.start" ||
        request.protocol_version !== CONTENT_PROTOCOL_VERSION ||
        typeof request.run_id !== "string" ||
        !request.run_id ||
        typeof request.request_id !== "string" ||
        !request.request_id ||
        !request.started_at
      ) {
        return Promise.resolve(accepted(request?.run_id ?? null, "unsupported_protocol"));
      }
      if (activeRun) {
        return Promise.resolve(accepted(activeRun.runId, activeRun.state === "terminal_pending" ? "terminal_pending" : "already_running"));
      }

      const run = {
        runId: request.run_id,
        requestId: request.request_id,
        startedAt: request.started_at,
        stage: "preflight",
        state: "running",
        result: null,
        cancellation: createCancellationToken()
      };
      activeRun = run;
      inFlight = runCollection(
        { type: "instagram.collectRelationships", run_id: run.runId },
        (stage) => {
          if (activeRun === run) {
            run.stage = stage;
          }
        },
        run.cancellation
      ).then((terminalResult) => {
        if (activeRun === run) {
          run.result = terminalResult;
          run.state = "terminal_pending";
          deliverTerminal(run);
        }
        return terminalResult;
      }).finally(() => {
        inFlight = null;
      });
      return Promise.resolve(accepted(run.runId, "started"));
    }

    function stop(request) {
      if (
        !request ||
        Object.keys(request).length !== 3 ||
        request.type !== "instagram.collectRelationships.stop" ||
        request.protocol_version !== CONTENT_PROTOCOL_VERSION ||
        typeof request.run_id !== "string" ||
        !request.run_id
      ) {
        return Promise.resolve(stopped(request?.run_id ?? null, false));
      }
      if (!activeRun || activeRun.runId !== request.run_id) {
        return Promise.resolve(stopped(request.run_id, false));
      }

      const run = activeRun;
      activeRun = null;
      environment.clearTimeout?.(terminalRetry);
      terminalRetry = null;
      run.result = null;
      run.cancellation.cancel(collectionError("COLLECTION_INTERRUPTED", STOPPED_MESSAGE, "interrupted"));
      dismissCurrentDialog(environment);
      removeNotice(environment);
      return Promise.resolve(stopped(run.runId, true));
    }

    return { collectRelationships, inspect, start, stop };
  }

  globalThis.InstatrackContent = {
    createInstagramCollector
  };

  if (globalThis.chrome?.runtime?.onMessage) {
    const collector = createInstagramCollector(globalThis);
    globalThis.chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (
        message?.type === "instagram.session.get" &&
        Object.keys(message).length === 3 &&
        typeof message.request_id === "string" &&
        message.request_id &&
        message.protocol_version === CONTENT_PROTOCOL_VERSION
      ) {
        waitForSession(globalThis, message).then(sendResponse);
        return true;
      }
      if (message?.type === "instagram.collectRelationships.start") {
        collector.start(message).then(sendResponse);
        return true;
      }
      if (message?.type === "instagram.collectRelationships.inspect") {
        sendResponse(collector.inspect());
        return undefined;
      }
      if (message?.type === "instagram.collectRelationships.stop") {
        collector.stop(message).then(sendResponse);
        return true;
      }
      return undefined;
    });
  }
})();
