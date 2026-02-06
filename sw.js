const DASHBOARD_URL = "https://www.right.codes/dashboard";
const RIGHTCODES_ORIGINS = ["https://right.codes/*", "https://www.right.codes/*"];

const DATA_KEY = "rcdm_data";
const LAST_ERROR_KEY = "rcdm_last_error";
const PREFS_KEY = "rcdm_prefs";
const AUTO_REFRESH_ALARM = "rcdm_auto_refresh";
const TEMP_TAB_BLOCK_RULE_ID = 30001;
const MIN_REFRESH_GAP_MS = 2_500;
const REMOTE_RATE_LIMIT_COOLDOWN_MS = 65_000;

let inFlightRefreshPromise = null;
let nextAllowedRefreshAt = 0;

const DEFAULT_PREFS = {
  autoRefresh: false,
  autoRefreshExplicit: false,
  refreshMinutes: 5,
  closeTempTab: true
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getPrefs() {
  const stored = await chrome.storage.sync.get({ [PREFS_KEY]: DEFAULT_PREFS });
  const prefs = { ...DEFAULT_PREFS, ...(stored[PREFS_KEY] || {}) };
  // Migration/behavior: auto refresh is OFF unless user explicitly enabled it.
  if (!prefs.autoRefreshExplicit) prefs.autoRefresh = false;
  return prefs;
}

async function syncAlarmWithPrefs() {
  const prefs = await getPrefs();
  await chrome.alarms.clear(AUTO_REFRESH_ALARM);
  if (!prefs.autoRefresh) return;

  const minutes = Number(prefs.refreshMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return;

  chrome.alarms.create(AUTO_REFRESH_ALARM, { periodInMinutes: minutes });
}

async function hasRightCodesPermission() {
  return chrome.permissions.contains({ origins: RIGHTCODES_ORIGINS });
}

async function findExistingDashboardTab() {
  const tabs = await chrome.tabs.query({ url: ["https://right.codes/dashboard*", "https://www.right.codes/dashboard*"] });
  return tabs.find((t) => typeof t.id === "number") || null;
}

function waitForTabUrl(tabId, pattern, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("timeout_waiting_for_tab_url"));
    }, timeoutMs);

    async function maybeResolveNow() {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (pattern.test(String(tab?.url || ""))) {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve(tab);
        }
      } catch {
        // ignore
      }
    }

    function onUpdated(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId) return;
      const url = String(changeInfo.url || tab?.url || "");
      if (!pattern.test(url)) return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(tab);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    void maybeResolveNow();
  });
}

async function installTempTabLightModeRule(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [TEMP_TAB_BLOCK_RULE_ID],
    addRules: [
      {
        id: TEMP_TAB_BLOCK_RULE_ID,
        priority: 1,
        action: { type: "block" },
        condition: {
          tabIds: [tabId],
          regexFilter: "^https://(www\\.)?right\\.codes/",
          resourceTypes: ["image", "font", "media"]
        }
      }
    ]
  });
}

async function clearTempTabLightModeRule() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [TEMP_TAB_BLOCK_RULE_ID]
  });
}

async function executeExtractWithRetry(tabId, maxAttempts = 4) {
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) throw new Error("tab_not_found");

      const injected = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractRightCodesDashboard
      });

      return injected?.[0]?.result;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err || "");
      const retryable =
        msg.includes("Frame with ID 0 was removed") ||
        msg.includes("No frame with id") ||
        msg.includes("The tab was closed") ||
        msg.includes("Cannot access contents of url");

      if (!retryable || attempt === maxAttempts) break;
      await sleep(220 * attempt);
    }
  }

  throw lastErr || new Error("extract_retry_failed");
}

async function extractDashboardWithResultRetry(tabId, maxAttempts = 3) {
  let lastResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await executeExtractWithRetry(tabId);
    lastResult = result;

    if (result?.ok) return result;

    const detail = String(result?.error || "").toLowerCase();
    const retryableResult = detail.includes("main_not_found") || detail.includes("dashboard_data_not_ready");
    if (!retryableResult || attempt === maxAttempts) return result;

    await sleep(300 * attempt);
  }

  return lastResult;
}

async function refreshDashboardData({ reason }) {
  const now = Date.now();
  if (now < nextAllowedRefreshAt) {
    const error = {
      at: new Date().toISOString(),
      reason,
      code: "rate_limited_local",
      detail: `cooldown_until_${new Date(nextAllowedRefreshAt).toISOString()}`
    };
    await chrome.storage.local.set({ [LAST_ERROR_KEY]: error });
    return { ok: false, error };
  }

  nextAllowedRefreshAt = now + MIN_REFRESH_GAP_MS;

  const hasPerm = await hasRightCodesPermission();
  if (!hasPerm) {
    const error = { at: new Date().toISOString(), reason, code: "missing_host_permission" };
    await chrome.storage.local.set({ [LAST_ERROR_KEY]: error });
    return { ok: false, error };
  }

  const prefs = await getPrefs();

  let tab = await findExistingDashboardTab();
  let createdTempTab = false;

  if (!tab) {
    tab = await chrome.tabs.create({ url: DASHBOARD_URL, active: false });
    createdTempTab = true;
  }

  if (!tab?.id) {
    const error = { at: new Date().toISOString(), reason, code: "tab_create_failed" };
    await chrome.storage.local.set({ [LAST_ERROR_KEY]: error });
    return { ok: false, error };
  }

  try {
    if (createdTempTab) {
      try {
        await installTempTabLightModeRule(tab.id);
      } catch {
        // ignore rule install failure, continue with normal mode
      }
    }

    await waitForTabUrl(tab.id, /^https:\/\/(www\.)?right\.codes\/dashboard/i);
    await sleep(120);

    const result = await extractDashboardWithResultRetry(tab.id);
    if (!result || !result.ok) {
      const detail = result?.error || result;
      const detailText = String(detail || "").toLowerCase();
      if (detailText.includes("too_many_requests") || detailText.includes("too many requests")) {
        nextAllowedRefreshAt = Math.max(nextAllowedRefreshAt, Date.now() + REMOTE_RATE_LIMIT_COOLDOWN_MS);
      }

      const error = {
        at: new Date().toISOString(),
        reason,
        code: "extract_failed",
        detail
      };
      await chrome.storage.local.set({ [LAST_ERROR_KEY]: error });
      return { ok: false, error };
    }

    await chrome.storage.local.set({ [DATA_KEY]: result, [LAST_ERROR_KEY]: null });
    return { ok: true, data: result };
  } catch (err) {
    const error = {
      at: new Date().toISOString(),
      reason,
      code: "refresh_exception",
      detail: String(err?.message || err)
    };
    await chrome.storage.local.set({ [LAST_ERROR_KEY]: error });
    return { ok: false, error };
  } finally {
    if (createdTempTab) {
      try {
        await clearTempTabLightModeRule();
      } catch {
        // ignore
      }
    }

    if (createdTempTab && prefs.closeTempTab) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        // ignore
      }
    }
  }
}

// Runs inside right.codes/dashboard page context.
async function extractRightCodesDashboard() {
  const fetchedAt = new Date().toISOString();

  const normalize = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

  async function waitFor(getEl, { timeoutMs = 15_000, intervalMs = 250 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const el = getEl();
      if (el) return el;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  }

  try {
    if (String(location.pathname || "").startsWith("/login")) {
      return { ok: false, error: "auth_required", fetchedAt };
    }

    const bodyTextEarly = normalize(document.body?.innerText || document.body?.textContent || "").toLowerCase();
    if (
      bodyTextEarly.includes("too many requests") ||
      bodyTextEarly.includes("查询请求过于频繁") ||
      bodyTextEarly.includes("每分钟最多30次")
    ) {
      return { ok: false, error: "too_many_requests", fetchedAt };
    }

    const main = await waitFor(() => document.querySelector("main, #root"), { timeoutMs: 20_000 });
    if (!main) {
      const bodyTextLate = normalize(document.body?.innerText || document.body?.textContent || "").toLowerCase();
      if (
        bodyTextLate.includes("too many requests") ||
        bodyTextLate.includes("查询请求过于频繁") ||
        bodyTextLate.includes("每分钟最多30次")
      ) {
        return { ok: false, error: "too_many_requests", fetchedAt };
      }

      if (
        String(location.pathname || "").startsWith("/login") ||
        bodyTextLate.includes("使用 linux do 登录") ||
        bodyTextLate.includes("还没有账号")
      ) {
        return { ok: false, error: "auth_required", fetchedAt };
      }

      return { ok: false, error: "main_not_found", fetchedAt };
    }

    const mainText = normalize((document.querySelector("main") || document.body || main).textContent);
    const balanceMatch = mainText.match(/余额\s*[:：]\s*\$\s*([0-9.]+)/);
    const balance = {
      raw: balanceMatch ? `$${balanceMatch[1]}` : null,
      amount: balanceMatch ? Number(balanceMatch[1]) : null
    };

    // Subscriptions cards
    const subGrid = await waitFor(() =>
      document.querySelector(".mb-8 .grid.grid-cols-1.sm\\:grid-cols-2.lg\\:grid-cols-3")
    );
    const subscriptions = [];
    if (subGrid) {
      for (const card of Array.from(subGrid.children)) {
        const name =
          normalize(card.querySelector(".text-purple-500")?.textContent) ||
          normalize(card.querySelector(".font-semibold")?.textContent);

        const rows = card.querySelectorAll(".space-y-1.text-sm > div.flex.items-center.justify-between");
        if (!rows?.length) continue;

        const byLabel = new Map();
        for (const row of rows) {
          const label = normalize(row.children?.[0]?.textContent);
          if (!label) continue;

          const valueEl = row.children?.[1];
          if (!valueEl) continue;

          if (label === "可用端点") {
            const endpoints = Array.from(valueEl.querySelectorAll("span[title]")).map((s) => ({
              title: normalize(s.getAttribute("title"))
            }));
            byLabel.set(label, endpoints);
          } else {
            byLabel.set(label, normalize(valueEl.textContent));
          }
        }

        const usedPercentText = normalize(card.querySelector(".mt-2 span.tabular-nums")?.textContent);
        const progress = card.querySelector('[role="progressbar"]');
        const usedPercent =
          progress?.getAttribute("aria-valuenow") != null
            ? Number(progress.getAttribute("aria-valuenow"))
            : usedPercentText
              ? Number(usedPercentText.replace("%", ""))
              : null;

        const remainingDaysRaw = byLabel.get("剩余天数");
        const remainingDays = remainingDaysRaw ? Number(normalize(remainingDaysRaw).replace(/[^0-9.]/g, "")) : null;

        const quotaRaw = byLabel.get("剩余额度");
        let quota = null;
        if (typeof quotaRaw === "string") {
          const m = quotaRaw.match(/\$\s*([0-9.]+)\s*\/\s*\$\s*([0-9.]+)/);
          if (m) {
            quota = { remaining: Number(m[1]), total: Number(m[2]), currency: "$", raw: quotaRaw };
          } else {
            quota = { raw: quotaRaw };
          }
        }

        subscriptions.push({
          name: name || null,
          remainingDaysRaw: remainingDaysRaw || null,
          remainingDays,
          acquiredAt: byLabel.get("获得时间") || null,
          expiresAt: byLabel.get("到期时间") || null,
          resetStatus: byLabel.get("今日重置") || null,
          endpoints: byLabel.get("可用端点") || [],
          quota,
          usedPercentText: usedPercentText || null,
          usedPercent
        });
      }
    }

    // Totals cards
    const totals = {};
    const totalsGrid = await waitFor(() =>
      document.querySelector(".grid.grid-cols-1.sm\\:grid-cols-3.gap-4.mb-6")
    );
    if (totalsGrid) {
      for (const card of Array.from(totalsGrid.children)) {
        const label = normalize(card.querySelector(".text-default-500.text-sm")?.textContent);
        const value = normalize(card.querySelector('[class*="text-"]:not(.text-default-500)')?.textContent);
        if (!label) continue;
        totals[label] = value || null;
      }
    }

    if (!balance?.raw && subscriptions.length === 0 && Object.keys(totals).length === 0) {
      return { ok: false, error: "dashboard_data_not_ready", fetchedAt };
    }

    return {
      ok: true,
      fetchedAt,
      url: location.href,
      title: document.title,
      balance,
      subscriptions,
      totals
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), fetchedAt };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void syncAlarmWithPrefs();
});

chrome.runtime.onStartup.addListener(() => {
  void syncAlarmWithPrefs();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  if (!changes[PREFS_KEY]) return;
  void syncAlarmWithPrefs();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_REFRESH_ALARM) return;
  void refreshDashboardData({ reason: "alarm" });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "rcdm_refresh") {
    void (async () => {
      if (!inFlightRefreshPromise) {
        inFlightRefreshPromise = refreshDashboardData({ reason: message.reason || "manual" }).finally(() => {
          inFlightRefreshPromise = null;
        });
      }
      const res = await inFlightRefreshPromise;
      sendResponse(res);
    })();
    return true;
  }

  if (message.type === "rcdm_sync_alarm") {
    void (async () => {
      await syncAlarmWithPrefs();
      sendResponse({ ok: true });
    })();
    return true;
  }
});
