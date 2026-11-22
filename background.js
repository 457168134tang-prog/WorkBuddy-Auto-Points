const HOSTS = [
  "www.codebuddy.cn", "codebuddy.cn",
  "www.workbuddy.cn", "workbuddy.cn"
];

const SESSION_FIELDS = new Set([
  "session", "session_2", "_pre_auth_session",
  "cb_login_mode", "cb_login_realm"
]);

const BILLING_PLANS = [
  "TCACA_code_008_cfWoLwvjU4",
  "TCACA_code_009_0XmEQc2xOf",
  "TCACA_code_038_OhvqZtiPKr",
  "TCACA_code_007_nzdH5h4Nl0",
  "TCACA_code_028_NtpWi0jzXs",
  "TCACA_code_029_6wCGEWquYy",
  "TCACA_code_030_BjSt89qTvr"
];

const BASE_CONFIG = {
  accounts: [],
  activeId: "",
  snapshots: {},
  lastAutoRefreshDate: "",
  settings: {
    apiBase: "https://www.workbuddy.cn",
    refreshIntervalMinutes: 30,
    dailyEnabled: true,
    tripEnabled: true
  }
};

const EXPIRED = "SESSION_GONE";
let cached = null;
let syncing = false;
let rotating = false;

const clock = {
  day() {
    const now = new Date();
    const two = (value) => `${value}`.padStart(2, "0");
    return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  }
};

const store = {
  async read() {
    if (cached) return cached;
    const saved = await chrome.storage.local.get(Object.keys(BASE_CONFIG));
    cached = structuredClone(BASE_CONFIG);
    for (const key of Object.keys(BASE_CONFIG)) {
      if (saved[key] !== undefined) cached[key] = saved[key];
    }
    cached.settings = { ...BASE_CONFIG.settings, ...(saved.settings || {}) };
    if (!/^https:\/\/www\.(codebuddy|workbuddy)\.cn$/.test(cached.settings.apiBase || "")) {
      cached.settings.apiBase = "https://www.workbuddy.cn";
    }
    cached.snapshots = saved.snapshots || {};
    cached.accounts = saved.accounts || [];
    return cached;
  },
  async commit() {
    if (cached) await chrome.storage.local.set(cached);
  }
};

const label = (value) => parseFloat((Number(value) || 0).toFixed(2)).toString();
const expiryTime = (value) => {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(`${value}`.includes("T") ? value : `${value}`.replace(" ", "T"));
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
};
const newAccountId = () => `acct_${(globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`).slice(0, 12)}`;

const ERROR_RULES = [
  [/not arrived|not yet|still traveling|in progress/i, "行程还在进行中，结束后再领取奖励"],
  [/no unclaimed|no travel|nothing to claim/i, "目前没有可领取的行程奖励"],
  [/no active buddy|no buddy/i, "暂时无法发起行程：可能还在途中，或今日已达上限"],
  [/daily limit|limit reached|reached.*limit/i, "今日行程已达上限，请明天再试"],
  [/already/i, "已处理过，无需重复操作"],
  [new RegExp(EXPIRED, "i"), "登录已失效，请重新登录并保存当前账号"],
  [/^HTTP_/, "网络请求失败，请稍后重试"]
];

const explain = (reason) => {
  const text = `${reason || ""}`;
  for (const [pattern, message] of ERROR_RULES) {
    if (pattern.test(text)) return message;
  }
  return text;
};

const cookies = {
  async collect() {
    const items = await chrome.cookies.getAll({});
    return items
      .filter((item) => HOSTS.some((host) => item.domain === host || item.domain === `.${host}`))
      .filter((item) => SESSION_FIELDS.has(item.name))
      .map((item) => ({
        name: item.name, value: item.value, domain: item.domain, path: item.path,
        secure: item.secure, httpOnly: item.httpOnly, sameSite: item.sameSite,
        expirationDate: item.expirationDate
      }));
  },
  scope(item) {
    return `https://${item.domain}${item.path && item.path.startsWith("/") ? item.path : "/"}`;
  },
  async wipe() {
    const items = await chrome.cookies.getAll({});
    for (const item of items) {
      if (!HOSTS.some((host) => item.domain === host || item.domain === `.${host}`)) continue;
      await chrome.cookies.remove({ url: cookies.scope(item), name: item.name }).catch(() => {});
    }
  },
  async restore(list) {
    for (const item of list || []) {
      const spec = {
        url: cookies.scope(item), name: item.name, value: item.value,
        path: item.path || "/", secure: item.secure !== false, httpOnly: item.httpOnly !== false
      };
      if (item.sameSite && item.sameSite !== "unspecified") spec.sameSite = item.sameSite;
      if (item.expirationDate && item.expirationDate > Date.now() / 1000) spec.expirationDate = item.expirationDate;
      await chrome.cookies.set(spec).catch(() => {});
    }
  },
  async borrow(account, task) {
    while (rotating) await new Promise((done) => setTimeout(done, 25));
    rotating = true;
    try {
      await cookies.wipe();
      await cookies.restore(account.cookies);
      return await task();
    } finally {
      const state = await store.read();
      const chosen = state.accounts.find((item) => item.id === state.activeId);
      await cookies.wipe();
      if (chosen) await cookies.restore(chosen.cookies);
      rotating = false;
    }
  }
};

const api = {
  async endpoint() {
    const items = await chrome.cookies.getAll({}).catch(() => []);
    const has = (host) => items.some((item) =>
      (item.domain === host || item.domain === `.${host}`) &&
      (item.name === "session" || item.name === "session_2")
    );
    if (has("www.codebuddy.cn")) return "https://www.codebuddy.cn";
    if (has("www.workbuddy.cn")) return "https://www.workbuddy.cn";
    return null;
  },
  async call(route, options = {}) {
    const state = await store.read();
    const base = ((await api.endpoint()) || state.settings.apiBase || "https://www.workbuddy.cn").replace(/\/$/, "");
    const isTrip = route.startsWith("/activity/growth/buddy/travel/");
    const response = await fetch(`${base}${route}`, {
      method: options.method || "GET",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain, */*",
        origin: base,
        referer: `${base}${isTrip ? "/profile/growth-center" : "/profile/plans-usage"}`,
        "x-client-platform": "web"
      },
      body: options.body,
      cache: "no-store"
    });
    let json = null;
    try { json = await response.json(); } catch (_) { }
    return { ok: response.ok, status: response.status, json };
  },
  trip(route, method = "GET", body) {
    return api.call(`/activity/growth/buddy/travel/${route}`, { method, body });
  }
};

const balance = {
  async read() {
    const response = await api.call("/billing/meter/get-user-resource", {
      method: "POST",
      body: JSON.stringify({
        PageNumber: 1, PageSize: 200, ProductCode: "p_tcaca", Status: [0, 3],
        OnlyValidPeriod: true, PackageCodes: BILLING_PLANS, NeedInUsage: true
      })
    });
    if (response.status === 401) throw new Error(EXPIRED);
    if (!response.ok) throw new Error(explain(`HTTP_${response.status}`));
    const rows = response.json?.data?.Response?.Data?.Accounts || [];
    return rows.reduce((total, row) => {
      const left = parseFloat(row.CycleCapacityRemainPrecise ?? row.CapacityRemainPrecise ?? "0") || 0;
      const size = parseFloat(row.CycleCapacitySizePrecise ?? row.CapacitySizePrecise ?? "0") || 0;
      total.remain += left;
      if (left > 0) total.amount += size;
      return total;
    }, { remain: 0, amount: 0, rows });
  }
};

const daily = {
  async state() {
    const response = await api.call("/billing/meter/checkin-status", { method: "POST", body: "{}" });
    if (response.status === 401) throw new Error(EXPIRED);
    if (response.json?.code === 10001 || response.json?.data?.today_checked_in === true) return "done";
    if (!response.ok) return { state: "error", note: explain(`HTTP_${response.status}`) };
    return "pending";
  },
  async claim() {
    const response = await api.call("/billing/meter/daily-checkin", { method: "POST", body: "{}" });
    if (response.status === 401) throw new Error(EXPIRED);
    if (response.json?.code === 0 || response.json?.code === 10001) {
      return { state: "done", amount: response.json?.data?.credit, fresh: response.json?.code === 0 };
    }
    if (!response.ok) return { state: "error", note: explain(`HTTP_${response.status}`) };
    return await daily.state();
  },
  async settle(enabled) {
    if (!enabled) return undefined;
    const current = await daily.state();
    if (current === "done" || typeof current === "object") return current;
    return daily.claim();
  }
};

const journey = {
  async status() {
    try {
      const response = await api.trip("status");
      if (response.json?.code !== 0) return null;
      const data = response.json.data || {};
      return {
        state: data.state,
        leftAt: data.depart_at, backAt: data.arrive_at, now: data.server_now,
        hours: data.duration_hours ?? data.location?.duration_hours,
        capped: data.daily_limit_reached, place: data.location?.name
      };
    } catch (_) { return null; }
  },
  async reward(leftAt) {
    try {
      const response = await api.trip("records?page=1&page_size=20");
      if (response.json?.code !== 0) return undefined;
      const rows = response.json?.data?.records || [];
      const hit = leftAt == null ? undefined : rows.find((row) => row.depart_at === leftAt);
      const value = (hit || rows[0])?.reward_credit;
      return typeof value === "number" ? value : undefined;
    } catch (_) { return undefined; }
  },
  async collect() {
    const response = await api.trip("claim", "POST", "{}");
    const json = response.json || {};
    if (json.code === 0) return { done: true, amount: json.data?.credit };
    const text = json.msg || "";
    if (/no unclaimed|nothing to claim/i.test(text)) return { empty: true };
    if (/not arrived|not yet/i.test(text)) return { waiting: true };
    return { error: explain(text) };
  },
  async depart() {
    const response = await api.trip("depart", "POST", JSON.stringify({ location_id: 1 }));
    const json = response.json || {};
    if (json.code !== 0) {
      const text = json.msg || "";
      if (/no active buddy|no buddy|already|traveling|in progress|daily limit|limit reached/i.test(text)) {
        return { blocked: /daily limit|limit reached/i.test(text) ? "capped" : "busy", note: explain(text) };
      }
      return { error: explain(text) };
    }
    let hours = json.data?.duration_hours ?? json.data?.duration;
    const next = await journey.status();
    const measured = next && next.leftAt != null && next.backAt != null && next.backAt > next.leftAt
      ? Math.round(((next.backAt - next.leftAt) / 3600) * 10) / 10
      : undefined;
    if (measured > 0) hours = measured;
    return { hours: hours > 0 ? hours : 0 };
  },
  async settle(shot, enabled) {
    if (!enabled) return;
    const status = await journey.status();
    if (!status) return;
    const travelling = status.state === "traveling";
    const returned = status.state != null && !travelling;
    const stamp = `${status.leftAt ?? status.backAt ?? status.state ?? ""}`;
    const record = {};

    if (returned && (shot.wasOnTrip || stamp !== shot.tripRewardKey)) {
      const result = await journey.collect();
      if (result.waiting) {
        record.note = "行程尚未结算，稍后再试";
      } else if (result.error) {
        record.error = result.error;
        if (shot.tripErrorDay !== clock.day()) {
          record.warn = true;
          shot.tripErrorDay = clock.day();
        }
      } else {
        let amount = result.amount;
        if (result.done && !(amount > 0)) amount = await journey.reward(status.leftAt);
        record.claim = { amount: amount || 0 };
        record.fresh = !!result.done;
        shot.tripRewardKey = stamp;
      }
    }

    if (returned && !status.capped && shot.tripLaunchDay !== clock.day()) {
      const result = await journey.depart();
      if (result.hours != null) {
        record.launch = { hours: result.hours };
        record.launched = true;
      } else if (result.error) {
        record.launch = { error: result.error };
      }
      shot.tripLaunchDay = clock.day();
    }

    shot.wasOnTrip = travelling;
    if (Object.keys(record).length) {
      shot.trip = { ...(shot.trip || {}), status, ...record };
    } else {
      shot.trip = { ...(shot.trip || {}), status };
    }
    return shot.trip;
  }
};

const engine = {
  async one(account) {
    const state = await store.read();
    const shot = state.snapshots[account.id] || {
      result: null, updatedAt: 0, daily: null, trip: null,
      error: "", authProblem: "", claimError: "",
      tripLaunchDay: "", tripRewardKey: "", tripErrorDay: "", wasOnTrip: false
    };
    shot.error = "";
    shot.authProblem = "";

    await cookies.borrow(account, async () => {
      try {
        const [dailyInfo] = await Promise.all([
          daily.settle(state.settings.dailyEnabled),
          journey.settle(shot, state.settings.tripEnabled)
        ]);
        shot.daily = dailyInfo;
        shot.result = await balance.read();
        shot.updatedAt = Date.now();
        if (/^账号 \d+$/.test(account.label || "")) {
          const response = await api.call("/console/account");
          const info = response.json?.data?.account || response.json?.data?.accountInfo || response.json?.data || response.json;
          const title = info?.enterpriseUserName || info?.nickname || info?.displayName || info?.accountName;
          if (title) {
            account.label = `${title}`;
            account.detail = `${info?.uin || info?.userId || info?.uid || ""}`;
          }
        }
      } catch (error) {
        if (error.message === EXPIRED) shot.authProblem = "expired";
        else shot.error = error.message || `${error}`;
      }
    });

    state.snapshots[account.id] = shot;
  },
  async all() {
    if (syncing) return;
    syncing = true;
    try {
      const state = await store.read();
      for (const account of state.accounts) await engine.one(account);
      await store.commit();
      await engine.badge();
      engine.announce(state);
      chrome.runtime.sendMessage({ kind: "REFRESHED", state }).catch(() => {});
    } finally {
      syncing = false;
    }
  },
  async badge() {
    const state = await store.read();
    const chosen = state.accounts.find((item) => item.id === state.activeId) || state.accounts[0];
    const shot = chosen && state.snapshots[chosen.id];
    if (!shot || !shot.result || shot.error || shot.authProblem) {
      chrome.action.setBadgeText({ text: shot?.authProblem ? "!" : "…" });
      chrome.action.setBadgeBackgroundColor({ color: shot?.authProblem ? "#d13438" : "#888" });
      return;
    }
    const value = shot.result.remain;
    const text = value >= 1000 ? `${Math.round(value / 100) / 10}k` : `${Math.round(value)}`;
    chrome.action.setBadgeText({ text: text.slice(0, 5) });
    chrome.action.setBadgeBackgroundColor({ color: "#1e415e" });
  },
  announce(state) {
    const good = [];
    const bad = [];
    for (const account of state.accounts) {
      const shot = state.snapshots[account.id];
      if (!shot) continue;
      if (shot.authProblem) { bad.push(`${account.label}: 登录已失效，请重新登录`); continue; }
      if (shot.error) { bad.push(`${account.label}: 积分读取失败：${shot.error}`); continue; }
      const dailyState = typeof shot.daily === "string" ? shot.daily : shot.daily?.state;
      if (shot.daily?.fresh) {
        good.push(`${account.label}: 每日积分 +${shot.daily.amount || ""}`.trim());
      } else if (dailyState === "pending") {
        bad.push(`${account.label}: 今日积分未领取，稍后会自动重试`);
      } else if (dailyState === "error") {
        bad.push(`${account.label}: 每日积分领取失败${shot.daily?.note ? `：${shot.daily.note}` : ""}`);
      }
      if (shot.trip?.fresh) {
        good.push(`${account.label}: 行程奖励 +${shot.trip.claim?.amount || 0} 积分`);
      } else if (shot.trip?.warn && (shot.trip.error || shot.trip.claim?.error)) {
        bad.push(`${account.label}: 行程奖励领取失败：${shot.trip.error || shot.trip.claim.error}`);
      } else if (shot.claimError) {
        bad.push(`${account.label}: 行程奖励领取失败：${shot.claimError}`);
      }
      if (shot.trip?.launched && shot.trip.launch?.hours != null) {
        good.push(`${account.label}: 行程已出发，预计 ${shot.trip.launch.hours} 小时后返回`);
      } else if (shot.trip?.launch?.error) {
        bad.push(`${account.label}: 发起行程失败：${shot.trip.launch.error}`);
      }
    }
    const show = (title, lines) => {
      if (!lines.length) return;
      chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon48.png"),
        title,
        message: lines.slice(0, 5).join(" · ")
      });
    };
    show("WorkBuddy积分管家", good);
    show("WorkBuddy积分管家 - 需要你处理", bad);
  }
};

async function adoptCurrent() {
  const state = await store.read();
  const items = await cookies.collect();
  if (!items.some((item) => item.name === "session" || item.name === "session_2")) {
    return { ok: false, error: "未检测到登录信息，请先在浏览器登录 codebuddy.cn 或 workbuddy.cn" };
  }
  let probe;
  try { probe = await balance.read(); }
  catch (error) { return { ok: false, error: `登录信息验证失败：${error.message || error}` }; }

  const token = (items.find((item) => item.name === "session") || {}).value || "";
  const found = state.accounts.find((account) =>
    (account.cookies || []).some((item) => item.name === "session" && item.value === token)
  );
  if (found) {
    state.activeId = found.id;
    await store.commit();
    return { ok: true, state, repeated: true, label: found.label, remain: probe.remain };
  }

  let nickname = "";
  let detail = "";
  try {
    const response = await api.call("/console/account");
    const info = response.json?.data?.account || response.json?.data?.accountInfo || response.json?.data || response.json;
    nickname = info?.enterpriseUserName || info?.nickname || info?.displayName || info?.accountName || "";
    detail = info?.uin || info?.userId || info?.uid || "";
  } catch (_) { }

  const account = {
    id: newAccountId(),
    label: nickname || `账号 ${state.accounts.length + 1}`,
    detail: `${detail}`,
    cookies: items,
    createdAt: Date.now()
  };
  state.accounts.push(account);
  state.activeId = account.id;
  state.snapshots[account.id] = {
    result: probe, updatedAt: Date.now(), daily: null, trip: null,
    error: "", authProblem: "", claimError: "",
    tripLaunchDay: "", tripRewardKey: "", tripErrorDay: "", wasOnTrip: false
  };
  await store.commit();
  await engine.badge();
  return { ok: true, state, label: account.label, remain: probe.remain };
}

async function handleActive(mode) {
  const state = await store.read();
  const account = state.accounts.find((item) => item.id === state.activeId);
  if (!account) return { ok: false, error: "请先保存账号" };
  const shot = state.snapshots[account.id] || {
    result: null, updatedAt: 0, daily: null, trip: null,
    error: "", authProblem: "", claimError: "",
    tripLaunchDay: "", tripRewardKey: "", tripErrorDay: "", wasOnTrip: false
  };
  let text = "";

  await cookies.borrow(account, async () => {
    try {
      if (mode === "claim") {
        const result = await journey.collect();
        if (result.error) {
          text = `行程奖励领取失败：${result.error}`;
          shot.claimError = result.error;
        } else if (result.waiting) {
          text = "行程奖励尚未到账，请稍后再试";
        } else if (result.empty) {
          text = "目前没有可领取的行程奖励";
        } else {
          let amount = result.amount;
          if (result.done && !(amount > 0)) amount = await journey.reward(shot.trip?.status?.leftAt);
          shot.trip = { ...(shot.trip || {}), claim: { amount: amount || 0 } };
          text = amount > 0 ? `已领取 ${amount} 积分` : "行程奖励已领取";
        }
      } else {
        const result = await journey.depart();
        if (result.error) {
          text = `发起行程失败：${result.error}`;
          shot.trip = { ...(shot.trip || {}), launch: { error: result.error } };
        } else if (result.blocked) {
          text = result.note || "当前无法发起行程，请稍后再试";
        } else {
          text = result.hours > 0 ? `已出发，预计 ${result.hours} 小时后返回` : "已出发，预计返回时间暂未获取";
          shot.trip = { ...(shot.trip || {}), launch: { hours: result.hours || 0 } };
        }
        const status = await journey.status();
        if (status) shot.trip = { ...(shot.trip || {}), status };
      }
    } catch (error) {
      text = error.message === EXPIRED ? "登录已失效，请重新登录并保存当前账号" : explain(error.message || error);
      if (error.message === EXPIRED) shot.authProblem = "expired";
    }
  });

  state.snapshots[account.id] = shot;
  await store.commit();
  return { ok: true, state, message: text };
}

async function siteBase() {
  const state = await store.read();
  return ((await api.endpoint()) || state.settings.apiBase || "https://www.workbuddy.cn").replace(/\/$/, "");
}
async function openHome() {
  await chrome.tabs.create({ url: await siteBase() });
}
async function openPlans() {
  await chrome.tabs.create({ url: `${await siteBase()}/profile/plans-usage` });
}

const handlers = {
  FETCH_STATE: async () => ({ ok: true, state: await store.read() }),
  SYNC_ALL: async () => { await engine.all(); return { ok: true, state: await store.read() }; },
  PICK: async (msg) => {
    const state = await store.read();
    if (!state.accounts.some((item) => item.id === msg.id)) return { ok: false, error: "账号不存在" };
    state.activeId = msg.id;
    await store.commit();
    await cookies.wipe();
    const chosen = state.accounts.find((item) => item.id === msg.id);
    if (chosen) await cookies.restore(chosen.cookies);
    await engine.badge();
    return { ok: true, state };
  },
  ADOPT: async () => adoptCurrent(),
  RENAME: async (msg) => {
    const state = await store.read();
    const account = state.accounts.find((item) => item.id === msg.id);
    if (account) account.label = `${msg.name || ""}`.trim() || account.label;
    await store.commit();
    return { ok: true, state };
  },
  FORGET: async (msg) => {
    const state = await store.read();
    state.accounts = state.accounts.filter((item) => item.id !== msg.id);
    delete state.snapshots[msg.id];
    if (state.activeId === msg.id) state.activeId = state.accounts[0]?.id || "";
    await store.commit();
    await engine.badge();
    return { ok: true, state };
  },
  WRITE_CONFIG: async (msg) => {
    const state = await store.read();
    state.settings = { ...state.settings, ...(msg.config || {}) };
    await store.commit();
    await schedule();
    return { ok: true, state };
  },
  COLLECT: async () => handleActive("claim"),
  DEPART: async () => handleActive("depart"),
  HOME: async () => { await openHome(); return { ok: true }; },
  PLANS: async () => { await openPlans(); return { ok: true }; }
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const action = handlers[msg?.kind];
  if (!action) {
    reply({ ok: false, error: "无法识别的请求" });
    return;
  }
  action(msg).then(reply).catch((error) => reply({ ok: false, error: error.message || `${error}` }));
  return true;
});

async function schedule() {
  const state = await store.read();
  await chrome.alarms.clear("refresh");
  await chrome.alarms.clear("auto-sync");
  const minutes = Number(state.settings.refreshIntervalMinutes) || 0;
  if (minutes > 0) await chrome.alarms.create("auto-sync", { periodInMinutes: minutes });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "auto-sync") return;
  await engine.all();
  const state = await store.read();
  state.lastAutoRefreshDate = clock.day();
  await store.commit();
});

async function launch(force) {
  const state = await store.read();
  await schedule();
  await engine.badge();
  if (force || state.lastAutoRefreshDate !== clock.day()) {
    await engine.all();
    state.lastAutoRefreshDate = clock.day();
    await store.commit();
  }
}

chrome.runtime.onStartup.addListener(() => launch(true));
chrome.runtime.onInstalled.addListener(() => launch(true));
launch(false);
