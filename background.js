

const SITE_DOMAINS = [
  "www.codebuddy.cn", "codebuddy.cn",
  "www.workbuddy.cn", "workbuddy.cn",
];

const AUTH_COOKIE_NAMES = new Set([
  "session", "session_2", "_pre_auth_session",
  "cb_login_mode", "cb_login_realm",
]);

const DEFAULT_PACKAGE_CODES = [
  "TCACA_code_008_cfWoLwvjU4",
  "TCACA_code_009_0XmEQc2xOf",
  "TCACA_code_038_OhvqZtiPKr",
  "TCACA_code_007_nzdH5h4Nl0",
  "TCACA_code_028_NtpWi0jzXs",
  "TCACA_code_029_6wCGEWquYy",
  "TCACA_code_030_BjSt89qTvr",
];

const DEFAULT_STATE = {
  accounts: [],
  activeId: "",
  snapshots: {},
  lastAutoRefreshDate: "",
  settings: {
    apiBase: "https://www.codebuddy.cn",
    refreshIntervalMinutes: 30,
    autoCheckin: true,
    buddyTravel: true,
  },
};

let state = null;
let refreshing = false;
let cookiesBusy = false;

async function ensureState() {
  if (state) return state;
  const keys = Object.keys(DEFAULT_STATE);
  const stored = await chrome.storage.local.get(keys);
  state = JSON.parse(JSON.stringify(DEFAULT_STATE));
  for (const k of keys) if (stored[k] !== undefined) state[k] = stored[k];
  state.settings = { ...DEFAULT_STATE.settings, ...(stored.settings || {}) };
  state.snapshots = stored.snapshots || {};
  state.accounts = stored.accounts || [];
  return state;
}

async function saveState() {
  if (state) await chrome.storage.local.set(state);
}

function newId() {
  return `acc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function createSnapshot() {
  return {
    result: null, updatedAt: 0, checkin: null, buddy: null,
    error: "", authProblem: "",
    buddyAutoDate: "", buddyClaimKey: "", buddyClaimErrorDate: "", buddyWasTraveling: false,
  };
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmt(n) { return parseFloat((n || 0).toFixed(2)).toString(); }

function parseExpiry(s) {
  if (!s) return Number.POSITIVE_INFINITY;
  const t = Date.parse(s.includes("T") ? s : s.replace(" ", "T"));
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

function cookieUrl(domain, path) {
  return `https://${domain}${path && path.startsWith("/") ? path : "/"}`;
}

async function readSiteCookies() {
  const all = await chrome.cookies.getAll({});
  return all
    .filter((c) => SITE_DOMAINS.some((d) => c.domain === d || c.domain === `.${d}` || c.domain.endsWith(`.${d.replace(/^www\./, "")}`)))
    .filter((c) => AUTH_COOKIE_NAMES.has(c.name))
    .map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
      expirationDate: c.expirationDate,
    }));
}

async function clearSiteCookies() {
  const all = await chrome.cookies.getAll({});
  for (const c of all) {
    if (!SITE_DOMAINS.some((d) => c.domain === d || c.domain === `.${d}`)) continue;
    await chrome.cookies.remove({ url: cookieUrl(c.domain, c.path), name: c.name }).catch(() => {});
  }
}

async function applyCookies(cookies) {
  for (const c of cookies || []) {
    const setting = {
      url: cookieUrl(c.domain, c.path),
      name: c.name,
      value: c.value,
      path: c.path || "/",
      secure: c.secure !== false,
      httpOnly: c.httpOnly !== false,
    };
    if (c.sameSite && c.sameSite !== "unspecified") setting.sameSite = c.sameSite;
    if (c.expirationDate && c.expirationDate > Date.now() / 1000) setting.expirationDate = c.expirationDate;
    await chrome.cookies.set(setting).catch(() => {});
  }
}

async function withAccountCookies(account, fn) {
  while (cookiesBusy) await new Promise((r) => setTimeout(r, 30));
  cookiesBusy = true;
  try {
    await clearSiteCookies();
    await applyCookies(account.cookies);
    return await fn();
  } finally {

    const s = await ensureState();
    const active = s.accounts.find((a) => a.id === s.activeId);
    await clearSiteCookies();
    if (active) await applyCookies(active.cookies);
    cookiesBusy = false;
  }
}

async function detectApiBase() {
  const cookies = await chrome.cookies.getAll({}).catch(() => []);
  const has = (host) =>
    cookies.some((c) =>
      (c.domain === host || c.domain === `.${host}`) &&
      (c.name === "session" || c.name === "session_2")
    );
  if (has("www.codebuddy.cn")) return "https://www.codebuddy.cn";
  if (has("www.workbuddy.cn")) return "https://www.workbuddy.cn";
  return null;
}

async function apiFetch(path, options = {}) {
  const s = await ensureState();
  const detected = await detectApiBase();
  const base = (detected || s.settings.apiBase || "https://www.codebuddy.cn").replace(/\/$/, "");
  const resp = await fetch(`${base}${path}`, {
    method: options.method || "GET",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/plain, */*",
      "x-client-platform": "web",
      ...(options.headers || {}),
    },
    body: options.body,
    cache: "no-store",
  });
  let json = null;
  try { json = await resp.json(); } catch (e) {  }
  return { resp, json };
}

async function fetchUsage() {
  const body = {
    PageNumber: 1, PageSize: 200, ProductCode: "p_tcaca", Status: [0, 3],
    OnlyValidPeriod: true, PackageCodes: DEFAULT_PACKAGE_CODES, NeedInUsage: true,
  };
  const { resp, json } = await apiFetch("/billing/meter/get-user-resource", {
    method: "POST", body: JSON.stringify(body),
  });
  if (resp.status === 401) throw new Error("AUTH_EXPIRED");
  if (!resp.ok) throw new Error(friendlyMsg(`HTTP_${resp.status}`));
  const accounts = json?.data?.Response?.Data?.Accounts || [];
  let remain = 0, total = 0;
  for (const a of accounts) {
    let r, size;
    if (a.CycleCapacityRemainPrecise != null && a.CycleCapacitySizePrecise != null) {
      r = parseFloat(a.CycleCapacityRemainPrecise) || 0;
      size = parseFloat(a.CycleCapacitySizePrecise) || 0;
    } else {
      r = parseFloat(a.CapacityRemainPrecise || "0") || 0;
      size = parseFloat(a.CapacitySizePrecise || "0") || 0;
    }
    remain += r;
    if (r > 0) total += size;
  }
  return { remain, total, accounts };
}

async function fetchCheckinStatus() {
  try {
    const { resp, json } = await apiFetch("/billing/meter/checkin-status", { method: "POST", body: "{}" });
    if (resp.status === 401) throw new Error("AUTH_EXPIRED");
    if (json?.code === 10001) return { state: "claimed" };
    if (!resp.ok) return { state: "unknown", error: friendlyMsg(`HTTP_${resp.status}`) };
    return { state: json?.data?.today_checked_in === true ? "claimed" : "unclaimed" };
  } catch (e) {
    if (e.message === "AUTH_EXPIRED") throw e;
    return { state: "unknown", error: friendlyMsg(e.message || e) };
  }
}

async function doCheckin() {
  try {
    const { resp, json } = await apiFetch("/billing/meter/daily-checkin", { method: "POST", body: "{}" });
    if (resp.status === 401) throw new Error("AUTH_EXPIRED");
    if (json?.code === 10001 || json?.code === 0) {
      return { state: "claimed", credit: json?.data?.credit, freshlyClaimed: json?.code === 0 };
    }
    if (!resp.ok) return { state: "unknown", error: friendlyMsg(`HTTP_${resp.status}`) };
    return await fetchCheckinStatus();
  } catch (e) {
    if (e.message === "AUTH_EXPIRED") throw e;
    return { state: "unknown", error: friendlyMsg(e.message || e) };
  }
}

async function ensureCheckin() {
  const status = await fetchCheckinStatus();
  if (status.state === "claimed") return status;
  if (status.state === "unclaimed") return doCheckin();
  return status;
}

async function callBuddyApi(sub, method, body) {
  const { resp, json } = await apiFetch(`/activity/growth/buddy/travel/${sub}`, { method, body });
  if (resp.status === 401) throw new Error("AUTH_EXPIRED");
  if (!json || typeof json !== "object") return { code: resp.status, msg: `HTTP_${resp.status}` };
  if (json.code == null) json.code = resp.status;
  return json;
}

async function fetchBuddyStatus() {
  try {
    const json = await callBuddyApi("status", "GET");
    if (json?.code !== 0) return null;
    const d = json.data || {};
    return {
      state: d.state, departAt: d.depart_at, arriveAt: d.arrive_at,
      serverNow: d.server_now, durationHours: d.duration_hours ?? d.location?.duration_hours,
      dailyLimitReached: d.daily_limit_reached, locationName: d.location?.name,
    };
  } catch (e) { return null; }
}

async function fetchTravelRewardCredit(departAt) {
  try {
    const json = await callBuddyApi("records?page=1&page_size=20", "GET");
    if (json?.code !== 0) return undefined;
    const records = json?.data?.records || [];
    if (!records.length) return undefined;
    const hit = departAt != null ? records.find((r) => r.depart_at === departAt) : undefined;
    const v = (hit || records[0])?.reward_credit;
    return typeof v === "number" ? v : undefined;
  } catch (e) { return undefined; }
}

function friendlyMsg(msg) {
  const text = String(msg || "");
  if (/not arrived|not yet|still traveling|in progress/i.test(text)) return "喵喵还在旅行途中，积分到账后再来领取";
  if (/no unclaimed|no travel|nothing to claim/i.test(text)) return "当前没有可领取的旅行积分";
  if (/no active buddy|no buddy/i.test(text)) return "当前没有可派出的喵喵（可能正在旅行中或今日已达上限）";
  if (/daily limit|limit reached|reached.*limit/i.test(text)) return "今日已达到上限，明天再来吧";
  if (/already/i.test(text)) return "已经操作过了，无需重复";
  if (/AUTH_EXPIRED|unauthenticated|unauthorized/i.test(text)) return "登录已过期，请重新添加账号";
  if (/^HTTP_/.test(text)) return "网络请求失败，请稍后重试";
  return text;
}

async function claimBuddy() {
  try {
    const json = await callBuddyApi("claim", "POST", "{}");
    if (json?.code === 0) return { claimed: true, credit: json?.data?.credit };
    const msg = json?.msg || `HTTP_${json?.code || ""}`;

    if (/no unclaimed|not arrived|not yet|no travel|nothing to claim/i.test(msg)) {
      return { credit: 0, reason: /not arrived|not yet/i.test(msg) ? "not-arrived" : "none" };
    }
    return { error: friendlyMsg(msg) };
  } catch (e) {
    if (e.message === "AUTH_EXPIRED") throw e;
    return { error: friendlyMsg(e.message || e) };
  }
}

function resolveTravelHours(st) {
  if (!st) return undefined;
  if (st.durationHours != null && st.durationHours > 0) return st.durationHours;
  if (st.arriveAt != null && st.departAt != null && st.arriveAt > st.departAt) {
    const h = (st.arriveAt - st.departAt) / 3600;
    return h > 0 ? Math.round(h * 10) / 10 : undefined;
  }
  return undefined;
}

async function departBuddy(locationId = 1) {
  try {
    const json = await callBuddyApi("depart", "POST", JSON.stringify({ location_id: locationId }));
    if (json?.code !== 0) {
      const raw = json?.msg || `HTTP_${json?.code || ""}`;

      if (/no active buddy|no buddy|already|traveling|in progress|daily limit|limit reached/i.test(raw)) {
        return { reason: /daily limit|limit reached/i.test(raw) ? "limit" : "not-idle", message: friendlyMsg(raw) };
      }
      return { error: friendlyMsg(raw) };
    }
    const departHours = json?.data?.duration_hours ?? json?.data?.duration;
    let hours = resolveTravelHours(await fetchBuddyStatus());
    if (hours == null && typeof departHours === "number" && departHours > 0) hours = departHours;
    return { hours: hours != null && hours > 0 ? hours : 0 };
  } catch (e) {
    if (e.message === "AUTH_EXPIRED") throw e;
    return { error: friendlyMsg(e.message || e) };
  }
}

async function ensureBuddy(snap) {
  const s = await ensureState();
  if (!s.settings.buddyTravel) return undefined;
  const status = await fetchBuddyStatus();
  if (!status) return undefined;
  const buddy = { status };
  const backFromTravel = status.state != null && status.state !== "traveling";
  const isTraveling = status.state === "traveling";
  const travelJustEnded = snap.buddyWasTraveling && !isTraveling;
  const travelKey = String(status.departAt ?? status.arriveAt ?? status.state ?? "");

  if (backFromTravel && (travelJustEnded || travelKey !== snap.buddyClaimKey)) {
    const c = await claimBuddy().catch((e) => ({ error: e.message || String(e) }));
    if (c.reason === "not-arrived") {

    } else if (c.error) {
      buddy.claim = { error: c.error };
      if (snap.buddyClaimErrorDate !== todayStr()) {
        buddy.freshlyClaimFailed = true;
        snap.buddyClaimErrorDate = todayStr();
      }
    } else {
      let credit = c.credit;
      if (c.claimed && !(credit > 0)) credit = await fetchTravelRewardCredit(status.departAt);
      buddy.claim = { credit: credit || 0 };
      if (c.claimed) buddy.freshlyClaimed = true;
      snap.buddyClaimKey = travelKey;
    }
  }
  const canDepart = backFromTravel && !status.dailyLimitReached;
  if (canDepart && snap.buddyAutoDate !== todayStr()) {
    const d = await departBuddy().catch((e) => ({ error: e.message || String(e) }));
    if (d.hours != null) { buddy.depart = { hours: d.hours }; buddy.freshlyDeparted = true; }
    else if (d.error) buddy.depart = { error: d.error };
    const st2 = await fetchBuddyStatus();
    if (st2) buddy.status = st2;
    snap.buddyAutoDate = todayStr();
  }
  snap.buddyWasTraveling = (buddy.status?.state || status.state) === "traveling";
  return buddy;
}

async function refreshAccount(acc) {
  const s = await ensureState();
  const snap = s.snapshots[acc.id] || createSnapshot();
  snap.error = ""; snap.authProblem = "";
  await withAccountCookies(acc, async () => {
    try {
      const autoCheckin = s.settings.autoCheckin;
      const [checkin, buddy] = await Promise.all([
        autoCheckin ? ensureCheckin() : Promise.resolve(undefined),
        ensureBuddy(snap),
      ]);
      snap.checkin = checkin;
      snap.buddy = buddy;
      snap.result = await fetchUsage();
      snap.updatedAt = Date.now();

      if (/^账号 \d+$/.test(acc.label)) {
        const identity = await fetchAccountName();
        if (identity && identity.label) { acc.label = identity.label; acc.detail = identity.detail || ""; }
      }
    } catch (e) {
      const msg = e.message || String(e);
      if (msg === "AUTH_EXPIRED") snap.authProblem = "expired";
      else snap.error = msg;
    }
  });
  s.snapshots[acc.id] = snap;
}

async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  try {
    const s = await ensureState();
    for (const acc of s.accounts) await refreshAccount(acc);
    await saveState();
    await updateBadge();
    notifyResults(s);
    chrome.runtime.sendMessage({ type: "STATE_UPDATED", state: s }).catch(() => {});
  } finally {
    refreshing = false;
  }
}

function notifyResults(s) {
  const info = [], warns = [];
  for (const acc of s.accounts) {
    const snap = s.snapshots[acc.id];
    if (!snap) continue;
    if (snap.authProblem) { warns.push(`${acc.label}: 登录已过期`); continue; }
    if (snap.error) { warns.push(`${acc.label}: 拉取失败 (${snap.error})`); continue; }
    if (snap.checkin?.freshlyClaimed) {
      info.push(snap.checkin.credit ? `${acc.label}: 签到 +${snap.checkin.credit}` : `${acc.label}: 签到完成`);
    }
    if (snap.buddy?.freshlyClaimed) {
      info.push(snap.buddy.claim?.credit > 0 ? `${acc.label}: 喵喵领取 ${snap.buddy.claim.credit}` : `${acc.label}: 喵喵积分已领取`);
    }
    if (snap.buddy?.freshlyDeparted && snap.buddy.depart?.hours != null) {
      info.push(`${acc.label}: 喵喵已出发 (${snap.buddy.depart.hours}h)`);
    }
  }
  const message = [...info.slice(0, 4), ...warns.slice(0, 2)].join(" · ");
  if (message) {
    chrome.notifications.create({
      type: "basic", iconUrl: chrome.runtime.getURL("icons/icon48.png"),
      title: "WorkBuddy自动签到", message,
    });
  }
}

async function updateBadge() {
  const s = await ensureState();
  const acc = s.accounts.find((a) => a.id === s.activeId) || s.accounts[0];
  const snap = acc && s.snapshots[acc.id];
  if (!snap || !snap.result || snap.error || snap.authProblem) {
    chrome.action.setBadgeText({ text: snap?.authProblem ? "!" : "…" });
    chrome.action.setBadgeBackgroundColor({ color: snap?.authProblem ? "#d13438" : "#888" });
    return;
  }
  const remain = snap.result.remain;
  let text = remain >= 1000 ? `${Math.round(remain / 100) / 10}k` : `${Math.round(remain)}`;
  if (text.length > 5) text = text.slice(0, 5);
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: "#1e415e" });
}

async function fetchAccountName() {
  try {
    const { resp, json } = await apiFetch("/console/account", { method: "GET" });
    if (!resp.ok) return null;

    const info = json?.data?.account || json?.data?.accountInfo || json?.data || json;
    const nickname = info?.enterpriseUserName || info?.nickname || info?.displayName || info?.accountName;
    if (!nickname) return null;
    const mask = info?.uin || info?.userId || info?.uid || "";
    return { label: String(nickname), detail: String(mask) };
  } catch (e) {
    return null;
  }
}

async function addCurrentAccount() {
  const s = await ensureState();
  const cookies = await readSiteCookies();
  if (!cookies.some((c) => c.name === "session" || c.name === "session_2")) {
    return { ok: false, error: "没有检测到登录态 Cookie，请先在浏览器登录 codebuddy.cn" };
  }

  let probe;
  try {
    probe = await fetchUsage();
  } catch (e) {
    return { ok: false, error: `登录态验证失败：${e.message || e}` };
  }

  const sessionVal = (cookies.find((c) => c.name === "session") || {}).value || "";
  const existing = s.accounts.find((a) =>
    (a.cookies || []).some((c) => c.name === "session" && c.value === sessionVal)
  );
  if (existing) {
    s.activeId = existing.id;
    await saveState();
    return { ok: true, state: s, duplicate: true, label: existing.label, remain: probe.remain };
  }

  const identity = await fetchAccountName();
  const acc = {
    id: newId(),
    label: identity?.label || `账号 ${s.accounts.length + 1}`,
    detail: identity?.detail || "",
    cookies,
    createdAt: Date.now(),
  };
  s.accounts.push(acc);
  s.activeId = acc.id;
  s.snapshots[acc.id] = createSnapshot();
  s.snapshots[acc.id].result = probe;
  s.snapshots[acc.id].updatedAt = Date.now();
  await saveState();
  await updateBadge();
  return { ok: true, state: s, label: acc.label, remain: probe.remain };
}

async function scheduleRefresh() {
  const s = await ensureState();
  await chrome.alarms.clear("refresh");
  const mins = Number(s.settings.refreshIntervalMinutes) || 0;
  if (mins > 0) await chrome.alarms.create("refresh", { periodInMinutes: mins });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "refresh") {
    await refreshAll();
    const s = await ensureState();
    s.lastAutoRefreshDate = todayStr();
    await saveState();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureState();
  await scheduleRefresh();
  await refreshAll();
});

chrome.runtime.onInstalled.addListener(async () => {
  await ensureState();
  await scheduleRefresh();
  await refreshAll();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    const s = await ensureState();
    switch (msg.type) {
      case "GET_STATE":
        sendResponse({ ok: true, state: s });
        break;
      case "REFRESH":
        await refreshAll();
        sendResponse({ ok: true, state: await ensureState() });
        break;
      case "SWITCH": {
        const acc = s.accounts.find((a) => a.id === msg.id);
        if (!acc) { sendResponse({ ok: false, error: "账号不存在" }); break; }
        s.activeId = msg.id;
        await saveState();
        await clearSiteCookies();
        await applyCookies(acc.cookies);
        await updateBadge();
        sendResponse({ ok: true, state: s });
        break;
      }
      case "ADD_ACCOUNT": {
        const result = await addCurrentAccount();
        sendResponse(result);
        break;
      }
      case "RENAME_ACCOUNT": {
        const acc = s.accounts.find((a) => a.id === msg.id);
        if (acc) { acc.label = msg.label; await saveState(); }
        sendResponse({ ok: true, state: s });
        break;
      }
      case "REMOVE_ACCOUNT":
        s.accounts = s.accounts.filter((a) => a.id !== msg.id);
        delete s.snapshots[msg.id];
        if (s.activeId === msg.id) s.activeId = s.accounts[0]?.id || "";
        await saveState();
        await updateBadge();
        sendResponse({ ok: true, state: s });
        break;
      case "UPDATE_SETTINGS":
        s.settings = { ...s.settings, ...msg.settings };
        await saveState();
        await scheduleRefresh();
        sendResponse({ ok: true, state: s });
        break;
      case "BUDDY_CLAIM":
      case "BUDDY_DEPART": {
        const acc = s.accounts.find((a) => a.id === s.activeId);
        if (!acc) { sendResponse({ ok: false, error: "没有账号" }); break; }
        const snap = s.snapshots[acc.id] || createSnapshot();
        let message = "";
        await withAccountCookies(acc, async () => {
          try {
            if (msg.type === "BUDDY_CLAIM") {
              const c = await claimBuddy();
              if (c.error) { snap.claimError = c.error; message = `领取失败：${c.error}`; }
              else if (c.reason === "not-arrived") {
                message = "喵喵还在旅行中，积分到账后再来领取";
              } else if (c.reason === "none") {
                message = "当前没有可领取的旅行积分";
              } else {
                let credit = c.credit;
                if (c.claimed && !(credit > 0)) credit = await fetchTravelRewardCredit(snap.buddy?.status?.departAt);
                if (!snap.buddy) snap.buddy = {};
                snap.buddy.claim = { credit: credit || 0 };
                message = (credit || 0) > 0 ? `已领取 ${credit} 积分` : (c.claimed ? "积分已领取" : "暂无可领取积分");
              }
            } else {
              const d = await departBuddy();
              if (d.error) {
                message = `派出失败：${d.error}`;
                if (!snap.buddy) snap.buddy = {};
                snap.buddy.depart = { error: d.error };
              } else if (d.reason) {

                message = d.message || "当前暂时无法派出喵喵";
              } else {
                message = `喵喵已出发，约 ${d.hours || 0} 小时后返回`;
                if (!snap.buddy) snap.buddy = {};
                snap.buddy.depart = { hours: d.hours || 0 };
              }
            }
            const st = await fetchBuddyStatus();
            if (st) { if (!snap.buddy) snap.buddy = {}; snap.buddy.status = st; }
          } catch (e) {
            message = e.message === "AUTH_EXPIRED" ? "登录已过期，请重新添加账号" : friendlyMsg(e.message || e);
            if (e.message === "AUTH_EXPIRED") snap.authProblem = "expired";
          }
        });
        s.snapshots[acc.id] = snap;
        await saveState();
        sendResponse({ ok: true, state: s, message });
        break;
      }
      case "OPEN_USAGE": {
        const detected = await detectApiBase();
        const base = (detected || s.settings.apiBase || "https://www.codebuddy.cn").replace(/\/$/, "");
        const url = `${base}/profile/plans-usage`;
        const tab = await chrome.tabs.create({ url });
        sendResponse({ ok: true, tabId: tab.id });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })().catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true;
});

ensureState().then(async (s) => {
  await scheduleRefresh();
  await updateBadge();
  const today = todayStr();
  if (s.lastAutoRefreshDate !== today) {
    await refreshAll();
    s.lastAutoRefreshDate = today;
    await saveState();
  }
});
