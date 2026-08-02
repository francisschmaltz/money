(() => {
  const root = document.documentElement;
  const endpoint = "/api/v1/me/appearance";
  const channelName = "money.appearance.v1";
  const validAppearances = new Set(["system", "light", "dark"]);
  const staleAfterMs = 30_000;
  const reconcileThrottleMs = 5_000;
  const systemPreference = window.matchMedia(
    "(prefers-color-scheme: dark)",
  );

  const normalize = (value) =>
    validAppearances.has(value) ? value : "system";
  const resolve = (appearance) =>
    appearance === "system"
      ? systemPreference.matches
        ? "dark"
        : "light"
      : appearance;

  let selectedAppearance = normalize(root.dataset.appearance);
  let resolvedTheme = resolve(selectedAppearance);
  let committedAppearance = selectedAppearance;
  let saveInFlight = false;
  let reconcileAfterSave = false;
  let reconcileInFlight = null;
  let reconcileQueued = false;
  let reconcileGeneration = 0;
  let mutationGeneration = 0;
  let hiddenAt = document.hidden ? Date.now() : null;
  let lastReconciledAt = 0;
  let printing = false;
  let picker = null;
  let options = [];
  let status = null;
  let channel = null;

  const themeColor = (theme) => {
    const fallback = theme === "dark" ? "#111111" : "#f7f7f7";
    if (
      !document.body ||
      typeof window.getComputedStyle !== "function"
    ) {
      return fallback;
    }
    return window.getComputedStyle(document.body).backgroundColor || fallback;
  };

  const updateMetadata = (theme) => {
    root.style.colorScheme = theme;
    const colorScheme = document.querySelector(
      'meta[name="color-scheme"]',
    );
    colorScheme?.setAttribute("content", theme);
    document
      .querySelectorAll('meta[name="theme-color"]')
      .forEach((browserTheme) => {
        browserTheme.removeAttribute("media");
        browserTheme.setAttribute("content", themeColor(theme));
      });
  };

  const dispatchThemeChange = () => {
    window.dispatchEvent(
      new CustomEvent("money:themechange", {
        detail: {
          appearance: selectedAppearance,
          resolvedTheme,
        },
      }),
    );
  };

  const syncPicker = () => {
    for (const option of options) {
      option.checked = option.value === selectedAppearance;
    }
  };

  const setStatus = (message = "") => {
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
  };

  const setBusy = (busy) => {
    if (busy) picker?.setAttribute("aria-busy", "true");
    else picker?.removeAttribute("aria-busy");
    for (const option of options) option.disabled = busy;
  };

  const applyAppearance = (appearance, { forceEvent = false } = {}) => {
    const nextAppearance = normalize(appearance);
    const nextTheme = printing ? "light" : resolve(nextAppearance);
    const changed =
      nextAppearance !== selectedAppearance || nextTheme !== resolvedTheme;
    selectedAppearance = nextAppearance;
    resolvedTheme = nextTheme;
    root.dataset.appearance = selectedAppearance;
    root.dataset.resolvedTheme = resolvedTheme;
    updateMetadata(resolvedTheme);
    syncPicker();
    if (changed || forceEvent) dispatchThemeChange();
    return selectedAppearance;
  };

  const responseAppearance = async (response) => {
    if (!response.ok) throw new Error("Appearance request failed.");
    const payload = await response.json();
    if (!validAppearances.has(payload?.appearance)) {
      throw new Error("Appearance response was invalid.");
    }
    return payload.appearance;
  };

  const csrfToken = () =>
    document.querySelector('meta[name="csrf-token"]')?.content || "";

  const reconcile = async ({ force = false } = {}) => {
    if (!picker) return selectedAppearance;
    if (saveInFlight) {
      reconcileAfterSave = true;
      return selectedAppearance;
    }
    const now = Date.now();
    if (!force && now - lastReconciledAt < reconcileThrottleMs) {
      return selectedAppearance;
    }
    if (reconcileInFlight) {
      if (force) {
        reconcileGeneration += 1;
        reconcileQueued = true;
      }
      return reconcileInFlight;
    }
    lastReconciledAt = now;
    const requestGeneration = ++reconcileGeneration;
    const requestMutationGeneration = mutationGeneration;
    const request = (async () => {
      try {
        const response = await fetch(endpoint, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        const appearance = await responseAppearance(response);
        if (
          requestGeneration !== reconcileGeneration ||
          requestMutationGeneration !== mutationGeneration ||
          saveInFlight
        ) {
          return selectedAppearance;
        }
        committedAppearance = appearance;
        applyAppearance(appearance);
        setStatus();
        return appearance;
      } catch {
        return selectedAppearance;
      }
    })();
    reconcileInFlight = request;
    const finishRequest = () => {
      if (reconcileInFlight !== request) return;
      reconcileInFlight = null;
      if (reconcileQueued) {
        reconcileQueued = false;
        if (saveInFlight) reconcileAfterSave = true;
        else void reconcile({ force: true });
      }
    };
    void request.then(finishRequest, finishRequest);
    return request;
  };

  const saveAppearance = async (
    appearance,
    { restoreFocus = false } = {},
  ) => {
    if (!validAppearances.has(appearance)) {
      throw new TypeError("Appearance must be system, light, or dark.");
    }
    if (!picker || saveInFlight) return selectedAppearance;

    const previousAppearance = committedAppearance;
    mutationGeneration += 1;
    if (reconcileInFlight) reconcileAfterSave = true;
    saveInFlight = true;
    setStatus();
    setBusy(true);
    applyAppearance(appearance);

    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        credentials: "same-origin",
        keepalive: true,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken(),
        },
        body: JSON.stringify({ appearance }),
      });
      const savedAppearance = await responseAppearance(response);
      committedAppearance = savedAppearance;
      applyAppearance(savedAppearance);
      channel?.postMessage({ appearance: savedAppearance });
      return savedAppearance;
    } catch (error) {
      committedAppearance = previousAppearance;
      applyAppearance(previousAppearance);
      setStatus("Appearance couldn’t be saved. Try again.");
      throw error;
    } finally {
      saveInFlight = false;
      setBusy(false);
      if (restoreFocus) {
        options
          .find((option) => option.checked)
          ?.focus({ preventScroll: true });
      }
      if (reconcileAfterSave) {
        reconcileAfterSave = false;
        void reconcile({ force: true });
      }
    }
  };

  const subscribe = (listener) => {
    if (typeof listener !== "function") return () => {};
    const wrapped = (event) => listener(event.detail);
    window.addEventListener("money:themechange", wrapped);
    return () => window.removeEventListener("money:themechange", wrapped);
  };

  const api = {
    isValid: (appearance) => validAppearances.has(appearance),
    refresh: () => reconcile({ force: true }),
    set: saveAppearance,
    subscribe,
  };
  Object.defineProperties(api, {
    appearance: { get: () => selectedAppearance },
    selected: { get: () => selectedAppearance },
    resolved: { get: () => resolvedTheme },
    resolvedTheme: { get: () => resolvedTheme },
  });
  window.moneyAppearance = Object.freeze(api);

  applyAppearance(selectedAppearance, { forceEvent: true });

  const handleSystemPreference = () => {
    if (selectedAppearance === "system") applyAppearance("system");
  };
  if (typeof systemPreference.addEventListener === "function") {
    systemPreference.addEventListener("change", handleSystemPreference);
  } else {
    systemPreference.addListener?.(handleSystemPreference);
  }

  window.addEventListener("beforeprint", () => {
    printing = true;
    applyAppearance(selectedAppearance, { forceEvent: true });
  });
  window.addEventListener("afterprint", () => {
    printing = false;
    applyAppearance(selectedAppearance, { forceEvent: true });
  });

  const initializePicker = () => {
    picker = document.querySelector("[data-appearance-picker]");
    if (!picker) return;
    options = [
      ...picker.querySelectorAll("[data-appearance-option]"),
    ].filter((option) => validAppearances.has(option.value));
    status = picker.querySelector("[data-appearance-status]");
    status?.setAttribute("aria-live", "polite");
    syncPicker();

    const keyboardSelectionKeys = new Set([
      " ",
      "Spacebar",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
    ]);
    let keyboardSelectionPending = false;
    window.addEventListener(
      "pointerdown",
      () => {
        keyboardSelectionPending = false;
      },
      { capture: true },
    );
    for (const option of options) {
      option.addEventListener("keydown", (event) => {
        keyboardSelectionPending = keyboardSelectionKeys.has(event.key);
      });
      option.addEventListener("change", () => {
        if (!option.checked || saveInFlight) return;
        const restoreFocus = keyboardSelectionPending;
        keyboardSelectionPending = false;
        void saveAppearance(option.value, { restoreFocus }).catch(() => {});
      });
    }

    if (typeof window.BroadcastChannel === "function") {
      channel = new window.BroadcastChannel(channelName);
      channel.addEventListener("message", () => {
        void reconcile({ force: true });
      });
    }

    window.addEventListener("pageshow", (event) => {
      if (event.persisted) void reconcile({ force: true });
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt == null) return;
      const hiddenFor = Date.now() - hiddenAt;
      hiddenAt = null;
      if (hiddenFor >= staleAfterMs) void reconcile();
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializePicker, {
      once: true,
    });
  } else {
    initializePicker();
  }
})();
