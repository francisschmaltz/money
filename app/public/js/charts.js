(() => {
  const money = (value, { axis = false, currency = "USD" } = {}) => {
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation:
        axis && Math.abs(value) >= 1_000_000 ? "compact" : "standard",
      ...(axis
        ? { maximumFractionDigits: Math.abs(value) >= 1_000_000 ? 1 : 0 }
        : {}),
    });
    const fractionDigits = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits;
    return formatter.format(value / 10 ** fractionDigits);
  };

  const parse = (canvas, key) => {
    try {
      return JSON.parse(canvas.dataset[key] || "[]");
    } catch {
      return [];
    }
  };

  const chartFallback = (
    canvas,
    message = "Chart unavailable. The numeric summary is still current.",
  ) => {
    if (!canvas || canvas.dataset.chartFallback === "true") return;
    canvas.dataset.chartFallback = "true";
    canvas.hidden = true;
    const fallback = document.createElement("p");
    fallback.className = "card-note chart-fallback";
    fallback.setAttribute("role", "status");
    fallback.textContent = message;
    canvas.insertAdjacentElement("afterend", fallback);
  };

  let colorProbe = null;

  const cssValue = (name, fallback) => {
    if (typeof window.getComputedStyle !== "function") return fallback;
    const value = window
      .getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    if (!value) return fallback;
    if (!value.includes("light-dark(")) return value;
    if (!document.body || typeof document.createElement !== "function") {
      return fallback;
    }
    if (!colorProbe) {
      colorProbe = document.createElement("span");
      colorProbe.hidden = true;
      colorProbe.setAttribute("aria-hidden", "true");
      document.body.append(colorProbe);
    }
    colorProbe.style.color = `var(${name})`;
    return window.getComputedStyle(colorProbe).color || fallback;
  };

  const SPENDING_COLOR_TOKENS = new Map([
    ["#2fa94f", "--chart-spending-1"],
    ["#5cc576", "--chart-spending-2"],
    ["#91d8a5", "--chart-spending-3"],
    ["#8abde9", "--chart-spending-4"],
    ["#438bd7", "--chart-spending-5"],
    ["#2764ae", "--chart-spending-6"],
    ["#a7a7a7", "--chart-spending-7"],
    ["#666666", "--chart-spending-8"],
  ]);
  const LINE_COLOR_TOKENS = new Map([
    ["#2fa94f", "--chart-line-default"],
    ["#249342", "--chart-line-dashboard"],
    ["#2f8f4e", "--chart-line-transactions"],
    ["#2664ae", "--chart-line-portfolio"],
  ]);
  const PORTFOLIO_COLOR_TOKENS = Array.from(
    { length: 6 },
    (_, index) => `--chart-portfolio-allocation-${index + 1}`,
  );
  const CREDIT_COLOR_TOKENS = Array.from(
    { length: 6 },
    (_, index) => `--chart-credit-card-${index + 1}`,
  );
  const SCORE_COLOR_TOKENS = Array.from(
    { length: 4 },
    (_, index) => `--chart-score-person-${index + 1}`,
  );

  const normalizedColor = (value) =>
    typeof value === "string" ? value.trim().toLowerCase() : "";

  const validColorToken = (value) =>
    typeof value === "string" &&
    /^--chart-[a-z0-9-]+$/.test(value)
      ? value
      : null;

  const themedColor = (token, fallback) =>
    token ? cssValue(token, fallback) : fallback;

  const seriesColorToken = (type, item, index) => {
    const declared = validColorToken(item?.color_token);
    if (declared) return declared;
    if (type === "credit") {
      return index === 0
        ? "--chart-credit-total"
        : CREDIT_COLOR_TOKENS[(index - 1) % CREDIT_COLOR_TOKENS.length];
    }
    if (type === "credit-score") {
      return item?.border_dash?.length
        ? "--chart-score-household"
        : SCORE_COLOR_TOKENS[index % SCORE_COLOR_TOKENS.length];
    }
    return null;
  };

  const themeTokens = () => {
    const dark =
      document.documentElement.dataset.resolvedTheme === "dark";
    return {
      axis: cssValue("--chart-axis", dark ? "#b8b8b8" : "#8b8b8b"),
      grid: cssValue("--chart-grid", dark ? "#303030" : "#efefef"),
      separator: cssValue(
        "--chart-separator",
        dark ? "#191919" : "#ffffff",
      ),
      tooltipBackground: cssValue(
        "--chart-tooltip-bg",
        dark ? "#f4f4f4" : "#171717",
      ),
      tooltipText: cssValue(
        "--chart-tooltip-text",
        dark ? "#171717" : "#ffffff",
      ),
    };
  };

  const sharedOptions = (tokens) => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: window.matchMedia("(prefers-reduced-motion: reduce)")
        .matches
        ? 0
        : 450,
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: tokens.tooltipBackground,
        titleColor: tokens.tooltipText,
        bodyColor: tokens.tooltipText,
        borderColor: tokens.grid,
        borderWidth: 1,
        titleFont: {
          family:
            "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
          size: 11,
        },
        bodyFont: {
          family:
            "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
          size: 12,
        },
        padding: 10,
        cornerRadius: 8,
      },
    },
  });

  function lineChart(canvas) {
    const labels = parse(canvas, "labels");
    const values = parse(canvas, "values");
    const sourceColor = canvas.dataset.color || "#2fa94f";
    const colorToken =
      LINE_COLOR_TOKENS.get(normalizedColor(sourceColor)) ||
      "--chart-line-default";
    const color = themedColor(colorToken, sourceColor);
    const tokens = themeTokens();
    const shared = sharedOptions(tokens);
    return new window.Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: color,
          backgroundColor: "transparent",
          moneyColorToken: colorToken,
          moneyColorFallback: sourceColor,
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: color,
          pointHoverBorderColor: tokens.separator,
          pointHoverBorderWidth: 2,
          tension: 0.32,
          fill: false,
        }],
      },
      options: {
        ...shared,
        interaction: { intersect: false, mode: "index" },
        scales: {
          x: {
            border: { display: false },
            grid: { display: false },
            ticks: { color: tokens.axis, font: { size: 10 }, maxTicksLimit: 6 },
          },
          y: {
            position: "right",
            border: { display: false },
            grid: { color: tokens.grid },
            ticks: {
              color: tokens.axis,
              font: { size: 10 },
              maxTicksLimit: 4,
              callback: (value) => money(value, { axis: true }),
            },
          },
        },
        plugins: {
          ...shared.plugins,
          tooltip: {
            ...shared.plugins.tooltip,
            callbacks: { label: (context) => money(context.parsed.y) },
          },
        },
      },
    });
  }

  function spendingChart(canvas) {
    const labels = parse(canvas, "labels");
    const values = parse(canvas, "values");
    const colors = parse(canvas, "colors");
    const tokens = themeTokens();
    const shared = sharedOptions(tokens);
    return new window.Chart(canvas, {
      type: "bar",
      data: {
        labels: [""],
        datasets: labels.map((label, index) => {
          const sourceColor = colors[index];
          const colorToken = SPENDING_COLOR_TOKENS.get(
            normalizedColor(sourceColor),
          );
          return {
            label,
            data: [values[index]],
            backgroundColor: themedColor(colorToken, sourceColor),
            borderColor: tokens.separator,
            borderWidth: 1.5,
            borderSkipped: false,
            borderRadius: index === 0
              ? { topLeft: 7, bottomLeft: 7 }
              : index === labels.length - 1
                ? { topRight: 7, bottomRight: 7 }
                : 0,
            barThickness: 31,
            moneyColorToken: colorToken,
            moneyColorFallback: sourceColor,
          };
        }),
      },
      options: {
        ...shared,
        indexAxis: "y",
        scales: {
          x: { stacked: true, display: false },
          y: { stacked: true, display: false },
        },
        plugins: {
          ...shared.plugins,
          tooltip: {
            ...shared.plugins.tooltip,
            callbacks: { label: (context) => `${context.dataset.label}: ${money(context.raw)}` },
          },
        },
      },
    });
  }

  function doughnutChart(canvas) {
    const labels = parse(canvas, "labels");
    const values = parse(canvas, "values");
    const tokens = themeTokens();
    const shared = sharedOptions(tokens);
    const palette = PORTFOLIO_COLOR_TOKENS.map((token) =>
      themedColor(token, "currentColor"),
    );
    return new window.Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: palette,
          borderColor: tokens.separator,
          borderWidth: 3,
          hoverOffset: 2,
          moneyColorTokens: PORTFOLIO_COLOR_TOKENS,
        }],
      },
      options: {
        ...shared,
        cutout: "71%",
        plugins: {
          ...shared.plugins,
          tooltip: {
            ...shared.plugins.tooltip,
            callbacks: { label: (context) => `${context.label}: ${context.raw}%` },
          },
        },
      },
    });
  }

  function creditChart(canvas) {
    const labels = parse(canvas, "labels");
    const series = parse(canvas, "series");
    const tokens = themeTokens();
    const shared = sharedOptions(tokens);
    return new window.Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: series.map((item, index) => {
          const colorToken = seriesColorToken("credit", item, index);
          const color = themedColor(colorToken, item.color);
          return {
            label: item.label,
            data: item.values,
            borderColor: color,
            backgroundColor: "transparent",
            borderWidth: item.border_width || 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: color,
            pointHoverBorderColor: tokens.separator,
            pointHoverBorderWidth: 2,
            tension: 0.3,
            spanGaps: false,
            fill: false,
            moneyColorToken: colorToken,
            moneyColorFallback: item.color,
          };
        }),
      },
      options: {
        ...shared,
        interaction: { intersect: false, mode: "index" },
        scales: {
          x: {
            border: { display: false },
            grid: { display: false },
            ticks: {
              color: tokens.axis,
              font: { size: 10 },
              maxTicksLimit: 6,
            },
          },
          y: {
            position: "right",
            beginAtZero: true,
            border: { display: false },
            grid: { color: tokens.grid },
            ticks: {
              color: tokens.axis,
              font: { size: 10 },
              maxTicksLimit: 5,
              callback: (value) => `${(Number(value) / 100).toFixed(0)}%`,
            },
          },
        },
        plugins: {
          ...shared.plugins,
          tooltip: {
            ...shared.plugins.tooltip,
            callbacks: {
              label: (context) =>
                context.parsed.y == null
                  ? `${context.dataset.label}: unavailable`
                  : `${context.dataset.label}: ${(context.parsed.y / 100).toFixed(1)}%`,
            },
          },
        },
      },
    });
  }

  function creditScoreChart(canvas) {
    const labels = parse(canvas, "labels");
    const series = parse(canvas, "series");
    const tokens = themeTokens();
    const shared = sharedOptions(tokens);
    return new window.Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: series.map((item, index) => {
          const colorToken = seriesColorToken(
            "credit-score",
            item,
            index,
          );
          const color = themedColor(colorToken, item.color);
          return {
            label: item.label,
            data: item.values,
            borderColor: color,
            backgroundColor: "transparent",
            borderWidth: item.border_width || 2,
            borderDash: item.border_dash || [],
            pointRadius: item.values.length < 12 ? 3 : 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: color,
            pointHoverBorderColor: tokens.separator,
            pointHoverBorderWidth: 2,
            tension: 0.25,
            spanGaps: false,
            fill: false,
            stepped: "before",
            moneyColorToken: colorToken,
            moneyColorFallback: item.color,
          };
        }),
      },
      options: {
        ...shared,
        interaction: { intersect: false, mode: "index" },
        scales: {
          x: {
            border: { display: false },
            grid: { display: false },
            ticks: {
              color: tokens.axis,
              font: { size: 10 },
              maxTicksLimit: 6,
            },
          },
          y: {
            position: "right",
            min: 300,
            max: 850,
            border: { display: false },
            grid: { color: tokens.grid },
            ticks: {
              color: tokens.axis,
              font: { size: 10 },
              precision: 0,
              maxTicksLimit: 5,
            },
          },
        },
        plugins: {
          ...shared.plugins,
          tooltip: {
            ...shared.plugins.tooltip,
            callbacks: {
              label: (context) =>
                context.parsed.y == null
                  ? `${context.dataset.label}: unavailable`
                  : `${context.dataset.label}: ${Math.round(context.parsed.y)}`,
            },
          },
        },
      },
    });
  }

  const updateChartTheme = (canvas) => {
    const chart = canvas.moneyChart;
    if (!chart) return;
    const tokens = themeTokens();
    const tooltip = chart.options?.plugins?.tooltip;
    if (tooltip) {
      tooltip.backgroundColor = tokens.tooltipBackground;
      tooltip.titleColor = tokens.tooltipText;
      tooltip.bodyColor = tokens.tooltipText;
      tooltip.borderColor = tokens.grid;
    }
    for (const scale of Object.values(chart.options?.scales || {})) {
      if (scale.ticks) scale.ticks.color = tokens.axis;
      if (scale.grid && scale.grid.display !== false) {
        scale.grid.color = tokens.grid;
      }
    }
    const spendingSourceColors =
      canvas.dataset.chart === "spending" ? parse(canvas, "colors") : [];
    const sourceSeries =
      canvas.dataset.chart === "credit" ||
      canvas.dataset.chart === "credit-score"
        ? parse(canvas, "series")
        : [];
    for (const [index, dataset] of (
      chart.data?.datasets || []
    ).entries()) {
      if ("pointHoverBorderColor" in dataset) {
        dataset.pointHoverBorderColor = tokens.separator;
      }
      if (
        canvas.dataset.chart === "spending" ||
        canvas.dataset.chart === "doughnut"
      ) {
        dataset.borderColor = tokens.separator;
      }
      if (canvas.dataset.chart === "spending") {
        const sourceColor =
          dataset.moneyColorFallback || spendingSourceColors[index];
        const colorToken =
          validColorToken(dataset.moneyColorToken) ||
          SPENDING_COLOR_TOKENS.get(normalizedColor(sourceColor));
        dataset.backgroundColor = themedColor(
          colorToken,
          sourceColor || dataset.backgroundColor,
        );
        dataset.moneyColorToken = colorToken;
        dataset.moneyColorFallback = sourceColor;
      }
      if (canvas.dataset.chart === "doughnut") {
        const colorTokens = Array.isArray(dataset.moneyColorTokens)
          ? dataset.moneyColorTokens
          : PORTFOLIO_COLOR_TOKENS;
        dataset.backgroundColor = colorTokens.map((token, index) =>
          themedColor(
            validColorToken(token),
            dataset.backgroundColor?.[index] || "currentColor",
          ),
        );
      }
      if (
        canvas.dataset.chart === "line" ||
        canvas.dataset.chart === "credit" ||
        canvas.dataset.chart === "credit-score"
      ) {
        const sourceItem = sourceSeries[index];
        const sourceColor =
          dataset.moneyColorFallback ||
          (canvas.dataset.chart === "line"
            ? canvas.dataset.color
            : sourceItem?.color);
        const colorToken =
          validColorToken(dataset.moneyColorToken) ||
          (canvas.dataset.chart === "line"
            ? LINE_COLOR_TOKENS.get(normalizedColor(sourceColor)) ||
              "--chart-line-default"
            : seriesColorToken(
                canvas.dataset.chart,
                sourceItem,
                index,
              ));
        const color = themedColor(
          colorToken,
          sourceColor || dataset.borderColor,
        );
        dataset.borderColor = color;
        dataset.pointHoverBackgroundColor = color;
        dataset.moneyColorToken = colorToken;
        dataset.moneyColorFallback = sourceColor;
      }
    }
    chart.update("none");
  };

  const updateCreditLegends = () => {
    document
      .querySelectorAll("[data-chart-color-token]")
      .forEach((marker) => {
        const token = validColorToken(marker.dataset.chartColorToken);
        if (!token || typeof marker.style?.setProperty !== "function") {
          return;
        }
        marker.style.setProperty(
          "--credit-series-color",
          themedColor(token, "currentColor"),
        );
      });
  };

  const updateChartsForTheme = () => {
    document
      .querySelectorAll("canvas[data-chart]")
      .forEach(updateChartTheme);
    updateCreditLegends();
  };

  function initialize() {
    updateCreditLegends();
    if (!window.Chart) {
      document.documentElement.dataset.charts = "unavailable";
      document
        .querySelectorAll("canvas[data-chart]")
        .forEach((canvas) => chartFallback(canvas));
      return;
    }
    document.querySelectorAll("canvas[data-chart]").forEach((canvas) => {
      if (canvas.dataset.chartReady) return;
      canvas.dataset.chartReady = "true";
      const type = canvas.dataset.chart;
      let chart = null;
      try {
        if (type === "line") chart = lineChart(canvas);
        if (type === "spending") chart = spendingChart(canvas);
        if (type === "doughnut") chart = doughnutChart(canvas);
        if (type === "credit") chart = creditChart(canvas);
        if (type === "credit-score") chart = creditScoreChart(canvas);
        if (chart) {
          canvas.moneyChart = chart;
        } else {
          chartFallback(canvas);
        }
      } catch {
        chartFallback(canvas);
      }
    });
  }

  window.addEventListener("money:themechange", updateChartsForTheme);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
