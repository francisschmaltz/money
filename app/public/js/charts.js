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

  const shared = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 450 },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#171717",
        titleFont: { family: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif", size: 11 },
        bodyFont: { family: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif", size: 12 },
        padding: 10,
        cornerRadius: 8,
      },
    },
  };

  function lineChart(canvas) {
    const labels = parse(canvas, "labels");
    const values = parse(canvas, "values");
    const color = canvas.dataset.color || "#2fa94f";
    return new window.Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: color,
          backgroundColor: "transparent",
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: color,
          pointHoverBorderColor: "#fff",
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
            ticks: { color: "#8b8b8b", font: { size: 10 }, maxTicksLimit: 6 },
          },
          y: {
            position: "right",
            border: { display: false },
            grid: { color: "#efefef" },
            ticks: {
              color: "#8b8b8b",
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
    return new window.Chart(canvas, {
      type: "bar",
      data: {
        labels: [""],
        datasets: labels.map((label, index) => ({
          label,
          data: [values[index]],
          backgroundColor: colors[index],
          borderColor: "#ffffff",
          borderWidth: 1.5,
          borderSkipped: false,
          borderRadius: index === 0
            ? { topLeft: 7, bottomLeft: 7 }
            : index === labels.length - 1
              ? { topRight: 7, bottomRight: 7 }
              : 0,
          barThickness: 31,
        })),
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
    return new window.Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: ["#2fa94f", "#5cc576", "#91d8a5", "#438bd7", "#2764ae", "#a7a7a7"],
          borderColor: "#ffffff",
          borderWidth: 3,
          hoverOffset: 2,
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
    return new window.Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: series.map((item) => ({
          label: item.label,
          data: item.values,
          borderColor: item.color,
          backgroundColor: "transparent",
          borderWidth: item.border_width || 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: item.color,
          pointHoverBorderColor: "#fff",
          pointHoverBorderWidth: 2,
          tension: 0.3,
          spanGaps: false,
          fill: false,
        })),
      },
      options: {
        ...shared,
        interaction: { intersect: false, mode: "index" },
        scales: {
          x: {
            border: { display: false },
            grid: { display: false },
            ticks: {
              color: "#8b8b8b",
              font: { size: 10 },
              maxTicksLimit: 6,
            },
          },
          y: {
            position: "right",
            beginAtZero: true,
            border: { display: false },
            grid: { color: "#efefef" },
            ticks: {
              color: "#8b8b8b",
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
    return new window.Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: series.map((item) => ({
          label: item.label,
          data: item.values,
          borderColor: item.color,
          backgroundColor: "transparent",
          borderWidth: item.border_width || 2,
          borderDash: item.border_dash || [],
          pointRadius: item.values.length < 12 ? 3 : 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: item.color,
          pointHoverBorderColor: "#fff",
          pointHoverBorderWidth: 2,
          tension: 0.25,
          spanGaps: false,
          fill: false,
          stepped: "before",
        })),
      },
      options: {
        ...shared,
        interaction: { intersect: false, mode: "index" },
        scales: {
          x: {
            border: { display: false },
            grid: { display: false },
            ticks: {
              color: "#8b8b8b",
              font: { size: 10 },
              maxTicksLimit: 6,
            },
          },
          y: {
            position: "right",
            min: 300,
            max: 850,
            border: { display: false },
            grid: { color: "#efefef" },
            ticks: {
              color: "#8b8b8b",
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

  function initialize() {
    if (!window.Chart) {
      document.documentElement.dataset.charts = "unavailable";
      return;
    }
    document.querySelectorAll("canvas[data-chart]").forEach((canvas) => {
      if (canvas.dataset.chartReady) return;
      canvas.dataset.chartReady = "true";
      const type = canvas.dataset.chart;
      let chart = null;
      if (type === "line") chart = lineChart(canvas);
      if (type === "spending") chart = spendingChart(canvas);
      if (type === "doughnut") chart = doughnutChart(canvas);
      if (type === "credit") chart = creditChart(canvas);
      if (type === "credit-score") chart = creditScoreChart(canvas);
      if (chart) canvas.moneyChart = chart;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
