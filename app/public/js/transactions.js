(() => {
  const resolvedChartColor = (token, fallback) => {
    if (typeof window.getComputedStyle !== "function") return fallback;
    const value = window
      .getComputedStyle(document.documentElement)
      .getPropertyValue(token)
      .trim();
    if (!value) return fallback;
    if (!value.includes("light-dark(")) return value;
    const probe = document.createElement("span");
    probe.hidden = true;
    probe.setAttribute("aria-hidden", "true");
    probe.style.color = `var(${token})`;
    document.body.append(probe);
    const resolved = window.getComputedStyle(probe).color || fallback;
    probe.remove();
    return resolved;
  };

  const chartSeparatorColor = () =>
    resolvedChartColor(
      "--chart-separator",
      window.moneyAppearance?.resolved === "dark"
        ? "#191919"
        : "#ffffff",
    );

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
      url.searchParams.delete("analytics_segment");
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
    const activeState = () => {
      const params = new URL(window.location.href).searchParams;
      const requestedGroup = params.get("analytics_group");
      const groupKey = groupingKeys.includes(requestedGroup)
        ? requestedGroup
        : groupingKeys.includes("category")
          ? "category"
          : groupingKeys[0];
      return {
        groupKey,
        grouping: groupings[groupKey],
        params,
      };
    };
    const appendText = (parent, tag, text) => {
      const element = document.createElement(tag);
      element.textContent = text;
      parent.append(element);
      return element;
    };
    const segmentUrl = (groupKey, segment) => {
      if (!segment || segment.key === `${groupKey}-other`) {
        return null;
      }
      return urlFor({
        analytics_group: groupKey,
        [groupKey === "merchant" ? "merchant" : "category"]:
          segment.value,
      });
    };

    const renderSegmentList = (groupKey, grouping) => {
      if (!segmentList) return;
      segmentList.replaceChildren();
      for (const [segmentIndex, segment] of grouping.segments.entries()) {
        const href = segmentUrl(groupKey, segment);
        const item = document.createElement("article");
        item.className = "spending-detail-category";
        item.toggleAttribute("data-spending-segment-item", true);

        const control = document.createElement(href ? "a" : "div");
        control.className = "spending-detail-category__select";
        if (href) {
          control.href = href;
          control.dataset.spendingSegment = "";
          control.dataset.segmentKey = segment.key;
        } else {
          control.setAttribute(
            "aria-label",
            "Other groups combined",
          );
        }

        const dot = document.createElement("span");
        dot.className = "category-dot";
        dot.style.setProperty(
          "--category-color",
          `var(--chart-spending-${(segmentIndex % 8) + 1})`,
        );
        dot.setAttribute("aria-hidden", "true");
        control.append(dot);

        const icon = document.createElement("span");
        icon.className = "list-icon list-icon--compact";
        icon.setAttribute("aria-hidden", "true");
        const glyph = document.createElement("i");
        glyph.className = `ph ${segment.icon || "ph-receipt"}`;
        icon.append(glyph);
        control.append(icon);

        const copy = document.createElement("span");
        appendText(
          copy,
          "strong",
          href ? segment.label : "Other groups combined",
        );
        appendText(
          copy,
          "small",
          `${formatPercent(segment.percent)}% · ${segment.count} transaction${segment.count === 1 ? "" : "s"}`,
        );
        control.append(copy);
        appendText(control, "strong", formatMoney(segment.amount));
        item.append(control);
        segmentList.append(item);
      }
    };

    const updateBreakdownChart = (grouping) => {
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
          .join(", ")}.`,
      );
      const chart = breakdownCanvas.moneyChart;
      if (!chart) return;
      chart.data.datasets = segments.map((segment, index) => {
        const colorToken = `--chart-spending-${(index % 8) + 1}`;
        return {
          label: segment.label,
          data: [segment.amount?.amount_minor ?? 0],
          backgroundColor: resolvedChartColor(
            colorToken,
            segment.color,
          ),
          borderColor: chartSeparatorColor(),
          borderWidth: 1.5,
          borderSkipped: false,
          borderRadius:
            index === 0
              ? { topLeft: 7, bottomLeft: 7 }
              : index === segments.length - 1
                ? { topRight: 7, bottomRight: 7 }
                : 0,
          barThickness: 31,
          moneyColorToken: colorToken,
          moneyColorFallback: segment.color,
        };
      });
      chart.update();
    };

    const updateLineChart = (grouping) => {
      if (!lineCanvas) return;
      const labels = grouping.seriesLabels;
      const values = grouping.seriesValues;
      const title = `${intervalTitle(grouping.seriesInterval)} spending`;
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
            grouping.segments[0]?.amount?.currency || "USD",
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
          const value = current.searchParams.get("analytics_group");
          if (value) target.searchParams.set("analytics_group", value);
          else target.searchParams.delete("analytics_group");
          target.searchParams.delete("analytics_segment");
          link.href = `${target.pathname}${target.search}${target.hash}`;
        });
    };

    const render = () => {
      const { groupKey, grouping, params } = activeState();
      const filterName =
        groupKey === "merchant" ? "merchant" : "category";
      const activeFilter = params.get(filterName);
      root.dataset.activeGroup = groupKey;
      root.removeAttribute("data-active-segment");
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
          });
        });
      setHiddenFilterValue("analytics_group", groupKey);
      if (segmentHeading) {
        segmentHeading.textContent = activeFilter
          ? grouping.segments[0]?.label ?? activeFilter
          : `All ${groupingPlural(grouping)}`;
      }
      if (selectionStatus) {
        selectionStatus.textContent = activeFilter
          ? groupKey === "merchant"
            ? `Filtering transactions by merchant ${activeFilter}.`
            : `Filtering transactions by ${grouping.segments[0]?.label ?? activeFilter} and its descendants.`
          : `Showing all ${grouping.label.toLowerCase()} spending.`;
      }
      if (reset) {
        reset.hidden = !activeFilter;
        reset.textContent = `Clear ${grouping.label.toLowerCase()}`;
        reset.href = urlFor({ [filterName]: null });
      }
      renderSegmentList(groupKey, grouping);
      updateLedgerNavigation();
      updateBreakdownChart(grouping);
      updateLineChart(grouping);
    };

    const pushGroupingState = (groupKey) => {
      window.history.pushState(
        { spendingExplorer: true },
        "",
        urlFor({ analytics_group: groupKey }),
      );
      render();
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
        pushGroupingState(group.dataset.group);
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
      const href = segmentUrl(
        current.groupKey,
        current.grouping.segments[index],
      );
      if (href) window.location.assign(href);
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
