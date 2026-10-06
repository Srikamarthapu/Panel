import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();
const hermesHome = process.env.HERMES_HOME || path.join(home, ".hermes");
const financeDir = path.join(hermesHome, "finance");
const portfolioPath = path.join(financeDir, "portfolio.json");
const policyPath = path.join(financeDir, "investment_policy.md");
const yesterdayPath = path.join(financeDir, "Yesterday's stock analysis.md");
const cronJobsPath = path.join(hermesHome, "cron", "jobs.json");
const cronOutputDir = path.join(hermesHome, "cron", "output");
const envPath = path.join(hermesHome, ".env");
const massiveBaseUrl = "https://api.massive.com";
const marketCache = new Map();

export const POPULAR_SYMBOLS = ["SPY", "QQQ", "VTI", "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "AMD", "TSLA", "JPM"];
const POPULAR_NAMES = {
  SPY: "SPDR S&P 500 ETF Trust",
  QQQ: "Invesco QQQ Trust",
  VTI: "Vanguard Total Stock Market ETF",
  AAPL: "Apple Inc.",
  MSFT: "Microsoft Corporation",
  NVDA: "NVIDIA Corporation",
  GOOGL: "Alphabet Inc.",
  AMZN: "Amazon.com Inc.",
  META: "Meta Platforms Inc.",
  AMD: "Advanced Micro Devices Inc.",
  TSLA: "Tesla Inc.",
  JPM: "JPMorgan Chase & Co."
};

const defaultPortfolio = {
  cash_usd: 100,
  broker: "manual",
  currency: "USD",
  holdings: [],
  watchlist: POPULAR_SYMBOLS.slice(0, 11),
  notes: []
};

function readText(file, fallback = "") {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readText(file));
  } catch {
    return fallback;
  }
}

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function stat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function readHermesEnv() {
  const env = {};
  for (const line of readText(envPath).split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key) env[key] = value;
  }
  return { ...env, ...process.env };
}

function safeNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function uniqueSymbols(values) {
  return Array.from(
    new Set(
      values
        .flat()
        .map((value) => String(value || "").trim().toUpperCase())
        .filter((value) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(value))
    )
  );
}

function cleanSnippet(text, max = 320) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

export function readPortfolio() {
  return { ...defaultPortfolio, ...readJson(portfolioPath, defaultPortfolio) };
}

export function findInvestmentJob() {
  const data = readJson(cronJobsPath, { jobs: [] });
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  return (
    jobs.find((job) => job?.name === "Daily investment research") ||
    jobs.find((job) => job?.script === "market_context.py") ||
    null
  );
}

function sectionText(text, label) {
  const wanted = label.toLowerCase();
  const lines = String(text || "").split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const normalized = lines[i]
      .replace(/^#+\s*/, "")
      .replace(/^\d+\.\s*/, "")
      .replace(/:$/, "")
      .trim()
      .toLowerCase();
    if (normalized === wanted || normalized.startsWith(`${wanted}:`)) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return "";

  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/^\s*(#+\s+|\d+\.\s+\S)/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function actionFromMemo(text) {
  const recommended = sectionText(text, "Recommended Action");
  const match = (recommended || text).match(/\b(trim\/sell|buy|hold|wait|trim|sell)\b/i);
  return match ? match[1].toLowerCase() : "pending";
}

function fileTimestamp(file) {
  const match = path.basename(file).match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}T${match[2]}:${match[3]}:${match[4]}`;
  return stat(file)?.mtime?.toISOString() || "";
}

export function readInvestmentMemos(jobId = findInvestmentJob()?.id) {
  if (!jobId) return [];
  const outputDir = path.join(cronOutputDir, jobId);
  if (!exists(outputDir)) return [];

  return fs
    .readdirSync(outputDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const file = path.join(outputDir, name);
      const body = readText(file);
      return {
        id: `${jobId}-${name}`,
        file,
        name,
        updatedAt: fileTimestamp(file),
        action: actionFromMemo(body),
        marketDataStatus: cleanSnippet(sectionText(body, "Market Data Status")),
        portfolioSnapshot: cleanSnippet(sectionText(body, "Portfolio Snapshot")),
        allocation: cleanSnippet(sectionText(body, "Exact Proposed Allocation within the 100 USD limit") || sectionText(body, "Exact Proposed Allocation")),
        risks: cleanSnippet(sectionText(body, "Risks and What Would Change Your Mind")),
        carryForward: cleanSnippet(sectionText(body, "Carry-forward for Tomorrow")),
        excerpt: cleanSnippet(body.replace(/^#.+$/m, ""))
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 12);
}

function cacheKey(apiPath, params) {
  return `${apiPath}?${new URLSearchParams(Object.entries(params || {}).sort()).toString()}`;
}

async function massiveGet(apiPath, params = {}, { ttlMs = 45000 } = {}) {
  const keyName = cacheKey(apiPath, params);
  const cached = marketCache.get(keyName);
  if (cached && Date.now() - cached.createdAt < ttlMs) return cached.value;

  const env = readHermesEnv();
  const key = env.MASSIVE_API_KEY;
  if (!key) return { ok: false, error: "MASSIVE_API_KEY is not set" };

  const url = new URL(`${massiveBaseUrl}${apiPath}`);
  for (const [keyName, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(keyName, String(value));
  }

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
        "User-Agent": "HermesMissionControl/1.0"
      },
      cache: "no-store"
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      const value = { ok: true, data };
      marketCache.set(keyName, { createdAt: Date.now(), value });
      return value;
    }
    const value = {
      ok: false,
      error: data.message || data.error || `HTTP ${response.status}`,
      httpStatus: response.status,
      status: data.status || "ERROR"
    };
    if (cached?.value?.ok) return { ...cached.value, stale: true, warning: value.error };
    return value;
  } catch (error) {
    if (cached?.value?.ok) return { ...cached.value, stale: true, warning: error.message };
    return { ok: false, error: error.message || "Market request failed" };
  }
}

function normalizeMarketStatus(result) {
  const data = result.ok ? result.data : {};
  return {
    ok: result.ok,
    status: data.market || result.status || "unknown",
    serverTime: data.serverTime || "",
    afterHours: Boolean(data.afterHours),
    earlyHours: Boolean(data.earlyHours),
    exchanges: data.exchanges || {},
    error: result.ok ? "" : result.error
  };
}

function normalizeReference(result, ticker) {
  const data = result.ok ? result.data?.results : null;
  const item = Array.isArray(data) ? data[0] : data;
  return {
    ticker,
    name: item?.name || POPULAR_NAMES[ticker] || ticker,
    market: item?.market || "stocks",
    locale: item?.locale || "us",
    type: item?.type || "",
    primaryExchange: item?.primary_exchange || "",
    currency: item?.currency_name || "usd",
    active: item?.active !== false,
    updatedAt: item?.last_updated_utc || ""
  };
}

function placeholderQuote(ticker) {
  return {
    ...normalizeReference({ ok: false }, ticker),
    price: null,
    previousClose: null,
    open: null,
    high: null,
    low: null,
    volume: null,
    changeUsd: null,
    changePercent: null,
    source: "Lookup on demand",
    updatedAt: "",
    ok: false,
    dataIssues: []
  };
}

function normalizeQuote(ticker, reference, previous, lastTrade) {
  const bar = previous.ok ? previous.data?.results?.[0] : null;
  const trade = lastTrade?.ok ? lastTrade.data?.results : null;
  const previousClose = safeNumber(bar?.c, null);
  const open = safeNumber(bar?.o, null);
  const livePrice = safeNumber(trade?.p, null);
  const price = livePrice ?? previousClose;
  const comparison = livePrice !== null && previousClose !== null ? previousClose : open;
  const changeUsd = price !== null && comparison !== null ? price - comparison : null;
  const changePercent = changeUsd !== null && comparison ? (changeUsd / comparison) * 100 : null;
  const source = livePrice !== null ? "Massive last trade" : previousClose !== null ? "Massive previous close" : "Unavailable";
  const updatedAt =
    livePrice !== null && trade?.t
      ? new Date(Math.floor(Number(trade.t) / 1000000)).toISOString()
      : bar?.t
        ? new Date(Number(bar.t)).toISOString()
        : reference.updatedAt;

  return {
    ...reference,
    price,
    previousClose,
    open,
    high: safeNumber(bar?.h, null),
    low: safeNumber(bar?.l, null),
    volume: safeNumber(bar?.v, null),
    changeUsd,
    changePercent,
    source,
    updatedAt,
    ok: price !== null,
    dataIssues: [previous.ok ? "" : previous.error, lastTrade && !lastTrade.ok ? lastTrade.error : ""].filter(Boolean)
  };
}

function quoteFromGroupedBar(ticker, bar) {
  const reference = normalizeReference({ ok: false }, ticker);
  const close = safeNumber(bar?.c, null);
  const open = safeNumber(bar?.o, null);
  const changeUsd = close !== null && open !== null ? close - open : null;
  const changePercent = changeUsd !== null && open ? (changeUsd / open) * 100 : null;
  return {
    ...reference,
    price: close,
    previousClose: close,
    open,
    high: safeNumber(bar?.h, null),
    low: safeNumber(bar?.l, null),
    volume: safeNumber(bar?.v, null),
    changeUsd,
    changePercent,
    source: "Massive grouped market bar",
    updatedAt: bar?.t ? new Date(Number(bar.t)).toISOString() : reference.updatedAt,
    ok: close !== null,
    dataIssues: []
  };
}

function marketDateFromStatus(result) {
  const serverTime = result.ok ? result.data?.serverTime : "";
  if (typeof serverTime === "string" && /^\d{4}-\d{2}-\d{2}/.test(serverTime)) return serverTime.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

async function getGroupedQuotes(symbols, marketStatusResult) {
  const tickers = uniqueSymbols(symbols);
  const date = marketDateFromStatus(marketStatusResult);
  const result = await massiveGet(`/v2/aggs/grouped/locale/us/market/stocks/${date}`, { adjusted: "true" }, { ttlMs: 90000 });
  const rows = result.ok && Array.isArray(result.data?.results) ? result.data.results : [];
  if (!rows.length) return [];
  const wanted = new Set(tickers);
  return rows
    .filter((row) => wanted.has(String(row.T || "").toUpperCase()))
    .map((row) => quoteFromGroupedBar(String(row.T || "").toUpperCase(), row))
    .sort((a, b) => tickers.indexOf(a.ticker) - tickers.indexOf(b.ticker));
}

export async function getTickerQuote(symbol, { includeLastTrade = false, includeReference = true } = {}) {
  const ticker = String(symbol || "").trim().toUpperCase();
  if (!ticker) return null;
  const [reference, previous, lastTrade] = await Promise.all([
    includeReference ? massiveGet(`/v3/reference/tickers/${encodeURIComponent(ticker)}`) : Promise.resolve({ ok: false }),
    massiveGet(`/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev`, { adjusted: "true" }),
    includeLastTrade ? massiveGet(`/v2/last/trade/${encodeURIComponent(ticker)}`) : Promise.resolve(null)
  ]);
  return normalizeQuote(ticker, normalizeReference(reference, ticker), previous, lastTrade);
}

export async function getTickerQuotes(symbols, options = {}) {
  const tickers = uniqueSymbols(symbols).slice(0, options.limit || 16);
  const quotes = await mapLimit(tickers, 4, (ticker) => getTickerQuote(ticker, options));
  return quotes.filter(Boolean);
}

function holdingShares(holding) {
  return safeNumber(holding.shares ?? holding.quantity ?? holding.units, 0);
}

function holdingCost(holding) {
  const direct = safeNumber(holding.cost_basis_usd ?? holding.cost_usd ?? holding.amount_usd ?? holding.allocation_usd, null);
  if (direct !== null) return direct;
  const shares = holdingShares(holding);
  const average = safeNumber(holding.average_cost ?? holding.avg_cost ?? holding.purchase_price, 0);
  return shares * average;
}

function buildPortfolioSummary(portfolio, quotes) {
  const quoteMap = Object.fromEntries(quotes.map((quote) => [quote.ticker, quote]));
  const holdings = Array.isArray(portfolio.holdings) ? portfolio.holdings : [];
  const cashUsd = safeNumber(portfolio.cash_usd ?? portfolio.cash ?? portfolio.cashUsd, 100);
  const rows = holdings.map((holding) => {
    const ticker = String(holding.ticker || holding.symbol || "").trim().toUpperCase();
    const quote = quoteMap[ticker] || {};
    const shares = holdingShares(holding);
    const costBasis = holdingCost(holding);
    const marketValue = shares && quote.price ? shares * quote.price : costBasis;
    return {
      ...holding,
      ticker,
      name: quote.name || holding.name || ticker,
      shares,
      costBasis,
      marketValue,
      price: quote.price ?? null,
      gainUsd: marketValue - costBasis,
      gainPercent: costBasis ? ((marketValue - costBasis) / costBasis) * 100 : null
    };
  });
  const investedUsd = rows.reduce((sum, row) => sum + safeNumber(row.marketValue, 0), 0);
  const costBasisUsd = rows.reduce((sum, row) => sum + safeNumber(row.costBasis, 0), 0);
  const totalValueUsd = cashUsd + investedUsd;
  const startingCapitalUsd = safeNumber(portfolio.starting_cash_usd ?? portfolio.startingCapitalUsd, 100);

  return {
    cashUsd,
    investedUsd,
    costBasisUsd,
    totalValueUsd,
    startingCapitalUsd,
    gainUsd: totalValueUsd - startingCapitalUsd,
    gainPercent: startingCapitalUsd ? ((totalValueUsd - startingCapitalUsd) / startingCapitalUsd) * 100 : null,
    holdings: rows.map((row) => ({
      ...row,
      allocationPercent: totalValueUsd ? (safeNumber(row.marketValue, 0) / totalValueUsd) * 100 : 0
    })),
    cashAllocationPercent: totalValueUsd ? (cashUsd / totalValueUsd) * 100 : 0
  };
}

export async function searchTickers(query) {
  const q = String(query || "").trim();
  if (!q) return [];
  const result = await massiveGet("/v3/reference/tickers", {
    market: "stocks",
    active: "true",
    search: q,
    limit: 10
  });
  const rows = result.ok && Array.isArray(result.data?.results) ? result.data.results : [];
  const localRows = Object.entries(POPULAR_NAMES)
    .filter(([ticker, name]) => `${ticker} ${name}`.toLowerCase().includes(q.toLowerCase()))
    .map(([ticker, name]) => ({
      ticker,
      name,
      market: "stocks",
      type: ticker === "SPY" || ticker === "QQQ" || ticker === "VTI" ? "ETF" : "CS",
      primaryExchange: "",
      active: true,
      currency: "usd",
      updatedAt: ""
    }));
  const remoteRows = rows.map((item) => ({
    ticker: item.ticker,
    name: item.name || item.ticker,
    market: item.market || "stocks",
    type: item.type || "",
    primaryExchange: item.primary_exchange || "",
    active: item.active !== false,
    currency: item.currency_name || "usd",
    updatedAt: item.last_updated_utc || ""
  }));
  return Array.from(new Map([...localRows, ...remoteRows].map((item) => [item.ticker, item])).values()).slice(0, 10);
}

export async function getMarketLookup({ query = "", symbols = [] } = {}) {
  const requestedSymbols = uniqueSymbols(symbols);
  const searchResults = query ? await searchTickers(query) : [];
  const querySymbol = uniqueSymbols([query])[0];
  const quoteSymbols = requestedSymbols.length ? requestedSymbols : uniqueSymbols([searchResults[0]?.ticker, querySymbol]).slice(0, 1);
  const env = readHermesEnv();
  const includeLastTrade = ["1", "true", "yes"].includes(String(env.MASSIVE_ENABLE_LAST_TRADE || env.MASSIVE_ENABLE_PAID_SNAPSHOTS || "").toLowerCase());
  const quotes = await getTickerQuotes(quoteSymbols, { includeLastTrade, includeReference: true, limit: 6 });
  return {
    generatedAt: new Date().toISOString(),
    query,
    results: searchResults,
    quotes,
    quote: quotes[0] || null,
    provider: "Massive"
  };
}

export function getMarketStateSnapshot() {
  const portfolio = readPortfolio();
  const job = findInvestmentJob();
  const decisions = readInvestmentMemos(job?.id).slice(0, 3);
  return {
    paths: { financeDir, portfolioPath, policyPath, yesterdayPath },
    portfolio: {
      cashUsd: safeNumber(portfolio.cash_usd ?? portfolio.cash ?? portfolio.cashUsd, 100),
      currency: portfolio.currency || "USD",
      broker: portfolio.broker || "manual",
      holdingsCount: Array.isArray(portfolio.holdings) ? portfolio.holdings.length : 0,
      watchlist: Array.isArray(portfolio.watchlist) ? portfolio.watchlist : []
    },
    investmentJob: job
      ? {
          id: job.id,
          name: job.name,
          script: job.script,
          schedule: job.schedule_display || job.schedule?.display || "",
          nextRunAt: job.next_run_at || "",
          lastRunAt: job.last_run_at || "",
          lastStatus: job.last_status || "",
          enabled: job.enabled !== false
        }
      : null,
    recentDecisions: decisions
  };
}

export async function getMarketDashboard() {
  const portfolio = readPortfolio();
  const investmentJob = findInvestmentJob();
  const decisions = readInvestmentMemos(investmentJob?.id);
  const holdingSymbols = (Array.isArray(portfolio.holdings) ? portfolio.holdings : []).map((holding) => holding.ticker || holding.symbol);
  const watchlist = Array.isArray(portfolio.watchlist) ? portfolio.watchlist : [];
  const symbols = uniqueSymbols([holdingSymbols, watchlist, POPULAR_SYMBOLS]).slice(0, 10);
  const marketStatusResult = await massiveGet("/v1/marketstatus/now");
  let quotes = await getGroupedQuotes(symbols, marketStatusResult);
  if (quotes.length < Math.min(5, symbols.length)) {
    quotes = await getTickerQuotes(symbols.slice(0, 5), { includeLastTrade: false, includeReference: false, limit: 5 });
  }

  const portfolioSummary = buildPortfolioSummary(portfolio, quotes);
  const latestDecision = decisions[0] || null;
  const quoteMap = Object.fromEntries(quotes.map((quote) => [quote.ticker, quote]));
  const popularQuotes = symbols.map((ticker) => quoteMap[ticker] || placeholderQuote(ticker));

  return {
    generatedAt: new Date().toISOString(),
    provider: {
      name: "Massive",
      apiKeyPresent: Boolean(readHermesEnv().MASSIVE_API_KEY),
      liveTradeEntitled: false
    },
    paths: { financeDir, portfolioPath, policyPath, yesterdayPath },
    marketStatus: normalizeMarketStatus(marketStatusResult),
    popularQuotes,
    portfolio,
    portfolioSummary,
    watchlist: uniqueSymbols([watchlist, POPULAR_SYMBOLS]),
    investmentJob: getMarketStateSnapshot().investmentJob,
    decisions,
    latestDecision,
    policy: {
      path: policyPath,
      body: readText(policyPath, "No investment policy file found."),
      excerpt: cleanSnippet(readText(policyPath, ""), 900)
    },
    yesterdayAnalysis: {
      path: yesterdayPath,
      body: readText(yesterdayPath, ""),
      updatedAt: stat(yesterdayPath)?.mtime?.toISOString() || ""
    }
  };
}

export { financeDir, portfolioPath, policyPath };
