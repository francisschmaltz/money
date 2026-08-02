import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const chartsScriptPath = path.resolve("app/public/js/charts.js");
const chartsStylesPath = path.resolve("app/public/css/money.css");
const creditViewPath = path.resolve("app/views/credit.ejs");
const transactionsScriptPath = path.resolve(
  "app/public/js/transactions.js",
);

class FakeTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) {
      listener.call(this, event);
    }
  }
}

function canvas(type, dataset = {}) {
  return {
    dataset: {
      chart: type,
      labels: "[]",
      values: "[]",
      ...dataset,
    },
  };
}

async function chartHarness() {
  const source = await readFile(chartsScriptPath, "utf8");
  const root = { dataset: { resolvedTheme: "light" } };
  const lightPalette = new Map([
    ["--chart-spending-1", "#2fa94f"],
    ["--chart-spending-2", "#5cc576"],
    ["--chart-spending-3", "#91d8a5"],
    ["--chart-spending-4", "#8abde9"],
    ["--chart-spending-5", "#438bd7"],
    ["--chart-spending-6", "#2764ae"],
    ["--chart-spending-7", "#a7a7a7"],
    ["--chart-spending-8", "#666666"],
    ["--chart-line-dashboard", "#249342"],
    ["--chart-line-portfolio", "#2664ae"],
    ["--chart-credit-total", "#249342"],
    ["--chart-credit-card-3", "#7f8b96"],
    ["--chart-score-person-2", "#8a5ac2"],
    ["--chart-score-household", "#249342"],
    ["--chart-portfolio-allocation-1", "#2fa94f"],
    ["--chart-portfolio-allocation-2", "#5cc576"],
    ["--chart-portfolio-allocation-3", "#91d8a5"],
    ["--chart-portfolio-allocation-4", "#438bd7"],
    ["--chart-portfolio-allocation-5", "#2764ae"],
    ["--chart-portfolio-allocation-6", "#a7a7a7"],
  ]);
  const darkPalette = new Map([
    ["--chart-spending-1", "#56d477"],
    ["--chart-spending-2", "#79dc92"],
    ["--chart-spending-3", "#a2e4b4"],
    ["--chart-spending-4", "#8dc5f2"],
    ["--chart-spending-5", "#6eafea"],
    ["--chart-spending-6", "#78a8ed"],
    ["--chart-spending-7", "#b8b8b8"],
    ["--chart-spending-8", "#9f9f9f"],
    ["--chart-line-dashboard", "#56d477"],
    ["--chart-line-portfolio", "#78a8ed"],
    ["--chart-credit-total", "#56d477"],
    ["--chart-credit-card-3", "#aeb8c2"],
    ["--chart-score-person-2", "#bd91eb"],
    ["--chart-score-household", "#56d477"],
    ["--chart-portfolio-allocation-1", "#56d477"],
    ["--chart-portfolio-allocation-2", "#79dc92"],
    ["--chart-portfolio-allocation-3", "#a2e4b4"],
    ["--chart-portfolio-allocation-4", "#6eafea"],
    ["--chart-portfolio-allocation-5", "#78a8ed"],
    ["--chart-portfolio-allocation-6", "#b8b8b8"],
  ]);
  const variables = new Map([
    ["--chart-axis", "light-dark(#707070, #b8b8b8)"],
    ["--chart-grid", "#dedede"],
    ["--chart-separator", "#ffffff"],
    ["--chart-tooltip-bg", "#171717"],
    ["--chart-tooltip-text", "#ffffff"],
    ...lightPalette,
  ]);
  const resolvedVariables = new Map([
    ["--chart-axis", "rgb(112, 112, 112)"],
  ]);
  const spendingColors = [
    "#2fa94f",
    "#5cc576",
    "#91d8a5",
    "#8abde9",
    "#438bd7",
    "#2764ae",
    "#a7a7a7",
    "#666666",
  ];
  const canvases = [
    canvas("line", {
      labels: '["Jan","Feb"]',
      values: "[100,200]",
      color: "#249342",
    }),
    canvas("line", {
      labels: '["Jan","Feb"]',
      values: "[100,200]",
      color: "#2664ae",
    }),
    canvas("spending", {
      labels: JSON.stringify(spendingColors),
      values: JSON.stringify(spendingColors.map((_, index) => index)),
      colors: JSON.stringify(spendingColors),
    }),
    canvas("doughnut", {
      labels: '["Cash","Stocks"]',
      values: "[30,70]",
    }),
    canvas("credit", {
      labels: '["Jan","Feb"]',
      series: JSON.stringify([
        {
          label: "Total",
          color: "#249342",
          color_token: "--chart-credit-total",
          values: [1000, 900],
        },
        {
          label: "Card",
          color: "#7f8b96",
          color_token: "--chart-credit-card-3",
          values: [500, 400],
        },
      ]),
    }),
    canvas("credit-score", {
      labels: '["Jan","Feb"]',
      series: JSON.stringify([
        {
          label: "Person",
          color: "#8a5ac2",
          color_token: "--chart-score-person-2",
          values: [700, 710],
        },
        {
          label: "Household average",
          color: "#249342",
          color_token: "--chart-score-household",
          border_dash: [7, 5],
          values: [690, 700],
        },
      ]),
    }),
  ];
  const legendMarkers = [
    "--chart-credit-total",
    "--chart-score-person-2",
  ].map((chartColorToken) => {
    const values = new Map();
    return {
      dataset: { chartColorToken },
      style: {
        setProperty(name, value) {
          values.set(name, value);
        },
        getPropertyValue(name) {
          return values.get(name) || "";
        },
      },
    };
  });
  const document = {
    body: {
      append(element) {
        element.isConnected = true;
      },
    },
    createElement() {
      return {
        hidden: false,
        style: {},
        setAttribute() {},
      };
    },
    documentElement: root,
    readyState: "complete",
    querySelectorAll(selector) {
      if (selector === "canvas[data-chart]") return canvases;
      if (selector === "[data-chart-color-token]") {
        return legendMarkers;
      }
      return [];
    },
  };
  class FakeChart {
    constructor(target, configuration) {
      this.target = target;
      this.data = configuration.data;
      this.options = configuration.options;
      this.type = configuration.type;
      this.updates = [];
    }

    update(mode) {
      this.updates.push(mode);
    }
  }
  const window = new FakeTarget();
  Object.assign(window, {
    Chart: FakeChart,
    getComputedStyle(target) {
      if (target !== root) {
        const name = target.style.color.match(/^var\((--[^)]+)\)$/)?.[1];
        return { color: resolvedVariables.get(name) || "" };
      }
      return {
        getPropertyValue(name) {
          return variables.get(name) || "";
        },
      };
    },
    matchMedia() {
      return { matches: true };
    },
  });
  const context = vm.createContext({
    Intl,
    JSON,
    Math,
    Number,
    Object,
    console,
    document,
    window,
  });
  vm.runInContext(source, context, { filename: chartsScriptPath });
  return {
    canvases,
    darkPalette,
    legendMarkers,
    resolvedVariables,
    root,
    variables,
    window,
  };
}

test("charts consume semantic tokens and update existing instances on theme change", async () => {
  const {
    canvases,
    darkPalette,
    legendMarkers,
    resolvedVariables,
    root,
    variables,
    window,
  } = await chartHarness();
  const [dashboardLine, portfolioLine, spending, doughnut, credit, score] =
    canvases;
  const originalInstances = canvases.map((item) => item.moneyChart);

  assert.equal(
    dashboardLine.moneyChart.options.scales.x.ticks.color,
    "rgb(112, 112, 112)",
  );
  assert.equal(
    dashboardLine.moneyChart.options.scales.y.grid.color,
    "#dedede",
  );
  assert.equal(
    dashboardLine.moneyChart.data.datasets[0].borderColor,
    "#249342",
  );
  assert.equal(
    portfolioLine.moneyChart.data.datasets[0].borderColor,
    "#2664ae",
  );
  assert.equal(
    spending.moneyChart.data.datasets[0].borderColor,
    "#ffffff",
  );
  assert.equal(
    spending.moneyChart.data.datasets
      .map((dataset) => dataset.backgroundColor)
      .join(","),
    "#2fa94f,#5cc576,#91d8a5,#8abde9,#438bd7,#2764ae,#a7a7a7,#666666",
  );
  assert.equal(
    doughnut.moneyChart.data.datasets[0].backgroundColor[0],
    "#2fa94f",
  );
  assert.equal(
    credit.moneyChart.data.datasets[1].borderColor,
    "#7f8b96",
  );
  assert.equal(
    score.moneyChart.data.datasets[0].borderColor,
    "#8a5ac2",
  );
  assert.equal(
    legendMarkers[0].style.getPropertyValue("--credit-series-color"),
    "#249342",
  );

  spending.moneyChart.data.datasets = spending.moneyChart.data.datasets.map(
    (dataset) => ({
      label: dataset.label,
      data: dataset.data,
      backgroundColor: dataset.moneyColorFallback,
      borderColor: dataset.borderColor,
    }),
  );
  for (const chartCanvas of [
    dashboardLine,
    portfolioLine,
    credit,
    score,
  ]) {
    for (const dataset of chartCanvas.moneyChart.data.datasets) {
      delete dataset.moneyColorToken;
      delete dataset.moneyColorFallback;
    }
  }
  delete doughnut.moneyChart.data.datasets[0].moneyColorTokens;

  root.dataset.resolvedTheme = "dark";
  resolvedVariables.set("--chart-axis", "rgb(184, 184, 184)");
  variables.set("--chart-grid", "#303030");
  variables.set("--chart-separator", "#191919");
  variables.set("--chart-tooltip-bg", "#f4f4f4");
  variables.set("--chart-tooltip-text", "#171717");
  for (const [token, color] of darkPalette) {
    variables.set(token, color);
  }
  window.dispatchEvent({ type: "money:themechange" });

  assert.deepEqual(
    canvases.map((item) => item.moneyChart),
    originalInstances,
  );
  assert.equal(
    dashboardLine.moneyChart.options.scales.x.ticks.color,
    "rgb(184, 184, 184)",
  );
  assert.equal(
    dashboardLine.moneyChart.options.scales.y.grid.color,
    "#303030",
  );
  assert.equal(
    dashboardLine.moneyChart.options.plugins.tooltip.backgroundColor,
    "#f4f4f4",
  );
  assert.equal(
    dashboardLine.moneyChart.data.datasets[0].borderColor,
    "#56d477",
  );
  assert.equal(
    portfolioLine.moneyChart.data.datasets[0].borderColor,
    "#78a8ed",
  );
  assert.equal(
    spending.moneyChart.data.datasets[0].borderColor,
    "#191919",
  );
  assert.equal(
    spending.moneyChart.data.datasets
      .map((dataset) => dataset.backgroundColor)
      .join(","),
    "#56d477,#79dc92,#a2e4b4,#8dc5f2,#6eafea,#78a8ed,#b8b8b8,#9f9f9f",
  );
  assert.equal(
    doughnut.moneyChart.data.datasets[0].backgroundColor[0],
    "#56d477",
  );
  assert.equal(
    credit.moneyChart.data.datasets[1].borderColor,
    "#aeb8c2",
  );
  assert.equal(
    score.moneyChart.data.datasets[0].borderColor,
    "#bd91eb",
  );
  assert.equal(
    score.moneyChart.data.datasets[1].pointHoverBackgroundColor,
    "#56d477",
  );
  assert.equal(
    legendMarkers[0].style.getPropertyValue("--credit-series-color"),
    "#56d477",
  );
  assert.equal(
    legendMarkers[1].style.getPropertyValue("--credit-series-color"),
    "#bd91eb",
  );
  assert.ok(
    canvases.every(
      (item) => item.moneyChart.updates.at(-1) === "none",
    ),
  );
});

test("chart palette tokens preserve every existing light source color", async () => {
  const [styles, creditView] = await Promise.all([
    readFile(chartsStylesPath, "utf8"),
    readFile(creditViewPath, "utf8"),
  ]);
  const tokenColors = [
    ["chart-spending-1", "#2fa94f"],
    ["chart-spending-2", "#5cc576"],
    ["chart-spending-3", "#91d8a5"],
    ["chart-spending-4", "#8abde9"],
    ["chart-spending-5", "#438bd7"],
    ["chart-spending-6", "#2764ae"],
    ["chart-spending-7", "#a7a7a7"],
    ["chart-spending-8", "#666666"],
    ["chart-line-default", "#2fa94f"],
    ["chart-line-dashboard", "#249342"],
    ["chart-line-transactions", "#2f8f4e"],
    ["chart-line-portfolio", "#2664ae"],
    ["chart-portfolio-allocation-1", "#2fa94f"],
    ["chart-portfolio-allocation-2", "#5cc576"],
    ["chart-portfolio-allocation-3", "#91d8a5"],
    ["chart-portfolio-allocation-4", "#438bd7"],
    ["chart-portfolio-allocation-5", "#2764ae"],
    ["chart-portfolio-allocation-6", "#a7a7a7"],
    ["chart-credit-total", "#249342"],
    ["chart-credit-card-1", "#438bd7"],
    ["chart-credit-card-2", "#2764ae"],
    ["chart-credit-card-3", "#7f8b96"],
    ["chart-credit-card-4", "#8abde9"],
    ["chart-credit-card-5", "#4f6b58"],
    ["chart-credit-card-6", "#656565"],
    ["chart-score-person-1", "#438bd7"],
    ["chart-score-person-2", "#8a5ac2"],
    ["chart-score-person-3", "#d27a36"],
    ["chart-score-person-4", "#2764ae"],
    ["chart-score-household", "#249342"],
  ];
  for (const [token, lightColor] of tokenColors) {
    assert.match(
      styles,
      new RegExp(`--${token}:\\s*light-dark\\(${lightColor},`),
    );
  }
  assert.match(creditView, /color_token: "--chart-credit-total"/);
  assert.match(creditView, /color_token: "--chart-score-household"/);
  assert.match(creditView, /data-chart-color-token=/);
  assert.doesNotMatch(
    creditView,
    /style="--credit-series-color: <%= series\.color %>"/,
  );
});

test("dynamic transaction charts read the separator token", async () => {
  const [source, view] = await Promise.all([
    readFile(transactionsScriptPath, "utf8"),
    readFile(path.resolve("app/views/transactions.ejs"), "utf8"),
  ]);
  assert.match(source, /getPropertyValue\(token\)/);
  assert.match(
    source,
    /resolvedChartColor\(\s*"--chart-separator",/,
  );
  assert.match(source, /borderColor: chartSeparatorColor\(\)/);
  assert.match(
    source,
    /`var\(--chart-spending-\$\{\(segmentIndex % 8\) \+ 1\}\)`/,
  );
  assert.match(
    view,
    /--category-color: var\(--chart-spending-<%= \(index % 8\) \+ 1 %>\)/,
  );
  assert.match(
    source,
    /backgroundColor: resolvedChartColor\(\s*colorToken,\s*segment\.color,/,
  );
  assert.match(source, /moneyColorToken: colorToken/);
  assert.doesNotMatch(source, /borderColor:\s*"#ffffff"/);
  assert.doesNotMatch(
    source,
    /--category-color",\s*segment\.color/,
  );
});
