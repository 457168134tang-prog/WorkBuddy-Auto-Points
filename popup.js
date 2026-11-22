const el = (id) => document.getElementById(id);
let view = null;
let timer = null;

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
function notice(text) {
  const box = el("flash");
  box.textContent = text;
  box.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => { box.hidden = true; }, 3200);
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
  const list = state.accounts || [];
  const picker = el("whoPick");
  picker.innerHTML = "";
  if (!list.length) {
    picker.innerHTML = '<option value="">请先保存账号</option>';
  } else {
    for (const item of list) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label || "账号";
      option.selected = item.id === state.activeId;
      picker.appendChild(option);
    }
  }
  const active = list.find((item) => item.id === state.activeId) || list[0];
  const shot = active ? state.snapshots[active.id] : null;
  el("who").textContent = active ? `当前账号：${active.label || "账号"}` : "尚未保存账号";
  el("blank").hidden = !!active;
  el("overview").hidden = !active || !shot?.result;
  el("planTable").hidden = !active || !shot?.result;
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
    el("flags").innerHTML = '<span>⚠ 登录已失效，请重新登录</span>';
  } else if (shot?.error) {
    el("flags").innerHTML = `<span>⚠ 积分读取失败：${safe(shot.error)}</span>`;
  }

  const result = shot?.result;
  if (result) {
    el("leftNum").textContent = numeric(result.remain);
    el("allNum").textContent = numeric(result.amount);
    const percent = result.amount > 0 ? (result.remain / result.amount) * 100 : 0;
    el("ratio").textContent = `${percent.toFixed(1)}%`;
    el("meterFill").style.width = `${Math.max(0, Math.min(100, percent))}%`;

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
    if (status.state === "traveling") {
      const left = Math.max(0, (status.backAt || 0) - (status.now || Math.floor(Date.now() / 1000)));
      const hh = `${Math.floor(left / 3600)}`.padStart(2, "0");
      const mm = `${Math.floor((left % 3600) / 60)}`.padStart(2, "0");
      const ss = `${left % 60}`.padStart(2, "0");
      flags.push(`✿ 行程进行中，剩余 ${hh}:${mm}:${ss}`);
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

async function rename() {
  const state = view;
  const active = state?.accounts.find((item) => item.id === state.activeId);
  if (!active) return;
  const name = prompt("为这个账号设置名称：", active.label || "");
  if (!name || !name.trim()) return;
  const reply = await ask("RENAME", { id: active.id, name: name.trim() });
  if (reply.ok) {
    view = reply.state;
    paint();
  }
}

async function forget() {
  const state = view;
  if (!state?.activeId) return;
  if (!confirm("确定移除这个账号？仅清除本插件保存的登录信息，不影响网站登录。")) return;
  const reply = await ask("FORGET", { id: state.activeId });
  if (reply.ok) {
    view = reply.state;
    paint();
    notice("账号已移除");
  }
}

async function act(kind) {
  if (kind === "SYNC_ALL") return refresh();
  if (kind === "ADOPT") return adopt();
  if (kind === "RENAME") return rename();
  if (kind === "FORGET") return forget();
  if (kind === "WRITE_CONFIG") {
    const reply = await ask("WRITE_CONFIG", {
      config: {
        apiBase: el("apiHost").value.trim() || "https://www.workbuddy.cn",
        refreshIntervalMinutes: Number(el("minutes").value) || 0,
        dailyEnabled: el("autoDaily").checked,
        tripEnabled: el("autoTrip").checked
      }
    });
    if (reply.ok) view = reply.state;
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
  if (button) act(button.dataset.act);
});

el("whoPick").addEventListener("change", async (event) => {
  const reply = await ask("PICK", { id: event.target.value });
  if (reply.ok) {
    view = reply.state;
    paint();
    notice("已切换账号");
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.kind === "REFRESHED") {
    view = message.state;
    paint();
  }
});

load();
