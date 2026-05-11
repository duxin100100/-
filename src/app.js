import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.mjs";

const state = {
  parsed: null,
};

const els = {
  pdfInput: document.querySelector("#pdfInput"),
  uploadPanel: document.querySelector("#uploadPanel"),
  statusPanel: document.querySelector("#statusPanel"),
  statusText: document.querySelector("#statusText"),
  errorPanel: document.querySelector("#errorPanel"),
  errorText: document.querySelector("#errorText"),
  resultPanel: document.querySelector("#resultPanel"),
  resetButton: document.querySelector("#resetButton"),
  exportButton: document.querySelector("#exportButton"),
  captureArea: document.querySelector("#captureArea"),
  endingValue: document.querySelector("#endingValue"),
  cumulativeDeposit: document.querySelector("#cumulativeDeposit"),
  totalProfit: document.querySelector("#totalProfit"),
  profitRate: document.querySelector("#profitRate"),
  rankList: document.querySelector("#rankList"),
  symbolCount: document.querySelector("#symbolCount"),
  offlineHint: document.querySelector("#offlineHint"),
};

els.pdfInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  await parseFile(file);
});

els.resetButton.addEventListener("click", resetUi);
els.exportButton.addEventListener("click", exportScreenshot);
registerServiceWorker();

async function parseFile(file) {
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    showError("仅支持 .pdf 文件。");
    return;
  }

  showStatus("正在读取 PDF...");

  try {
    const buffer = await file.arrayBuffer();
    showStatus("正在解析报表文本...");
    const pages = await withTimeout(extractPdfPages(buffer), 45000);
    const parsed = parseIbkrReport(pages);

    if (!parsed.accountSummary || parsed.symbolProfits.length === 0) {
      throw new Error("无法识别该 IBKR 报表，请确认上传的是 Activity Statement / 活动报表 PDF。");
    }

    state.parsed = parsed;
    renderResults(parsed);
  } catch (error) {
    showError(error.message || "无法识别该 IBKR 报表，请确认上传的是 Activity Statement / 活动报表 PDF。");
  }
}

async function extractPdfPages(buffer) {
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    useSystemFonts: true,
  }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = groupTextItemsIntoLines(content.items);
    const text = content.items
      .map((item) => normalizeText(item.str))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push({ pageNumber, lines, text });
  }

  return pages;
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      window.setTimeout(() => {
        reject(new Error("PDF 解析超时，请刷新页面后重新上传。"));
      }, timeoutMs);
    }),
  ]);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    setOfflineHint("当前浏览器不支持离线安装。", "unavailable");
    return;
  }

  if (!window.isSecureContext) {
    setOfflineHint("离线安装需要 HTTPS；本地测试请用 localhost。", "unavailable");
    return;
  }

  try {
    await navigator.serviceWorker.register("./service-worker.js");
    await navigator.serviceWorker.ready;
    setOfflineHint("离线缓存已准备好，可添加到主屏幕。", "ready");
  } catch (error) {
    setOfflineHint("离线缓存准备失败，请刷新后重试。", "unavailable");
  }
}

function setOfflineHint(message, status) {
  if (!els.offlineHint) return;
  els.offlineHint.textContent = message;
  els.offlineHint.classList.remove("ready", "unavailable");
  if (status) els.offlineHint.classList.add(status);
}

function groupTextItemsIntoLines(items) {
  const rows = new Map();

  for (const item of items) {
    const y = Math.round(item.transform[5] / 3) * 3;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({
      text: normalizeText(item.str),
      x: item.transform[4],
    });
  }

  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, row]) =>
      row
        .sort((a, b) => a.x - b.x)
        .map((item) => item.text)
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

export function parseIbkrReport(pages) {
  const lines = pages.flatMap((page) => page.lines);
  const fullText = pages.map((page) => page.text).join(" ").replace(/\s+/g, " ").trim();
  const accountSummary = parseAccountSummary(fullText, lines);
  const symbolProfits = parseSymbolProfits(fullText);

  if (!accountSummary) {
    throw new Error("未能识别累积存款或结束价值，请检查报表是否包含账户摘要。");
  }

  if (symbolProfits.length === 0) {
    throw new Error("未识别到股票收益数据，请确认报表中包含 Realized / Unrealized P&L 数据。");
  }

  return {
    accountSummary,
    symbolProfits,
  };
}

function parseAccountSummary(fullText, lines) {
  const currency = findCurrency(fullText, lines);
  const cumulativeDeposit = findFirstAmountAfterLabel(fullText, [
    "累积存款",
    "累计存款",
    "净存款",
    "存款和取款",
    "Net Deposits",
    "Deposits & Withdrawals",
    "Cumulative Deposits",
    "Deposits",
  ]);
  const endingValue = findFirstAmountAfterLabel(fullText, [
    "结束价值",
    "期末价值",
    "Ending Value",
    "Ending Net Liquidation Value",
    "Net Liquidation Value",
    "Total Ending Value",
  ]);

  if (!Number.isFinite(cumulativeDeposit) || !Number.isFinite(endingValue)) {
    return null;
  }

  const totalProfit = endingValue - cumulativeDeposit;
  const profitRate = cumulativeDeposit === 0 ? 0 : totalProfit / cumulativeDeposit;

  return {
    cumulativeDeposit,
    endingValue,
    totalProfit,
    profitRate,
    currency,
  };
}

function findCurrency(fullText, lines) {
  const textMatch = fullText.match(/(?:基础货币|Base Currency)\s+([A-Z]{3})/i);
  if (textMatch) return textMatch[1].toUpperCase();
  for (const line of lines) {
    const lineMatch = line.match(/(?:基础货币|Base Currency)\s+([A-Z]{3})/i);
    if (lineMatch) return lineMatch[1].toUpperCase();
  }
  return undefined;
}

function findFirstAmountAfterLabel(fullText, labels) {
  for (const label of labels) {
    const labelPattern = escapeRegExp(label).replace(/\\ /g, "\\s+");
    const re = new RegExp(`${labelPattern}\\s+(?:[A-Z]{3}\\s+)?(${NUMBER_PATTERN})`, "i");
    const match = fullText.match(re);
    if (match) return parseAmount(match[1]);
  }
  return NaN;
}

function parseSymbolProfits(fullText) {
  const buckets = new Map();
  const stockSection = extractBetween(
    fullText,
    /已实现和未实现的表现总结|Realized and Unrealized Performance Summary/i,
    /总数\s+股票|Total\s+Stocks?/i,
  );
  const stockRowsText = trimThroughLastAssetHeader(stockSection, /(?:^|\s)(股票|Stocks?)\s+/i);
  collectProfitRows(stockRowsText, "stock", buckets);

  const realizedStart = fullText.search(/已实现和未实现的表现总结|Realized and Unrealized Performance Summary/i);
  const realizedText = realizedStart >= 0 ? fullText.slice(realizedStart) : fullText;
  const optionStart = realizedText.search(/股票和指数期权|Stock and Index Options?/i);
  if (optionStart >= 0) {
    const optionText = realizedText.slice(optionStart);
    const optionSection = extractBetween(
      optionText,
      /股票和指数期权|Stock and Index Options?/i,
      /总数\s+股票和指数期权|Total\s+Stock and Index Options?/i,
    );
    collectProfitRows(optionSection, "option", buckets);
  }

  return [...buckets.values()]
    .map((item) => ({
      ...item,
      stockRealizedPL: roundMoney(item.stockRealizedPL),
      stockUnrealizedPL: roundMoney(item.stockUnrealizedPL),
      optionProfit: roundMoney(item.optionProfit),
      totalProfit: roundMoney(item.stockRealizedPL + item.stockUnrealizedPL + item.optionProfit),
    }))
    .filter((item) => Math.abs(item.totalProfit) > 0.004)
    .sort((a, b) => b.totalProfit - a.totalProfit);
}

function extractBetween(text, startRe, endRe) {
  const startMatch = text.match(startRe);
  if (!startMatch || startMatch.index === undefined) return "";
  const start = startMatch.index + startMatch[0].length;
  const rest = text.slice(start);
  const endMatch = rest.match(endRe);
  const end = endMatch && endMatch.index !== undefined ? endMatch.index : rest.length;
  return rest.slice(0, end).trim();
}

function trimThroughLastAssetHeader(section, headerRe) {
  const matches = [...section.matchAll(new RegExp(headerRe.source, `${headerRe.flags.includes("i") ? "i" : ""}g`))];
  if (matches.length === 0) return section;
  const last = matches[matches.length - 1];
  return section.slice((last.index || 0) + last[0].length).trim();
}

function collectProfitRows(section, assetClass, buckets) {
  const cleaned = section
    .replace(/活动账单\s+-.*?页面:\s*\d+/g, " ")
    .replace(/Activity Statement\s+-.*?Page:\s*\d+/gi, " ")
    .replace(/已实现和未实现的表现总结|Realized and Unrealized Performance Summary/gi, " ")
    .replace(/已实现和\s*表现总结/g, " ")
    .replace(/代码|Symbol|费用调整|Cost Adj\.?|已实现的|未实现的|短期利润|短期损失|长期利润|长期损失|总数/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const rowRe = new RegExp(`(.+?)\\s+(${NUMBER_PATTERN})\\s+(${NUMBER_PATTERN})\\s+(${NUMBER_PATTERN})\\s+(${NUMBER_PATTERN})\\s+(${NUMBER_PATTERN})\\s+(${NUMBER_PATTERN})\\s+(${NUMBER_PATTERN})\\s+(${NUMBER_PATTERN})\\s+(${NUMBER_PATTERN})\\s+(${NUMBER_PATTERN})\\s+(${NUMBER_PATTERN})\\s+(${NUMBER_PATTERN})(?=\\s+(?:[A-Z][A-Z0-9]*(?:\\s[A-Z])?(?:\\s+\\d{1,2}[A-Z]{3}\\d{2}|\\s+\\d{6}[CP]\\d{8})?|总数|Total|外汇|Forex|$))`, "g");
  let match;

  while ((match = rowRe.exec(cleaned))) {
    const label = match[1].trim();
    if (!label || /^(股票|Stocks?|股票和指数期权|Stock and Index Options?|外汇|Forex)$/i.test(label)) continue;

    const cols = match.slice(2).map(parseAmount);
    if (cols.some((value) => !Number.isFinite(value))) continue;

    const symbol = assetClass === "option" ? extractUnderlyingSymbol(label) : normalizeSymbol(label);
    if (!symbol) continue;

    const bucket = getBucket(buckets, symbol);
    if (assetClass === "stock") {
      bucket.stockRealizedPL += cols[5];
      bucket.stockUnrealizedPL += cols[10];
    } else {
      bucket.optionProfit += cols[5];
    }
  }
}

function extractUnderlyingSymbol(label) {
  const osi = label.match(/^([A-Z]{1,6})\s+\d{6}[CP]\d{8}$/);
  if (osi) return osi[1];

  const standard = label.match(/^([A-Z][A-Z0-9]*(?:\s[A-Z])?)\s+\d{1,2}[A-Z]{3}\d{2}\s+/i);
  if (standard) return normalizeSymbol(standard[1]);

  const first = label.match(/^([A-Z][A-Z0-9]*(?:\s[A-Z])?)/);
  return first ? normalizeSymbol(first[1]) : "UNKNOWN";
}

function normalizeSymbol(label) {
  const compact = label
    .replace(/\s+(?:INC|CORP|LTD|PLC|ETF|COM|CLASS|CL).*$/i, "")
    .trim()
    .toUpperCase();
  const match = compact.match(/^[A-Z][A-Z0-9]*(?:\s[A-Z])?/);
  return match ? match[0] : "";
}

function getBucket(buckets, symbol) {
  if (!buckets.has(symbol)) {
    buckets.set(symbol, {
      symbol,
      stockRealizedPL: 0,
      stockUnrealizedPL: 0,
      optionProfit: 0,
      totalProfit: 0,
    });
  }
  return buckets.get(symbol);
}

function renderResults(parsed) {
  const { accountSummary, symbolProfits } = parsed;
  hideAll();
  els.resultPanel.hidden = false;
  els.resetButton.hidden = false;

  els.endingValue.textContent = formatMoney(accountSummary.endingValue, accountSummary.currency, false);
  els.cumulativeDeposit.textContent = formatMoney(accountSummary.cumulativeDeposit, accountSummary.currency, false);
  els.totalProfit.textContent = formatMoney(accountSummary.totalProfit, accountSummary.currency, true);
  els.totalProfit.className = accountSummary.totalProfit < 0 ? "negative" : "positive";
  els.profitRate.textContent = formatRate(accountSummary.profitRate);
  els.profitRate.classList.toggle("negative", accountSummary.profitRate < 0);
  els.symbolCount.textContent = `${symbolProfits.length} 个标的`;

  els.rankList.innerHTML = symbolProfits
    .map(
      (item, index) => `
        <article class="rank-card">
          <div class="rank-main">
            <div class="symbol">
              <span class="rank-index">${index + 1}</span>
              <strong>${escapeHtml(item.symbol)}</strong>
            </div>
            <div class="profit-value ${item.totalProfit < 0 ? "negative" : ""}">
              ${formatMoney(item.totalProfit, accountSummary.currency, true)}
            </div>
          </div>
          <div class="metric-grid">
            ${renderMetric("已实现盈亏", item.stockRealizedPL, accountSummary.currency)}
            ${renderMetric("未实现盈亏", item.stockUnrealizedPL, accountSummary.currency)}
            ${renderMetric("期权收益", item.optionProfit, accountSummary.currency)}
          </div>
        </article>
      `,
    )
    .join("");
}

function renderMetric(label, value, currency) {
  const cls = value < 0 ? "negative" : value > 0 ? "positive" : "";
  return `
    <div class="metric">
      <span>${label}</span>
      <strong class="${cls}">${formatMoney(value, currency, true)}</strong>
    </div>
  `;
}

async function exportScreenshot() {
  if (!window.html2canvas) {
    showError("截图组件加载失败，请刷新页面后再试。");
    return;
  }

  const canvas = await window.html2canvas(els.captureArea, {
    backgroundColor: "#f6f7f5",
    scale: Math.min(window.devicePixelRatio || 1, 2),
  });
  const link = document.createElement("a");
  link.download = `ibkr-summary-${new Date().toISOString().slice(0, 10)}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

function showStatus(message) {
  hideAll();
  els.statusPanel.hidden = false;
  els.statusText.textContent = message;
  els.resetButton.hidden = true;
}

function showError(message) {
  hideAll();
  els.errorPanel.hidden = false;
  els.errorText.textContent = message;
  els.resetButton.hidden = false;
}

function resetUi() {
  state.parsed = null;
  els.pdfInput.value = "";
  hideAll();
  els.uploadPanel.hidden = false;
  els.resetButton.hidden = true;
}

function hideAll() {
  els.uploadPanel.hidden = true;
  els.statusPanel.hidden = true;
  els.errorPanel.hidden = true;
  els.resultPanel.hidden = true;
}

function formatMoney(value, currency, signed) {
  const abs = Math.abs(value);
  const prefix = signed ? (value > 0 ? "+" : value < 0 ? "-" : "") : "";
  const formatted = abs.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${prefix}${currency ? `${currency} ` : ""}${formatted}`;
}

function formatRate(value) {
  const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${prefix}${Math.abs(value * 100).toFixed(2)}%`;
}

function parseAmount(value) {
  if (typeof value !== "string") return NaN;
  const trimmed = value.trim();
  const negativeByParens = /^\(.+\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[(),]/g, "").replace(/[A-Z]{3}/gi, "");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return NaN;
  return negativeByParens ? -parsed : parsed;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizeText(value) {
  return String(value || "").replace(/\u00a0/g, " ").trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const NUMBER_PATTERN = String.raw`-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)`;
