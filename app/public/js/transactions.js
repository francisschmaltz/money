(() => {
  function transactionFilters() {
    const form = document.querySelector("[data-transaction-filter]");
    if (!form) return;
    const submit = form.querySelector("[data-transaction-filter-submit]");
    let submitting = false;

    form.addEventListener("submit", (event) => {
      if (submitting) {
        event.preventDefault();
        return;
      }
      submitting = true;
      form
        .querySelectorAll("input[name], select[name]")
        .forEach((control) => {
          if (
            control.type !== "hidden" &&
            String(control.value ?? "").trim() === ""
          ) {
            control.disabled = true;
          }
        });
      form.setAttribute("aria-busy", "true");
      if (submit) {
        submit.disabled = true;
        submit.dataset.originalLabel = submit.textContent;
        submit.textContent = "Applying…";
      }
    });

    window.addEventListener("pageshow", () => {
      submitting = false;
      form.removeAttribute("aria-busy");
      form
        .querySelectorAll("input[name], select[name]")
        .forEach((control) => {
          control.disabled = false;
        });
      if (submit) {
        submit.disabled = false;
        submit.textContent =
          submit.dataset.originalLabel || "Apply";
      }
    });
  }

  function spendingExplorer() {
    const root = document.querySelector("[data-spending-explorer]");
    const payload = root?.querySelector(
      "[data-spending-explorer-data]",
    );
    if (!root || !payload) return;

    let groupings;
    try {
      groupings = JSON.parse(payload.textContent || "{}");
    } catch {
      return;
    }
    const groupingKeys = Object.keys(groupings);
    if (!groupingKeys.length) return;

    const breakdownCanvas = root.querySelector(
      "[data-spending-breakdown-chart]",
    );
    const lineCanvas = root.querySelector(
      "[data-spending-line-chart]",
    );
    const segmentList = root.querySelector(
      "[data-spending-segment-list]",
    );
    const segmentHeading = root.querySelector(
      "[data-spending-segment-heading]",
    );
    const seriesTitle = root.querySelector(
      "[data-spending-series-title]",
    );
    const seriesInterval = root.querySelector(
      "[data-spending-series-interval]",
    );
    const selectionStatus = root.querySelector(
      "[data-spending-selection-status]",
    );
    const reset = root.querySelector(
      "[data-spending-segment-reset]",
    );
    const filterForm = document.querySelector(
      "[data-transaction-filter]",
    );
    const periodLabel = root.dataset.periodLabel || "selected period";

    const formatMoney = (value) => {
      const currency = value?.currency || "USD";
      const digits = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits;
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
      }).format(Number(value?.amount_minor ?? 0) / 10 ** digits);
    };
    const formatPercent = (value) =>
      new Intl.NumberFormat(undefined, {
        maximumFractionDigits: 2,
      }).format(Number(value ?? 0));
    const intervalTitle = (interval) =>
      ({
        day: "Daily",
        week: "Weekly",
        month: "Monthly",
      })[interval] || "Spending";
    const groupingPlural = (grouping) =>
      grouping.key === "category"
        ? "categories"
        : `${grouping.label.toLowerCase()}s`;
    const urlFor = (updates = {}) => {
      const url = new URL(window.location.href);
      url.searchParams.delete("cursor");
      for (const [key, value] of Object.entries(updates)) {
        if (value == null || String(value).trim() === "") {
          url.searchParams.delete(key);
        } else {
          url.searchParams.set(key, String(value));
        }
      }
      return `${url.pathname}${url.search}${url.hash}`;
    };
    const setHiddenFilterValue = (name, value) => {
      if (!filterForm) return;
      let input = filterForm.querySelector(
        `input[type="hidden"][name="${name}"]`,
      );
      if (!value) {
        input?.remove();
        return;
      }
      if (!input) {
        input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        filterForm.append(input);
      }
      input.value = value;
    };
    const mutedColor = (color) =>
      /^#[0-9a-f]{6}$/i.test(color || "")
        ? `${color}55`
        : "#d5d5d5";
    const activeState = () => {
      const params = new URL(window.location.href).searchParams;
      const requestedGroup = params.get("analytics_group");
      const groupKey = groupingKeys.includes(requestedGroup)
        ? requestedGroup
        : groupingKeys.includes("category")
          ? "category"
          : groupingKeys[0];
      const grouping = groupings[groupKey];
      const requestedSegment = params.get("analytics_segment");
      const segment =
        grouping.segments.find(
          (candidate) => candidate.key === requestedSegment,
        ) || null;
      return { groupKey, grouping, segment };
    };
    const appendText = (parent, tag, text, className) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      element.textContent = text;
      parent.append(element);
      return element;
    };
    const segmentUrl = (groupKey, segmentKey) =>
      urlFor({
        analytics_group: groupKey,
        analytics_segment: segmentKey,
      });
    const ledgerUrl = (groupKey, segment) =>
      groupKey === "merchant"
        ? urlFor({ q: segment.value || segment.label })
        : urlFor({ category: segment.value || segment.label });

    const renderSegmentList = (
      groupKey,
      grouping,
      selectedSegment,
      { focusSelection = false } = {},
    ) => {
      if (!segmentList) return;
      segmentList.replaceChildren();
      for (const segment of grouping.segments) {
        const selected = segment.key === selectedSegment?.key;
        const item = document.createElement("article");
        item.className = "spending-detail-category";
        item.toggleAttribute("data-spending-segment-item", true);
        item.classList.toggle("is-selected", selected);

        const select = document.createElement("a");
        select.className = "spending-detail-category__select";
        select.href = segmentUrl(groupKey, segment.key);
        select.dataset.spendingSegment = "";
        select.dataset.segmentKey = segment.key;
        select.setAttribute(
          "aria-current",
          selected ? "true" : "false",
        );

        const dot = document.createElement("span");
        dot.className = "category-dot";
        dot.style.setProperty(
          "--category-color",
          segment.color || "#777777",
        );
        dot.setAttribute("aria-hidden", "true");
        select.append(dot);

        const icon = document.createElement("span");
        icon.className = "list-icon list-icon--compact";
        icon.setAttribute("aria-hidden", "true");
        const glyph = document.createElement("i");
        glyph.className = `ph ${segment.icon || "ph-receipt"}`;
        icon.append(glyph);
        select.append(icon);

        const copy = document.createElement("span");
        appendText(copy, "strong", segment.label);
        appendText(
          copy,
          "small",
          `${formatPercent(segment.percent)}% · ${segment.count} transaction${segment.count === 1 ? "" : "s"}`,
        );
        select.append(copy);
        appendText(
          select,
          "strong",
          formatMoney(segment.amount),
        );
        item.append(select);

        if (!segment.key.endsWith("-other")) {
          const filter = appendText(
            item,
            "a",
            "Show matching transactions",
            "spending-detail-category__filter",
          );
          filter.href = ledgerUrl(groupKey, segment);
        } else {
          appendText(
            item,
            "span",
            "Remaining groups combined",
            "spending-detail-category__filter spending-detail-category__filter--note",
          );
        }
        segmentList.append(item);
      }
      if (focusSelection && selectedSegment) {
        segmentList
          .querySelector(
            `[data-spending-segment][data-segment-key="${CSS.escape(selectedSegment.key)}"]`,
          )
          ?.focus();
      }
    };

    const updateBreakdownChart = (
      grouping,
      selectedSegment,
    ) => {
      if (!breakdownCanvas) return;
      const segments = grouping.segments;
      breakdownCanvas.dataset.labels = JSON.stringify(
        segments.map((segment) => segment.label),
      );
      breakdownCanvas.dataset.values = JSON.stringify(
        segments.map(
          (segment) => segment.amount?.amount_minor ?? 0,
        ),
      );
      breakdownCanvas.dataset.colors = JSON.stringify(
        segments.map((segment) => segment.color),
      );
      breakdownCanvas.setAttribute(
        "aria-label",
        `${periodLabel} spending grouped by ${grouping.label.toLowerCase()}. ${segments
          .map(
            (segment) =>
              `${segment.label} ${formatMoney(segment.amount)}`,
          )
          .join(", ")}${selectedSegment ? `. ${selectedSegment.label} is selected.` : "."}`,
      );
      const chart = breakdownCanvas.moneyChart;
      if (!chart) return;
      chart.data.datasets = segments.map((segment, index) => ({
        label: segment.label,
        data: [segment.amount?.amount_minor ?? 0],
        backgroundColor:
          !selectedSegment ||
          selectedSegment.key === segment.key
            ? segment.color
            : mutedColor(segment.color),
        borderColor: "#ffffff",
        borderWidth: 1.5,
        borderSkipped: false,
        borderRadius:
          index === 0
            ? { topLeft: 7, bottomLeft: 7 }
            : index === segments.length - 1
              ? { topRight: 7, bottomRight: 7 }
              : 0,
        barThickness: 31,
      }));
      chart.update();
    };

    const updateLineChart = (
      grouping,
      selectedSegment,
    ) => {
      if (!lineCanvas) return;
      const labels =
        selectedSegment?.seriesLabels ?? grouping.seriesLabels;
      const values =
        selectedSegment?.seriesValues ?? grouping.seriesValues;
      const title = `${intervalTitle(grouping.seriesInterval)}${
        selectedSegment ? ` ${selectedSegment.label}` : ""
      } spending`;
      lineCanvas.dataset.labels = JSON.stringify(labels);
      lineCanvas.dataset.values = JSON.stringify(values);
      lineCanvas.setAttribute(
        "aria-label",
        `${title} for ${periodLabel}. ${formatMoney({
          amount_minor: values.reduce(
            (sum, value) => sum + Number(value || 0),
            0,
          ),
          currency:
            selectedSegment?.amount?.currency ||
            grouping.segments[0]?.amount?.currency ||
            "USD",
        })} total.`,
      );
      if (seriesTitle) seriesTitle.textContent = title;
      if (seriesInterval) {
        seriesInterval.textContent = grouping.seriesInterval;
      }
      const chart = lineCanvas.moneyChart;
      if (!chart) return;
      chart.data.labels = labels;
      chart.data.datasets[0].data = values;
      chart.update();
    };

    const updateLedgerNavigation = () => {
      const current = new URL(window.location.href);
      document
        .querySelectorAll(
          '.transaction-row[href], .pagination a[href^="/transactions"]',
        )
        .forEach((link) => {
          const target = new URL(
            link.getAttribute("href"),
            window.location.origin,
          );
          for (const key of [
            "analytics_group",
            "analytics_segment",
          ]) {
            const value = current.searchParams.get(key);
            if (value) target.searchParams.set(key, value);
            else target.searchParams.delete(key);
          }
          link.href = `${target.pathname}${target.search}${target.hash}`;
        });
    };

    const render = ({ focusSelection = false } = {}) => {
      const { groupKey, grouping, segment } = activeState();
      root.dataset.activeGroup = groupKey;
      root.dataset.activeSegment = segment?.key || "";
      root
        .querySelectorAll("[data-spending-group]")
        .forEach((control) => {
          const active = control.dataset.group === groupKey;
          control.setAttribute(
            "aria-current",
            active ? "true" : "false",
          );
          control.classList.toggle("is-selected", active);
          control.href = urlFor({
            analytics_group: control.dataset.group,
            analytics_segment: null,
          });
        });
      setHiddenFilterValue("analytics_group", groupKey);
      setHiddenFilterValue(
        "analytics_segment",
        segment?.key || null,
      );
      if (segmentHeading) {
        segmentHeading.textContent = segment
          ? segment.label
          : `All ${groupingPlural(grouping)}`;
      }
      if (selectionStatus) {
        selectionStatus.textContent = segment
          ? `${segment.label} selected. The ledger is unchanged.`
          : `Showing all ${grouping.label.toLowerCase()} spending.`;
      }
      if (reset) {
        reset.hidden = !segment;
        reset.href = urlFor({ analytics_segment: null });
      }
      renderSegmentList(groupKey, grouping, segment, {
        focusSelection,
      });
      updateLedgerNavigation();
      updateBreakdownChart(grouping, segment);
      updateLineChart(grouping, segment);
    };

    const pushExplorerState = (
      updates,
      { focusSelection = false } = {},
    ) => {
      window.history.pushState(
        { spendingExplorer: true },
        "",
        urlFor(updates),
      );
      render({ focusSelection });
    };
    const plainActivation = (event) =>
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey;

    root.addEventListener("click", (event) => {
      const group = event.target.closest("[data-spending-group]");
      if (group && plainActivation(event)) {
        event.preventDefault();
        pushExplorerState({
          analytics_group: group.dataset.group,
          analytics_segment: null,
        });
        return;
      }
      const segment = event.target.closest(
        "[data-spending-segment]",
      );
      if (segment && plainActivation(event)) {
        event.preventDefault();
        const current = activeState();
        pushExplorerState(
          {
            analytics_group: current.groupKey,
            analytics_segment:
              current.segment?.key === segment.dataset.segmentKey
                ? null
                : segment.dataset.segmentKey,
          },
          {
            focusSelection:
              current.segment?.key !== segment.dataset.segmentKey,
          },
        );
        return;
      }
      const clear = event.target.closest(
        "[data-spending-segment-reset]",
      );
      if (clear && plainActivation(event)) {
        event.preventDefault();
        pushExplorerState({ analytics_segment: null });
      }
    });

    breakdownCanvas?.addEventListener("click", (event) => {
      const chart = breakdownCanvas.moneyChart;
      if (!chart) return;
      const points = chart.getElementsAtEventForMode(
        event,
        "nearest",
        { intersect: true },
        true,
      );
      const index = points[0]?.datasetIndex;
      const current = activeState();
      const segment = current.grouping.segments[index];
      if (!segment) return;
      pushExplorerState({
        analytics_group: current.groupKey,
        analytics_segment:
          current.segment?.key === segment.key ? null : segment.key,
      });
    });

    window.addEventListener("popstate", () => render());
    render();
  }

  function initialize() {
    transactionFilters();
    spendingExplorer();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, {
      once: true,
    });
  } else {
    initialize();
  }
})();
