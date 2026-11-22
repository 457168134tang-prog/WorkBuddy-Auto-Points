const $ = (id) => document.getElementById(id);
let currentState = null;

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => resolve(res || { ok: false }));
  });
}
function fmt(n) { return parseFloat((n || 0).toFixed(2)).toString(); }
function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}
function parseExpiry(s) {
  if (!s) return Number.POSITIVE_INFINITY;
  const t = Date.parse(s.includes("T") ? s : s.replace(" ", "T"));
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function load() {
  const res = await send({ type: "GET_STATE" });
  if (res.ok) { currentState = res.state; render(); }
}

function render() {
  const s = currentState;
  if (!s) return;
  const accounts = s.accounts || [];
  const select = $("accountSelect");
  select.innerHTML = "";
  if (!accounts.length) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "没有账号";
    select.appendChild(o);
  } else {
    for (const acc of accounts) {
      const o = document.createElement("option");
      o.value = acc.id; o.textContent = acc.label || "账号";
      if (acc.id === s.activeId) o.selected = true;
      select.appendChild(o);
    }
  }
  const acc = accounts.find((a) => a.id === s.activeId) || accounts[0];
  const snap = acc ? s.snapshots[acc.id] : null;

  $("activeHint").textContent = acc ? `当前账号：${acc.label || "账号"}` : "尚未添加账号";
  $("empty").hidden = !!acc;
  $("summary").hidden = !acc || !snap?.result;
  $("packages").hidden = !acc || !snap?.result;
  $("status").textContent = "";
  $("buddyActions").hidden = true;
  $("updated").textContent = "";

  if (!acc) {
    $("remain").textContent = "—";
    $("total").textContent = "—";
    $("pct").textContent = "";
    $("barFill").style.width = "0";
    return;
  }

  if (snap?.authProblem) {
    $("status").innerHTML = '<span class="tag">⚠ 登录已过期，请在官网重新登录后「添加当前账号」</span>';
  } else if (snap?.error) {
    $("status").innerHTML = `<span class="tag">⚠ 拉取失败：${escapeHtml(snap.error)}</span>`;
  }

  const result = snap?.result;
  if (result) {
    $("remain").textContent = fmt(result.remain);
    $("total").textContent = fmt(result.total);
    const pct = result.total > 0 ? (result.remain / result.total) * 100 : 0;
    $("pct").textContent = `${pct.toFixed(1)}%`;
    $("barFill").style.width = `${Math.max(0, Math.min(100, pct))}%`;
    const visible = (result.accounts || [])
      .filter((a) => (parseFloat(a.CycleCapacityRemainPrecise ?? a.CapacityRemainPrecise ?? "0") || 0) > 0)
      .sort((a, b) => parseExpiry(a.CycleEndTime) - parseExpiry(b.CycleEndTime));
    const body = $("packageBody");
    body.innerHTML = "";
    if (!visible.length) {
      body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted)">暂无有余量的套餐</td></tr>';
    } else {
      for (const a of visible.slice(0, 5)) {
        const tr = document.createElement("tr");
        const remain = fmt(parseFloat(a.CycleCapacityRemainPrecise ?? a.CapacityRemainPrecise ?? "0"));
        const size = fmt(parseFloat(a.CycleCapacitySizePrecise ?? a.CapacitySizePrecise ?? "0"));
        tr.innerHTML = `<td title="${escapeHtml(a.PackageName || '')}">${escapeHtml((a.PackageName || "-").slice(0, 18))}</td><td>${remain}</td><td>${size}</td><td>${escapeHtml((a.CycleEndTime || "-").slice(0, 16))}</td>`;
        body.appendChild(tr);
      }
      if (visible.length > 5) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td colspan="4" style="text-align:center;color:var(--muted)">共 ${visible.length} 个，仅显示前 5 条</td>`;
        body.appendChild(tr);
      }
    }
  }

  const tags = [];
  if (s.settings.autoCheckin && snap?.checkin) {
    const c = snap.checkin;
    tags.push(c.state === "claimed" ? "✓ 已签到" : c.state === "unclaimed" ? "○ 未签到" : "⚠ 签到异常");
  }
  if (s.settings.buddyTravel && snap?.buddy?.status) {
    const st = snap.buddy.status;
    if (st.state === "traveling") {
      const remain = Math.max(0, (st.arriveAt || 0) - (st.serverNow || Math.floor(Date.now() / 1000)));
      const hh = String(Math.floor(remain / 3600)).padStart(2, "0");
      const mm = String(Math.floor((remain % 3600) / 60)).padStart(2, "0");
      const ss = String(remain % 60).padStart(2, "0");
      tags.push(`✿ 旅行倒计时 ${hh}:${mm}:${ss}`);
    } else if (st.dailyLimitReached) {
      tags.push("✿ 今日已完成");
    } else {
      tags.push("✿ 可领积分 / 去旅行");
      $("buddyActions").hidden = false;
    }
  }
  if (tags.length) $("status").innerHTML += tags.map((t) => `<span class="tag">${t}</span>`).join("");
  if (snap?.updatedAt) $("updated").textContent = `最近更新 ${fmtTime(snap.updatedAt)}`;

  $("apiBase").value = s.settings.apiBase || "";
  $("refreshInterval").value = s.settings.refreshIntervalMinutes ?? 30;
  $("autoCheckin").checked = !!s.settings.autoCheckin;
  $("buddyTravel").checked = !!s.settings.buddyTravel;
}

$("refreshBtn").addEventListener("click", async () => {
  toast("正在刷新全部账号…");
  const res = await send({ type: "REFRESH" });
  if (res.ok) { currentState = res.state; render(); toast("刷新完成"); }
  else toast(`刷新失败：${res.error || ""}`);
});

$("accountSelect").addEventListener("change", async (e) => {
  const res = await send({ type: "SWITCH", id: e.target.value });
  if (res.ok) { currentState = res.state; render(); toast("已切换账号"); }
  else toast(`切换失败：${res.error || ""}`);
});

$("addBtn").addEventListener("click", async () => {
  toast("正在读取浏览器登录态并验证…");
  const res = await send({ type: "ADD_ACCOUNT" });
  if (res.ok) {
    currentState = res.state; render();
    toast(res.duplicate ? `账号 ${res.label} 已存在，已切换到它（剩余 ${fmt(res.remain)}）` : `账号已添加（剩余 ${fmt(res.remain)}）`);
  } else {
    toast(`添加失败：${res.error || ""}`);
  }
});

$("openSiteBtn").addEventListener("click", async () => {
  await send({ type: "OPEN_USAGE" });
});

$("renameBtn").addEventListener("click", async () => {
  const s = currentState;
  const acc = s?.accounts.find((a) => a.id === s.activeId);
  if (!acc) return;
  const name = prompt("给这个账号起个名字：", acc.label || "");
  if (!name || !name.trim()) return;
  const res = await send({ type: "RENAME_ACCOUNT", id: acc.id, label: name.trim() });
  if (res.ok) { currentState = res.state; render(); }
});

async function buddyAction(type) {
  const res = await send({ type });
  if (res.ok) { if (res.state) currentState = res.state; render(); toast(res.message || "操作完成"); }
  else toast(`操作失败：${res.error || ""}`);
}
$("buddyClaimBtn").addEventListener("click", () => buddyAction("BUDDY_CLAIM"));
$("buddyDepartBtn").addEventListener("click", () => buddyAction("BUDDY_DEPART"));

$("usageBtn").addEventListener("click", () => send({ type: "OPEN_USAGE" }));

$("removeBtn").addEventListener("click", async () => {
  const s = currentState;
  if (!s?.activeId) return;
  if (!confirm("确定从插件里删除这个账号？（只删除插件保存的 Cookie，不影响网站登录）")) return;
  const res = await send({ type: "REMOVE_ACCOUNT", id: s.activeId });
  if (res.ok) { currentState = res.state; render(); toast("账号已删除"); }
});

$("saveSettings").addEventListener("click", async () => {
  const settings = {
    apiBase: $("apiBase").value.trim() || "https://www.codebuddy.cn",
    refreshIntervalMinutes: Number($("refreshInterval").value) || 0,
    autoCheckin: $("autoCheckin").checked,
    buddyTravel: $("buddyTravel").checked,
  };
  const res = await send({ type: "UPDATE_SETTINGS", settings });
  toast(res.ok ? "设置已保存" : `保存失败：${res.error || ""}`);
  if (res.ok) currentState = res.state;
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATE_UPDATED") { currentState = msg.state; render(); }
});

load();
