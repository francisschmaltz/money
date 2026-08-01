(() => {
  const escapeText = (value) => String(value ?? "");
  const searchEntityTypes = new Set([
    "transaction",
    "account",
    "recurring",
    "manual_asset",
    "insight",
  ]);
  const mapKitScriptUrl =
    "https://cdn.apple-mapkit.com/mk/6/mapkit.core.js";
  const mapKitTokenEndpoint = "/api/mapkit-token";
  const mapKitAuthorizationFailureListeners = new Set();
  let mapKitLoadPromise = null;
  let mapKitInitialized = false;

  async function fetchMapKitAuthorizationToken() {
    const response = await fetch(mapKitTokenEndpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error("MapKit authorization is unavailable.");
    }
    const payload = await response.json().catch(() => null);
    const token =
      typeof payload?.token === "string" ? payload.token.trim() : "";
    if (!token) {
      throw new Error("MapKit authorization is unavailable.");
    }
    return token;
  }

  function notifyMapKitAuthorizationFailure() {
    for (const listener of mapKitAuthorizationFailureListeners) {
      try {
        listener();
      } catch {
        // Authorization failure must stay isolated to the map.
      }
    }
  }

  function configureMapKit(mapkit) {
    if (mapKitInitialized) return mapkit;
    if (typeof mapkit?.init !== "function") {
      throw new Error("MapKit JS did not initialize.");
    }
    mapkit.init({
      authorizationCallback(done) {
        void fetchMapKitAuthorizationToken().then(
          (token) => {
            try {
              done(token);
            } catch {
              notifyMapKitAuthorizationFailure();
            }
          },
          () => {
            notifyMapKitAuthorizationFailure();
            try {
              done("");
            } catch {
              // MapKit exposes no error callback for authorization.
            }
          },
        );
      },
    });
    mapKitInitialized = true;
    return mapkit;
  }

  const normalizedSearchQuery = (value) =>
    String(value ?? "").trim().slice(0, 120);

  const normalizedSearchEntityType = (value) =>
    searchEntityTypes.has(String(value ?? "")) ? String(value) : "";

  const accountAliasStorageKey = "money.account-aliases.v1";

  function storedAccountAliases() {
    try {
      const parsed = JSON.parse(
        window.localStorage.getItem(accountAliasStorageKey) || "{}",
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return Object.fromEntries(
        Object.entries(parsed)
          .filter(
            ([accountId, alias]) =>
              accountId &&
              typeof alias === "string" &&
              alias.trim() &&
              alias.trim().length <= 120,
          )
          .map(([accountId, alias]) => [accountId, alias.trim()]),
      );
    } catch {
      return {};
    }
  }

  function accountIdFromUrl(value) {
    const match = String(value ?? "").match(
      /^\/accounts(?:\?[^#]*)?#account-(.+)$/,
    );
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return null;
    }
  }

  function applyAccountAliasTarget(target, aliases = storedAccountAliases()) {
    const accountId = target?.dataset?.accountDisplayName;
    if (!accountId) return;
    const providerName =
      target.dataset.accountProviderName || target.textContent.trim();
    const displayName = aliases[accountId] || providerName;
    target.textContent =
      `${target.dataset.accountPrefix || ""}` +
      displayName +
      `${target.dataset.accountSuffix || ""}`;
  }

  function searchUrl(query, entityType = "") {
    const parameters = new URLSearchParams();
    const normalizedQuery = normalizedSearchQuery(query);
    const normalizedEntityType = normalizedSearchEntityType(entityType);
    if (normalizedQuery) parameters.set("q", normalizedQuery);
    if (normalizedEntityType) {
      parameters.set("entity_type", normalizedEntityType);
    }
    const serialized = parameters.toString();
    return serialized ? `/search?${serialized}` : "/search";
  }

  function safeSearchResultUrl(value) {
    if (
      typeof value !== "string" ||
      !value.startsWith("/") ||
      value.startsWith("//")
    ) {
      return null;
    }
    try {
      const candidate = new URL(value, window.location.origin);
      if (candidate.origin !== window.location.origin) return null;
      return `${candidate.pathname}${candidate.search}${candidate.hash}`;
    } catch {
      return null;
    }
  }

  function searchResultLink(item, dataAttribute) {
    const href = safeSearchResultUrl(item?.url);
    if (!href) return null;
    const link = document.createElement("a");
    link.className = "search-result";
    link.href = href;
    link.dataset[dataAttribute] = "";

    const leading = document.createElement("i");
    leading.className = `ph ${item.icon || "ph-magnifying-glass"}`;
    leading.setAttribute("aria-hidden", "true");

    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = escapeText(item.title);
    const accountId = accountIdFromUrl(href);
    if (accountId) {
      title.dataset.accountDisplayName = accountId;
      title.dataset.accountProviderName = title.textContent;
      applyAccountAliasTarget(title);
    }
    const meta = document.createElement("small");
    meta.textContent = escapeText(item.meta);
    copy.append(title, meta);

    const arrow = document.createElement("i");
    arrow.className = "ph ph-arrow-up-right";
    arrow.setAttribute("aria-hidden", "true");
    link.append(leading, copy, arrow);
    return link;
  }

  function searchStateElement({
    title,
    copy,
    icon = "ph-magnifying-glass",
    loading = false,
  }) {
    const state = document.createElement("div");
    state.className = loading
      ? "search-page__state search-page__state--loading card"
      : "search-page__state card";
    const symbol = document.createElement("span");
    symbol.className = "empty-icon";
    const symbolIcon = document.createElement("i");
    symbolIcon.className = `ph ${icon}`;
    symbolIcon.setAttribute("aria-hidden", "true");
    symbol.append(symbolIcon);
    const heading = document.createElement("h2");
    heading.textContent = title;
    const paragraph = document.createElement("p");
    paragraph.textContent = copy;
    state.append(symbol, heading, paragraph);
    return state;
  }

  function mobileNavigation() {
    const button = document.querySelector("[data-mobile-menu]");
    const nav = document.querySelector("[data-mobile-nav]");
    if (!button || !nav) return;

    const setOpen = (open, { restoreFocus = false } = {}) => {
      nav.hidden = !open;
      nav.toggleAttribute("inert", !open);
      button.setAttribute("aria-expanded", String(open));
      button.setAttribute(
        "aria-label",
        open ? "Close navigation" : "Open navigation",
      );
      const icon = button.querySelector("i");
      icon?.classList.toggle("ph-list", !open);
      icon?.classList.toggle("ph-x", open);
      if (!open && restoreFocus) button.focus();
    };

    button.addEventListener("click", () => {
      setOpen(nav.hidden, { restoreFocus: !nav.hidden });
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || nav.hidden) return;
      event.preventDefault();
      setOpen(false, { restoreFocus: true });
    });
    document.addEventListener("pointerdown", (event) => {
      if (
        nav.hidden ||
        nav.contains(event.target) ||
        button.contains(event.target)
      ) {
        return;
      }
      setOpen(false);
      window.setTimeout(() => button.focus(), 0);
    });
  }

  function localDateTimes() {
    const exactFormatter = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
    const transactionFormatter = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    document.querySelectorAll("[data-local-date-time]").forEach((element) => {
      const date = new Date(element.dataset.localDateTime);
      if (!Number.isFinite(date.getTime())) return;
      const formatter =
        element.dataset.localDateTimeStyle === "transaction"
          ? transactionFormatter
          : exactFormatter;
      element.textContent =
        `${element.dataset.localDateTimePrefix || ""}${formatter.format(date)}`;
      element.title = `Stored as ${date.toISOString()}`;
    });
  }

  function accountAliases() {
    const dialog = document.querySelector("[data-account-alias-dialog]");
    const form = dialog?.querySelector("[data-account-alias-form]");
    const input = form?.querySelector("[data-account-alias-input]");
    const providerCopy = form?.querySelector(
      "[data-account-alias-provider]",
    );
    const status = form?.querySelector("[data-account-alias-status]");
    const actionMenus = [
      ...document.querySelectorAll("[data-account-actions]"),
    ];
    let aliases = storedAccountAliases();
    let activeAccountId = null;
    let activeProviderName = "";
    let activeButton = null;

    const closeActionMenus = (except = null) => {
      actionMenus.forEach((menu) => {
        if (menu !== except && menu.open) menu.open = false;
      });
    };

    actionMenus.forEach((menu) => {
      menu.addEventListener("toggle", () => {
        if (menu.open) closeActionMenus(menu);
      });
    });

    document.addEventListener("click", (event) => {
      if (
        !actionMenus.some((menu) => menu.contains(event.target))
      ) {
        closeActionMenus();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const openMenu = actionMenus.find((menu) => menu.open);
      if (!openMenu) return;
      event.preventDefault();
      openMenu.open = false;
      openMenu
        .querySelector("[data-account-actions-trigger]")
        ?.focus();
    });

    const updateCreditChart = () => {
      const canvas = document.querySelector(
        'canvas[data-chart="credit"][data-series]',
      );
      const chart = canvas?.moneyChart;
      if (!canvas || !chart) return;
      try {
        const series = JSON.parse(canvas.dataset.series || "[]");
        chart.data.datasets.forEach((dataset, index) => {
          const accountId = series[index]?.account_id;
          if (!accountId) return;
          dataset.label =
            aliases[accountId] || series[index].label;
        });
        chart.update("none");
      } catch {}
    };

    const apply = () => {
      document
        .querySelectorAll("[data-account-display-name]")
        .forEach((target) => applyAccountAliasTarget(target, aliases));
      document
        .querySelectorAll("[data-account-alias-edit]")
        .forEach((button) => {
          const accountId = button.dataset.accountAliasEdit;
          const providerName =
            button.dataset.accountProviderName || "account";
          const displayedName = aliases[accountId] || providerName;
          button.setAttribute(
            "aria-label",
            `Rename ${displayedName} in this browser`,
          );
        });
      document
        .querySelectorAll("[data-account-actions-trigger]")
        .forEach((trigger) => {
          const accountId = trigger.dataset.accountActionsTrigger;
          const providerName =
            trigger.dataset.accountProviderName || "account";
          const displayedName = aliases[accountId] || providerName;
          trigger.setAttribute(
            "aria-label",
            `Actions for ${displayedName}`,
          );
        });
      updateCreditChart();
    };

    const persist = () => {
      try {
        window.localStorage.setItem(
          accountAliasStorageKey,
          JSON.stringify(aliases),
        );
        return true;
      } catch {
        if (status) {
          status.textContent =
            "This browser blocked local storage, so the name wasn’t saved.";
        }
        return false;
      }
    };

    const close = () => {
      if (dialog?.open) dialog.close();
      activeButton?.focus();
    };

    document
      .querySelectorAll("[data-account-alias-edit]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          activeAccountId = button.dataset.accountAliasEdit || null;
          activeProviderName =
            button.dataset.accountProviderName || "Account";
          const actionMenu = button.closest("[data-account-actions]");
          activeButton =
            actionMenu?.querySelector(
              "[data-account-actions-trigger]",
            ) || button;
          if (actionMenu) actionMenu.open = false;
          if (input) {
            input.value =
              aliases[activeAccountId] || activeProviderName;
          }
          if (providerCopy) {
            providerCopy.textContent = `Original: ${activeProviderName}`;
          }
          if (status) status.textContent = "";
          if (dialog && !dialog.open) dialog.showModal();
          window.setTimeout(() => input?.select(), 0);
        });
      });

    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!activeAccountId || !input) return;
      const alias = input.value.trim();
      if (!alias || alias.length > 120) {
        if (status) status.textContent = "Enter a name up to 120 characters.";
        return;
      }
      if (alias === activeProviderName) {
        delete aliases[activeAccountId];
      } else {
        aliases[activeAccountId] = alias;
      }
      if (!persist()) return;
      apply();
      close();
    });

    form
      ?.querySelector("[data-account-alias-reset]")
      ?.addEventListener("click", () => {
        if (!activeAccountId) return;
        delete aliases[activeAccountId];
        if (!persist()) return;
        apply();
        close();
      });

    dialog
      ?.querySelectorAll("[data-account-alias-close]")
      .forEach((button) => button.addEventListener("click", close));
    dialog?.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    apply();
  }

  function globalSearch() {
    const dialog = document.querySelector("[data-search-dialog]");
    const input = dialog?.querySelector("[data-search-input]");
    const entityType = dialog?.querySelector("[data-search-entity-type]");
    const results = dialog?.querySelector("[data-search-results]");
    const status = dialog?.querySelector("[data-search-dialog-status]");
    const fullSearchLink = dialog?.querySelector("[data-search-full-link]");
    const openers = document.querySelectorAll("[data-search-open]");
    if (!dialog || !input || !results) return;

    let timer;
    let controller;
    let activeIndex = -1;

    const selectable = () => [...results.querySelectorAll("[data-search-result]")];

    const select = (index) => {
      const items = selectable();
      if (!items.length) return;
      activeIndex = (index + items.length) % items.length;
      items.forEach((item, itemIndex) => item.setAttribute("aria-selected", String(itemIndex === activeIndex)));
      items[activeIndex].scrollIntoView({ block: "nearest" });
    };

    const setEmpty = (title, copy, icon = "ph-magnifying-glass") => {
      results.replaceChildren();
      const state = document.createElement("div");
      state.className = "search-empty";
      const symbol = document.createElement("span");
      symbol.className = "empty-icon";
      const symbolIcon = document.createElement("i");
      symbolIcon.className = `ph ${icon}`;
      symbolIcon.setAttribute("aria-hidden", "true");
      symbol.append(symbolIcon);
      const heading = document.createElement("h2");
      heading.textContent = title;
      const paragraph = document.createElement("p");
      paragraph.textContent = copy;
      state.append(symbol, heading, paragraph);
      results.append(state);
      activeIndex = -1;
      if (status) status.textContent = `${title}. ${copy}`;
    };

    const updateFullSearchLink = () => {
      if (fullSearchLink) {
        fullSearchLink.href = searchUrl(input.value, entityType?.value);
      }
    };

    const renderGroups = (groups) => {
      results.replaceChildren();
      activeIndex = -1;
      if (!groups?.length) {
        setEmpty("Nothing found", "Try another merchant, category, account, or subscription.", "ph-magnifying-glass-minus");
        return;
      }
      groups.forEach((group) => {
        const section = document.createElement("section");
        section.className = "search-group";
        const heading = document.createElement("h3");
        heading.textContent = escapeText(group.label);
        section.append(heading);
        group.items.forEach((item) => {
          const link = searchResultLink(item, "searchResult");
          if (!link) return;
          link.setAttribute("aria-selected", "false");
          section.append(link);
        });
        if (section.querySelector("[data-search-result]")) {
          results.append(section);
        }
      });
      const resultCount = selectable().length;
      if (!resultCount) {
        setEmpty("Nothing found", "Try another merchant, category, account, or subscription.", "ph-magnifying-glass-minus");
        return;
      }
      if (status) {
        status.textContent = `${resultCount} result${resultCount === 1 ? "" : "s"} found.`;
      }
      select(0);
    };

    const runSearch = async () => {
      const query = input.value.trim();
      controller?.abort();
      updateFullSearchLink();
      if (query.length < 2) {
        setEmpty("Search everything", "Type at least two characters to start.", "ph-command");
        return;
      }
      controller = new AbortController();
      results.replaceChildren();
      const loading = document.createElement("div");
      loading.className = "search-loading";
      loading.textContent = "Searching your finances…";
      results.append(loading);
      try {
        const parameters = new URLSearchParams({ q: query });
        if (entityType?.value) {
          parameters.set("entity_type", entityType.value);
        }
        const response = await fetch(`/api/search?${parameters}`, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(`Search failed with ${response.status}`);
        const payload = await response.json();
        renderGroups(payload.groups);
      } catch (error) {
        if (error.name !== "AbortError") {
          setEmpty("Search is unavailable", "Your data is fine. Try again in a moment.", "ph-cloud-slash");
        }
      }
    };

    const open = (event) => {
      event?.preventDefault();
      if (!dialog.open) dialog.showModal();
      updateFullSearchLink();
      window.setTimeout(() => input.focus(), 0);
    };

    const close = () => {
      controller?.abort();
      dialog.close();
    };

    openers.forEach((opener) => opener.addEventListener("click", open));
    dialog.querySelector("[data-search-close]")?.addEventListener("click", close);
    input.addEventListener("input", () => {
      window.clearTimeout(timer);
      updateFullSearchLink();
      timer = window.setTimeout(runSearch, 150);
    });
    entityType?.addEventListener("change", () => {
      window.clearTimeout(timer);
      updateFullSearchLink();
      if (input.value.trim().length >= 2) runSearch();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        select(activeIndex + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        select(activeIndex - 1);
      } else if (event.key === "Enter" && activeIndex >= 0) {
        event.preventDefault();
        selectable()[activeIndex]?.click();
      } else if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener("click", (event) => {
      const bounds = dialog.getBoundingClientRect();
      const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
      if (outside) close();
    });
    dialog.addEventListener("close", () => controller?.abort());
    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") open(event);
    });
    updateFullSearchLink();
  }

  function searchPage() {
    const root = document.querySelector("[data-search-page]");
    const form = root?.querySelector("[data-search-page-form]");
    const input = root?.querySelector("[data-search-page-input]");
    const entityType = root?.querySelector("[data-search-page-entity-type]");
    const results = root?.querySelector("[data-search-page-results]");
    const status = root?.querySelector("[data-search-page-status]");
    const clear = root?.querySelector("[data-search-page-clear]");
    if (!root || !form || !input || !entityType || !results || !status) return;

    let timer;
    let controller;
    let generation = 0;

    const stateFromControls = () => ({
      query: normalizedSearchQuery(input.value),
      entityType: normalizedSearchEntityType(entityType.value),
    });

    const stateFromLocation = () => {
      const parameters = new URLSearchParams(window.location.search);
      return {
        query: normalizedSearchQuery(parameters.get("q")),
        entityType: normalizedSearchEntityType(parameters.get("entity_type")),
      };
    };

    const stateKey = (state) => searchUrl(state.query, state.entityType);

    const cancelPending = () => {
      window.clearTimeout(timer);
      controller?.abort();
      controller = null;
      generation += 1;
    };

    const setStatus = (copy) => {
      status.textContent = copy;
    };

    const renderInitial = () => {
      results.setAttribute("aria-busy", "false");
      const state = searchStateElement({
        title: "Search everything",
        copy: "Start with a merchant, spending category, or account name.",
      });
      const examples = document.createElement("div");
      examples.className = "search-page__examples";
      examples.setAttribute("aria-label", "Example searches");
      [
        ["Apple", "/search?q=Apple"],
        ["Groceries", "/search?q=groceries"],
        ["Coffee", "/search?q=coffee"],
      ].forEach(([label, href]) => {
        const link = document.createElement("a");
        link.href = href;
        link.dataset.searchExample = "";
        link.textContent = label;
        examples.append(link);
      });
      state.append(examples);
      results.replaceChildren(state);
      setStatus("Search transactions, accounts, recurring charges, assets, and insights.");
    };

    const renderTooShort = () => {
      results.setAttribute("aria-busy", "false");
      results.replaceChildren(
        searchStateElement({
          title: "Keep typing",
          copy: "Search starts at two characters.",
          icon: "ph-text-aa",
        }),
      );
      setStatus("Type at least two characters to search.");
    };

    const renderLoading = () => {
      results.setAttribute("aria-busy", "true");
      results.replaceChildren(
        searchStateElement({
          title: "Searching",
          copy: "Looking across your finances…",
          icon: "ph-magnifying-glass",
          loading: true,
        }),
      );
      setStatus("Searching your finances…");
    };

    const renderEmpty = (query) => {
      results.setAttribute("aria-busy", "false");
      results.replaceChildren(
        searchStateElement({
          title: "Nothing found",
          copy: "Try another merchant, category, account, subscription, asset, or insight.",
          icon: "ph-magnifying-glass-minus",
        }),
      );
      setStatus(`No results for “${query}”.`);
    };

    const renderError = (retryState) => {
      results.setAttribute("aria-busy", "false");
      const state = searchStateElement({
        title: "Search is unavailable",
        copy: "Your data is fine. Try again in a moment.",
        icon: "ph-cloud-slash",
      });
      const retry = document.createElement("button");
      retry.className = "button button--secondary";
      retry.type = "button";
      retry.textContent = "Try again";
      retry.addEventListener("click", () => scheduleSearch({
        historyMode: null,
        delay: 0,
        state: retryState,
      }));
      state.append(retry);
      results.replaceChildren(state);
      setStatus("Search is unavailable right now.");
    };

    const renderGroups = (payload, query) => {
      const groups = Array.isArray(payload?.groups) ? payload.groups : [];
      if (!groups.length) {
        renderEmpty(query);
        return;
      }

      const groupContainer = document.createElement("div");
      groupContainer.className = "search-page__groups";
      let renderedCount = 0;

      groups.forEach((group) => {
        const section = document.createElement("section");
        section.className = "search-page__group card";
        const groupHeading = document.createElement("div");
        groupHeading.className = "search-page__group-heading";
        const heading = document.createElement("h2");
        heading.textContent = escapeText(group.label);
        const list = document.createElement("ul");
        list.className = "search-page__result-list";

        (Array.isArray(group.items) ? group.items : []).forEach((item) => {
          const link = searchResultLink(item, "searchPageResult");
          if (!link) return;
          const row = document.createElement("li");
          row.append(link);
          list.append(row);
          renderedCount += 1;
        });
        if (!list.children.length) return;

        const groupCount = document.createElement("span");
        const count = Number.isInteger(group.returned_count)
          ? group.returned_count
          : list.children.length;
        groupCount.textContent = `${count} shown`;
        groupHeading.append(heading, groupCount);
        section.append(groupHeading, list);
        groupContainer.append(section);
      });

      if (!renderedCount) {
        renderEmpty(query);
        return;
      }
      results.setAttribute("aria-busy", "false");
      results.replaceChildren(groupContainer);
      const groupCount = groupContainer.children.length;
      setStatus(
        `Showing ${renderedCount} result${renderedCount === 1 ? "" : "s"} across ${groupCount} ${groupCount === 1 ? "group" : "groups"}.`,
      );
    };

    const writeHistory = (state, mode) => {
      const target = stateKey(state);
      const current = `${window.location.pathname}${window.location.search}`;
      if (mode === "push" && target !== current) {
        window.history.pushState(null, "", target);
      } else if (mode === "replace" && target !== current) {
        window.history.replaceState(null, "", target);
      }
    };

    const fetchResults = async (state, requestGeneration) => {
      controller = new AbortController();
      const parameters = new URLSearchParams({
        q: state.query,
        limit: "50",
      });
      if (state.entityType) {
        parameters.set("entity_type", state.entityType);
      }
      try {
        const response = await fetch(`/api/search?${parameters}`, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(`Search failed with ${response.status}`);
        const payload = await response.json();
        if (
          requestGeneration !== generation ||
          stateKey(stateFromLocation()) !== stateKey(state)
        ) {
          return;
        }
        renderGroups(payload, state.query);
      } catch (error) {
        if (
          error.name !== "AbortError" &&
          requestGeneration === generation &&
          stateKey(stateFromLocation()) === stateKey(state)
        ) {
          renderError(state);
        }
      }
    };

    function scheduleSearch({
      historyMode = null,
      delay = 0,
      state = stateFromControls(),
    } = {}) {
      cancelPending();
      writeHistory(state, historyMode);
      if (!state.query) {
        renderInitial();
        return;
      }
      if (state.query.length < 2) {
        renderTooShort();
        return;
      }
      renderLoading();
      const requestGeneration = generation;
      timer = window.setTimeout(
        () => fetchResults(state, requestGeneration),
        delay,
      );
    }

    input.addEventListener("input", () => {
      scheduleSearch({ historyMode: "replace", delay: 150 });
    });

    entityType.addEventListener("change", () => {
      scheduleSearch({ historyMode: "push", delay: 0 });
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const state = stateFromControls();
      const current = `${window.location.pathname}${window.location.search}`;
      scheduleSearch({
        historyMode: stateKey(state) === current ? null : "push",
        delay: 0,
        state,
      });
    });

    clear?.addEventListener("click", (event) => {
      event.preventDefault();
      input.value = "";
      entityType.value = "";
      scheduleSearch({
        historyMode: "push",
        state: { query: "", entityType: "" },
      });
      input.focus();
    });

    window.addEventListener("popstate", () => {
      cancelPending();
      const state = stateFromLocation();
      input.value = state.query;
      entityType.value = state.entityType;
      const canonical = stateKey(state);
      const current = `${window.location.pathname}${window.location.search}`;
      if (canonical !== current) {
        window.history.replaceState(null, "", canonical);
      }
      scheduleSearch({ state, delay: 0 });
    });

    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.focus();
        input.select();
      }
    });
  }

  function recurringControls() {
    document.querySelectorAll("[data-recurring-section]").forEach((section) => {
      section.querySelectorAll("[data-period]").forEach((button) => {
        button.addEventListener("click", () => {
          const period = button.dataset.period;
          section.querySelectorAll("[data-period]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
          section.querySelectorAll("[data-amount]").forEach((amount) => { amount.textContent = amount.dataset[period]; });
          const total = section.querySelector("[data-recurring-total]");
          const label = section.querySelector("[data-period-label]");
          if (total) total.textContent = total.dataset[period];
          if (label) label.textContent = period === "annual" ? "per year" : "per month";
        });
      });
    });
  }

  function recurringClassification() {
    document
      .querySelectorAll("[data-recurring-classification]")
      .forEach((form) => {
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const status = form.querySelector("[data-save-status]");
          const button = form.querySelector('button[type="submit"]');
          const type = new FormData(form).get("type");
          const csrfToken =
            document.querySelector('meta[name="csrf-token"]')?.content ||
            "";
          button.disabled = true;
          if (status) status.textContent = "Saving…";
          try {
            const response = await fetch(form.dataset.endpoint, {
              method: "PUT",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-CSRF-Token": csrfToken,
              },
              body: JSON.stringify({ type }),
            });
            if (!response.ok) throw new Error("Classification failed");
            if (status) status.textContent = "Saved";
            window.setTimeout(() => window.location.reload(), 300);
          } catch {
            button.disabled = false;
            if (status) {
              status.textContent = "Couldn’t save classification";
            }
          }
        });
      });
  }

  function dashboardBalanceSwitcher() {
    const root = document.querySelector("[data-dashboard-balance]");
    if (!root) return;

    let metrics;
    try {
      metrics = JSON.parse(root.dataset.metrics || "{}");
    } catch {
      return;
    }

    const buttons = [...root.querySelectorAll("[data-balance-metric]")];
    const label = root.querySelector("[data-balance-label]");
    const value = root.querySelector("[data-balance-value]");
    const description = root.querySelector("[data-balance-description]");
    const trend = root.querySelector("[data-balance-trend]");
    const trendIcon = trend?.querySelector("i");
    const trendText = trend?.querySelector("span");
    const action = root.querySelector("[data-balance-action]");
    const actionLabel = action?.querySelector("span");
    const canvas = root.querySelector('canvas[data-chart="line"]');
    const periodLinks = [
      ...root.querySelectorAll("[data-dashboard-period]"),
    ];
    const periodComparison =
      root.dataset.periodComparison || "over the selected period";
    const periodLabel =
      root.dataset.periodLabel || "Selected period";

    const formatMoney = (moneyValue, { sign = false } = {}) => {
      const currency = moneyValue?.currency || "USD";
      const amountMinor = Number(moneyValue?.amount_minor);
      if (!Number.isSafeInteger(amountMinor)) return "—";
      const formatter = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        signDisplay: sign ? "exceptZero" : "auto",
      });
      const digits = formatter.resolvedOptions().maximumFractionDigits;
      return formatter.format(amountMinor / 10 ** digits);
    };

    const activate = (
      requestedName,
      { updateUrl = true, focus = false } = {},
    ) => {
      const name = Object.hasOwn(metrics, requestedName)
        ? requestedName
        : "cash";
      const metric = metrics[name];
      const series = Array.isArray(metric.series) ? metric.series : [];
      const labels = Array.isArray(metric.labels) ? metric.labels : [];

      buttons.forEach((button) => {
        const active = button.dataset.balanceMetric === name;
        button.setAttribute("aria-pressed", String(active));
        if (active && focus) button.focus();
      });
      if (label) label.textContent = metric.label;
      if (value) value.textContent = formatMoney(metric.value);
      if (description) description.textContent = metric.description;

      if (trend && trendText && trendIcon) {
        trend.classList.remove("trend--positive", "trend--negative");
        if (series.length > 1) {
          const change = series.at(-1) - series[0];
          trend.classList.add(
            change >= 0 ? "trend--positive" : "trend--negative",
          );
          trendIcon.hidden = false;
          trendIcon.className = `ph ${
            change >= 0 ? "ph-arrow-up-right" : "ph-arrow-down-right"
          }`;
          trendText.textContent =
            `${formatMoney(
              {
                amount_minor: change,
                currency: metric.value.currency,
              },
              { sign: true },
            )} ${periodComparison}`;
        } else {
          trendIcon.hidden = true;
          trendIcon.className = "ph";
          trendText.textContent =
            "History begins with the first local snapshot.";
        }
      }

      if (action) action.href = metric.action_href;
      if (actionLabel) actionLabel.textContent = metric.action_label;

      periodLinks.forEach((link) => {
        const url = new URL(link.href, window.location.origin);
        if (name === "cash") {
          url.searchParams.delete("metric");
        } else {
          url.searchParams.set("metric", name);
        }
        link.href = `${url.pathname}${url.search}${url.hash}`;
      });

      if (canvas) {
        canvas.dataset.labels = JSON.stringify(labels);
        canvas.dataset.values = JSON.stringify(series);
        canvas.setAttribute(
          "aria-label",
          `${metric.chart_label} · ${periodLabel}`,
        );
        const chart =
          canvas.moneyChart ?? window.Chart?.getChart?.(canvas);
        if (chart) {
          chart.data.labels = [...labels];
          chart.data.datasets[0].data = [...series];
          chart.update();
        }
      }

      if (updateUrl) {
        const url = new URL(window.location.href);
        if (name === "cash") {
          url.searchParams.delete("metric");
        } else {
          url.searchParams.set("metric", name);
        }
        window.history.replaceState(
          null,
          "",
          `${url.pathname}${url.search}${url.hash}`,
        );
      }
    };

    buttons.forEach((button, index) => {
      button.addEventListener("click", () => {
        activate(button.dataset.balanceMetric);
      });
      button.addEventListener("keydown", (event) => {
        if (
          !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
            event.key,
          )
        ) {
          return;
        }
        event.preventDefault();
        const nextIndex =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index +
                  (event.key === "ArrowRight" ? 1 : -1) +
                  buttons.length) %
                buttons.length;
        activate(buttons[nextIndex].dataset.balanceMetric, {
          focus: true,
        });
      });
    });

    const requested = new URLSearchParams(window.location.search).get(
      "metric",
    );
    activate(requested || "cash", { updateUrl: false });
  }

  function periodControls() {
    document.querySelectorAll(".period-select").forEach((control) => {
      control.querySelectorAll("button").forEach((button) => {
        button.addEventListener("click", () => {
          control.querySelectorAll("button").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
        });
      });
      if (control.classList.contains("period-select--portfolio")) {
        control
          .querySelector('[aria-current="true"]')
          ?.scrollIntoView({
            block: "nearest",
            inline: "center",
          });
      }
    });
  }

  function settingsForms() {
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || "";
    const wealthGroupLabels = {
      cash: "Cash account",
      taxable_investment: "Personal brokerage",
      retirement: "Retirement",
      credit_card: "Credit card",
      loan: "Loan",
      other_asset: "Other asset",
      other_liability: "Other liability",
      excluded: "Excluded",
    };

    const requestJson = async (
      url,
      { method = "POST", body, signal } = {},
    ) => {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(
          payload.message || `Save failed with ${response.status}`,
        );
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    };

    const insightAdminStatus = document.querySelector(
      "[data-insight-admin-status]",
    );
    const toggleInsights = document.querySelector(
      "[data-insights-toggle]",
    );
    const runInsights = document.querySelector("[data-insights-run]");
    const clearInsights = document.querySelector(
      "[data-insights-clear]",
    );
    const clearInsightsDialog = document.querySelector(
      "[data-insights-clear-dialog]",
    );
    const clearInsightsDialogOpen = document.querySelector(
      "[data-insights-clear-dialog-open]",
    );
    const clearInsightsDialogClose = [
      ...(clearInsightsDialog?.querySelectorAll(
        "[data-insights-clear-dialog-close]",
      ) ?? []),
    ];
    const clearInsightsDialogStatus = clearInsightsDialog?.querySelector(
      "[data-insights-clear-dialog-status]",
    );
    let clearInsightsDialogOpener = null;
    let clearInsightsBusy = false;

    const closeClearInsightsDialog = () => {
      if (clearInsightsBusy) return;
      if (clearInsightsDialog?.open) clearInsightsDialog.close();
    };

    clearInsightsDialogOpen?.addEventListener("click", () => {
      if (!clearInsightsDialog) return;
      clearInsightsDialogOpener = clearInsightsDialogOpen;
      if (clearInsightsDialogStatus) {
        clearInsightsDialogStatus.textContent = "";
      }
      if (!clearInsightsDialog.open) clearInsightsDialog.showModal();
      window.setTimeout(
        () =>
          clearInsightsDialog
            .querySelector("[data-insights-clear-dialog-close]")
            ?.focus(),
        0,
      );
    });
    clearInsightsDialogClose.forEach((button) => {
      button.addEventListener("click", closeClearInsightsDialog);
    });
    clearInsightsDialog?.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeClearInsightsDialog();
    });
    clearInsightsDialog?.addEventListener("click", (event) => {
      if (event.target === clearInsightsDialog) {
        closeClearInsightsDialog();
      }
    });
    clearInsightsDialog?.addEventListener("close", () => {
      clearInsightsDialogOpener?.focus();
    });

    toggleInsights?.addEventListener("click", async () => {
      const enabled = toggleInsights.dataset.insightsEnabled !== "true";
      toggleInsights.disabled = true;
      if (runInsights) runInsights.disabled = true;
      if (insightAdminStatus) {
        insightAdminStatus.textContent = enabled
          ? "Turning on insights…"
          : "Pausing insights…";
      }
      try {
        await requestJson("/api/v1/settings/insights/status", {
          method: "PUT",
          body: { enabled },
        });
        if (insightAdminStatus) {
          insightAdminStatus.textContent = enabled
            ? "Insights turned on."
            : "Insights paused.";
        }
        window.setTimeout(() => window.location.reload(), 600);
      } catch (error) {
        toggleInsights.disabled = false;
        if (runInsights) {
          runInsights.disabled =
            runInsights.dataset.insightsCanRun === "false";
        }
        if (insightAdminStatus) {
          insightAdminStatus.textContent =
            error.message || "Couldn’t update insight settings.";
        }
      }
    });

    runInsights?.addEventListener("click", async () => {
      if (runInsights.dataset.insightsCanRun === "false") return;
      runInsights.disabled = true;
      if (insightAdminStatus) {
        insightAdminStatus.textContent = "Queueing insight run…";
      }
      try {
        const result = await requestJson(
          "/api/v1/settings/insights/run",
        );
        if (insightAdminStatus) {
          insightAdminStatus.textContent =
            result.already_in_progress
              ? "An insight run is already in progress."
              : "Insight run queued.";
        }
        window.setTimeout(() => window.location.reload(), 600);
      } catch (error) {
        runInsights.disabled =
          runInsights.dataset.insightsCanRun === "false";
        if (insightAdminStatus) {
          insightAdminStatus.textContent =
            error.message || "Couldn’t start insights.";
        }
      }
    });

    clearInsights?.addEventListener("click", async () => {
      const warning = clearInsights.dataset.confirmMessage;
      if (warning && !window.confirm(warning)) return;
      clearInsightsBusy = true;
      clearInsights.disabled = true;
      clearInsightsDialogClose.forEach((button) => {
        button.disabled = true;
      });
      if (insightAdminStatus) {
        insightAdminStatus.textContent = "Clearing insights…";
      }
      if (clearInsightsDialogStatus) {
        clearInsightsDialogStatus.textContent = "Clearing insights…";
      }
      try {
        await requestJson("/api/v1/settings/insights", {
          method: "DELETE",
        });
        if (insightAdminStatus) {
          insightAdminStatus.textContent = "Insights cleared.";
        }
        if (clearInsightsDialogStatus) {
          clearInsightsDialogStatus.textContent = "Insights cleared.";
        }
        window.setTimeout(() => window.location.reload(), 600);
      } catch (error) {
        clearInsightsBusy = false;
        clearInsights.disabled = false;
        clearInsightsDialogClose.forEach((button) => {
          button.disabled = false;
        });
        const message =
          error.message || "Couldn’t clear insights.";
        if (insightAdminStatus) {
          insightAdminStatus.textContent = message;
        }
        if (clearInsightsDialogStatus) {
          clearInsightsDialogStatus.textContent = message;
        }
        window.setTimeout(() => clearInsights.focus(), 0);
      }
    });

    const llmRanking = document.querySelector(
      "[data-insight-llm-ranking]",
    );
    if (llmRanking) {
      const llmForm = llmRanking.querySelector("[data-llm-form]");
      const familySelect = llmRanking.querySelector("[data-llm-family]");
      const baseGuidance = llmRanking.querySelector(
        "[data-llm-base-guidance]",
      );
      const familyGuidance = Object.fromEntries(
        [...llmRanking.querySelectorAll("[data-llm-family-guidance]")]
          .map((field) => [field.dataset.llmFamilyGuidance, field]),
      );
      const candidateLimit = llmRanking.querySelector(
        "[data-llm-candidate-limit]",
      );
      const resultLimit = llmRanking.querySelector(
        "[data-llm-result-limit]",
      );
      const feedbackMode = llmRanking.querySelector(
        "[data-llm-feedback-mode]",
      );
      const feedbackLimit = llmRanking.querySelector(
        "[data-llm-feedback-limit]",
      );
      const contextLimit = llmRanking.querySelector(
        "[data-llm-context-limit]",
      );
      const preview = llmRanking.querySelector("[data-llm-preview]");
      const previewStatus = llmRanking.querySelector(
        "[data-llm-preview-status]",
      );
      const requestJsonOutput = llmRanking.querySelector(
        "[data-llm-request-json]",
      );
      const actionStatus = llmRanking.querySelector(
        "[data-llm-action-status]",
      );
      const restoreDefault = llmRanking.querySelector(
        "[data-llm-restore-default]",
      );
      const testDraft = llmRanking.querySelector("[data-llm-test]");
      const saveGuidance = llmRanking.querySelector("[data-llm-save]");
      const llmActionButtons = [
        restoreDefault,
        testDraft,
        saveGuidance,
      ].filter(Boolean);
      const testResult = llmRanking.querySelector(
        "[data-llm-test-result]",
      );
      const testSummary = llmRanking.querySelector(
        "[data-llm-test-summary]",
      );
      const testOutput = llmRanking.querySelector(
        "[data-llm-test-output]",
      );
      const savedRevision = llmRanking.querySelector(
        "[data-llm-saved-revision]",
      );
      const revisionNote = llmRanking.querySelector(
        "[data-llm-revision-note]",
      );
      const revisionNoteCopy = llmRanking.querySelector(
        "[data-llm-revision-note-copy]",
      );
      const families = ["weekly", "investments", "subscriptions"];
      let llmActionBusy = false;
      let previewTimer = null;
      let previewController = null;
      let previewSequence = 0;
      let previewPending = false;

      const setNodeText = (selector, value) => {
        const node = llmRanking.querySelector(selector);
        if (node) node.textContent = value;
      };

      const integerOrNull = (value) => {
        if (value === null || value === undefined || value === "") {
          return null;
        }
        const number = Number(value);
        return Number.isFinite(number) ? Math.round(number) : null;
      };

      const formattedInteger = (value) => {
        const number = integerOrNull(value);
        return number === null
          ? "Unavailable"
          : number.toLocaleString("en-US");
      };

      const formattedTimestamp = (value) => {
        if (!value) return "Unavailable";
        const date = new Date(value);
        return Number.isFinite(date.getTime())
          ? date.toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })
          : String(value);
      };

      const formattedUsage = (usage) => {
        if (!usage || typeof usage !== "object") return "Unavailable";
        const promptTokens = integerOrNull(
          usage.prompt_tokens ?? usage.input_tokens,
        );
        const completionTokens = integerOrNull(
          usage.completion_tokens ?? usage.output_tokens,
        );
        const totalTokens = integerOrNull(usage.total_tokens);
        if (
          promptTokens === null &&
          completionTokens === null &&
          totalTokens === null
        ) {
          return "Unavailable";
        }
        const pieces = [];
        if (totalTokens !== null) {
          pieces.push(`${formattedInteger(totalTokens)} total`);
        }
        if (promptTokens !== null) {
          pieces.push(`${formattedInteger(promptTokens)} in`);
        }
        if (completionTokens !== null) {
          pieces.push(`${formattedInteger(completionTokens)} out`);
        }
        return `${pieces.join(" · ")} tokens`;
      };

      const draftSettings = () => ({
        base_guidance: baseGuidance?.value ?? "",
        family_guidance: Object.fromEntries(
          families.map((family) => [
            family,
            familyGuidance[family]?.value ?? "",
          ]),
        ),
        candidate_limit: Number(candidateLimit?.value),
        result_limit: Number(resultLimit?.value),
        feedback_mode:
          feedbackMode?.value || "bad_and_archived",
        feedback_limit: Number(feedbackLimit?.value),
        context_length:
          contextLimit?.value === ""
            ? null
            : Number(contextLimit?.value),
      });

      const updateCharacterCounts = () => {
        const fields = {
          base: [baseGuidance, 4000],
          ...Object.fromEntries(
            families.map((family) => [
              family,
              [familyGuidance[family], 2000],
            ]),
          ),
        };
        Object.entries(fields).forEach(([name, [field, maximum]]) => {
          const counter = llmRanking.querySelector(
            `[data-llm-character-count="${name}"]`,
          );
          if (counter && field) {
            counter.textContent =
              `${field.value.length.toLocaleString("en-US")} / ` +
              maximum.toLocaleString("en-US");
          }
        });
      };

      const showSelectedFamily = () => {
        const selected = familySelect?.value || "weekly";
        llmRanking
          .querySelectorAll("[data-llm-family-panel]")
          .forEach((panel) => {
            panel.hidden =
              panel.dataset.llmFamilyPanel !== selected;
          });
      };

      const updateRevisionNote = () => {
        if (!revisionNote) return;
        const current = Number(llmRanking.dataset.llmRevision);
        const provenance = families
          .map((family) => {
            const node = llmRanking.querySelector(
              `[data-llm-family-provenance="${family}"]`,
            );
            const revision = integerOrNull(
              node?.dataset.guidanceRevision,
            );
            return { family, revision };
          })
          .filter(({ revision }) => revision !== null);
        const outdated = Number.isFinite(current)
          ? provenance.filter(
              ({ revision }) => revision !== current,
            )
          : [];
        if (!outdated.length && provenance.length === 0) {
          const applied = integerOrNull(
            llmRanking.dataset.llmLastAppliedRevision,
          );
          if (
            applied !== null &&
            Number.isFinite(current) &&
            applied !== current
          ) {
            outdated.push({ family: null, revision: applied });
          }
        }
        revisionNote.hidden = outdated.length === 0;
        if (!revisionNote.hidden && revisionNoteCopy) {
          const descriptions = outdated.map(
            ({ family, revision }) =>
              family
                ? `${
                    family[0].toUpperCase() + family.slice(1)
                  } uses revision ${revision}`
                : `The last good ranking uses revision ${revision}`,
          );
          revisionNoteCopy.textContent =
            `${descriptions.join("; ")}. ` +
            `Saved revision ${current} applies to each family on its next successful run.`;
        }
      };

      const renderThroughput = (throughput) => {
        if (!throughput || typeof throughput !== "object") return;
        const totalTokens = integerOrNull(
          throughput.total_tokens ?? throughput.tokens,
        );
        if (totalTokens !== null) {
          const callsWithUsage = integerOrNull(
            throughput.calls_with_usage,
          );
          const familyCount = integerOrNull(
            throughput.call_count ?? throughput.family_count,
          );
          const reported =
            callsWithUsage !== null && familyCount !== null
              ? ` · ${callsWithUsage}/${familyCount} calls reported`
              : "";
          setNodeText(
            "[data-llm-throughput]",
            `${formattedInteger(totalTokens)} tokens${reported}`,
          );
        }
      };

      const renderPreview = (payload) => {
        const result = payload?.preview ?? payload ?? {};
        const counts = result.counts ?? {};
        const feedbackCount =
          integerOrNull(
            counts.feedback_count ??
              counts.feedback_pattern_count,
          ) ??
          (() => {
            const bad = integerOrNull(counts.bad_feedback_count);
            const archived = integerOrNull(
              counts.archived_feedback_count,
            );
            return bad === null && archived === null
              ? null
              : (bad ?? 0) + (archived ?? 0);
          })();
        const candidateCount =
          counts.candidate_count ??
          counts.candidates ??
          result.candidate_count;
        const estimatedInput = integerOrNull(
          result.estimated_input_tokens ??
            result.estimate?.input_tokens,
        );
        const contextLength = integerOrNull(
          result.context_length ??
            result.model_state?.context_length,
        );
        const contextLengthSource =
          result.context_length_source ??
          result.model_state?.context_length_source;
        const estimatedTotal = integerOrNull(
          result.estimated_total_tokens,
        );
        const utilizationValue =
          result.utilization?.percent ??
          result.utilization_percent ??
          (contextLength && (estimatedTotal ?? estimatedInput) !== null
            ? (
                ((estimatedTotal ??
                  estimatedInput +
                    integerOrNull(result.output_token_reserve ?? 256)) /
                  contextLength) *
                100
              )
            : null);
        const utilization =
          utilizationValue === null ||
          utilizationValue === undefined
            ? null
            : Number(utilizationValue);
        const utilizationMetric = llmRanking.querySelector(
          "[data-llm-utilization-metric]",
        );
        const utilizationState =
          result.utilization?.state ||
          (!Number.isFinite(utilization)
            ? null
            : utilization > 100
              ? "over"
              : utilization >= 95
                ? "critical"
                : utilization >= 80
                  ? "warning"
                  : "normal");

        setNodeText(
          "[data-llm-candidate-count]",
          formattedInteger(candidateCount),
        );
        setNodeText(
          "[data-llm-feedback-count]",
          formattedInteger(feedbackCount),
        );
        const dataAsOf = llmRanking.querySelector(
          "[data-llm-data-as-of]",
        );
        const dataTimestamp =
          result.data_as_of ??
          result.data_timestamp ??
          result.freshness?.data_as_of;
        if (dataAsOf) {
          dataAsOf.textContent = formattedTimestamp(dataTimestamp);
          if (dataTimestamp) {
            dataAsOf.setAttribute("datetime", dataTimestamp);
          } else {
            dataAsOf.removeAttribute("datetime");
          }
        }
        setNodeText(
          "[data-llm-estimated-input]",
          estimatedInput === null
            ? "Unavailable"
            : `≈${formattedInteger(estimatedInput)} tokens`,
        );
        setNodeText(
          "[data-llm-context-length]",
          contextLength === null
            ? "Unknown"
            : `${formattedInteger(contextLength)} tokens${
                contextLengthSource === "settings"
                  ? " · Settings override"
                  : contextLengthSource === "model"
                    ? " · Loaded model"
                    : ""
              }`,
        );

        let utilizationCopy = "Unavailable";
        if (Number.isFinite(utilization)) {
          const percent = `${utilization.toFixed(
            utilization >= 100 ? 0 : 1,
          )}%`;
          utilizationCopy =
            utilizationState === "over"
              ? `${percent} · Likely over context`
              : utilizationState === "critical"
                ? `${percent} · Critical`
                : utilizationState === "warning"
                  ? `${percent} · Warning`
                  : percent;
        }
        setNodeText("[data-llm-utilization]", utilizationCopy);
        if (utilizationMetric) {
          utilizationMetric.classList.remove(
            "llm-ranking__metric--warning",
            "llm-ranking__metric--critical",
            "llm-ranking__metric--over",
          );
          if (
            ["warning", "critical", "over"].includes(
              utilizationState,
            )
          ) {
            utilizationMetric.classList.add(
              `llm-ranking__metric--${utilizationState}`,
            );
          }
        }

        const lastUsage =
          result.last_actual_usage ??
          result.last_call?.usage ??
          result.call_status?.usage ??
          payload?.last_actual_usage;
        setNodeText(
          "[data-llm-last-actual]",
          formattedUsage(lastUsage),
        );
        renderThroughput(
          result.throughput ??
            payload?.throughput ??
            result.full_run_throughput,
        );

        const stale =
          result.data_stale === true ||
          result.stale === true ||
          result.data_is_stale === true ||
          result.freshness?.stale === true;
        const staleNotice = llmRanking.querySelector(
          "[data-llm-stale-notice]",
        );
        if (staleNotice) {
          staleNotice.hidden = !stale;
          if (stale) {
            setNodeText(
              "[data-llm-stale-message]",
              (Array.isArray(result.stale_reasons)
                ? result.stale_reasons.join(" ")
                : null) ||
                result.stale_reason ||
                result.freshness?.message ||
                "Using the last good stored findings because connected data is stale.",
            );
          }
        }

        const body =
          result.request_body ??
          result.outbound_body ??
          result.request ??
          result.body;
        if (requestJsonOutput) {
          requestJsonOutput.textContent =
            body === undefined
              ? "The server did not return a request preview."
              : typeof body === "string"
                ? body
                : JSON.stringify(body, null, 2);
        }
        if (previewStatus) {
          previewStatus.textContent = "Preview updated.";
        }
        preview?.setAttribute("aria-busy", "false");
      };

      const runPreview = async () => {
        if (llmActionBusy) {
          previewPending = true;
          return;
        }
        if (!llmForm?.checkValidity()) {
          previewController?.abort();
          preview?.setAttribute("aria-busy", "false");
          if (previewStatus) {
            previewStatus.textContent =
              "Fix the invalid request limits to refresh.";
          }
          return;
        }
        previewPending = false;
        const sequence = ++previewSequence;
        previewController?.abort();
        previewController = new AbortController();
        preview?.setAttribute("aria-busy", "true");
        if (previewStatus) {
          previewStatus.textContent = "Refreshing preview…";
        }
        try {
          const result = await requestJson(
            "/api/v1/settings/insights/llm/preview",
            {
              body: {
                family: familySelect?.value || "weekly",
                settings: draftSettings(),
              },
              signal: previewController.signal,
            },
          );
          if (sequence !== previewSequence) return;
          renderPreview(result);
        } catch (error) {
          if (
            error?.name === "AbortError" ||
            sequence !== previewSequence
          ) {
            return;
          }
          preview?.setAttribute("aria-busy", "false");
          if (previewStatus) {
            previewStatus.textContent =
              error.message || "Couldn’t build the preview.";
          }
          if (requestJsonOutput) {
            requestJsonOutput.textContent =
              "Request preview unavailable.";
          }
        }
      };

      const schedulePreview = ({ immediate = false } = {}) => {
        if (previewTimer) window.clearTimeout(previewTimer);
        previewController?.abort();
        previewController = null;
        previewSequence += 1;
        if (immediate) {
          runPreview();
          return;
        }
        previewTimer = window.setTimeout(runPreview, 350);
      };

      const setLlmActionBusy = (busy) => {
        llmActionBusy = busy;
        llmForm?.setAttribute("aria-busy", String(busy));
        llmActionButtons.forEach((button) => {
          button.disabled = busy;
        });
        if (!busy && previewPending) {
          schedulePreview({ immediate: true });
        }
      };

      const applySettings = (settings) => {
        if (!settings || typeof settings !== "object") return;
        if (typeof settings.base_guidance === "string") {
          baseGuidance.value = settings.base_guidance;
        }
        families.forEach((family) => {
          const value = settings.family_guidance?.[family];
          if (
            familyGuidance[family] &&
            typeof value === "string"
          ) {
            familyGuidance[family].value = value;
          }
        });
        if (settings.candidate_limit != null) {
          candidateLimit.value = String(settings.candidate_limit);
        }
        if (settings.result_limit != null) {
          resultLimit.value = String(settings.result_limit);
        }
        if (settings.feedback_mode) {
          feedbackMode.value = settings.feedback_mode;
        }
        if (settings.feedback_limit != null) {
          feedbackLimit.value = String(settings.feedback_limit);
        }
        if (Object.hasOwn(settings, "context_length")) {
          contextLimit.value =
            settings.context_length == null
              ? ""
              : String(settings.context_length);
        }
        updateCharacterCounts();
      };

      const restoreDefaultSettings = () => {
        const defaultBase = llmRanking.querySelector(
          "[data-llm-default-base]",
        );
        baseGuidance.value = defaultBase?.value ?? "";
        families.forEach((family) => {
          const defaultFamily = llmRanking.querySelector(
            `[data-llm-default-family="${family}"]`,
          );
          familyGuidance[family].value =
            defaultFamily?.value ?? "";
        });
        candidateLimit.value =
          llmRanking.dataset.llmDefaultCandidateLimit || "5";
        resultLimit.value =
          llmRanking.dataset.llmDefaultResultLimit || "3";
        feedbackMode.value =
          llmRanking.dataset.llmDefaultFeedbackMode ||
          "bad_and_archived";
        feedbackLimit.value =
          llmRanking.dataset.llmDefaultFeedbackLimit || "12";
        contextLimit.value =
          llmRanking.dataset.llmDefaultContextLength || "";
        updateCharacterCounts();
        if (actionStatus) {
          actionStatus.textContent =
            "Default loaded. Save to activate it.";
        }
        schedulePreview({ immediate: true });
      };

      restoreDefault?.addEventListener(
        "click",
        restoreDefaultSettings,
      );

      testDraft?.addEventListener("click", async () => {
        if (llmActionBusy || !llmForm?.reportValidity()) return;
        setLlmActionBusy(true);
        previewController?.abort();
        if (actionStatus) {
          actionStatus.textContent = "Testing draft…";
        }
        try {
          const result = await requestJson(
            "/api/v1/settings/insights/llm/test",
            {
              body: {
                family: familySelect?.value || "weekly",
                settings: draftSettings(),
              },
            },
          );
          const test = result?.test ?? result;
          const selection =
            test.selection?.finding_ids ??
            test.selection?.findingIds ??
            test.selected_ids ??
            [];
          const telemetry = test.telemetry ?? {};
          const summaryParts = [
            test.status
              ? String(test.status).replaceAll("_", " ")
              : "Test completed",
          ];
          if (selection.length) {
            summaryParts.push(
              `${selection.length} validated ID${
                selection.length === 1 ? "" : "s"
              }`,
            );
          }
          const usage =
            test.actual_usage ??
            telemetry.actual_usage ??
            telemetry.usage ??
            test.usage;
          if (formattedUsage(usage) !== "Unavailable") {
            summaryParts.push(formattedUsage(usage));
          }
          if (telemetry.latency_ms ?? test.latency_ms) {
            summaryParts.push(
              `${formattedInteger(
                telemetry.latency_ms ?? test.latency_ms,
              )} ms`,
            );
          }
          if (telemetry.finish_reason ?? test.finish_reason) {
            summaryParts.push(
              `finish: ${
                telemetry.finish_reason ?? test.finish_reason
              }`,
            );
          }
          if (testSummary) {
            testSummary.textContent = summaryParts.join(" · ");
          }
          const rawResponse =
            test.raw_response ??
            result.raw_response ??
            test.response ??
            null;
          if (testOutput) {
            testOutput.textContent =
              rawResponse == null
                ? "The provider returned no response body."
                : typeof rawResponse === "string"
                  ? rawResponse
                  : JSON.stringify(rawResponse, null, 2);
          }
          if (testResult) testResult.hidden = false;
          if (actionStatus) {
            const testStatusMessages = {
              succeeded: "Draft tested. Nothing was saved.",
              no_candidates:
                "Draft test did not run: no active candidates. Nothing was saved.",
              not_configured:
                "Draft test failed: LM Studio is not configured. Nothing was saved.",
              timeout:
                "Draft test failed: LM Studio timed out. Nothing was saved.",
              provider_error:
                "Draft test failed: LM Studio returned an error. Nothing was saved.",
              context_error:
                "Draft test failed: the request exceeded the model context. Nothing was saved.",
              length:
                "Draft test failed: the model response hit its output limit. Nothing was saved.",
              invalid_response:
                "Draft test failed: the model returned an invalid selection. Nothing was saved.",
            };
            actionStatus.textContent =
              testStatusMessages[test.status] ||
              `Draft test failed: ${String(
                test.status || "unknown error",
              ).replaceAll("_", " ")}. Nothing was saved.`;
          }
          if (
            test.request_body ||
            test.preview ||
            result.request_body ||
            result.preview
          ) {
            renderPreview(result);
          }
        } catch (error) {
          if (actionStatus) {
            actionStatus.textContent =
              error.message || "Couldn’t test the draft.";
          }
          if (testResult) testResult.hidden = true;
        } finally {
          setLlmActionBusy(false);
        }
      });

      llmForm?.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (llmActionBusy || !llmForm.reportValidity()) return;
        setLlmActionBusy(true);
        previewController?.abort();
        if (actionStatus) {
          actionStatus.textContent = "Saving guidance…";
        }
        try {
          const result = await requestJson(
            "/api/v1/settings/insights/llm",
            {
              method: "PUT",
              body: {
                expected_revision: Number(
                  llmRanking.dataset.llmRevision || 0,
                ),
                settings: draftSettings(),
              },
            },
          );
          const settings = result.settings ?? result;
          applySettings(settings);
          const revision = Number(
            settings.revision ?? result.revision,
          );
          if (Number.isFinite(revision)) {
            llmRanking.dataset.llmRevision = String(revision);
            if (savedRevision) {
              savedRevision.textContent = String(revision);
            }
          }
          updateRevisionNote();
          if (actionStatus) {
            actionStatus.textContent = Number.isFinite(revision)
              ? `Guidance saved as revision ${revision}. It will apply on the next run.`
              : "Guidance saved. It will apply on the next run.";
          }
          schedulePreview({ immediate: true });
        } catch (error) {
          if (actionStatus) {
            actionStatus.textContent =
              error.status === 409
                ? "These settings changed elsewhere. Refresh before saving."
                : error.message || "Couldn’t save guidance.";
          }
        } finally {
          setLlmActionBusy(false);
        }
      });

      llmForm?.addEventListener("input", () => {
        updateCharacterCounts();
        schedulePreview();
      });
      llmForm?.addEventListener("change", (event) => {
        if (event.target === familySelect) {
          showSelectedFamily();
        }
        schedulePreview();
      });

      showSelectedFamily();
      updateCharacterCounts();
      updateRevisionNote();
      schedulePreview({ immediate: true });
    }

    const saveRule = async (ruleId, settings) => {
      const response = await fetch(`/api/v1/settings/insight-rules/${encodeURIComponent(ruleId)}`, {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ settings }),
      });
      if (!response.ok) throw new Error(`Rule save failed with ${response.status}`);
      return response.json();
    };

    document.querySelectorAll("[data-save-form]").forEach((form) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const status = form.querySelector("[data-save-status]");
        const submit = form.querySelector('button[type="submit"]');
        const values = new FormData(form);
        submit?.setAttribute("disabled", "");
        if (status) status.textContent = "Saving…";
        try {
          await Promise.all([
            saveRule("weekly.spend_less", {
              minimum_change_basis_points: Math.round(Number(values.get("weekly_percent")) * 100),
              minimum_change_minor: Math.round(Number(values.get("weekly_dollars")) * 100),
            }),
            saveRule("subscriptions.expensive", {
              monthly_threshold_minor: Math.round(Number(values.get("subscription_dollars")) * 100),
            }),
            saveRule("investments.concentration", {
              threshold_basis_points: Math.round(Number(values.get("concentration_percent")) * 100),
            }),
          ]);
          if (status) status.textContent = "Rules saved";
        } catch {
          if (status) status.textContent = "Couldn’t save rules";
        } finally {
          submit?.removeAttribute("disabled");
        }
      });
    });

    document
      .querySelector("[data-category-create-form]")
      ?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const status = form.querySelector("[data-save-status]");
        const submit = form.querySelector('button[type="submit"]');
        const values = new FormData(form);
        submit?.setAttribute("disabled", "");
        if (status) status.textContent = "Creating…";
        try {
          await requestJson("/api/v1/categories", {
            body: {
              name: values.get("name"),
              classification: values.get("classification"),
              parent_category_id:
                values.get("parent_category_id") || null,
            },
          });
          if (status) status.textContent = "Category created";
          window.location.reload();
        } catch (error) {
          if (status) status.textContent = error.message;
          submit?.removeAttribute("disabled");
        }
      });

    const categoryManager = document.querySelector(
      "[data-category-manager]",
    );
    const categoryEditToggle = categoryManager?.querySelector(
      "[data-category-edit-toggle]",
    );
    const categoryMergeStart = categoryManager?.querySelector(
      "[data-category-merge-start]",
    );
    const categoryGlobalStatus = categoryManager?.querySelector(
      "[data-category-global-status]",
    );
    const categoryEditForms = [
      ...(categoryManager?.querySelectorAll(
        "[data-category-edit-form]",
      ) ?? []),
    ];
    const setCategoryEditing = (editing) => {
      if (!categoryManager || !categoryEditToggle) return;
      categoryManager.dataset.categoryEditing = String(editing);
      categoryEditToggle.textContent = editing
        ? "Save changes"
        : "Edit categories";
      if (categoryMergeStart) {
        categoryMergeStart.disabled = editing;
      }
      categoryEditForms.forEach((form) => {
        form.toggleAttribute("hidden", !editing);
      });
      if (!editing && categoryGlobalStatus) {
        categoryGlobalStatus.textContent = "";
      }
    };
    categoryEditForms.forEach((form) => {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        categoryEditToggle?.click();
      });
    });
    categoryEditToggle?.addEventListener("click", async () => {
      const editing =
        categoryManager?.dataset.categoryEditing === "true";
      if (!editing) {
        setCategoryEditing(true);
        categoryEditForms[0]
          ?.querySelector('input[name="name"]')
          ?.focus();
        return;
      }
      const changes = categoryEditForms.flatMap((form) => {
        const values = new FormData(form);
        const name = String(values.get("name") || "");
        const classification = String(
          values.get("classification") || "",
        );
        const parentCategoryId = String(
          values.get("parent_category_id") || "",
        );
        if (
          name === form.dataset.originalName &&
          classification === form.dataset.originalClassification &&
          parentCategoryId === form.dataset.originalParentId
        ) {
          return [];
        }
        return [{
          form,
          name,
          classification,
          parentCategoryId,
        }];
      });
      if (!changes.length) {
        setCategoryEditing(false);
        return;
      }
      categoryEditToggle.setAttribute("disabled", "");
      if (categoryGlobalStatus) {
        categoryGlobalStatus.textContent =
          `Saving ${changes.length} change${changes.length === 1 ? "" : "s"}…`;
      }
      try {
        for (const change of changes) {
          const row = change.form.closest("[data-category-row]");
          const response = await requestJson(change.form.dataset.endpoint, {
            method: "PATCH",
            body: {
              name: change.name,
              classification: change.classification,
              parent_category_id: change.parentCategoryId || null,
              expected_version: Number(row?.dataset.categoryVersion),
            },
          });
          change.form.dataset.originalName = change.name;
          change.form.dataset.originalClassification =
            change.classification;
          change.form.dataset.originalParentId =
            change.parentCategoryId;
          if (row && response?.category?.version) {
            row.dataset.categoryVersion =
              String(response.category.version);
          }
        }
        if (categoryGlobalStatus) {
          categoryGlobalStatus.textContent = "Changes saved";
        }
        window.location.reload();
      } catch (error) {
        if (categoryGlobalStatus) {
          categoryGlobalStatus.textContent = error.message;
        }
        categoryEditToggle.removeAttribute("disabled");
      }
    });

    categoryManager
      ?.querySelectorAll("[data-category-delete]")
      .forEach((button) => {
        button.addEventListener("click", async () => {
          const row = button.closest("[data-category-row]");
          const form = button.closest("[data-category-edit-form]");
          const name =
            form?.dataset.originalName || "this category";
          const confirmed = window.confirm(
            `Delete “${name}”? Its transactions and budgets will move to Other. ` +
              "Child categories will move up one level.",
          );
          if (!confirmed) return;
          button.setAttribute("disabled", "");
          if (categoryGlobalStatus) {
            categoryGlobalStatus.textContent = `Deleting ${name}…`;
          }
          try {
            await requestJson(button.dataset.endpoint, {
              method: "DELETE",
              body: {
                expected_version: Number(
                  row?.dataset.categoryVersion,
                ),
              },
            });
            if (categoryGlobalStatus) {
              categoryGlobalStatus.textContent =
                `${name} deleted; spending moved to Other`;
            }
            window.location.reload();
          } catch (error) {
            if (categoryGlobalStatus) {
              categoryGlobalStatus.textContent = error.message;
            }
            button.removeAttribute("disabled");
          }
        });
      });

    document
      .querySelectorAll("[data-category-split]")
      .forEach((button) => {
        button.addEventListener("click", async () => {
          const row = button.closest("[data-category-merged-row]");
          const status = row?.querySelector("[data-save-status]");
          button.setAttribute("disabled", "");
          if (status) status.textContent = "Splitting…";
          try {
            await requestJson(button.dataset.endpoint, {
              body: {
                expected_version: Number(
                  row?.dataset.categoryVersion,
                ),
              },
            });
            if (status) status.textContent = "Category restored";
            window.location.reload();
          } catch (error) {
            if (status) status.textContent = error.message;
            button.removeAttribute("disabled");
          }
        });
      });

    const mergeForm = document.querySelector(
      "[data-category-merge-form]",
    );
    const mergeDestination = mergeForm?.querySelector(
      "[data-category-merge-destination]",
    );
    const mergeNewFields = mergeForm?.querySelector(
      "[data-category-merge-new]",
    );
    const mergeControls = [
      ...(categoryManager?.querySelectorAll(
        "[data-category-merge-control]",
      ) ?? []),
    ];
    const mergeInputs = mergeControls
      .map((control) => control.querySelector("[data-category-select]"))
      .filter(Boolean);
    const mergeRows = mergeInputs
      .map((input) => input.closest("[data-category-row]"))
      .filter(Boolean);
    const mergeSummary = mergeForm?.querySelector(
      "[data-category-merge-summary]",
    );
    const mergeStatus = mergeForm?.querySelector("[data-save-status]");
    const mergeSubmit = mergeForm?.querySelector(
      'button[type="submit"]',
    );
    const mergeCancel = mergeForm?.querySelector(
      "[data-category-merge-cancel]",
    );
    const mergeName = mergeForm?.querySelector('input[name="name"]');
    let mergeMode = false;
    let mergeBusy = false;

    const selectedMergeRows = () =>
      mergeRows.filter(
        (row) => row.querySelector("[data-category-select]")?.checked,
      );

    const updateMergeState = () => {
      if (!mergeForm || !mergeDestination) return;
      const selectedRows = selectedMergeRows();
      const selectedIds = new Set(
        selectedRows.map((row) => row.dataset.categoryId),
      );

      mergeDestination.querySelectorAll("option").forEach((option) => {
        if (!option.value || option.value === "__new__") return;
        const isSource = selectedIds.has(option.value);
        option.hidden = isSource;
        option.disabled = isSource;
      });
      if (selectedIds.has(mergeDestination.value)) {
        mergeDestination.value = "";
      }

      const createsNew = mergeDestination.value === "__new__";
      mergeNewFields?.toggleAttribute("hidden", !createsNew);
      mergeName?.toggleAttribute("required", createsNew);

      const transactionCount = selectedRows.reduce(
        (sum, row) =>
          sum + Number(row.dataset.categoryTransactionCount || 0),
        0,
      );
      const budgetCount = selectedRows.reduce(
        (sum, row) =>
          sum + Number(row.dataset.categoryBudgetCount || 0),
        0,
      );
      const destinationOption =
        mergeDestination.selectedOptions?.[0];
      const destinationLabel = createsNew
        ? mergeName?.value.trim()
          ? `New “${mergeName.value.trim()}”`
          : "New category (name required)"
        : mergeDestination.value
          ? destinationOption?.textContent.trim()
          : "Choose a destination";
      if (mergeSummary) {
        mergeSummary.textContent = selectedRows.length
          ? `${selectedRows.length} selected · Destination: ${destinationLabel} · ${transactionCount} transactions · ${budgetCount} budget lines`
          : "Select the categories to merge.";
      }

      const validDestination =
        Boolean(mergeDestination.value) &&
        (!createsNew || Boolean(mergeName?.value.trim()));
      if (mergeSubmit) {
        mergeSubmit.disabled =
          mergeBusy || selectedRows.length === 0 || !validDestination;
      }
      if (mergeCancel) mergeCancel.disabled = mergeBusy;
    };

    const setMergeMode = (
      active,
      { restoreFocus = false } = {},
    ) => {
      if (
        !categoryManager ||
        !categoryMergeStart ||
        !mergeForm
      ) {
        return;
      }
      mergeMode = active;
      categoryManager.dataset.categoryMergeMode = String(active);
      categoryMergeStart.hidden = active;
      categoryEditToggle?.toggleAttribute("disabled", active);
      mergeForm.hidden = !active;
      mergeForm.style.display = active ? "" : "none";
      mergeForm.toggleAttribute("inert", !active);
      mergeControls.forEach((control) => {
        control.hidden = !active;
        control.style.display = active ? "" : "none";
      });
      if (active) {
        setCategoryEditing(false);
        if (categoryGlobalStatus) categoryGlobalStatus.textContent = "";
      } else {
        mergeInputs.forEach((input) => {
          input.checked = false;
        });
        mergeForm.reset();
        if (mergeStatus) mergeStatus.textContent = "";
      }
      updateMergeState();
      if (active) {
        mergeInputs[0]?.focus();
      } else if (restoreFocus) {
        categoryMergeStart.focus();
      }
    };

    categoryMergeStart?.addEventListener("click", () => {
      setMergeMode(true);
    });
    mergeCancel?.addEventListener("click", () => {
      if (mergeBusy) return;
      setMergeMode(false, { restoreFocus: true });
    });
    mergeDestination?.addEventListener("change", updateMergeState);
    mergeName?.addEventListener("input", updateMergeState);
    mergeInputs.forEach((input) => {
      input.addEventListener("change", updateMergeState);
    });
    mergeRows.forEach((row) => {
      row.addEventListener("click", (event) => {
        if (
          !mergeMode ||
          event.target.closest(
            "input, button, a, select, textarea, summary, details, form",
          )
        ) {
          return;
        }
        row.querySelector("[data-category-select]")?.click();
      });
    });
    mergeForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const selectedRows = selectedMergeRows();
      if (!selectedRows.length) {
        if (mergeStatus) {
          mergeStatus.textContent = "Select at least one category";
        }
        mergeInputs[0]?.focus();
        return;
      }
      const values = new FormData(mergeForm);
      const existingDestination =
        values.get("destination_category_id") !== "__new__"
          ? String(values.get("destination_category_id"))
          : null;
      const sourceCategoryIds = selectedRows.map(
        (row) => row.dataset.categoryId,
      );
      if (
        !existingDestination &&
        values.get("destination_category_id") !== "__new__"
      ) {
        if (mergeStatus) {
          mergeStatus.textContent = "Choose a destination";
        }
        mergeDestination?.focus();
        return;
      }
      if (
        values.get("destination_category_id") === "__new__" &&
        !String(values.get("name") || "").trim()
      ) {
        if (mergeStatus) {
          mergeStatus.textContent = "Enter a name for the destination";
        }
        mergeName?.focus();
        return;
      }
      const sourceLabels = selectedRows.map(
        (row) => row.dataset.categoryPath || "Unnamed category",
      );
      const destinationLabel = existingDestination
        ? mergeDestination?.selectedOptions?.[0]?.textContent.trim()
        : `new category “${String(values.get("name") || "").trim()}”`;
      const confirmed = window.confirm(
        `Merge ${sourceLabels.join(", ")} into ${destinationLabel}? ` +
          "Old and future transactions will resolve to this destination.",
      );
      if (!confirmed) {
        mergeSubmit?.focus();
        return;
      }
      const versionRows = [
        ...selectedRows,
        ...(existingDestination
          ? [
              document.querySelector(
                `[data-category-row][data-category-id="${CSS.escape(existingDestination)}"]`,
              ),
            ].filter(Boolean)
          : []),
      ];
      const expectedVersions = Object.fromEntries(
        versionRows.map((row) => [
          row.dataset.categoryId,
          Number(row.dataset.categoryVersion),
        ]),
      );
      mergeBusy = true;
      updateMergeState();
      if (mergeStatus) mergeStatus.textContent = "Merging…";
      try {
        await requestJson("/api/v1/categories/merge", {
          body: {
            source_category_ids: sourceCategoryIds,
            destination: existingDestination
              ? { category_id: existingDestination }
              : {
                  name: values.get("name"),
                  classification: values.get("classification"),
                  parent_category_id:
                    values.get("parent_category_id") || null,
                },
            expected_versions: expectedVersions,
          },
        });
        if (mergeStatus) {
          mergeStatus.textContent = "Categories merged";
        }
        window.location.reload();
      } catch (error) {
        mergeBusy = false;
        if (mergeStatus) mergeStatus.textContent = error.message;
        updateMergeState();
        mergeSubmit?.focus();
      }
    });
    setMergeMode(false);

    document.querySelectorAll("[data-account-group-form]").forEach((form) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const accountId = form.dataset.accountId;
        const select = form.querySelector('select[name="balance_group"]');
        const status = form.querySelector("[data-save-status]");
        const submit = form.querySelector('button[type="submit"]');
        submit.disabled = true;
        if (status) status.textContent = "Saving…";
        try {
          await requestJson(
            `/api/v1/accounts/${encodeURIComponent(accountId)}/balance-group`,
            {
              method: "PUT",
              body: { balance_group: select.value || null },
            },
          );
          const current = form.querySelector("small");
          if (current) {
            const prefix = current.textContent.split(" · currently ")[0];
            current.textContent = `${prefix} · currently ${
              select.value ? wealthGroupLabels[select.value] : "automatic"
            }`;
          }
          if (status) status.textContent = "Saved";
        } catch (error) {
          if (status) status.textContent = error.message || "Couldn’t save";
        } finally {
          submit.disabled = false;
        }
      });
    });

    const currencyFractionDigits = (currency) => {
      try {
        return new Intl.NumberFormat("en", {
          style: "currency",
          currency,
        }).resolvedOptions().maximumFractionDigits;
      } catch {
        throw new Error("Use a valid three-letter currency code");
      }
    };

    const decimalToMinor = (rawValue, currency) => {
      const normalized = String(rawValue ?? "")
        .trim()
        .replace(new RegExp(`^${currency}\\s*`, "i"), "")
        .replace(/^[$€£¥₹]\s*/, "")
        .replaceAll(",", "")
        .replace(/\s/g, "");
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
        throw new Error("Enter a valid non-negative asset value");
      }
      const digits = currencyFractionDigits(currency);
      const [whole, fraction = ""] = normalized.split(".");
      if (fraction.length > digits) {
        throw new Error(
          `${currency} values support ${digits} decimal place${digits === 1 ? "" : "s"}`,
        );
      }
      const scale = 10n ** BigInt(digits);
      const fractionMinor = BigInt(
        fraction.padEnd(digits, "0") || "0",
      );
      const amount = BigInt(whole) * scale + fractionMinor;
      if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("That value is too large");
      }
      return Number(amount);
    };

    const updateCurrencyInput = (form) => {
      const currencyInput = form.querySelector('[name="currency_code"]');
      const valueInput = form.querySelector('[name="value"]');
      if (!currencyInput || !valueInput) return;
      const currency = currencyInput.value.trim().toUpperCase();
      try {
        const digits = currencyFractionDigits(currency);
        valueInput.placeholder =
          digits === 0 ? "0" : `0.${"0".repeat(digits)}`;
      } catch {
        valueInput.placeholder = "0.00";
      }
    };

    const manualAssetPayload = (form) => {
      const values = new FormData(form);
      const currencyCode = String(values.get("currency_code") || "")
        .trim()
        .toUpperCase();
      if (!/^[A-Z]{3}$/.test(currencyCode)) {
        throw new Error("Use a three-letter currency code");
      }
      const valuedOn = String(values.get("valued_on") || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(valuedOn)) {
        throw new Error("Choose an as-of date");
      }
      return {
        name: String(values.get("name") || "").trim(),
        asset_type: String(values.get("asset_type") || ""),
        description: String(values.get("description") || "").trim() || null,
        currency_code: currencyCode,
        value_minor: decimalToMinor(values.get("value"), currencyCode),
        valued_on: valuedOn,
      };
    };

    document.querySelectorAll("[data-manual-asset-create], [data-manual-asset-edit]").forEach((form) => {
      updateCurrencyInput(form);
      form
        .querySelector('[name="currency_code"]')
        ?.addEventListener("input", () => updateCurrencyInput(form));
    });

    document.querySelector("[data-manual-asset-create]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const status = form.querySelector("[data-save-status]");
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      if (status) status.textContent = "Saving…";
      try {
        const payload = manualAssetPayload(form);
        const result = await requestJson("/api/v1/manual-assets", {
          body: payload,
        });
        if (result.demo) {
          const empty = document.querySelector("[data-manual-assets-empty]");
          empty?.remove();
          const confirmation = document.createElement("p");
          confirmation.className = "manual-asset-confirmation";
          confirmation.textContent = `${payload.name} added at ${new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: payload.currency_code,
          }).format(
            payload.value_minor /
              10 ** currencyFractionDigits(payload.currency_code),
          )}.`;
          document.querySelector("[data-manual-asset-list]")?.prepend(confirmation);
          form.reset();
          const date = form.querySelector('[name="valued_on"]');
          if (date) date.value = new Date().toISOString().slice(0, 10);
          const currency = form.querySelector('[name="currency_code"]');
          if (currency) currency.value = "USD";
          updateCurrencyInput(form);
          if (status) status.textContent = "Asset added";
        } else {
          const assetId = result.asset?.id;
          if (assetId) {
            const encodedAssetId = encodeURIComponent(assetId);
            window.location.assign(
              `/settings?asset=${encodedAssetId}#asset-${encodedAssetId}`,
            );
          } else {
            window.location.reload();
          }
        }
      } catch (error) {
        if (status) status.textContent = error.message || "Couldn’t add asset";
      } finally {
        submit.disabled = false;
      }
    });

    document.querySelectorAll("[data-manual-asset-edit]").forEach((form) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const assetId = form.dataset.assetId;
        const status = form.querySelector("[data-save-status]");
        const submit = form.querySelector('button[type="submit"]');
        submit.disabled = true;
        if (status) status.textContent = "Saving…";
        try {
          const result = await requestJson(
            `/api/v1/manual-assets/${encodeURIComponent(assetId)}`,
            {
              method: "PUT",
              body: manualAssetPayload(form),
            },
          );
          if (status) status.textContent = "Changes saved";
          if (!result.demo) window.location.reload();
        } catch (error) {
          if (status) status.textContent = error.message || "Couldn’t save changes";
        } finally {
          submit.disabled = false;
        }
      });
    });

    document.querySelectorAll("[data-manual-asset-archive]").forEach((button) => {
      button.addEventListener("click", async () => {
        const assetId = button.dataset.manualAssetArchive;
        const item = button.closest("[data-manual-asset-item]");
        const status = item?.querySelector("[data-save-status]");
        if (!window.confirm("Archive this asset? It will leave current net worth totals but retain its history.")) return;
        button.disabled = true;
        if (status) status.textContent = "Archiving…";
        try {
          await requestJson(
            `/api/v1/manual-assets/${encodeURIComponent(assetId)}`,
            { method: "DELETE" },
          );
          item?.remove();
          if (!document.querySelector("[data-manual-asset-item]")) {
            const empty = document.createElement("p");
            empty.className = "card-note";
            empty.dataset.manualAssetsEmpty = "";
            empty.textContent = "No manual assets yet.";
            document.querySelector("[data-manual-asset-list]")?.append(empty);
          }
        } catch (error) {
          button.disabled = false;
          if (status) status.textContent = error.message || "Couldn’t archive asset";
        }
      });
    });
  }

  function plaidLink() {
    const button = document.querySelector("[data-plaid-link]");
    const status = document.querySelector("[data-connection-status]");
    const oauthReturn = document.querySelector("[data-plaid-oauth-return]");
    if (
      !button &&
      !oauthReturn &&
      !document.querySelector("[data-plaid-update], [data-plaid-remove]")
    ) {
      return;
    }
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || "";
    const oauthStorageKey = "money.plaid.oauth";
    let loadingPromise;

    const clearOauthSession = () => {
      try {
        window.localStorage.removeItem(oauthStorageKey);
      } catch {
        // A browser that blocks same-origin storage cannot safely resume OAuth.
      }
    };

    const storeOauthSession = ({ token, expiration, itemId }) => {
      const expiresAt = Date.parse(expiration);
      if (!token || !Number.isFinite(expiresAt)) {
        throw new Error("Plaid returned an invalid connection session");
      }
      window.localStorage.setItem(
        oauthStorageKey,
        JSON.stringify({
          token,
          expires_at: expiresAt,
          item_id: itemId,
        }),
      );
    };

    const readOauthSession = () => {
      try {
        const session = JSON.parse(
          window.localStorage.getItem(oauthStorageKey) || "null",
        );
        if (
          typeof session?.token !== "string" ||
          !session.token ||
          !Number.isFinite(session.expires_at) ||
          session.expires_at <= Date.now() ||
          !(
            session.item_id === null ||
            typeof session.item_id === "string"
          )
        ) {
          clearOauthSession();
          return null;
        }
        return session;
      } catch {
        clearOauthSession();
        return null;
      }
    };

    const claimOauthSession = (token) => {
      const session = readOauthSession();
      if (!session || session.token !== token) return false;
      clearOauthSession();
      return true;
    };

    const loadScript = () => {
      if (window.Plaid) return Promise.resolve();
      if (loadingPromise) return loadingPromise;
      loadingPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
        script.async = true;
        script.onload = resolve;
        script.onerror = () => reject(new Error("Plaid Link failed to load"));
        document.head.append(script);
      });
      return loadingPromise;
    };

    const postJson = async (url, body = {}) => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || "Connection failed");
      return payload;
    };

    const createHandler = ({
      token,
      itemId,
      trigger = null,
      receivedRedirectUri = null,
    }) =>
      window.Plaid.create({
        token,
        ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
        onSuccess: async (publicToken, metadata) => {
          if (!claimOauthSession(token)) {
            if (status) {
              status.textContent =
                "This connection is already finishing in another window.";
            }
            return;
          }
          try {
            if (status) {
              status.textContent = itemId
                ? "Connection repaired. Starting a sync…"
                : "Connecting and starting the first sync…";
            }
            if (itemId) {
              await postJson(
                `/api/v1/plaid/items/${encodeURIComponent(itemId)}/sync`,
              );
            } else {
              await postJson("/api/v1/plaid/exchange", {
                public_token: publicToken,
                institution_id: metadata?.institution?.institution_id,
                institution_name: metadata?.institution?.name,
              });
            }
            if (status) {
              status.textContent = itemId
                ? "Reconnected. A fresh sync is running."
                : "Connected. Your first sync is queued.";
            }
            window.setTimeout(() => {
              if (oauthReturn) {
                window.location.assign("/settings#connections");
              } else {
                window.location.reload();
              }
            }, 900);
          } catch (error) {
            if (trigger) trigger.disabled = false;
            if (status) {
              status.textContent =
                error.message ||
                "The connection succeeded, but sync could not start.";
            }
          }
        },
        onExit: (error) => {
          clearOauthSession();
          if (trigger) trigger.disabled = false;
          if (status) {
            status.textContent = error
              ? "Plaid Link closed with an error."
              : "";
          }
        },
      });

    const launch = async ({ trigger, linkTokenUrl, itemId = null }) => {
      trigger.disabled = true;
      if (status) status.textContent = "Opening Plaid Link…";
      try {
        const [{ link_token: token, expiration }] = await Promise.all([
          postJson(linkTokenUrl),
          loadScript(),
        ]);
        storeOauthSession({
          token,
          expiration,
          itemId,
        });
        const handler = createHandler({ token, itemId, trigger });
        handler.open();
      } catch (error) {
        clearOauthSession();
        trigger.disabled = false;
        if (status) status.textContent = error.message || "Plaid Link is unavailable.";
      }
    };

    button?.addEventListener("click", () =>
      launch({
        trigger: button,
        linkTokenUrl: "/api/v1/plaid/link-token",
      }),
    );

    document.querySelectorAll("[data-plaid-update]").forEach((trigger) => {
      trigger.addEventListener("click", () => {
        const itemId = trigger.dataset.plaidUpdate;
        launch({
          trigger,
          itemId,
          linkTokenUrl: `/api/v1/plaid/items/${encodeURIComponent(itemId)}/link-token`,
        });
      });
    });

    document.querySelectorAll("[data-plaid-remove]").forEach((trigger) => {
      trigger.addEventListener("click", async () => {
        const itemId = trigger.dataset.plaidRemove;
        const retainHistory = document.querySelector(
          `[data-retain-history="${CSS.escape(itemId)}"]`,
        )?.checked === true;
        const warning = retainHistory
          ? "Remove this Plaid connection and retain archived financial history?"
          : "Remove this Plaid connection and permanently purge its imported financial data?";
        if (!window.confirm(warning)) return;
        trigger.disabled = true;
        if (status) status.textContent = "Removing connection…";
        try {
          const response = await fetch(
            `/api/v1/plaid/items/${encodeURIComponent(itemId)}`,
            {
              method: "DELETE",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-CSRF-Token": csrfToken,
              },
              body: JSON.stringify({ retain_history: retainHistory }),
            },
          );
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.message || "Removal failed");
          }
          if (status) status.textContent = retainHistory
            ? "Connection removed. Archived history was retained."
            : "Connection and imported data removed.";
          window.setTimeout(() => window.location.reload(), 900);
        } catch (error) {
          trigger.disabled = false;
          if (status) status.textContent = error.message || "Couldn’t remove the connection.";
        }
      });
    });

    if (oauthReturn) {
      const receivedUrl = new URL(window.location.href);
      const parameters = [...receivedUrl.searchParams.keys()];
      const oauthStateId = receivedUrl.searchParams.get("oauth_state_id");
      const session = readOauthSession();
      if (
        !oauthStateId ||
        parameters.length !== 1 ||
        parameters[0] !== "oauth_state_id" ||
        receivedUrl.hash ||
        !session
      ) {
        if (status) {
          status.textContent =
            "This Plaid connection session expired. Return to Settings and try again.";
        }
        return;
      }
      loadScript()
        .then(() => {
          const handler = createHandler({
            token: session.token,
            itemId: session.item_id,
            receivedRedirectUri: receivedUrl.href,
          });
          handler.open();
        })
        .catch((error) => {
          if (status) {
            status.textContent =
              error.message || "Plaid Link is unavailable.";
          }
        });
    }
  }

  function appleCardImport() {
    const importDialog = document.querySelector(
      "[data-apple-card-import-dialog]",
    );
    const importForm = document.querySelector(
      "[data-apple-card-import-form]",
    );
    const confirmButton = document.querySelector(
      "[data-apple-card-import-confirm]",
    );
    const previewCopy = document.querySelector(
      "[data-apple-card-preview-copy]",
    );
    const previewResults = document.querySelector(
      "[data-apple-card-preview-results]",
    );
    const previewWarnings = document.querySelector(
      "[data-apple-card-preview-warnings]",
    );
    const importStatus = document.querySelector(
      "[data-apple-card-import-status]",
    );
    const valuesDialog = document.querySelector(
      "[data-apple-card-values-dialog]",
    );
    const valuesForm = document.querySelector(
      "[data-apple-card-values-form]",
    );
    const connectionStatus = document.querySelector(
      "[data-connection-status]",
    );
    if (!importDialog && !valuesDialog) return;

    const csrfToken =
      document.querySelector('meta[name="csrf-token"]')?.content || "";
    let previewDigest = null;
    const appleCardUploadType =
      "application/vnd.money.apple-card-import";

    const money = (amountMinor) =>
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(Number(amountMinor || 0) / 100);

    const fetchJson = async (url, options = {}) => {
      const response = await fetch(url, {
        ...options,
        headers: {
          Accept: "application/json",
          "X-CSRF-Token": csrfToken,
          ...(options.headers || {}),
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || `Request failed with ${response.status}`);
      }
      return payload;
    };

    const appleCardUploadPayload = async (form, digest = null) => {
      const values = new FormData(form);
      const file = values.get("file");
      if (!(file instanceof File) || file.size === 0) {
        throw new Error("Choose an Apple Card CSV to upload.");
      }
      if (file.size > 2 * 1024 * 1024) {
        throw new Error("The CSV exceeds the 2 MiB limit.");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const chunks = [];
      for (let offset = 0; offset < bytes.length; offset += 32_768) {
        chunks.push(
          String.fromCharCode(...bytes.subarray(offset, offset + 32_768)),
        );
      }
      return {
        file_base64: window.btoa(chunks.join("")),
        balance: String(values.get("balance") || ""),
        credit_limit: String(values.get("credit_limit") || ""),
        balance_as_of: String(values.get("balance_as_of") || ""),
        last_four: String(values.get("last_four") || ""),
        ...(digest ? { preview_digest: digest } : {}),
      };
    };

    const resetPreview = () => {
      previewDigest = null;
      if (confirmButton) confirmButton.disabled = true;
      if (previewResults) {
        previewResults.hidden = true;
        previewResults.replaceChildren();
      }
      if (previewWarnings) {
        previewWarnings.hidden = true;
        previewWarnings.replaceChildren();
      }
      if (previewCopy) {
        previewCopy.textContent =
          "Choose a file and preview it before anything is written.";
      }
      if (importStatus) importStatus.textContent = "";
    };

    const addPreviewValue = (label, value) => {
      const item = document.createElement("div");
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      term.textContent = label;
      detail.textContent = String(value);
      item.append(term, detail);
      previewResults?.append(item);
    };

    document
      .querySelectorAll("[data-apple-card-import-open]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          resetPreview();
          importDialog?.showModal();
        });
      });

    document
      .querySelectorAll("[data-apple-card-values-open]")
      .forEach((button) => {
        button.addEventListener("click", () => valuesDialog?.showModal());
      });

    document
      .querySelectorAll("[data-apple-card-dialog-close]")
      .forEach((button) => {
        button.addEventListener("click", () =>
          button.closest("dialog")?.close(),
        );
      });

    importForm?.addEventListener("input", resetPreview);
    importForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!importForm.reportValidity()) return;
      const submit = importForm.querySelector('button[type="submit"]');
      submit.disabled = true;
      if (importStatus) importStatus.textContent = "Checking the CSV…";
      try {
        const payload = await fetchJson(
          "/api/v1/apple-card/imports/preview",
          {
            method: "POST",
            headers: { "Content-Type": appleCardUploadType },
            body: JSON.stringify(
              await appleCardUploadPayload(importForm),
            ),
          },
        );
        previewDigest = payload.preview_digest;
        if (previewCopy) {
          previewCopy.textContent = payload.posted_start_on
            ? `Posted ${payload.posted_start_on} through ${payload.posted_end_on}.`
            : "No valid posted transactions found.";
        }
        previewResults?.replaceChildren();
        addPreviewValue("Charges", money(payload.charge_total_minor));
        addPreviewValue("Credits", money(payload.credit_total_minor));
        addPreviewValue("New", payload.new_row_count);
        addPreviewValue("Already imported", payload.existing_row_count);
        addPreviewValue("Rejected", payload.rejected_row_count);
        addPreviewValue("Warnings", payload.warning_count);
        if (previewResults) previewResults.hidden = false;

        const notices = [
          ...(payload.rejected || []),
          ...(payload.warnings || []),
        ];
        previewWarnings?.replaceChildren();
        notices.slice(0, 12).forEach((notice) => {
          const item = document.createElement("li");
          item.textContent = `Row ${notice.row}: ${notice.message}`;
          previewWarnings?.append(item);
        });
        if (previewWarnings) previewWarnings.hidden = notices.length === 0;
        const canImport =
          payload.accepted_row_count > 0 &&
          payload.rejected_row_count === 0;
        if (confirmButton) confirmButton.disabled = !canImport;
        if (importStatus) {
          importStatus.textContent = canImport
            ? "Preview ready. No data has been written."
            : "Fix rejected rows before importing.";
        }
      } catch (error) {
        resetPreview();
        if (importStatus) {
          importStatus.textContent =
            error.message || "Couldn’t preview the CSV.";
        }
      } finally {
        submit.disabled = false;
      }
    });

    confirmButton?.addEventListener("click", async () => {
      if (!previewDigest || !importForm?.reportValidity()) return;
      confirmButton.disabled = true;
      const submit = importForm.querySelector('button[type="submit"]');
      submit.disabled = true;
      if (importStatus) importStatus.textContent = "Importing transactions…";
      try {
        const payload = await fetchJson("/api/v1/apple-card/imports", {
          method: "POST",
          headers: { "Content-Type": appleCardUploadType },
          body: JSON.stringify(
            await appleCardUploadPayload(importForm, previewDigest),
          ),
        });
        if (importStatus) {
          importStatus.textContent =
            `Imported ${payload.new_row_count} new transaction${
              payload.new_row_count === 1 ? "" : "s"
            }; ${payload.existing_row_count} already existed.`;
        }
        window.setTimeout(() => window.location.reload(), 900);
      } catch (error) {
        if (importStatus) {
          importStatus.textContent =
            error.message || "Couldn’t import the CSV.";
        }
        confirmButton.disabled = false;
        submit.disabled = false;
      }
    });

    valuesForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!valuesForm.reportValidity()) return;
      const submit = valuesForm.querySelector('button[type="submit"]');
      const status = valuesForm.querySelector(
        "[data-apple-card-values-status]",
      );
      const values = new FormData(valuesForm);
      submit.disabled = true;
      if (status) status.textContent = "Saving…";
      try {
        await fetchJson("/api/v1/apple-card/account", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            balance: values.get("balance"),
            credit_limit: values.get("credit_limit"),
            balance_as_of: values.get("balance_as_of"),
            last_four: values.get("last_four"),
          }),
        });
        if (status) status.textContent = "Card values updated.";
        window.setTimeout(() => window.location.reload(), 700);
      } catch (error) {
        if (status) {
          status.textContent = error.message || "Couldn’t update values.";
        }
        submit.disabled = false;
      }
    });

    document
      .querySelectorAll("[data-apple-card-remove]")
      .forEach((button) => {
        button.addEventListener("click", async () => {
          const connectionId = button.dataset.connectionId;
          const retainHistory = document.querySelector(
            `[data-retain-history="${CSS.escape(connectionId)}"]`,
          )?.checked === true;
          const warning = retainHistory
            ? "Remove Apple Card and retain its archived history?"
            : "Remove Apple Card and permanently purge its imported transactions?";
          if (!window.confirm(warning)) return;
          button.disabled = true;
          if (connectionStatus) {
            connectionStatus.textContent = "Removing Apple Card…";
          }
          try {
            await fetchJson("/api/v1/apple-card/connection", {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ retain_history: retainHistory }),
            });
            window.location.reload();
          } catch (error) {
            button.disabled = false;
            if (connectionStatus) {
              connectionStatus.textContent =
                error.message || "Couldn’t remove Apple Card.";
            }
          }
        });
      });
  }

  function exportTransactions() {
    document.querySelector("[data-download]")?.addEventListener("click", () => {
      const rows = [...document.querySelectorAll(".transaction-list--ledger .transaction-row")];
      const csv = [
        ["Merchant", "Category and account", "Amount"],
        ...rows.map((row) => [
          row.querySelector(".transaction-row__main strong")?.textContent.trim() || "",
          row.querySelector(".transaction-row__main span")?.textContent.trim() || "",
          row.querySelector(".transaction-row__meta strong")?.textContent.trim() || "",
        ]),
      ].map((cells) => cells.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "money-transactions.csv";
      link.click();
      URL.revokeObjectURL(link.href);
    });
  }

  function transactionBulkEdit() {
    const root = document.querySelector("[data-bulk-transactions]");
    if (!root) return;

    const start = root.querySelector("[data-bulk-select-start]");
    const selectionBar = root.querySelector("[data-bulk-selection-bar]");
    const selectAll = root.querySelector("[data-bulk-select-all]");
    const selectedCount = root.querySelector("[data-bulk-selected-count]");
    const openEditor = root.querySelector("[data-bulk-edit-open]");
    const dialog = root.querySelector("[data-bulk-edit-dialog]");
    const form = root.querySelector("[data-bulk-edit-form]");
    const dialogCount = root.querySelector("[data-bulk-dialog-count]");
    const submit = root.querySelector("[data-bulk-edit-submit]");
    const status = root.querySelector("[data-bulk-edit-status]");
    const transactionFilter = document.querySelector(
      "[data-transaction-filter]",
    );
    const pagination = root.querySelector(".pagination");
    const rows = [...root.querySelectorAll("[data-bulk-transaction-row]")];
    const inputs = rows
      .map((row) => row.querySelector("[data-bulk-transaction-select]"))
      .filter(Boolean);
    const editableInputs = inputs.filter((input) => !input.disabled);
    const toggles = [
      ...root.querySelectorAll("[data-bulk-change]"),
    ];
    const csrfToken =
      document.querySelector('meta[name="csrf-token"]')?.content || "";
    let selectionMode = false;

    const selectedInputs = () =>
      editableInputs.filter((input) => input.checked);

    const updateSubmit = () => {
      if (!submit) return;
      submit.disabled =
        selectedInputs().length === 0 ||
        !toggles.some((toggle) => toggle.checked);
    };

    const updateSelection = () => {
      const count = selectedInputs().length;
      if (selectedCount) {
        selectedCount.textContent = `${count} selected`;
        selectedCount.setAttribute(
          "aria-label",
          count
            ? `${count} transaction${count === 1 ? "" : "s"} selected. Edit selected is available.`
            : "No transactions selected.",
        );
      }
      if (dialogCount) dialogCount.textContent = String(count);
      if (openEditor) {
        openEditor.disabled = count === 0;
        openEditor.textContent =
          count === 0 ? "Edit selected" : `Edit ${count} selected`;
      }
      if (selectAll) {
        selectAll.checked =
          editableInputs.length > 0 && count === editableInputs.length;
        selectAll.indeterminate =
          count > 0 && count < editableInputs.length;
      }
      updateSubmit();
    };

    const setSelectionMode = (
      active,
      { restoreFocus = false } = {},
    ) => {
      selectionMode = active;
      root.toggleAttribute("data-bulk-selection-mode", active);
      if (start) start.hidden = active;
      if (selectionBar) selectionBar.hidden = !active;
      if (transactionFilter) {
        transactionFilter.inert = active;
        transactionFilter.toggleAttribute(
          "data-selection-frozen",
          active,
        );
      }
      if (pagination) pagination.inert = active;
      rows.forEach((row) => {
        const control = row.querySelector(".transaction-select-control");
        if (control) control.hidden = !active;
        const link = row.querySelector(".transaction-row");
        if (link) {
          if (active) {
            link.setAttribute("aria-disabled", "true");
          } else {
            link.removeAttribute("aria-disabled");
          }
          link.inert = active;
        }
      });
      if (!active) {
        editableInputs.forEach((input) => {
          input.checked = false;
        });
        if (dialog?.open) dialog.close();
      }
      updateSelection();
      if (!active && restoreFocus) start?.focus();
    };

    const fieldForToggle = (toggle) => {
      const fields = {
        display_name: root.querySelector("[data-bulk-display-name]"),
        category_primary: root.querySelector("[data-bulk-category]"),
        tags: root.querySelector("[data-bulk-tags]"),
        excluded_from_spending: root.querySelector(
          "[data-bulk-excluded]",
        ),
        budget_month_offset: root.querySelector(
          "[data-bulk-budget-month]",
        ),
      };
      return fields[toggle.dataset.bulkChange];
    };

    toggles.forEach((toggle) => {
      const sync = () => {
        const field = fieldForToggle(toggle);
        if (field) field.disabled = !toggle.checked;
        updateSubmit();
      };
      toggle.addEventListener("change", sync);
      sync();
    });

    start?.addEventListener("click", () => {
      setSelectionMode(true);
      editableInputs[0]?.focus();
    });

    root
      .querySelector("[data-bulk-select-cancel]")
      ?.addEventListener("click", () =>
        setSelectionMode(false, { restoreFocus: true }),
      );

    selectAll?.addEventListener("change", () => {
      editableInputs.forEach((input) => {
        input.checked = selectAll.checked;
      });
      updateSelection();
    });

    inputs.forEach((input) =>
      input.addEventListener("change", updateSelection),
    );

    rows.forEach((row) => {
      const rowLink = row.querySelector(".transaction-row");
      row.addEventListener("click", (event) => {
        if (
          !selectionMode ||
          event.target.closest(".transaction-select-control")
        ) {
          return;
        }
        event.preventDefault();
        const input = row.querySelector(
          "[data-bulk-transaction-select]",
        );
        if (!input || input.disabled) return;
        input.click();
      });
      rowLink?.addEventListener("auxclick", (event) => {
        if (selectionMode) event.preventDefault();
      });
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !selectionMode) return;
      event.preventDefault();
      setSelectionMode(false, { restoreFocus: true });
    });

    openEditor?.addEventListener("click", () => {
      if (!selectedInputs().length || !dialog) return;
      if (status) status.textContent = "";
      updateSelection();
      dialog.showModal();
      toggles[0]?.focus();
    });

    root.querySelectorAll("[data-bulk-edit-close]").forEach((button) => {
      button.addEventListener("click", () => dialog?.close());
    });
    dialog?.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });

    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const transactionIds = selectedInputs().map((input) => input.value);
      const changes = {};
      if (
        root.querySelector('[data-bulk-change="display_name"]')?.checked
      ) {
        changes.display_name =
          root.querySelector("[data-bulk-display-name]")?.value.trim() ||
          null;
      }
      if (
        root.querySelector('[data-bulk-change="category_primary"]')
          ?.checked
      ) {
        const category =
          root.querySelector("[data-bulk-category]")?.value || "";
        if (!category) {
          if (status) status.textContent = "Choose a category.";
          return;
        }
        changes.category_primary = category;
      }
      if (root.querySelector('[data-bulk-change="tags"]')?.checked) {
        changes.tags = [
          ...new Map(
            (
              root.querySelector("[data-bulk-tags]")?.value || ""
            )
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean)
              .map((tag) => [tag.toLowerCase(), tag]),
          ).values(),
        ];
      }
      if (
        root.querySelector(
          '[data-bulk-change="excluded_from_spending"]',
        )?.checked
      ) {
        changes.excluded_from_spending =
          root.querySelector("[data-bulk-excluded]")?.value === "true";
      }
      if (
        root.querySelector(
          '[data-bulk-change="budget_month_offset"]',
        )?.checked
      ) {
        changes.budget_month_offset = Number(
          root.querySelector("[data-bulk-budget-month]")?.value,
        );
      }
      if (!transactionIds.length || !Object.keys(changes).length) {
        if (status) {
          status.textContent =
            "Select transactions and at least one field.";
        }
        return;
      }

      submit.disabled = true;
      if (status) status.textContent = "Saving changes…";
      try {
        const response = await fetch(
          "/api/v1/transactions/batch-edit",
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-CSRF-Token": csrfToken,
            },
            body: JSON.stringify({
              transaction_ids: transactionIds,
              changes,
            }),
          },
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            payload.message ||
              `Update failed with ${response.status}`,
          );
        }
        const count = payload.updated_count ?? transactionIds.length;
        if (status) {
          status.textContent = `${count} transaction${
            count === 1 ? "" : "s"
          } updated`;
        }
        window.setTimeout(() => window.location.reload(), 500);
      } catch (error) {
        if (status) {
          status.textContent =
            error.message || "Couldn’t update transactions";
        }
        updateSubmit();
      }
    });

    updateSelection();
  }

  function transactionNotes() {
    const csrfToken =
      document.querySelector('meta[name="csrf-token"]')?.content || "";
    document
      .querySelectorAll("[data-transaction-note-form]")
      .forEach((form) => {
        const input = form.querySelector("[data-transaction-note-input]");
        const count = form.querySelector("[data-transaction-note-count]");
        const status = form.querySelector(
          "[data-transaction-note-status]",
        );
        const submit = form.querySelector('button[type="submit"]');
        const updateCount = () => {
          if (count && input) count.textContent = String(input.value.length);
        };
        input?.addEventListener("input", updateCount);
        updateCount();

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const transactionId = form.dataset.transactionId;
          const expectedVersion = Number(form.dataset.noteVersion || 0);
          if (!transactionId || !input || !submit) return;
          submit.disabled = true;
          if (status) status.textContent = "Saving…";
          try {
            const response = await fetch(
              `/api/v1/transactions/${encodeURIComponent(transactionId)}/note`,
              {
                method: "PUT",
                headers: {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                  "X-CSRF-Token": csrfToken,
                },
                body: JSON.stringify({
                  note: input.value,
                  expected_note_version: expectedVersion,
                }),
              },
            );
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
              throw new Error(
                payload.message ||
                  `Update failed with ${response.status}`,
              );
            }
            input.value = payload.note || "";
            form.dataset.noteVersion = String(
              payload.note_version ?? expectedVersion + 1,
            );
            updateCount();
            if (status) {
              status.textContent = payload.note ? "Note saved" : "Note cleared";
            }
            const updated = form.querySelector(
              "[data-transaction-note-updated]",
            );
            if (updated) updated.textContent = "Updated just now";
            const preview = form
              .closest(".transaction-note-editor")
              ?.querySelector(".transaction-disclosure__preview");
            if (preview) {
              preview.textContent =
                String(payload.note || "")
                  .replace(/\s+/g, " ")
                  .trim() || "No note";
            }
          } catch (error) {
            if (status) {
              status.textContent =
                error.message || "Couldn’t update the note";
            }
          } finally {
            submit.disabled = false;
          }
        });
      });
  }

  function transactionOrganization() {
    const csrfToken =
      document.querySelector('meta[name="csrf-token"]')?.content || "";
    document
      .querySelectorAll(
        "[data-transaction-category-form], [data-transaction-organize-form]",
      )
      .forEach((form) => {
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const transactionId = form.dataset.transactionId;
          const submit = form.querySelector('button[type="submit"]');
          const status = form.querySelector(
            "[data-transaction-category-status], [data-transaction-organize-status]",
          );
          if (!transactionId || !submit) return;

          const changes = {};
          const displayName = form.elements.namedItem("display_name");
          const category = form.elements.namedItem("category_primary");
          const tags = form.elements.namedItem("tags");
          const excluded = form.elements.namedItem(
            "excluded_from_spending",
          );
          const budgetMonth = form.elements.namedItem(
            "budget_month_offset",
          );
          if (
            displayName &&
            displayName.value.trim() !== displayName.dataset.initialValue
          ) {
            changes.display_name = displayName.value.trim() || null;
          }
          if (
            category &&
            category.value !== category.dataset.initialValue
          ) {
            changes.category_primary = category.value;
          }
          if (tags && tags.value.trim() !== tags.dataset.initialValue) {
            const parsedTags = [
              ...new Map(
                tags.value
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean)
                  .map((tag) => [tag.toLowerCase(), tag]),
              ).values(),
            ];
            if (parsedTags.length > 20) {
              if (status) status.textContent = "Use at most 20 tags.";
              return;
            }
            changes.tags = parsedTags;
          }
          if (
            excluded &&
            excluded.value !== excluded.dataset.initialValue
          ) {
            changes.excluded_from_spending = excluded.value === "true";
          }
          if (
            budgetMonth &&
            budgetMonth.value !== budgetMonth.dataset.initialValue
          ) {
            changes.budget_month_offset = Number(budgetMonth.value);
          }
          if (!Object.keys(changes).length) {
            if (status) status.textContent = "Nothing changed.";
            return;
          }

          submit.disabled = true;
          if (status) status.textContent = "Saving…";
          try {
            const response = await fetch(
              "/api/v1/transactions/batch-edit",
              {
                method: "POST",
                headers: {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                  "X-CSRF-Token": csrfToken,
                },
                body: JSON.stringify({
                  transaction_ids: [transactionId],
                  changes,
                }),
              },
            );
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
              throw new Error(
                payload.message ||
                  `Update failed with ${response.status}`,
              );
            }
            if (status) status.textContent = "Changes saved";
            window.setTimeout(() => window.location.reload(), 350);
          } catch (error) {
            if (status) {
              status.textContent =
                error.message || "Couldn’t update the transaction";
            }
            submit.disabled = false;
          }
        });
      });
  }

  function loadMapKit() {
    if (
      window.mapkit?.Map &&
      window.mapkit?.Coordinate &&
      window.mapkit?.MarkerAnnotation
    ) {
      try {
        return Promise.resolve(configureMapKit(window.mapkit));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (mapKitLoadPromise) return mapKitLoadPromise;

    mapKitLoadPromise = new Promise((resolve, reject) => {
      const callbackName =
        `__moneyMapKitReady${Date.now()}` +
        Math.random().toString(16).slice(2);
      const script = document.createElement("script");
      let settled = false;
      let timeoutId;

      const cleanupCallback = () => {
        try {
          delete window[callbackName];
        } catch {
          window[callbackName] = undefined;
        }
      };
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        cleanupCallback();
        if (error) {
          script.remove();
          reject(error);
          return;
        }
        try {
          resolve(configureMapKit(window.mapkit));
        } catch (initializationError) {
          reject(initializationError);
        }
      };

      window[callbackName] = () => {
        if (
          !window.mapkit?.Map ||
          !window.mapkit?.Coordinate ||
          !window.mapkit?.MarkerAnnotation
        ) {
          finish(new Error("MapKit JS did not initialize."));
          return;
        }
        finish();
      };
      script.src = mapKitScriptUrl;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.dataset.callback = callbackName;
      script.dataset.libraries = "map,annotations,services";
      script.addEventListener(
        "error",
        () => finish(new Error("MapKit JS did not load.")),
        { once: true },
      );
      timeoutId = window.setTimeout(
        () => finish(new Error("MapKit JS timed out.")),
        12_000,
      );
      document.head.append(script);
    });

    return mapKitLoadPromise;
  }

  function validLocationCoordinate(latitude, longitude) {
    return (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      latitude >= -90 &&
      latitude <= 90 &&
      longitude >= -180 &&
      longitude <= 180
    );
  }

  function directTransactionCoordinate(root) {
    const latitudeText = String(root.dataset.locationLat || "").trim();
    const longitudeText = String(root.dataset.locationLon || "").trim();
    if (!latitudeText || !longitudeText) return null;
    const latitude = Number(latitudeText);
    const longitude = Number(longitudeText);
    return validLocationCoordinate(latitude, longitude)
      ? { latitude, longitude }
      : null;
  }

  function geocodedCoordinate(result) {
    const places = Array.isArray(result) ? result : result?.results;
    const coordinate = places?.[0]?.coordinate;
    const latitude = Number(coordinate?.latitude);
    const longitude = Number(coordinate?.longitude);
    return validLocationCoordinate(latitude, longitude)
      ? { latitude, longitude }
      : null;
  }

  function renderTransactionMap(mapkit, mapElement, coordinate, title) {
    const center = new mapkit.Coordinate(
      coordinate.latitude,
      coordinate.longitude,
    );
    const region = new mapkit.CoordinateRegion(
      center,
      new mapkit.CoordinateSpan(0.008, 0.008),
    );
    const hidden = mapkit.FeatureVisibility?.Hidden || "hidden";
    const map = new mapkit.Map(mapElement, {
      region,
      isRotationEnabled: false,
      isScrollEnabled: false,
      isZoomEnabled: false,
      showsCompass: hidden,
      showsMapTypeControl: false,
      showsPointsOfInterest: false,
      showsScale: hidden,
      showsUserLocation: false,
      showsZoomControl: false,
    });
    const markerTitle = title || "Transaction location";
    const marker = new mapkit.MarkerAnnotation(center, {
      title: markerTitle,
      accessibilityLabel: `${markerTitle} location`,
    });
    map.addAnnotation(marker);
    return map;
  }

  function transactionLocations() {
    document
      .querySelectorAll("[data-transaction-location]")
      .forEach((root) => {
        const mapElement = root.querySelector("[data-mapkit-map]");
        if (!mapElement) return;

        const directCoordinate = directTransactionCoordinate(root);
        // The server sets this attribute only from Plaid's street-address
        // field. Locality-only display text intentionally never reaches the
        // geocoder.
        const streetAddress = String(
          root.dataset.locationAddress || "",
        )
          .trim()
          .slice(0, 500);
        if (!directCoordinate && !streetAddress) {
          root.dataset.mapkitState = "unavailable";
          mapElement.hidden = true;
          return;
        }

        const dialog = root.closest("dialog");
        const state = {
          cancelled: false,
          failed: false,
          map: null,
          mapkit: null,
        };
        const active = () =>
          !state.cancelled &&
          !state.failed &&
          root.isConnected !== false &&
          (!dialog || dialog.open);
        const handleMapKitFailure = () => {
          if (state.cancelled) return;
          state.failed = true;
          state.map?.destroy?.();
          state.map = null;
          root.dataset.mapkitState = "unavailable";
          mapElement.hidden = true;
        };
        const removeMapKitListeners = () => {
          mapKitAuthorizationFailureListeners.delete(
            handleMapKitFailure,
          );
          state.mapkit?.removeEventListener?.(
            "error",
            handleMapKitFailure,
          );
          state.mapkit?.removeEventListener?.(
            "load-error",
            handleMapKitFailure,
          );
        };
        const teardown = () => {
          state.cancelled = true;
          state.map?.destroy?.();
          state.map = null;
          removeMapKitListeners();
          window.removeEventListener("pagehide", teardown);
        };
        dialog?.addEventListener("close", teardown, { once: true });
        window.addEventListener("pagehide", teardown, { once: true });
        mapKitAuthorizationFailureListeners.add(handleMapKitFailure);
        root.dataset.mapkitState = "loading";
        mapElement.hidden = true;

        (async () => {
          try {
            const mapkit = await loadMapKit();
            state.mapkit = mapkit;
            mapkit.addEventListener?.("error", handleMapKitFailure);
            mapkit.addEventListener?.(
              "load-error",
              handleMapKitFailure,
            );
            if (!active()) return;

            let coordinate = directCoordinate;
            if (!coordinate) {
              if (!mapkit.Geocoder) return;
              const geocoder = new mapkit.Geocoder();
              coordinate = geocodedCoordinate(
                await geocoder.lookup(streetAddress),
              );
            }
            if (!coordinate || !active()) return;

            mapElement.hidden = false;
            state.map = renderTransactionMap(
              mapkit,
              mapElement,
              coordinate,
              String(root.dataset.locationTitle || "").trim(),
            );
            root.dataset.mapkitState = "ready";
          } catch {
            // The address and Apple Maps link remain useful without the map.
          } finally {
            if (root.dataset.mapkitState !== "ready") {
              root.dataset.mapkitState = "unavailable";
              mapElement.hidden = true;
            }
          }
        })();
      });
  }

  function transactionRecurringPatterns() {
    const csrfToken =
      document.querySelector('meta[name="csrf-token"]')?.content || "";
    document
      .querySelectorAll("[data-transaction-recurring-form]")
      .forEach((form) => {
        const status = form.querySelector(
          "[data-transaction-recurring-status]",
        );
        const submit = form.querySelector('button[type="submit"]');
        const remove = form.querySelector(
          "[data-remove-recurring-pattern]",
        );
        const setBusy = (busy) => {
          if (submit) submit.disabled = busy;
          if (remove) remove.disabled = busy;
        };
        const request = async (method, body = null) => {
          setBusy(true);
          if (status) {
            status.textContent =
              method === "DELETE" ? "Removing…" : "Saving…";
          }
          try {
            const response = await fetch(form.dataset.endpoint, {
              method,
              headers: {
                Accept: "application/json",
                ...(body
                  ? { "Content-Type": "application/json" }
                  : {}),
                "X-CSRF-Token": csrfToken,
              },
              ...(body ? { body: JSON.stringify(body) } : {}),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
              throw new Error(
                payload.message ||
                  `Update failed with ${response.status}`,
              );
            }
            if (status) {
              const action =
                method === "DELETE" ? "Removed" : "Saved";
              status.textContent = payload.recompute_queued
                ? `${action}. Recurring totals are updating…`
                : `${action}. Recurring totals update during the next refresh.`;
            }
            window.setTimeout(() => window.location.reload(), 900);
          } catch (error) {
            if (status) {
              status.textContent =
                error.message || "Couldn’t update the recurring pattern";
            }
            setBusy(false);
          }
        };

        form.addEventListener("submit", (event) => {
          event.preventDefault();
          const data = new FormData(form);
          request("PUT", {
            type: data.get("type"),
            cadence: data.get("cadence"),
          });
        });
        remove?.addEventListener("click", () => {
          request("DELETE");
        });
      });
  }

  function insightBulkActions() {
    const root = document.querySelector("[data-bulk-insights]");
    if (!root) return;

    const start = root.querySelector("[data-insight-bulk-start]");
    const selectionBar = root.querySelector(
      "[data-insight-selection-bar]",
    );
    const selectAll = root.querySelector("[data-insight-select-all]");
    const selectedCount = root.querySelector(
      "[data-insight-selected-count]",
    );
    const selectedCountVisible = selectedCount?.querySelector(
      "[data-insight-selected-count-visible]",
    );
    const selectionAnnouncement = selectedCount?.querySelector(
      "[data-insight-selection-announcement]",
    );
    const action = root.querySelector("[data-insight-bulk-action]");
    const reasonField = root.querySelector(
      "[data-insight-bulk-reason-field]",
    );
    const reason = root.querySelector("[data-insight-bulk-reason]");
    const subscriptionReason = reason?.querySelector(
      "[data-subscription-only]",
    );
    const apply = root.querySelector("[data-insight-bulk-apply]");
    const cancel = root.querySelector("[data-insight-bulk-cancel]");
    const status = root.querySelector("[data-insight-bulk-status]");
    const context = root.querySelector("details.insight-context");
    const cards = [
      ...root.querySelectorAll("[data-bulk-insight-card]"),
    ];
    const inputs = cards
      .map((card) => card.querySelector("[data-insight-select]"))
      .filter(Boolean);
    const csrfToken =
      document.querySelector('meta[name="csrf-token"]')?.content || "";
    let selectionMode = false;
    let contextWasOpen = false;
    let selectionBusy = false;

    const selectedInputs = () =>
      inputs.filter((input) => input.checked);

    const updateSelection = () => {
      const selected = selectedInputs();
      const count = selected.length;
      const allSubscriptions =
        count > 0 &&
        selected.every(
          (input) => input.dataset.insightFamily === "subscriptions",
        );
      if (selectedCountVisible) {
        selectedCountVisible.textContent = `${count} selected`;
      } else if (selectedCount) {
        selectedCount.textContent = `${count} selected`;
      }
      if (selectionAnnouncement) {
        const availableActions = [
          ...(action?.querySelectorAll("option[value]") ?? []),
        ]
          .filter((option) => option.value && !option.disabled)
          .map((option) => option.textContent.trim());
        selectionAnnouncement.textContent =
          `${count} insight${count === 1 ? "" : "s"} selected. ` +
          `Available actions: ${availableActions.join(", ")}.`;
      }
      cards.forEach((card) => {
        const input = card.querySelector("[data-insight-select]");
        card.toggleAttribute(
          "data-insight-selected",
          Boolean(input?.checked),
        );
      });
      if (selectAll) {
        selectAll.checked = inputs.length > 0 && count === inputs.length;
        selectAll.indeterminate = count > 0 && count < inputs.length;
      }
      if (subscriptionReason) {
        subscriptionReason.hidden = !allSubscriptions;
        subscriptionReason.disabled = !allSubscriptions;
        if (!allSubscriptions && reason?.value === "not_subscription") {
          reason.value = "";
        }
      }
      const needsReason = action?.value === "report_incorrect";
      if (reasonField) reasonField.hidden = !needsReason;
      if (!needsReason && reason) reason.value = "";
      if (apply) {
        apply.disabled =
          count === 0 ||
          !action?.value ||
          (needsReason && !reason?.value);
        apply.textContent = count > 0 ? `Apply to ${count}` : "Apply";
      }
    };

    const setSelectionMode = (active, { restoreFocus = false } = {}) => {
      selectionMode = active;
      root.toggleAttribute("data-insight-selection-mode", active);
      if (start) start.hidden = active;
      if (selectionBar) selectionBar.hidden = !active;
      cards.forEach((card) => {
        const control = card.querySelector(".insight-select-control");
        const actions = card.querySelector(".insight-card__actions");
        if (control) control.hidden = !active;
        actions?.toggleAttribute("inert", active);
        actions?.toggleAttribute("aria-hidden", active);
        card.querySelectorAll(".insight-card__menu[open]").forEach(
          (menu) => menu.removeAttribute("open"),
        );
      });
      if (active) {
        contextWasOpen = Boolean(context?.open);
        if (context) context.open = true;
      } else {
        inputs.forEach((input) => {
          input.checked = false;
        });
        if (action) action.value = "";
        if (reason) reason.value = "";
        if (status) status.textContent = "";
        if (context) context.open = contextWasOpen;
        if (restoreFocus) start?.focus();
      }
      updateSelection();
    };

    start?.addEventListener("click", () => {
      setSelectionMode(true);
      inputs[0]?.focus();
    });

    cancel?.addEventListener("click", () => {
      if (selectionBusy) return;
      setSelectionMode(false, { restoreFocus: true });
    });

    selectAll?.addEventListener("change", () => {
      inputs.forEach((input) => {
        input.checked = selectAll.checked;
      });
      updateSelection();
    });

    inputs.forEach((input) => {
      input.addEventListener("change", updateSelection);
    });
    cards.forEach((card) => {
      card.addEventListener(
        "click",
        (event) => {
          if (
            !selectionMode ||
            event.target.closest(".insight-select-control")
          ) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const input = card.querySelector("[data-insight-select]");
          if (!input || input.disabled) return;
          input.checked = !input.checked;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        },
        true,
      );
    });
    action?.addEventListener("change", updateSelection);
    reason?.addEventListener("change", updateSelection);
    document.addEventListener("keydown", (event) => {
      if (
        event.key !== "Escape" ||
        !selectionMode ||
        selectionBusy
      ) {
        return;
      }
      event.preventDefault();
      setSelectionMode(false, { restoreFocus: true });
    });

    apply?.addEventListener("click", async () => {
      const findingIds = selectedInputs().map((input) => input.value);
      if (
        !selectionMode ||
        findingIds.length === 0 ||
        !action?.value
      ) {
        return;
      }
      selectionBusy = true;
      apply.disabled = true;
      if (cancel) cancel.disabled = true;
      if (status) {
        status.textContent = `Saving ${findingIds.length} insight${findingIds.length === 1 ? "" : "s"}…`;
      }
      try {
        const response = await fetch("/api/v1/insights/batch-action", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({
            finding_ids: findingIds,
            action: action.value,
            ...(action.value === "report_incorrect"
              ? { reason_code: reason?.value }
              : {}),
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            payload.message || `Update failed with ${response.status}`,
          );
        }
        if (status) {
          const updatedCount =
            Number(payload.updated_count) || findingIds.length;
          status.textContent = `Updated ${updatedCount} insight${updatedCount === 1 ? "" : "s"}`;
        }
        const next = new URL(window.location.href);
        next.searchParams.delete("finding");
        window.setTimeout(() => {
          window.location.assign(
            `${next.pathname}${next.search}${next.hash}`,
          );
        }, 250);
      } catch (error) {
        selectionBusy = false;
        if (cancel) cancel.disabled = false;
        if (status) {
          status.textContent =
            error.message || "Couldn’t update the selected insights";
        }
        updateSelection();
      }
    });

    updateSelection();
  }

  function insightActions() {
    const csrfToken =
      document.querySelector('meta[name="csrf-token"]')?.content || "";
    document.querySelectorAll("[data-insight-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const findingId = button.dataset.findingId;
        const action = button.dataset.insightAction;
        const card = button.closest("[data-insight-card]");
        const status =
          card?.querySelector("[data-insight-action-status]") ??
          document.querySelector("[data-insight-action-status]");
        const confirmation = button.dataset.confirmMessage;
        const reasonCode = button.dataset.reasonCode;
        if (confirmation && !window.confirm(confirmation)) return;
        button.disabled = true;
        if (status) status.textContent = "Saving…";
        try {
          const deleting = action === "delete";
          const response = await fetch(
            deleting
              ? `/api/v1/insights/${encodeURIComponent(findingId)}`
              : `/api/v1/insights/${encodeURIComponent(findingId)}/actions/${encodeURIComponent(action)}`,
            {
              method: deleting ? "DELETE" : "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-CSRF-Token": csrfToken,
              },
              body: JSON.stringify(
                reasonCode ? { reason_code: reasonCode } : {},
              ),
            },
          );
          if (!response.ok) throw new Error("Action failed");
          if (
            [
              "archive",
              "confirm",
              "delete",
              "dismiss",
              "ignore",
              "mark_bad",
              "report_incorrect",
              "mark_expected",
              "restore",
            ].includes(action)
          ) {
            const next = new URL(window.location.href);
            next.searchParams.delete("finding");
            window.location.assign(
              `${next.pathname}${next.search}${next.hash}`,
            );
            return;
          }
          if (status) status.textContent = "Ready to review";
        } catch {
          button.disabled = false;
          if (status) status.textContent = "Couldn’t save this action";
        }
      });
    });
  }

  const cleanupRulePrefillStorageKey =
    "money.cleanup-rule-prefill.v1";

  function transactionCleanupRules() {
    const cleanupRoot = document.querySelector(
      "[data-transaction-cleanup]",
    );
    const root = cleanupRoot?.querySelector("[data-cleanup-rules]");
    if (!cleanupRoot || !root) return;

    const list = root.querySelector("[data-cleanup-rule-list]");
    const emptyState = root.querySelector(
      "[data-cleanup-rule-empty]",
    );
    const status = root.querySelector("[data-cleanup-rule-status]");
    const dialog = root.querySelector("[data-cleanup-rule-dialog]");
    const form = root.querySelector("[data-cleanup-rule-form]");
    const formStatus = root.querySelector(
      "[data-cleanup-rule-form-status]",
    );
    const formSubmit = root.querySelector(
      "[data-cleanup-rule-submit]",
    );
    const ruleIdInput = root.querySelector("[data-cleanup-rule-id]");
    const matcherField = root.querySelector(
      "[data-cleanup-rule-matcher-field]",
    );
    const matcherMode = root.querySelector(
      "[data-cleanup-rule-matcher-mode]",
    );
    const matcherValue = root.querySelector(
      "[data-cleanup-rule-matcher-value]",
    );
    const enabledInput = root.querySelector(
      "[data-cleanup-rule-enabled]",
    );
    const dialogTitle = root.querySelector(
      "[data-cleanup-rule-dialog-title]",
    );
    const csrfToken =
      document.querySelector('meta[name="csrf-token"]')?.content || "";
    const endpoint = "/api/v1/transaction-cleanup-rules";
    const fields = {
      display_name: root.querySelector(
        "[data-cleanup-rule-display-name]",
      ),
      category_primary: root.querySelector(
        "[data-cleanup-rule-category]",
      ),
      tags: root.querySelector("[data-cleanup-rule-tags]"),
    };
    let rules = new Map();

    const initialPayload = root.dataset.cleanupRulePayload;
    try {
      for (const rule of JSON.parse(initialPayload || "[]")) {
        if (rule?.id) rules.set(String(rule.id), rule);
      }
    } catch {
      rules = new Map();
    }

    const appendText = (parent, tagName, text, className) => {
      const element = document.createElement(tagName);
      if (className) element.className = className;
      element.textContent = String(text ?? "");
      parent.append(element);
      return element;
    };

    const responseRules = (payload) => {
      if (Array.isArray(payload)) return payload;
      if (Array.isArray(payload?.rules)) return payload.rules;
      return [];
    };

    const matcherLabel = (rule) =>
      rule.matcher?.field === "normalized_name"
        ? "Transaction name"
        : "Merchant";
    const matcherModeLabel = (rule) =>
      rule.matcher?.mode === "contains" ? "contains" : "exactly";

    const changeLabels = (rule) => {
      const changes = rule.changes || {};
      return [
        changes.display_name
          ? `Rename to ${changes.display_name}`
          : null,
        changes.category_primary || null,
        Object.hasOwn(changes, "tags")
          ? changes.tags?.length
            ? changes.tags.join(" · ")
            : "Clear tags"
          : null,
      ].filter(Boolean);
    };

    const updatedLabel = (value) => {
      const date = new Date(value);
      if (Number.isNaN(date.valueOf())) return null;
      return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
      }).format(date);
    };

    const ruleRow = (rule) => {
      const row = document.createElement("article");
      row.className = "cleanup-rule-row";
      row.classList.toggle(
        "cleanup-rule-row--disabled",
        !rule.enabled,
      );
      row.dataset.cleanupRule = String(rule.id);

      const icon = document.createElement("span");
      icon.className = "cleanup-rule-row__icon";
      const iconGlyph = document.createElement("i");
      iconGlyph.className = "ph ph-magic-wand";
      iconGlyph.setAttribute("aria-hidden", "true");
      icon.append(iconGlyph);

      const copy = document.createElement("span");
      copy.className = "cleanup-rule-row__copy";
      appendText(
        copy,
        "strong",
        `${matcherLabel(rule)} ${matcherModeLabel(rule)} “${
          rule.matcher?.value || ""
        }”`,
      );
      const changes = appendText(
        copy,
        "span",
        changeLabels(rule).join(" · "),
      );
      const arrow = document.createElement("i");
      arrow.className = "ph ph-arrow-right";
      arrow.setAttribute("aria-hidden", "true");
      changes.prepend(arrow);
      const count =
        Number(rule.matched_transaction_count) || 0;
      const updated = updatedLabel(rule.updated_at);
      appendText(
        copy,
        "small",
        [
          `${count} matching posted transaction${
            count === 1 ? "" : "s"
          }`,
          updated ? `Updated ${updated}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      );

      const actions = document.createElement("span");
      actions.className = "cleanup-rule-row__actions";
      const toggleLabel = document.createElement("label");
      toggleLabel.className = "cleanup-rule-toggle";
      const toggleCopy = appendText(
        toggleLabel,
        "span",
        `${rule.enabled ? "Disable" : "Enable"} rule for ${
          rule.matcher?.value || "transaction"
        }`,
        "sr-only",
      );
      toggleCopy.dataset.cleanupRuleToggleLabel = "";
      const toggle = document.createElement("input");
      toggle.className = "switch";
      toggle.type = "checkbox";
      toggle.checked = Boolean(rule.enabled);
      toggle.dataset.cleanupRuleToggle = "";
      toggleLabel.append(toggle);

      const edit = document.createElement("button");
      edit.className = "button button--ghost";
      edit.type = "button";
      edit.dataset.cleanupRuleEdit = "";
      edit.textContent = "Edit";

      const remove = document.createElement("button");
      remove.className = "button button--ghost danger-action";
      remove.type = "button";
      remove.dataset.cleanupRuleDelete = "";
      remove.setAttribute(
        "aria-label",
        `Delete rule for ${rule.matcher?.value || "transaction"}`,
      );
      const removeIcon = document.createElement("i");
      removeIcon.className = "ph ph-trash";
      removeIcon.setAttribute("aria-hidden", "true");
      remove.append(removeIcon);
      actions.append(toggleLabel, edit, remove);
      row.append(icon, copy, actions);
      return row;
    };

    const renderRules = () => {
      if (!list) return;
      list.replaceChildren();
      [...rules.values()]
        .sort(
          (left, right) =>
            String(right.updated_at || "").localeCompare(
              String(left.updated_at || ""),
            ) ||
            String(left.id).localeCompare(String(right.id)),
        )
        .forEach((rule) => list.append(ruleRow(rule)));
      if (emptyState) emptyState.hidden = rules.size > 0;
    };

    const parseTags = (value) => [
      ...new Map(
        String(value || "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
          .map((tag) => [tag.toLowerCase(), tag]),
      ).values(),
    ];

    const changeToggle = (field) =>
      root.querySelector(
        `[data-cleanup-rule-change="${field}"]`,
      );

    const setChange = (field, active, value = "") => {
      const toggle = changeToggle(field);
      const input = fields[field];
      if (toggle) toggle.checked = Boolean(active);
      if (input) {
        if (
          input instanceof HTMLSelectElement &&
          value &&
          ![...input.options].some(
            (option) => option.value === value,
          )
        ) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value;
          input.append(option);
        }
        input.disabled = !active;
        input.value = Array.isArray(value)
          ? value.join(", ")
          : value ?? "";
      }
    };

    const openRuleDialog = ({ rule = null, prefill = null } = {}) => {
      if (!dialog || !form) return;
      form.reset();
      if (ruleIdInput) ruleIdInput.value = rule?.id || "";
      if (dialogTitle) {
        dialogTitle.textContent = rule ? "Edit rule" : "New rule";
      }
      if (matcherField) {
        matcherField.value =
          rule?.matcher?.field ??
          prefill?.matcher?.field ??
          "normalized_merchant";
      }
      if (matcherMode) {
        matcherMode.value =
          rule?.matcher?.mode ??
          prefill?.matcher?.mode ??
          "exact";
      }
      if (matcherValue) {
        matcherValue.value =
          rule?.matcher?.value ?? prefill?.matcher?.value ?? "";
      }
      const changes = rule?.changes ?? prefill?.changes ?? {};
      for (const field of Object.keys(fields)) {
        setChange(
          field,
          Object.hasOwn(changes, field),
          changes[field],
        );
      }
      if (enabledInput) {
        enabledInput.checked = rule?.enabled ?? true;
      }
      if (formStatus) formStatus.textContent = "";
      dialog.showModal();
      matcherValue?.focus();
    };

    const request = async (url, options = {}) => {
      const response = await fetch(url, {
        ...options,
        headers: {
          Accept: "application/json",
          ...(options.body
            ? {
                "Content-Type": "application/json",
                "X-CSRF-Token": csrfToken,
              }
            : {}),
          ...options.headers,
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          payload.message || `Request failed with ${response.status}`,
        );
      }
      return payload;
    };

    const loadRules = async () => {
      const payload = await request(endpoint);
      rules = new Map(
        responseRules(payload)
          .filter((rule) => rule?.id)
          .map((rule) => [String(rule.id), rule]),
      );
      renderRules();
    };

    root
      .querySelectorAll("[data-cleanup-rule-change]")
      .forEach((toggle) => {
        toggle.addEventListener("change", () => {
          const input = fields[toggle.dataset.cleanupRuleChange];
          if (input) input.disabled = !toggle.checked;
        });
      });

    root
      .querySelectorAll("[data-cleanup-rule-cancel]")
      .forEach((button) =>
        button.addEventListener("click", () => dialog?.close()),
      );

    root
      .querySelector("[data-cleanup-rule-new]")
      ?.addEventListener("click", () => openRuleDialog());

    root
      .querySelectorAll("[data-cleanup-rule-tag]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const toggle = changeToggle("tags");
          const input = fields.tags;
          if (!input) return;
          if (toggle) {
            toggle.checked = true;
            input.disabled = false;
          }
          const tags = parseTags(input.value);
          if (
            !tags.some(
              (tag) =>
                tag.toLowerCase() ===
                button.dataset.cleanupRuleTag.toLowerCase(),
            )
          ) {
            tags.push(button.dataset.cleanupRuleTag);
          }
          input.value = tags.join(", ");
        });
      });

    list?.addEventListener("click", async (event) => {
      const row = event.target.closest("[data-cleanup-rule]");
      if (!row) return;
      const rule = rules.get(row.dataset.cleanupRule);
      if (!rule) return;
      if (event.target.closest("[data-cleanup-rule-edit]")) {
        openRuleDialog({ rule });
        return;
      }
      if (!event.target.closest("[data-cleanup-rule-delete]")) {
        return;
      }
      const confirmed = window.confirm(
        `Delete the rule for “${rule.matcher?.value}”? ` +
          "Existing automatic changes will revert and future cleanup will stop. " +
          "Manual edits will stay.",
      );
      if (!confirmed) return;
      if (status) status.textContent = "Deleting rule…";
      try {
        await request(
          `${endpoint}/${encodeURIComponent(rule.id)}`,
          {
            method: "DELETE",
            body: "{}",
          },
        );
        await loadRules();
        if (status) status.textContent = "Rule deleted";
      } catch (error) {
        if (status) {
          status.textContent =
            error.message || "Couldn’t delete the rule";
        }
      }
    });

    list?.addEventListener("change", async (event) => {
      const toggle = event.target.closest(
        "[data-cleanup-rule-toggle]",
      );
      if (!toggle) return;
      const row = toggle.closest("[data-cleanup-rule]");
      const rule = rules.get(row?.dataset.cleanupRule);
      if (!rule) return;
      const previous = Boolean(rule.enabled);
      toggle.disabled = true;
      if (status) {
        status.textContent = toggle.checked
          ? "Enabling rule…"
          : "Disabling rule…";
      }
      try {
        await request(
          `${endpoint}/${encodeURIComponent(rule.id)}`,
          {
            method: "PUT",
            body: JSON.stringify({
              matcher: {
                field: rule.matcher.field,
                mode: rule.matcher.mode ?? "exact",
                value: rule.matcher.value,
              },
              changes: rule.changes,
              enabled: toggle.checked,
            }),
          },
        );
        await loadRules();
        if (status) {
          status.textContent = toggle.checked
            ? "Rule enabled"
            : "Rule disabled";
        }
      } catch (error) {
        toggle.checked = previous;
        toggle.disabled = false;
        if (status) {
          status.textContent =
            error.message || "Couldn’t update the rule";
        }
      }
    });

    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const changes = {};
      if (changeToggle("display_name")?.checked) {
        const value = fields.display_name?.value.trim();
        if (!value) {
          if (formStatus) {
            formStatus.textContent = "Enter the corrected merchant name.";
          }
          fields.display_name?.focus();
          return;
        }
        changes.display_name = value;
      }
      if (changeToggle("category_primary")?.checked) {
        const value = fields.category_primary?.value;
        if (value) changes.category_primary = value;
      }
      if (changeToggle("tags")?.checked) {
        changes.tags = parseTags(fields.tags?.value);
      }
      if (!Object.keys(changes).length) {
        if (formStatus) {
          formStatus.textContent = "Choose at least one change.";
        }
        return;
      }
      const value = matcherValue?.value.trim();
      if (!value) {
        if (formStatus) {
          formStatus.textContent = "Enter text to match.";
        }
        matcherValue?.focus();
        return;
      }
      const ruleId = ruleIdInput?.value;
      const method = ruleId ? "PUT" : "POST";
      const url = ruleId
        ? `${endpoint}/${encodeURIComponent(ruleId)}`
        : endpoint;
      if (formSubmit) formSubmit.disabled = true;
      if (formStatus) formStatus.textContent = "Saving rule…";
      try {
        await request(url, {
          method,
          body: JSON.stringify({
            matcher: {
              field: matcherField?.value,
              mode: matcherMode?.value,
              value,
            },
            changes,
            enabled: Boolean(enabledInput?.checked),
          }),
        });
        await loadRules();
        dialog?.close();
        if (status) {
          status.textContent = ruleId
            ? "Rule updated"
            : "Rule created";
        }
        cleanupRoot.dispatchEvent(
          new CustomEvent("cleanup-rule-saved"),
        );
      } catch (error) {
        if (formStatus) {
          formStatus.textContent =
            error.message || "Couldn’t save the rule";
        }
      } finally {
        if (formSubmit) formSubmit.disabled = false;
      }
    });

    cleanupRoot.addEventListener(
      "cleanup-rule-prefill",
      (event) => openRuleDialog({ prefill: event.detail }),
    );

    const rerun = cleanupRoot.querySelector("[data-cleanup-rerun]");
    const rerunStatus = cleanupRoot.querySelector(
      "[data-cleanup-rerun-status]",
    );
    rerun?.addEventListener("click", async () => {
      rerun.setAttribute("disabled", "");
      if (rerunStatus) rerunStatus.textContent = "Re-running all rules…";
      try {
        const result = await request(`${endpoint}/rerun`, {
          method: "POST",
          body: "{}",
        });
        await loadRules();
        if (rerunStatus) {
          const transactionCount = Number(
            result.transaction_count ?? 0,
          );
          const ruleCount = Number(result.rule_count ?? 0);
          rerunStatus.textContent =
            `${transactionCount} posted transaction${
              transactionCount === 1 ? "" : "s"
            } checked across ${ruleCount} enabled rule${
              ruleCount === 1 ? "" : "s"
            }`;
        }
      } catch (error) {
        if (rerunStatus) rerunStatus.textContent = error.message;
      } finally {
        rerun.removeAttribute("disabled");
      }
    });

    renderRules();
    try {
      const pendingPrefill = window.sessionStorage.getItem(
        cleanupRulePrefillStorageKey,
      );
      if (pendingPrefill) {
        window.sessionStorage.removeItem(cleanupRulePrefillStorageKey);
        openRuleDialog({ prefill: JSON.parse(pendingPrefill) });
      }
    } catch {}
  }

  function transactionCleanup() {
    const root = document.querySelector("[data-transaction-cleanup]");
    if (!root) return;

    const searchForm = root.querySelector("[data-cleanup-search]");
    if (!searchForm) return;
    const queryInput = root.querySelector("[data-cleanup-query]");
    const searchStatus = root.querySelector(
      "[data-cleanup-search-status]",
    );
    const workspace = root.querySelector("[data-cleanup-workspace]");
    const emptyState = root.querySelector("[data-cleanup-empty]");
    const editor = root.querySelector("[data-cleanup-editor]");
    const matchList = root.querySelector("[data-cleanup-match-list]");
    const saveStatus = root.querySelector("[data-cleanup-save-status]");
    const saveAsRule = root.querySelector("[data-cleanup-save-rule]");
    const submit = root.querySelector("[data-cleanup-submit]");
    const selectedCount = root.querySelector(
      "[data-cleanup-selected-count]",
    );
    const csrfToken =
      document.querySelector('meta[name="csrf-token"]')?.content || "";
    let searchController;
    let currentRuleSource = {
      raw_merchant: root.dataset.cleanupSourceMerchant || null,
      raw_name: root.dataset.cleanupSourceName || null,
    };
    let lastAppliedRulePrefill = null;

    const moneyFormatter = (value) => {
      if (!value || !Number.isSafeInteger(value.amount_minor)) return "—";
      try {
        const formatter = new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: value.currency || "USD",
        });
        const digits =
          formatter.resolvedOptions().maximumFractionDigits ?? 2;
        return formatter.format(
          value.amount_minor / (10 ** digits),
        );
      } catch {
        return String(value.amount_minor);
      }
    };

    const selectedInputs = () => [
      ...root.querySelectorAll("[data-cleanup-select]:checked"),
    ];

    const updateSelectedCount = () => {
      const count = selectedInputs().length;
      if (selectedCount) {
        selectedCount.textContent = `${count} selected`;
      }
      if (submit) {
        submit.disabled = count === 0;
        submit.textContent =
          count === 0
            ? "Apply to selected"
            : `Apply to ${count} selected`;
      }
    };

    const appendText = (parent, tagName, text, className) => {
      const element = document.createElement(tagName);
      if (className) element.className = className;
      element.textContent = String(text ?? "");
      parent.append(element);
      return element;
    };

    const matchRow = (match, isAnchor = false) => {
      const row = document.createElement("label");
      row.className = "cleanup-match-row";
      row.dataset.cleanupMatch = "";
      row.dataset.matchReason = isAnchor
        ? "source"
        : match.match_reason || "similar_name";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = String(match.id);
      checkbox.dataset.cleanupSelect = "";
      checkbox.checked =
        isAnchor || Boolean(match.preselected);
      checkbox.addEventListener("change", updateSelectedCount);

      const identity = document.createElement("span");
      identity.className = "cleanup-match-row__identity";
      appendText(
        identity,
        "strong",
        match.display_name || match.raw_merchant || match.raw_name,
      );
      const transactionMeta = appendText(identity, "small", "");
      if (match.posted_on) {
        transactionMeta.append(
          document.createTextNode(match.posted_on),
        );
      }
      if (match.account_name) {
        if (transactionMeta.childNodes.length) {
          transactionMeta.append(document.createTextNode(" · "));
        }
        const accountName = document.createElement("span");
        if (match.account_id) {
          accountName.dataset.accountDisplayName = match.account_id;
          accountName.dataset.accountProviderName = match.account_name;
        }
        accountName.textContent = match.account_name;
        applyAccountAliasTarget(accountName);
        transactionMeta.append(accountName);
      }
      const category = match.category_primary || "Uncategorized";
      if (category) {
        if (transactionMeta.childNodes.length) {
          transactionMeta.append(document.createTextNode(" · "));
        }
        transactionMeta.append(
          document.createTextNode(category),
        );
      }
      if (
        match.raw_merchant &&
        match.raw_merchant !== match.display_name
      ) {
        appendText(
          identity,
          "small",
          `Provider: ${match.raw_merchant}`,
        );
      }
      if (match.tags?.length) {
        appendText(
          identity,
          "span",
          match.tags.join(" · "),
          "cleanup-match-row__tags",
        );
      }

      const matchMeta = document.createElement("span");
      matchMeta.className = "cleanup-match-row__match";
      appendText(matchMeta, "strong", moneyFormatter(match.amount));
      appendText(
        matchMeta,
        "small",
        isAnchor
          ? "Selected transaction"
          : match.match_reason === "exact_merchant"
            ? "Exact name"
            : `${Math.round(
                (match.similarity_basis_points || 0) / 100,
              )}% match`,
      );

      row.append(checkbox, identity, matchMeta);
      return row;
    };

    const setFieldValue = (selector, value) => {
      const field = root.querySelector(selector);
      if (!field) return;
      if (field instanceof HTMLSelectElement && value) {
        if (
          ![...field.options].some(
            (option) => option.value === value,
          )
        ) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value;
          field.append(option);
        }
      }
      field.value = value ?? "";
    };

    const renderMatches = (payload) => {
      if (!matchList) return;
      const rows = [];
      if (payload.anchor) rows.push(payload.anchor);
      for (const match of payload.matches || []) {
        if (!rows.some((row) => row.id === match.id)) rows.push(match);
      }

      matchList.replaceChildren();
      rows.forEach((match) => {
        matchList.append(
          matchRow(match, payload.anchor?.id === match.id),
        );
      });

      const source = payload.anchor || rows[0];
      if (source) {
        currentRuleSource = {
          raw_merchant: source.raw_merchant || null,
          raw_name: source.raw_name || null,
        };
        setFieldValue(
          "[data-cleanup-display-name]",
          source.display_name ||
            source.raw_merchant ||
            payload.query,
        );
        setFieldValue(
          "[data-cleanup-category]",
          source.category_primary,
        );
        setFieldValue(
          "[data-cleanup-tags]",
          (source.tags || []).join(", "),
        );
      }

      const hasRows = rows.length > 0;
      if (workspace) workspace.hidden = !hasRows;
      if (emptyState) emptyState.hidden = hasRows;
      updateSelectedCount();
    };

    const loadMatches = async () => {
      const query = queryInput?.value.trim() || "";
      if (query.length < 2) {
        if (searchStatus) {
          searchStatus.textContent =
            "Enter at least two characters.";
        }
        return;
      }
      searchController?.abort();
      searchController = new AbortController();
      if (searchStatus) searchStatus.textContent = "Finding matches…";
      try {
        const url = new URL(
          "/api/v1/transactions/matches",
          window.location.origin,
        );
        url.searchParams.set("q", query);
        url.searchParams.set("limit", "50");
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: searchController.signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            payload.message ||
              `Search failed with ${response.status}`,
          );
        }
        renderMatches(payload);
        if (searchStatus) {
          const count =
            (payload.matches?.length || 0) +
            (payload.anchor ? 1 : 0);
          searchStatus.textContent =
            count === 1
              ? "1 matching transaction"
              : `${count} matching transactions`;
        }
      } catch (error) {
        if (error.name === "AbortError") return;
        if (searchStatus) {
          searchStatus.textContent =
            error.message || "Couldn’t find matches";
        }
      }
    };

    root
      .querySelectorAll("[data-cleanup-select]")
      .forEach((input) =>
        input.addEventListener("change", updateSelectedCount),
      );

    root
      .querySelectorAll("[data-cleanup-change]")
      .forEach((toggle) => {
        const field = {
          display_name: root.querySelector(
            "[data-cleanup-display-name]",
          ),
          category_primary: root.querySelector(
            "[data-cleanup-category]",
          ),
          tags: root.querySelector("[data-cleanup-tags]"),
        }[toggle.dataset.cleanupChange];
        const sync = () => {
          if (field) field.disabled = !toggle.checked;
        };
        toggle.addEventListener("change", sync);
        sync();
      });

    root
      .querySelectorAll("[data-cleanup-tag]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const toggle = root.querySelector(
            '[data-cleanup-change="tags"]',
          );
          const input = root.querySelector("[data-cleanup-tags]");
          if (!input) return;
          if (toggle) {
            toggle.checked = true;
            toggle.dispatchEvent(new Event("change"));
          }
          const tags = input.value
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean);
          if (
            !tags.some(
              (tag) =>
                tag.toLowerCase() ===
                button.dataset.cleanupTag.toLowerCase(),
            )
          ) {
            tags.push(button.dataset.cleanupTag);
          }
          input.value = tags.join(", ");
        });
      });

    root
      .querySelector("[data-cleanup-select-exact]")
      ?.addEventListener("click", () => {
        root
          .querySelectorAll("[data-cleanup-match]")
          .forEach((row) => {
            const input = row.querySelector("[data-cleanup-select]");
            if (input) {
              input.checked = ["source", "exact_merchant"].includes(
                row.dataset.matchReason,
              );
            }
          });
        updateSelectedCount();
      });

    root
      .querySelector("[data-cleanup-clear]")
      ?.addEventListener("click", () => {
        root
          .querySelectorAll("[data-cleanup-select]")
          .forEach((input) => {
            input.checked = false;
          });
        updateSelectedCount();
      });

    searchForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (saveAsRule) saveAsRule.hidden = true;
      lastAppliedRulePrefill = null;
      loadMatches();
    });

    saveAsRule?.addEventListener("click", () => {
      if (!lastAppliedRulePrefill) return;
      if (root.querySelector("[data-cleanup-rules]")) {
        root.dispatchEvent(
          new CustomEvent("cleanup-rule-prefill", {
            detail: lastAppliedRulePrefill,
          }),
        );
        return;
      }
      try {
        window.sessionStorage.setItem(
          cleanupRulePrefillStorageKey,
          JSON.stringify(lastAppliedRulePrefill),
        );
        window.location.assign("/format-rules?new_rule=1");
      } catch {
        if (saveStatus) {
          saveStatus.textContent = "Couldn’t open the rule editor";
        }
      }
    });

    root.addEventListener("cleanup-rule-saved", () => {
      if (saveAsRule) saveAsRule.hidden = true;
      lastAppliedRulePrefill = null;
    });

    editor?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const transactionIds = selectedInputs().map(
        (input) => input.value,
      );
      const changes = {};
      const displayToggle = root.querySelector(
        '[data-cleanup-change="display_name"]',
      );
      const categoryToggle = root.querySelector(
        '[data-cleanup-change="category_primary"]',
      );
      const tagsToggle = root.querySelector(
        '[data-cleanup-change="tags"]',
      );
      if (displayToggle?.checked) {
        changes.display_name =
          root
            .querySelector("[data-cleanup-display-name]")
            ?.value.trim() || null;
      }
      if (categoryToggle?.checked) {
        changes.category_primary =
          root.querySelector("[data-cleanup-category]")?.value ||
          null;
      }
      if (tagsToggle?.checked) {
        changes.tags = [
          ...new Map(
            (
              root.querySelector("[data-cleanup-tags]")?.value || ""
            )
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean)
              .map((tag) => [tag.toLowerCase(), tag]),
          ).values(),
        ];
      }
      if (!transactionIds.length) {
        if (saveStatus) saveStatus.textContent = "Select a transaction.";
        return;
      }
      if (!Object.keys(changes).length) {
        if (saveStatus) saveStatus.textContent = "Choose an edit to apply.";
        return;
      }
      submit.disabled = true;
      if (saveStatus) saveStatus.textContent = "Applying changes…";
      try {
        const response = await fetch(
          "/api/v1/transactions/batch-edit",
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-CSRF-Token": csrfToken,
            },
            body: JSON.stringify({
              transaction_ids: transactionIds,
              changes,
            }),
          },
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            payload.message ||
              `Update failed with ${response.status}`,
          );
        }
        if (saveStatus) {
          const count =
            payload.updated_count ?? transactionIds.length;
          saveStatus.textContent = `${count} transaction${
            count === 1 ? "" : "s"
          } updated`;
        }
        const matchValue =
          currentRuleSource.raw_merchant ||
          currentRuleSource.raw_name ||
          queryInput?.value.trim();
        if (matchValue) {
          lastAppliedRulePrefill = {
            matcher: {
              field: currentRuleSource.raw_merchant
                ? "normalized_merchant"
                : "normalized_name",
              value: matchValue,
            },
            changes: {
              ...changes,
              ...(Object.hasOwn(changes, "tags")
                ? { tags: [...changes.tags] }
                : {}),
            },
          };
          if (saveAsRule) saveAsRule.hidden = false;
        }
        await loadMatches();
      } catch (error) {
        if (saveStatus) {
          saveStatus.textContent =
            error.message || "Couldn’t update transactions";
        }
      } finally {
        updateSelectedCount();
      }
    });

    updateSelectedCount();
  }

  function creditScoreTracking() {
    const root = document.querySelector(".credit-score-card");
    if (!root) return;
    const dialog = document.querySelector("[data-credit-score-dialog]");
    const scope = dialog || root;
    const csrfToken =
      document.querySelector('meta[name="csrf-token"]')?.content || "";

    root
      .querySelector("[data-credit-score-dialog-open]")
      ?.addEventListener("click", () => dialog?.showModal());
    dialog
      ?.querySelector("[data-credit-score-dialog-close]")
      ?.addEventListener("click", () => dialog.close());
    dialog?.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });

    const requestJson = async (url, { method = "PUT", body } = {}) => {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          payload.message || `Credit score update failed with ${response.status}`,
        );
      }
      return payload;
    };

    const statusFor = (element) =>
      element.querySelector("[data-credit-score-status]") ||
      element
        .closest("[data-credit-score-source]")
        ?.querySelector("[data-credit-score-status]");

    const setBusy = (form, busy, message) => {
      form
        .querySelectorAll("button, input, select")
        .forEach((control) => {
          control.disabled = busy;
        });
      const status = statusFor(form);
      if (status && message) status.textContent = message;
    };

    const sourcePayload = (form) => {
      const values = new FormData(form);
      return {
        label: String(values.get("label") || "").trim(),
        bureau: String(values.get("bureau") || "").trim() || null,
        model: String(values.get("model") || "").trim() || null,
      };
    };

    const observationPayload = (form) => {
      const values = new FormData(form);
      const score = Number(values.get("score"));
      const observedOn = String(values.get("observed_on") || "");
      if (!Number.isInteger(score) || score < 300 || score > 850) {
        throw new Error("Enter a whole-number score from 300 to 850");
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(observedOn)) {
        throw new Error("Choose an observation date");
      }
      return { score, observedOn };
    };

    const createForm = scope.querySelector(
      "[data-credit-score-source-create]",
    );
    const preset = createForm?.querySelector('[name="preset"]');
    const applyPreset = () => {
      const option = preset?.selectedOptions[0];
      if (!option || !createForm) return;
      createForm.elements.label.value = option.dataset.label || "";
      createForm.elements.bureau.value = option.dataset.bureau || "";
      createForm.elements.model.value = option.dataset.model || "";
    };
    preset?.addEventListener("change", applyPreset);
    applyPreset();

    createForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      let createdSource = null;
      try {
        const sourceInput = sourcePayload(form);
        const observation = observationPayload(form);
        setBusy(form, true, "Adding source…");
        const source = await requestJson(
          "/api/v1/credit-score-sources",
          {
            method: "POST",
            body: sourceInput,
          },
        );
        createdSource = source.source;
        await requestJson(
          `/api/v1/credit-score-sources/${encodeURIComponent(createdSource.id)}/observations/${encodeURIComponent(observation.observedOn)}`,
          { body: { score: observation.score } },
        );
        const status = statusFor(form);
        if (status) status.textContent = "Source added";
        window.location.reload();
      } catch (error) {
        if (createdSource) {
          const status = statusFor(form);
          if (status) {
            status.textContent =
              "Source added, but the score did not save. Reloading…";
          }
          window.setTimeout(() => window.location.reload(), 900);
          return;
        }
        setBusy(form, false, error.message || "Couldn’t add source");
      }
    });

    scope
      .querySelectorAll("[data-credit-score-observation]")
      .forEach((form) => {
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          try {
            const observation = observationPayload(form);
            setBusy(form, true, "Saving score…");
            await requestJson(
              `/api/v1/credit-score-sources/${encodeURIComponent(form.dataset.sourceId)}/observations/${encodeURIComponent(observation.observedOn)}`,
              { body: { score: observation.score } },
            );
            const status = statusFor(form);
            if (status) status.textContent = "Score saved";
            window.location.reload();
          } catch (error) {
            setBusy(form, false, error.message || "Couldn’t save score");
          }
        });
      });

    scope
      .querySelectorAll("[data-credit-score-correct]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const source = button.closest("[data-credit-score-source]");
          const form = source?.querySelector(
            "[data-credit-score-observation]",
          );
          if (!form) return;
          form.elements.score.value = button.dataset.score || "";
          form.elements.observed_on.value = button.dataset.date || "";
          form.elements.score.focus();
        });
      });

    scope
      .querySelectorAll("[data-credit-score-source-edit]")
      .forEach((form) => {
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          try {
            const sourceInput = sourcePayload(form);
            setBusy(form, true, "Saving source…");
            await requestJson(
              `/api/v1/credit-score-sources/${encodeURIComponent(form.dataset.sourceId)}`,
              { body: sourceInput },
            );
            const status = statusFor(form);
            if (status) status.textContent = "Source saved";
            window.location.reload();
          } catch (error) {
            setBusy(form, false, error.message || "Couldn’t save source");
          }
        });
      });

    scope
      .querySelectorAll("[data-credit-score-archive]")
      .forEach((button) => {
        button.addEventListener("click", async () => {
          if (
            !window.confirm(
              "Archive this score source? It will leave current averages while its earlier history stays intact.",
            )
          ) {
            return;
          }
          const source = button.closest("[data-credit-score-source]");
          const status = statusFor(button.closest("form") || source);
          button.disabled = true;
          if (status) status.textContent = "Archiving…";
          try {
            await requestJson(
              `/api/v1/credit-score-sources/${encodeURIComponent(button.dataset.creditScoreArchive)}`,
              { method: "DELETE" },
            );
            window.location.reload();
          } catch (error) {
            button.disabled = false;
            if (status) {
              status.textContent = error.message || "Couldn’t archive source";
            }
          }
        });
      });
  }

  function planningForms() {
    const forms = document.querySelectorAll("[data-plan-form]");
    const disclosureStateKey = "money.plan.save-state.v1";
    try {
      const savedState = JSON.parse(
        window.sessionStorage.getItem(disclosureStateKey) || "null",
      );
      if (savedState?.disclosure) {
        const disclosure = document.querySelector(
          `[data-plan-disclosure="${CSS.escape(savedState.disclosure)}"]`,
        );
        if (disclosure instanceof HTMLDetailsElement) {
          disclosure.open = true;
          const status = disclosure.querySelector("[data-plan-status]");
          if (status) status.textContent = savedState.message || "Saved";
        }
      }
      window.sessionStorage.removeItem(disclosureStateKey);
    } catch {
      // Saving still works when session storage is unavailable.
    }
    const budgetRows = [
      ...document.querySelectorAll("[data-budget-category-id]"),
    ];
    const budgetRowsById = new Map(
      budgetRows.map((row) => [
        row.dataset.budgetCategoryId,
        row,
      ]),
    );
    const collapsedBudgetIds = new Set();
    const refreshBudgetTree = () => {
      for (const row of budgetRows) {
        let parentId = row.dataset.budgetParentId;
        let hidden = false;
        const visited = new Set();
        while (parentId && !visited.has(parentId)) {
          if (collapsedBudgetIds.has(parentId)) {
            hidden = true;
            break;
          }
          visited.add(parentId);
          parentId =
            budgetRowsById.get(parentId)?.dataset.budgetParentId || "";
        }
        row.hidden = hidden;
      }
    };
    document.querySelectorAll("[data-budget-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        const row = button.closest("[data-budget-category-id]");
        const categoryId = row?.dataset.budgetCategoryId;
        if (!categoryId) return;
        const collapsed = collapsedBudgetIds.has(categoryId);
        if (collapsed) {
          collapsedBudgetIds.delete(categoryId);
        } else {
          collapsedBudgetIds.add(categoryId);
        }
        button.setAttribute("aria-expanded", String(collapsed));
        const category =
          row.querySelector(".budget-category-link")?.textContent?.trim() ||
          "category";
        button.setAttribute(
          "aria-label",
          `${collapsed ? "Collapse" : "Expand"} ${category} child budgets`,
        );
        refreshBudgetTree();
      });
    });
    if (!forms.length) return;
    const csrfToken =
      document.querySelector('meta[name="csrf-token"]')?.content || "";
    const goalDialogOpeners = document.querySelectorAll(
      "[data-goal-dialog-open]",
    );
    const goalDialogOpenersByDialog = new WeakMap();

    goalDialogOpeners.forEach((opener) => {
      opener.addEventListener("click", () => {
        const dialog = document.getElementById(
          opener.dataset.goalDialogTarget || "",
        );
        if (!(dialog instanceof HTMLDialogElement)) return;
        goalDialogOpenersByDialog.set(dialog, opener);
        dialog.showModal();
        dialog.querySelector("[data-goal-dialog-initial-focus]")?.focus();
      });
    });

    document.querySelectorAll("[data-goal-dialog]").forEach((dialog) => {
      dialog
        .querySelectorAll("[data-goal-dialog-close]")
        .forEach((button) =>
          button.addEventListener("click", () => dialog.close()),
        );
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
      dialog.addEventListener("close", () => {
        dialog.querySelectorAll("form").forEach((form) => {
          form.reset();
          const status = form.querySelector("[data-plan-status]");
          if (status) status.textContent = "";
        });
        goalDialogOpenersByDialog.get(dialog)?.focus();
      });
    });

    const minorUnits = (value) => {
      const normalized = String(value ?? "")
        .trim()
        .replaceAll(",", "")
        .replace(/^\$/, "");
      if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) {
        throw new Error("Enter a valid dollar amount with at most two decimals.");
      }
      const [whole, fractional = ""] = normalized.split(".");
      const amount = Number(whole) * 100 + Number(fractional.padEnd(2, "0"));
      if (!Number.isSafeInteger(amount)) {
        throw new Error("That amount is too large.");
      }
      return amount;
    };

    const idempotencyKeyFor = (form) => {
      const key =
        form.dataset.idempotencyKey ||
        (window.crypto?.randomUUID?.() ??
          `web-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      form.dataset.idempotencyKey = key;
      return key;
    };

    const payloadFor = (form, submitter) => {
      if (form.dataset.transactionSplit !== undefined) {
        if (submitter?.dataset.clearSplit !== undefined) {
          return {
            lines: [],
            expected_version: Number(
              form.elements.namedItem("expected_version")?.value ?? 0,
            ),
            idempotency_key: idempotencyKeyFor(form),
          };
        }
        const sign = Math.sign(Number(form.dataset.sourceAmount)) || 1;
        return {
          lines: [...form.querySelectorAll("[data-split-line]")].map(
            (line) => ({
              category: line.querySelector("[data-split-category]").value,
              amount_minor:
                sign *
                minorUnits(line.querySelector("[data-split-amount]").value),
            }),
          ),
          expected_version: Number(
            form.elements.namedItem("expected_version")?.value ?? 0,
          ),
          idempotency_key: idempotencyKeyFor(form),
        };
      }
      if (form.dataset.budgetBatchForm !== undefined) {
        const selectedRows = [
          ...form.querySelectorAll("[data-budget-add-row]"),
        ].filter(
          (row) => row.querySelector("[data-budget-add-toggle]")?.checked,
        );
        if (!selectedRows.length) {
          throw new Error("Select at least one budget category.");
        }
        return {
          lines: selectedRows.map((row) => {
            const toggle = row.querySelector("[data-budget-add-toggle]");
            return {
              category_id: toggle.value,
              amount_minor: minorUnits(
                row.querySelector("[data-budget-add-amount]").value,
              ),
              tracking_mode: row.querySelector(
                "[data-budget-add-tracking]",
              ).value,
              expected_version: Number(
                toggle.dataset.budgetVersion || 0,
              ),
            };
          }),
          idempotency_key: idempotencyKeyFor(form),
        };
      }
      const payload = Object.fromEntries(new FormData(form));
      if (form.dataset.budgetIncomeForm !== undefined) {
        payload.income_category_ids = [
          ...form.querySelectorAll(
            'input[name="income_category_ids"]:checked',
          ),
        ].map((input) => input.value);
      }
      form.querySelectorAll("[data-money-minor]").forEach((input) => {
        payload[input.dataset.moneyMinor] = minorUnits(input.value);
      });
      for (const [key, value] of Object.entries(payload)) {
        if (value !== "") continue;
        const field = form.elements.namedItem(key);
        if (field?.dataset?.nullWhenEmpty !== undefined) {
          payload[key] = null;
        } else {
          delete payload[key];
        }
      }
      if ((form.dataset.method || "POST") !== "GET") {
        payload.idempotency_key = idempotencyKeyFor(form);
      }
      return payload;
    };

    document
      .querySelectorAll("[data-budget-batch-form]")
      .forEach((form) => {
        const rows = [
          ...form.querySelectorAll("[data-budget-add-row]"),
        ];
        const submit = form.querySelector("[data-budget-batch-submit]");
        const update = () => {
          let selectedCount = 0;
          for (const row of rows) {
            const toggle = row.querySelector("[data-budget-add-toggle]");
            const amount = row.querySelector("[data-budget-add-amount]");
            const tracking = row.querySelector(
              "[data-budget-add-tracking]",
            );
            const selected = toggle?.checked === true;
            if (selected) selectedCount += 1;
            if (amount) {
              amount.disabled = !selected;
              amount.required = selected;
            }
            if (tracking) tracking.disabled = !selected;
          }
          if (submit) {
            submit.disabled = selectedCount === 0;
            submit.textContent = selectedCount
              ? `Add ${selectedCount} categor${selectedCount === 1 ? "y" : "ies"}`
              : "Add selected";
          }
        };
        rows.forEach((row) =>
          row
            .querySelector("[data-budget-add-toggle]")
            ?.addEventListener("change", update),
        );
        update();
      });

    const incomeCategoryCount = document.querySelector(
      "[data-income-category-count]",
    );
    const incomeForm = document.querySelector(
      "[data-budget-income-form]",
    );
    const updateIncomeCount = () => {
      if (!incomeCategoryCount || !incomeForm) return;
      const count = incomeForm.querySelectorAll(
        'input[name="income_category_ids"]:checked',
      ).length;
      incomeCategoryCount.textContent = `${count} selected`;
    };
    incomeForm
      ?.querySelectorAll('input[name="income_category_ids"]')
      .forEach((input) =>
        input.addEventListener("change", updateIncomeCount),
      );
    updateIncomeCount();

    document
      .querySelectorAll("[data-goal-spend-form]")
      .forEach((form) => {
        const goalSelect = form.querySelector("[data-goal-spend-select]");
        const sourceSelect = form.querySelector("[data-goal-spend-source]");
        const versionInput = form.querySelector("[data-goal-spend-version]");
        const syncGoalVersion = () => {
          const option = goalSelect?.selectedOptions?.[0];
          if (versionInput) {
            versionInput.value = option?.dataset.goalVersion || "";
          }
          sourceSelect?.querySelectorAll("[data-source-label]").forEach(
            (sourceOption) => {
              const source = sourceOption.value;
              const availableMinor = Number(
                option?.dataset[
                  source === "brokerage"
                    ? "brokerageEarmarked"
                    : "cashEarmarked"
                ] || 0,
              );
              sourceOption.textContent = option?.value
                ? `${sourceOption.dataset.sourceLabel} · ${new Intl.NumberFormat(
                    "en-US",
                    {
                      style: "currency",
                      currency: "USD",
                    },
                  ).format(availableMinor / 100)} earmarked · overspend allowed`
                : `${sourceOption.dataset.sourceLabel} · overspend allowed`;
            },
          );
        };
        goalSelect?.addEventListener("change", syncGoalVersion);
        syncGoalVersion();
      });

    forms.forEach((form) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        const status = form.querySelector("[data-plan-status]");
        const submitter = event.submitter;
        if (submitter) submitter.disabled = true;
        if (status) status.textContent = "Saving…";
        try {
          const response = await fetch(form.dataset.endpoint, {
            method: form.dataset.method || "POST",
            credentials: "same-origin",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-CSRF-Token": csrfToken,
            },
            body: JSON.stringify(payloadFor(form, submitter)),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(body.message || body.error || "The plan did not save.");
          }
          if (status) status.textContent = body.title || "Saved";
          delete form.dataset.idempotencyKey;
          const disclosure = form.closest("[data-plan-disclosure]");
          if (disclosure?.dataset.planDisclosure) {
            try {
              window.sessionStorage.setItem(
                disclosureStateKey,
                JSON.stringify({
                  disclosure: disclosure.dataset.planDisclosure,
                  message: body.title || "Saved",
                }),
              );
            } catch {
              // The inline status still confirms the save.
            }
          }
          const reloadDelay = form.dataset.endpoint.includes("/budget")
            ? 650
            : 250;
          window.setTimeout(() => window.location.reload(), reloadDelay);
        } catch (error) {
          if (status) {
            status.textContent = error.message || "The plan did not save.";
          }
          if (submitter) submitter.disabled = false;
        }
      });
    });

    document.querySelectorAll("[data-budget-remove]").forEach((button) => {
      button.addEventListener("click", async () => {
        const form = button.closest("[data-plan-form]");
        const status = form?.querySelector("[data-plan-status]");
        if (
          !form ||
          !window.confirm(
            "Remove this category and any child allocations from the budget?",
          )
        ) {
          return;
        }
        button.disabled = true;
        if (status) status.textContent = "Removing…";
        try {
          const response = await fetch(button.dataset.endpoint, {
            method: "DELETE",
            credentials: "same-origin",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-CSRF-Token": csrfToken,
            },
            body: JSON.stringify({
              expected_version: Number(
                form.elements.namedItem("expected_version")?.value ?? 0,
              ),
              confirm_descendants: true,
              idempotency_key:
                window.crypto?.randomUUID?.() ??
                `web-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(
              body.message || body.error || "The budget was not removed.",
            );
          }
          if (status) status.textContent = body.title || "Removed";
          window.setTimeout(() => window.location.reload(), 650);
        } catch (error) {
          if (status) status.textContent = error.message;
          button.disabled = false;
        }
      });
    });
  }

  function detailDialogs() {
    const dialogs = [
      ...document.querySelectorAll("[data-detail-dialog]"),
    ];
    const links = [
      ...document.querySelectorAll("[data-detail-dialog-link]"),
    ];
    const scrollStorageKey = "money.detail-scroll.v1";

    links.forEach((link) => {
      link.addEventListener("click", (event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        const destination = new URL(link.href, window.location.origin);
        if (
          destination.origin !== window.location.origin ||
          destination.pathname !== window.location.pathname
        ) {
          return;
        }
        try {
          window.sessionStorage.setItem(
            scrollStorageKey,
            JSON.stringify({
              pathname: destination.pathname,
              search: destination.search,
              scrollY: window.scrollY,
              savedAt: Date.now(),
            }),
          );
        } catch {
          // Scroll restoration is a convenience; the dialog still works.
        }
      });
    });

    if (!dialogs.length) return;

    let openedFromInPageLink = false;
    try {
      const saved = JSON.parse(
        window.sessionStorage.getItem(scrollStorageKey) || "null",
      );
      window.sessionStorage.removeItem(scrollStorageKey);
      if (
        saved?.pathname === window.location.pathname &&
        saved?.search === window.location.search &&
        Number.isFinite(saved.scrollY) &&
        Date.now() - Number(saved.savedAt) < 30_000
      ) {
        openedFromInPageLink = true;
        window.scrollTo({ top: saved.scrollY, behavior: "auto" });
      }
    } catch {
      // Ignore unavailable or malformed session storage.
    }

    dialogs.forEach((dialog) => {
      const selectedLink = document.querySelector(
        '[data-detail-dialog-link][aria-current="true"]',
      );
      const closeButton = dialog.querySelector(
        "[data-detail-dialog-close]",
      );

      closeButton?.addEventListener("click", () => dialog.close());
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
      dialog.addEventListener("close", () => {
        const queryKey = dialog.dataset.detailQueryKey;
        if (queryKey) {
          if (openedFromInPageLink) {
            window.history.back();
            return;
          }
          const directUrl = new URL(window.location.href);
          directUrl.searchParams.delete(queryKey);
          window.history.replaceState(
            null,
            "",
            `${directUrl.pathname}${directUrl.search}${directUrl.hash}`,
          );
        }
        selectedLink?.focus();
      });

      if (
        dialog.dataset.detailAutoOpen !== undefined &&
        !dialog.open
      ) {
        dialog.showModal();
        closeButton?.focus();
      }
    });
  }

  function dismissibleNotifications() {
    const notifications = [
      ...document.querySelectorAll("[data-dismissible-notification]"),
    ];
    if (!notifications.length) return;

    const storageKey = "money.dismissed-notifications.v1";
    let dismissed = new Set();
    try {
      const stored = JSON.parse(
        window.sessionStorage.getItem(storageKey) || "[]",
      );
      if (Array.isArray(stored)) {
        dismissed = new Set(
          stored.filter((value) => typeof value === "string"),
        );
      }
    } catch {
      // Dismissal remains useful even when session storage is unavailable.
    }

    notifications.forEach((notification) => {
      const notificationId =
        notification.dataset.dismissibleNotification;
      if (!notificationId) return;
      if (dismissed.has(notificationId)) {
        notification.hidden = true;
        return;
      }

      notification
        .querySelector("[data-notification-dismiss]")
        ?.addEventListener("click", () => {
          dismissed.add(notificationId);
          try {
            window.sessionStorage.setItem(
              storageKey,
              JSON.stringify([...dismissed].slice(-50)),
            );
          } catch {
            // Hiding the notification does not depend on persistence.
          }
          notification.hidden = true;
        });
    });
  }

  function initialize() {
    localDateTimes();
    dismissibleNotifications();
    accountAliases();
    mobileNavigation();
    globalSearch();
    searchPage();
    recurringControls();
    recurringClassification();
    dashboardBalanceSwitcher();
    periodControls();
    settingsForms();
    plaidLink();
    appleCardImport();
    exportTransactions();
    transactionBulkEdit();
    transactionNotes();
    transactionOrganization();
    transactionRecurringPatterns();
    insightBulkActions();
    insightActions();
    transactionCleanupRules();
    transactionCleanup();
    creditScoreTracking();
    planningForms();
    detailDialogs();
    transactionLocations();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
