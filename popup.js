const el = (id) => document.getElementById(id);
let view = null;
let timer = null;
let countdownTimer = null;
let renameTarget = "";
let forgetTarget = "";
let pickSortDesc = null;

function ask(kind, extra = {}) {
  return new Promise((done) => {
    chrome.runtime.sendMessage({ kind, ...extra }, (reply) => done(reply || { ok: false }));
  });
}
function numeric(value) {
  return parseFloat(((Number(value) || 0).toFixed(2))).toString();
}
function stamp(ms) {
  if (!ms) return "—";
  const date = new Date(ms);
  const two = (value) => `${value}`.padStart(2, "0");
  return `${date.getFullYear()}/${two(date.getMonth() + 1)}/${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}
function safe(value) {
  return `${value ?? ""}`.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function endOf(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(`${value}`.includes("T") ? value : `${value}`.replace(" ", "T"));
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}
function activeTrip(shot) {
  const status = shot?.trip?.status;
  const launch = shot?.trip?.launch;
  const now = Math.floor(Date.now() / 1000);
  if (status && status.state != null) {
    if (status.state === "traveling") {
      return { active: true, backAt: status.backAt || 0, now: status.now || now };
    }
    return { active: false, backAt: 0, now };
  }
  if (launch?.hours > 0 || launch?.launchedAt) {
    const source = typeof launch.launchedAt === "number" ? launch.launchedAt : shot?.updatedAt;
    const start = typeof source === "number" ? Math.floor(source / 1000) : 0;
    const estimated = launch.backAt || (start > 0 && launch.hours > 0 ? start + launch.hours * 3600 : 0);
    if (estimated > now) return { active: true, backAt: estimated, now };
  }
  return { active: false, backAt: 0, now };
}
function countdownText(trip) {
  const left = Math.max(0, (trip.backAt || 0) - Math.floor(Date.now() / 1000));
  const hh = `${Math.floor(left / 3600)}`.padStart(2, "0");
  const mm = `${Math.floor((left % 3600) / 60)}`.padStart(2, "0");
  const ss = `${left % 60}`.padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
function syncCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  if (!el("tripCountdown")) return;
  countdownTimer = setInterval(() => {
    const active = activeAccount();
    const trip = activeTrip(active ? view?.snapshots[active.id] : null);
    const node = el("tripCountdown");
    if (!trip.active || !node) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      return;
    }
    node.textContent = `✿ 行程进行中，剩余 ${countdownText(trip)}`;
  }, 1000);
}
function notice(text) {
  const box = el("flash");
  box.textContent = text;
  box.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => { box.hidden = true; }, 3200);
}
function hideInline() {
  el("renameBox").hidden = true;
  el("forgetBox").hidden = true;
  renameTarget = "";
  forgetTarget = "";
}
function activeAccount() {
  return view?.accounts.find((item) => item.id === view.activeId) || null;
}

function accountPoints(item, state = view) {
  const result = state?.snapshots?.[item.id]?.result;
  if (!result || !Number.isFinite(Number(result.remain))) return null;
  return Number(result.remain);
}

function pointText(item, state = view) {
  const points = accountPoints(item, state);
  return points === null ? "—" : numeric(points);
}

function closePickMenu() {
  const menu = el("pickMenu");
  if (menu) menu.hidden = true;
  const control = el("whoPick");
  if (control) control.setAttribute("aria-expanded", "false");
}

function renderPickRows() {
  const state = view;
  if (!state) return;
  const sortBtn = el("sortBtn");
  const next = pickSortDesc ? "升序" : "降序";
  sortBtn.textContent = `积分${pickSortDesc ? "↑" : "↓"}`;
  sortBtn.title = `按积分${next}排列`;
  sortBtn.setAttribute("aria-label", `按积分${next}排列`);

  const query = el("pickSearch").value.trim().toLowerCase();
  let list = [...(state.accounts || [])];
  if (query) list = list.filter((item) => `${item.label || ""}`.toLowerCase().includes(query));
  if (pickSortDesc !== null) {
    list.sort((first, second) => {
      const a = accountPoints(first, state);
      const b = accountPoints(second, state);
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return pickSortDesc ? b - a : a - b;
    });
  }

  const box = el("pickList");
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = `<div class="pickEmpty">${state.accounts?.length ? "无匹配账号" : "请先保存账号"}</div>`;
    return;
  }
  for (const item of list) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pickRow";
    row.dataset.id = item.id;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(item.id === state.activeId));
    row.innerHTML = `<span>${safe(item.label || "账号")}</span><span class="point">${safe(pointText(item, state))}</span>`;
    box.appendChild(row);
  }
}

async function chooseAccount(id) {
  closePickMenu();
  if (!id || !view || id === view.activeId) return;
  const reply = await ask("PICK", { id });
  if (reply.ok) {
    view = reply.state;
    paint();
    notice("已切换账号");
  }
}

async function load() {
  const reply = await ask("FETCH_STATE");
  if (reply.ok) {
    view = reply.state;
    paint();
  }
}

function paint() {
  const state = view;
  if (!state) return;
  hideInline();
  const list = state.accounts || [];
  const active = activeAccount();
  const shown = active || list[0];
  el("pickLabel").textContent = shown ? shown.label || "账号" : "请先保存账号";
  closePickMenu();
  renderPickRows();
  const shot = active ? state.snapshots[active.id] : null;
  el("who").textContent = active ? `当前账号：${active.label || "账号"}` : "尚未保存账号";
  el("blank").hidden = !!active;
  el("overview").hidden = !active || !shot?.result;
  el("planTable").hidden = !active || !shot?.result;
  el("renameBtn").disabled = !active;
  el("forgetBtn").disabled = !active;
  el("flags").innerHTML = "";
  el("claimBtn").hidden = true;
  el("departBtn").hidden = true;
  el("lastTime").textContent = "";

  if (!active) {
    el("leftNum").textContent = "—";
    el("allNum").textContent = "—";
    el("ratio").textContent = "";
    el("meterFill").style.width = "0";
    return;
  }
  if (shot?.authProblem) {
    el("flags").innerHTML = '<span>⚠ 登录已失效，请重新登录并保存账号</span>';
  } else if (shot?.error) {
    el("flags").innerHTML = `<span>⚠ 积分读取失败：${safe(shot.error)}</span>`;
  }

  const result = shot?.result;
  if (result) {
    el("leftNum").textContent = numeric(result.remain);
    el("allNum").textContent = numeric(result.amount);
    const percent = result.amount > 0 ? (result.remain / result.amount) * 100 : 0;
    el("ratio").textContent = `${percent.toFixed(1)}%`;
    const meter = el("meterFill");
    meter.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    meter.style.background = percent >= 60 ? "var(--good)" : percent >= 20 ? "var(--warn)" : "var(--alert)";

    const usable = (result.rows || [])
      .filter((row) => (parseFloat(row.CycleCapacityRemainPrecise ?? row.CapacityRemainPrecise ?? "0") || 0) > 0)
      .sort((first, second) => endOf(first.CycleEndTime) - endOf(second.CycleEndTime));
    const body = el("planBody");
    body.innerHTML = "";
    if (!usable.length) {
      body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--soft)">暂无可用套餐</td></tr>';
    } else {
      for (const row of usable.slice(0, 5)) {
        const line = document.createElement("tr");
        const left = numeric(parseFloat(row.CycleCapacityRemainPrecise ?? row.CapacityRemainPrecise ?? "0"));
        const size = numeric(parseFloat(row.CycleCapacitySizePrecise ?? row.CapacitySizePrecise ?? "0"));
        line.innerHTML = `<td title="${safe(row.PackageName || "")}">${safe((row.PackageName || "-").slice(0, 18))}</td><td>${left}</td><td>${size}</td><td>${safe((row.CycleEndTime || "-").slice(0, 16))}</td>`;
        body.appendChild(line);
      }
      if (usable.length > 5) {
        const line = document.createElement("tr");
        line.innerHTML = `<td colspan="4" style="text-align:center;color:var(--soft)">共 ${usable.length} 项，仅显示前 5 项</td>`;
        body.appendChild(line);
      }
    }
  }

  const flags = [];
  if (state.settings.dailyEnabled && shot?.daily) {
    const phase = typeof shot.daily === "string" ? shot.daily : shot.daily.state;
    flags.push(phase === "done" ? "✓ 今日积分已领取" : phase === "pending" ? "○ 今日积分待领取" : "⚠ 积分状态异常");
  }
  if (state.settings.tripEnabled && shot?.trip?.status) {
    const status = shot.trip.status;
    const trip = activeTrip(shot);
    if (trip.active) {
      flags.push(`✿ 行程进行中，剩余 ${countdownText(trip)}`);
    } else if (status.capped) {
      flags.push("✿ 今日行程已达上限，明天可继续出发");
      el("claimBtn").hidden = false;
    } else {
      flags.push("✿ 奖励可领，可继续出发");
      el("claimBtn").hidden = false;
      el("departBtn").hidden = false;
    }
  }
  el("flags").innerHTML += flags.map((text) => `<span>${text}</span>`).join("");
  const countdownNode = Array.from(el("flags").querySelectorAll("span"))
    .find((node) => node.textContent.startsWith("✿ 行程进行中，剩余 "));
  if (countdownNode) countdownNode.id = "tripCountdown";
  syncCountdown();
  if (shot?.updatedAt) el("lastTime").textContent = `最近同步 ${stamp(shot.updatedAt)}`;

  el("apiHost").value = state.settings.apiBase || "";
  el("minutes").value = state.settings.refreshIntervalMinutes ?? 30;
  el("autoDaily").checked = !!state.settings.dailyEnabled;
  el("autoTrip").checked = !!state.settings.tripEnabled;
}

async function refresh() {
  notice("正在同步全部账号…");
  const reply = await ask("SYNC_ALL");
  if (reply.ok) {
    view = reply.state;
    paint();
    notice("同步完成");
  } else {
    notice(`同步失败：${reply.error || ""}`);
  }
}

async function adopt() {
  notice("正在读取登录信息…");
  const reply = await ask("ADOPT");
  if (!reply.ok) {
    notice(`保存失败：${reply.error || ""}`);
    return;
  }
  view = reply.state;
  paint();
  notice(reply.repeated ? `${reply.label} 已存在，已切换到它` : `账号 ${reply.label} 已保存`);
}

function rename() {
  const active = activeAccount();
  if (!active) return notice("请先保存账号");
  hideInline();
  renameTarget = active.id;
  el("renameInput").value = active.label || "";
  el("renameBox").hidden = false;
  el("renameInput").focus();
  el("renameInput").select();
}

async function saveRename() {
  if (!renameTarget) return;
  const name = el("renameInput").value.trim();
  if (!name) return notice("名称不能为空");
  const reply = await ask("RENAME", { id: renameTarget, name });
  hideInline();
  if (reply.ok) {
    view = reply.state;
    paint();
    notice("名称已更新");
  } else {
    notice(`改名失败：${reply.error || ""}`);
  }
}

function forget() {
  const active = activeAccount();
  if (!active) return notice("请先保存账号");
  hideInline();
  forgetTarget = active.id;
  el("forgetText").textContent = `移除「${active.label || "账号"}」？`;
  el("forgetBox").hidden = false;
}

async function confirmForget() {
  if (!forgetTarget) return;
  const reply = await ask("FORGET", { id: forgetTarget });
  hideInline();
  if (reply.ok) {
    view = reply.state;
    paint();
    notice("账号已移除");
  } else {
    notice(`移除失败：${reply.error || ""}`);
  }
}

async function openPage(kind, starting, done) {
  notice(starting);
  const reply = await ask(kind);
  notice(reply.ok ? done : `打开失败：${reply.error || ""}`);
}

async function act(kind) {
  if (kind === "SYNC_ALL") return refresh();
  if (kind === "ADOPT") return adopt();
  if (kind === "RENAME") return rename();
  if (kind === "RENAME_SAVE") return saveRename();
  if (kind === "RENAME_CANCEL") return hideInline();
  if (kind === "FORGET") return forget();
  if (kind === "FORGET_YES") return confirmForget();
  if (kind === "FORGET_NO") return hideInline();
  if (kind === "LOGIN") return openPage(kind, "正在打开登录页…", "登录页已打开，登录后可点「保存当前账号」");
  if (kind === "PLANS") return openPage(kind, "正在打开用量页…", "用量页已打开");
  if (kind === "WRITE_CONFIG") {
    const reply = await ask("WRITE_CONFIG", {
      config: {
        apiBase: el("apiHost").value.trim() || "https://www.workbuddy.cn",
        refreshIntervalMinutes: Number(el("minutes").value) || 0,
        dailyEnabled: el("autoDaily").checked,
        tripEnabled: el("autoTrip").checked
      }
    });
    if (reply.ok) {
      view = reply.state;
      el("apiHost").value = view.settings.apiBase || "";
      el("minutes").value = view.settings.refreshIntervalMinutes ?? 30;
      el("autoDaily").checked = !!view.settings.dailyEnabled;
      el("autoTrip").checked = !!view.settings.tripEnabled;
      paint();
    }
    notice(reply.ok ? "选项已保存" : `保存失败：${reply.error || ""}`);
    return;
  }
  const reply = await ask(kind);
  if (reply.ok) {
    if (reply.state) view = reply.state;
    paint();
    notice(reply.message || "操作完成");
  } else {
    notice(`操作失败：${reply.error || ""}`);
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-act]");
  if (button && !button.disabled) act(button.dataset.act);
});

el("whoPick").addEventListener("click", () => {
  if (!view?.accounts?.length) return;
  const menu = el("pickMenu");
  const opening = menu.hidden;
  menu.hidden = !opening;
  el("whoPick").setAttribute("aria-expanded", String(opening));
  if (opening) {
    renderPickRows();
    el("pickSearch").focus();
  }
});

el("pickSearch").addEventListener("input", renderPickRows);

el("sortBtn").addEventListener("click", () => {
  pickSortDesc = !pickSortDesc;
  renderPickRows();
});

el("pickList").addEventListener("click", (event) => {
  const row = event.target.closest(".pickRow");
  if (row) chooseAccount(row.dataset.id);
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".pickWrap")) closePickMenu();
});

el("renameInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveRename();
  if (event.key === "Escape") hideInline();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideInline();
    closePickMenu();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.kind === "REFRESHED") {
    view = message.state;
    paint();
  }
});

load();
