const DASHBOARD_URL = "https://right.codes/dashboard";
const ORIGINS = ["https://right.codes/*"];

const DATA_KEY = "rcdm_data";
const LAST_ERROR_KEY = "rcdm_last_error";
const PREFS_KEY = "rcdm_prefs";

const DEFAULT_PREFS = {
  autoRefresh: false,
  autoRefreshExplicit: false,
  refreshMinutes: 5,
  closeTempTab: true
};

const REFRESH_MINUTES_OPTIONS = [1, 2, 5, 10, 15, 30, 60];
const BEIJING_TZ = "Asia/Shanghai";
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTimeBeijing(input) {
  if (!input) return "—";
  const d = typeof input === "string" || typeof input === "number" ? new Date(input) : input;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return String(input);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: BEIJING_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(d);
}

function msUntilNextBeijingMidnight(nowMs = Date.now()) {
  // Beijing time is UTC+8 and has no DST. We compute next 00:00 (Beijing) in UTC milliseconds.
  const bjtMs = nowMs + BEIJING_OFFSET_MS;
  const bjt = new Date(bjtMs);
  const y = bjt.getUTCFullYear();
  const m = bjt.getUTCMonth();
  const d = bjt.getUTCDate();

  const nextMidnightBjtMs = Date.UTC(y, m, d + 1, 0, 0, 0, 0);
  const nextMidnightRealMs = nextMidnightBjtMs - BEIJING_OFFSET_MS;
  return nextMidnightRealMs - nowMs;
}

function formatHms(ms) {
  const clamped = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function getBeijingResetInfo(nowMs = Date.now()) {
  const msLeft = msUntilNextBeijingMidnight(nowMs);
  const nextResetAtMs = nowMs + msLeft;
  return {
    msLeft,
    nextResetAtMs,
    countdownText: formatHms(msLeft),
    nextResetAtText: `${formatTimeBeijing(nextResetAtMs)}（北京时间 00:00）`
  };
}

function isQuotaDepleted(sub) {
  const remaining = sub?.quota?.remaining;
  if (typeof remaining === "number") return remaining <= 1e-9;

  const raw =
    sub?.quota?.raw ||
    (typeof sub?.quota === "string" ? sub.quota : null) ||
    (typeof sub?.quotaRaw === "string" ? sub.quotaRaw : null);
  if (typeof raw !== "string") return false;

  const m = raw.match(/[$¥]\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return false;
  return Number(m[1]) <= 1e-9;
}

async function getPrefs() {
  const stored = await chrome.storage.sync.get({ [PREFS_KEY]: DEFAULT_PREFS });
  const prefs = { ...DEFAULT_PREFS, ...(stored[PREFS_KEY] || {}) };
  // Auto refresh is OFF unless user explicitly enabled it (migration-friendly).
  if (!prefs.autoRefreshExplicit) prefs.autoRefresh = false;
  return prefs;
}

async function setPrefs(partial) {
  const prefs = await getPrefs();
  await chrome.storage.sync.set({ [PREFS_KEY]: { ...prefs, ...partial } });
}

async function getData() {
  const stored = await chrome.storage.local.get({ [DATA_KEY]: null, [LAST_ERROR_KEY]: null });
  return { data: stored[DATA_KEY], lastError: stored[LAST_ERROR_KEY] };
}

async function hasPermission() {
  return chrome.permissions.contains({ origins: ORIGINS });
}

async function requestPermission() {
  return chrome.permissions.request({ origins: ORIGINS });
}

async function refreshNow() {
  return chrome.runtime.sendMessage({ type: "rcdm_refresh", reason: "manual" });
}

async function openDashboard() {
  await chrome.tabs.create({ url: DASHBOARD_URL });
}

function buildSummaryText(payload) {
  const lines = [];
  if (payload?.balance?.raw) lines.push(`余额: ${payload.balance.raw}`);
  const totals = payload?.totals || {};
  for (const k of ["累计请求", "累计 Token", "累计花费"]) {
    if (totals[k]) lines.push(`${k}: ${totals[k]}`);
  }
  lines.push(`更新时间(北京时间): ${payload?.fetchedAt ? formatTimeBeijing(payload.fetchedAt) : "—"}`);
  return lines.join("\n");
}

function render({ data, prefs, permitted, lastError, busy }) {
  const root = document.querySelector("#app");
  if (!root) return;

  const fetchedAt = data?.fetchedAt || null;
  const totals = data?.totals || {};
  const subs = Array.isArray(data?.subscriptions) ? data.subscriptions : [];

  const errorText = lastError
    ? `${lastError.code || "error"} @ ${formatTimeBeijing(lastError.at)}（北京时间）\n${escapeHtml(
        JSON.stringify(lastError.detail ?? lastError, null, 2)
      )}`
    : "";

  const permBlock = !permitted
    ? `<div class="row"><div class="muted small">需要授权访问 right.codes 才能抓取数据</div><button id="btnGrant" class="primary">授权</button></div>`
    : "";

  const cardsHtml = subs.length
    ? subs
        .map((s) => {
          const resetText = s.resetStatus || "—";
          const resetDotClass = resetText.includes("未") ? "bad" : "";
          const quotaText = s.quota?.raw || (typeof s.quota === "string" ? s.quota : "—");
          const depleted = isQuotaDepleted(s);

          return `
          <div class="sub ${depleted ? "depleted" : ""}">
            <h3>${escapeHtml(s.name || "（未命名订阅）")}</h3>
            <div class="kv">
              <div class="muted">到期时间</div><div>${escapeHtml(s.expiresAt || "—")}</div>
              <div class="muted">今日重置</div>
              <div class="pill"><span class="dot ${resetDotClass}"></span><span>${escapeHtml(resetText)}</span></div>
              <div class="muted">剩余额度</div><div>${escapeHtml(quotaText)}</div>
            </div>
          </div>
        `;
        })
        .join("")
    : `<div class="muted small">暂无订阅数据（请先刷新一次）</div>`;

  const html = `
    <div class="card">
      <div class="header">
        <div>
          <div class="title">Right Code Dashboard Mini</div>
          <div class="subtitle">最近更新：${escapeHtml(formatTimeBeijing(fetchedAt))}（北京时间）</div>
        </div>
        <div class="toolbar">
          <button id="btnOpen">打开</button>
          <button id="btnRefresh" class="primary">${busy ? "刷新中…" : "刷新"}</button>
        </div>
      </div>

      <div class="content">
        ${permBlock}

        <div class="row">
          <div class="muted">距离北京时间零点刷新</div>
          <div style="display:flex; gap:8px; align-items:center;">
            <span id="resetCountdown">—</span>
            <span class="muted small" id="nextResetAt"></span>
          </div>
        </div>

        <div class="row">
          <div class="muted">余额</div>
          <div>${escapeHtml(data?.balance?.raw || "—")}</div>
        </div>

        <div class="grid3">
          <div class="metric"><div class="k">累计请求</div><div class="v">${escapeHtml(totals["累计请求"] || "—")}</div></div>
          <div class="metric"><div class="k">累计 Token</div><div class="v">${escapeHtml(totals["累计 Token"] || "—")}</div></div>
          <div class="metric"><div class="k">累计花费</div><div class="v">${escapeHtml(totals["累计花费"] || "—")}</div></div>
        </div>

        <div class="row">
          <div class="muted">自动刷新</div>
          <div style="display:flex; gap:8px; align-items:center;">
            <label class="pill" style="cursor:pointer;">
              <input id="toggleAuto" type="checkbox" ${prefs.autoRefresh ? "checked" : ""} style="accent-color: var(--accent);" />
              <span>${prefs.autoRefresh ? "已开启" : "已关闭"}</span>
            </label>
            <select id="selMinutes" title="刷新间隔（分钟）">
              ${REFRESH_MINUTES_OPTIONS.map((m) => `<option value="${m}" ${Number(prefs.refreshMinutes) === m ? "selected" : ""}>${m}m</option>`).join("")}
            </select>
          </div>
        </div>

        <div class="subs">${cardsHtml}</div>

        ${lastError ? `<div class="error">${errorText}</div>` : ""}
      </div>

      <div class="footer">
        <div class="muted small">不会保存你的 Token/密钥，只缓存页面上的数字。</div>
        <div style="display:flex; gap:8px;">
          <button id="btnCopy" class="small">复制摘要</button>
        </div>
      </div>
    </div>
  `;

  root.innerHTML = html;
}

async function main() {
  let busy = false;
  let countdownTimer = null;
  let didLazyRefreshOnOpen = false;

  async function refreshUI() {
    const prefs = await getPrefs();
    const permitted = await hasPermission();
    const { data, lastError } = await getData();
    render({ data, prefs, permitted, lastError, busy });

    const tick = () => {
      const info = getBeijingResetInfo();
      const elCountdown = document.querySelector("#resetCountdown");
      const elNext = document.querySelector("#nextResetAt");
      if (elCountdown) elCountdown.textContent = info.countdownText;
      if (elNext) elNext.textContent = info.nextResetAtText;
    };

    tick();
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(tick, 1000);

    const btnOpen = document.querySelector("#btnOpen");
    const btnRefresh = document.querySelector("#btnRefresh");
    const btnGrant = document.querySelector("#btnGrant");
    const btnCopy = document.querySelector("#btnCopy");
    const toggleAuto = document.querySelector("#toggleAuto");
    const selMinutes = document.querySelector("#selMinutes");

    if (btnOpen) btnOpen.addEventListener("click", () => void openDashboard());

    if (btnRefresh) {
      btnRefresh.addEventListener("click", () => {
        void runRefresh("manual_click");
      });
    }

    if (btnGrant) {
      btnGrant.addEventListener("click", () => {
        void (async () => {
          const ok = await requestPermission();
          if (ok) {
            await chrome.runtime.sendMessage({ type: "rcdm_sync_alarm" });
            didLazyRefreshOnOpen = true;
            await runRefresh("permission_granted");
          }
          await refreshUI();
        })();
      });
    }

    if (toggleAuto) {
      toggleAuto.addEventListener("change", () => {
        void (async () => {
          await setPrefs({ autoRefresh: toggleAuto.checked, autoRefreshExplicit: true });
          await chrome.runtime.sendMessage({ type: "rcdm_sync_alarm" });
          await refreshUI();
        })();
      });
    }

    if (selMinutes) {
      selMinutes.addEventListener("change", () => {
        void (async () => {
          await setPrefs({ refreshMinutes: Number(selMinutes.value) });
          await chrome.runtime.sendMessage({ type: "rcdm_sync_alarm" });
          await refreshUI();
        })();
      });
    }

    if (btnCopy) {
      btnCopy.addEventListener("click", () => {
        void (async () => {
          const payload = (await getData()).data;
          await navigator.clipboard.writeText(buildSummaryText(payload));
          btnCopy.textContent = "已复制";
          setTimeout(() => {
            btnCopy.textContent = "复制摘要";
          }, 1200);
        })();
      });
    }
  }

  async function runRefresh(reason) {
    busy = true;
    await refreshUI();
    try {
      await chrome.runtime.sendMessage({ type: "rcdm_refresh", reason });
    } finally {
      busy = false;
      await refreshUI();
    }
  }

  async function lazyRefreshOnOpen() {
    if (didLazyRefreshOnOpen) return;
    const permitted = await hasPermission();
    if (!permitted) return;
    didLazyRefreshOnOpen = true;
    await runRefresh("ui_open");
  }

  chrome.storage.onChanged.addListener((_changes, areaName) => {
    if (areaName !== "local" && areaName !== "sync") return;
    void refreshUI();
  });

  await refreshUI();
  await lazyRefreshOnOpen();
}

void main();
