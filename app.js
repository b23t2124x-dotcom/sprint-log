"use strict";
/*
 * スプリント練習日誌
 * - 記録はこの端末の localStorage にだけ保存する（外部サーバーには送らない）
 * - 外部への通信は Open-Meteo（天気・地名検索）だけ。CSP の connect-src でも制限している
 * - 画面に出す文字列はすべて esc() でエスケープするか textContent で入れる
 */

/* ---------- 共通ユーティリティ ---------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function toHalf(s) {
  return String(s)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ":").replace(/[．。]/g, ".").replace(/[−ー－]/g, "-").replace(/[＋]/g, "+");
}
function parseTime(s) {
  if (s == null) return NaN;
  s = toHalf(s).trim();
  if (!s) return NaN;
  if (s.includes(":")) {
    const [m, r] = s.split(":");
    const v = Number(m) * 60 + Number(r);
    return isFinite(v) && v > 0 ? v : NaN;
  }
  const v = Number(s);
  return isFinite(v) && v > 0 ? v : NaN;
}
function fmt(t, dp = 2) {
  if (!isFinite(t)) return "—";
  const f = Math.pow(10, dp);
  t = Math.round(t * f) / f;
  if (t >= 60) {
    const m = Math.floor(t / 60);
    const r = (t - m * 60).toFixed(dp).padStart(dp + 3, "0");
    return m + ":" + r;
  }
  return t.toFixed(dp);
}
function fmtSigned(x, dp = 2) {
  if (!isFinite(x)) return "—";
  const v = Math.round(x * Math.pow(10, dp)) / Math.pow(10, dp);
  return (v > 0 ? "+" : v < 0 ? "−" : "±") + Math.abs(v).toFixed(dp);
}
function fmtWind(w) { return (w > 0 ? "+" : w < 0 ? "−" : "±") + Math.abs(w).toFixed(1); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
let toastT;
function toast(m) {
  const t = $("#toast");
  t.textContent = m;
  t.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("show"), 2200);
}
function ymd(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function todayStr() { return ymd(new Date()); }
function nowHourStr() { return String(new Date().getHours()).padStart(2, "0") + ":00"; }
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
function chipGroup(el, onChange) {
  el.addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    el.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", c === b ? "true" : "false"));
    if (onChange) onChange(b.dataset.v);
  });
}
function chipVal(el) { const b = el.querySelector('.chip[aria-pressed="true"]'); return b ? b.dataset.v : null; }
function setChip(el, v) { el.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", c.dataset.v === String(v) ? "true" : "false")); }
function handOffset(d) { return d >= 300 ? 0.14 : 0.24; }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function str(v, max) { return typeof v === "string" ? v.slice(0, max) : ""; }
function numIn(v, lo, hi) { return typeof v === "number" && isFinite(v) && v >= lo && v <= hi ? v : null; }

/* ---------- 換算表の補間 ---------- */
function convertAll(dist, t) {
  const ci = TDIST.indexOf(dist);
  if (ci < 0 || !isFinite(t)) return null;
  const n = TABLE.length;
  const col = TABLE.map((r) => r[ci]);
  let i, out = false;
  if (t <= col[0]) { i = 0; out = t < col[0]; }
  else if (t >= col[n - 1]) { i = n - 2; out = t > col[n - 1]; }
  else { i = 0; while (i < n - 2 && col[i + 1] < t) i++; }
  const f = (t - col[i]) / (col[i + 1] - col[i]);
  return { times: TDIST.map((d, j) => TABLE[i][j] + f * (TABLE[i + 1][j] - TABLE[i][j])), out };
}
function convertTo(fromD, t, toD) {
  const r = convertAll(fromD, t);
  if (!r) return null;
  return { t: r.times[TDIST.indexOf(toD)], out: r.out };
}

/* ---------- 風の換算（Mureika） ----------
   100m: t0 = tw * [1.027 - 0.027 * exp(-0.000125 H) * (1 - w*tw/100)^2]
         （Mureika "Back-of-the-envelope wind and altitude correction for 100 metre sprint times" 式13）
   200m: 風は後半の直線だけに効くとみなし、100m式の風の項を半分の時間で計算して1.2倍。
         標高の項は tw*5e-6*H。Mureika (2008) の200m補正表（+1.0で約0.06秒、+2.0で約0.12秒）に合わせた推定式。 */
function toNoWind(ev, tw, w, H) {
  if (ev === 100) return tw * (1.027 - 0.027 * Math.exp(-0.000125 * H) * Math.pow(1 - (w * tw) / 100, 2));
  const h = tw / 2;
  const g = h * 0.027 * (1 - Math.pow(1 - (w * h) / 100, 2));
  return tw + 1.2 * g + tw * 5e-6 * H;
}
function fromNoWind(ev, t0, w, H) { // toNoWind(tw) = t0 を二分法で解く
  let lo = t0 - 3, hi = t0 + 3;
  for (let k = 0; k < 80; k++) {
    const m = (lo + hi) / 2;
    if (toNoWind(ev, m, w, H) < t0) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}

/* ---------- X の文字数（日本語などは2カウント） ---------- */
function xLen(s) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    n += (c <= 4351 || (c >= 8192 && c <= 8205) || (c >= 8208 && c <= 8223) || (c >= 8242 && c <= 8247)) ? 1 : 2;
  }
  return n;
}

/* ---------- 保存（この端末の localStorage） ---------- */
const LS_ENTRIES = "sprintlog.entries.v1";
const LS_LOC = "sprintlog.location.v1";
const LS_BACKUP = "sprintlog.lastBackup.v1";
const LS_POST = "sprintlog.postprefs.v1";
const S = { entries: [] };

const TYPES = ["スプリント", "加速走", "テンポ走", "スタート練", "ウエイト", "試合", "休養", "その他"];
const WEATHER = ["晴れ", "くもり", "雨", "雪", "室内"];
const COND = [["◎", "絶好調"], ["○", "良い"], ["△", "いまいち"], ["×", "不調"]];
const DISTS = [30, 50, 60, 80, 100, 120, 150, 200, 250, 300, 400];

// 読み込んだデータ（端末に保存済みのものもバックアップファイルも）は必ずここを通して形と範囲をそろえる
function sanitizeEntry(e) {
  if (!e || typeof e !== "object") return null;
  if (typeof e.id !== "string" || !/^e[a-z0-9]{4,40}$/.test(e.id)) return null;
  if (typeof e.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return null;
  const menu = Array.isArray(e.menu) ? e.menu.slice(0, 50).map((m) => {
    if (!m || typeof m !== "object") return null;
    const dist = numIn(m.dist, 1, 50000);
    if (dist == null) return null;
    const reps = numIn(m.reps, 1, 20) || 1, sets = numIn(m.sets, 1, 6) || 1;
    const times = Array.isArray(m.times) ? m.times.slice(0, 120).map((t) => numIn(t, 0.01, 36000)) : [];
    return { dist, reps: Math.round(reps), sets: Math.round(sets), rest: str(m.rest, 6), setRest: str(m.setRest, 6), timing: m.timing === "elec" ? "elec" : "hand", times, note: str(m.note, 100) };
  }).filter(Boolean) : [];
  let wx = null;
  if (e.wx && typeof e.wx === "object") {
    wx = { temp: numIn(e.wx.temp, -60, 60), hum: numIn(e.wx.hum, 0, 100), code: numIn(e.wx.code, 0, 99), ws: numIn(e.wx.ws, 0, 100), wd: numIn(e.wx.wd, 0, 360), at: str(e.wx.at, 16), place: str(e.wx.place, 60) };
  }
  return {
    id: e.id, date: e.date, time: typeof e.time === "string" && /^\d{2}:\d{2}$/.test(e.time) ? e.time : "",
    types: Array.isArray(e.types) ? e.types.filter((t) => TYPES.includes(t)) : [],
    menu, weather: WEATHER.includes(e.weather) ? e.weather : "",
    temp: str(e.temp, 6), wind: str(e.wind, 80), windAuto: e.windAuto === true, wx,
    rpe: numIn(e.rpe, 1, 10) || 6, cond: COND.some(([k]) => k === e.cond) ? e.cond : "",
    body: str(e.body, 5000), post: str(e.post, 5000), postManual: e.postManual === true,
    createdAt: numIn(e.createdAt, 0, 1e14) || 0, updatedAt: numIn(e.updatedAt, 0, 1e14) || 0,
  };
}
function loadEntries() {
  const raw = lsGet(LS_ENTRIES, []);
  S.entries = Array.isArray(raw) ? raw.map(sanitizeEntry).filter(Boolean) : [];
}
function persist() {
  if (!lsSet(LS_ENTRIES, S.entries)) { toast("保存できませんでした。端末の空き容量を確認してください"); return false; }
  return true;
}
function saveEntry(e) {
  const clean = sanitizeEntry(Object.assign({}, e, { updatedAt: Date.now() }));
  if (!clean) { toast("保存できませんでした"); return false; }
  const i = S.entries.findIndex((x) => x.id === clean.id);
  if (i >= 0) S.entries[i] = clean; else S.entries.push(clean);
  const ok = persist();
  renderLog();
  return ok;
}
function deleteEntry(id) { S.entries = S.entries.filter((x) => x.id !== id); persist(); renderLog(); }

/* ---------- 天気（Open-Meteo） ---------- */
const WMO = (c) => {
  if (c === 0) return ["快晴", "晴れ"];
  if (c === 1 || c === 2) return ["晴れ", "晴れ"];
  if (c === 3) return ["くもり", "くもり"];
  if (c === 45 || c === 48) return ["霧", "くもり"];
  if ((c >= 51 && c <= 57)) return ["霧雨", "雨"];
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return ["雨", "雨"];
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return ["雪", "雪"];
  if (c >= 95) return ["雷雨", "雨"];
  return ["—", ""];
};
const DIR16 = ["北", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東", "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西"];
function dirName(d) { return DIR16[Math.round(d / 22.5) % 16]; }
function getLoc() {
  const l = lsGet(LS_LOC, null);
  if (!l || typeof l !== "object") return null;
  const lat = numIn(l.lat, -90, 90), lon = numIn(l.lon, -180, 180);
  if (lat == null || lon == null) return null;
  return { lat, lon, name: str(l.name, 60) || "設定した場所" };
}
function setLoc(lat, lon, name) {
  // 約1kmの精度に丸める
  lsSet(LS_LOC, { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100, name: String(name).slice(0, 60) });
  renderLoc();
}
async function getJSON(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(url, { signal: ctl.signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    if (!r.ok) throw new Error("http " + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}
async function fetchWeather(date, time, loc) {
  const today = new Date(todayStr() + "T00:00:00");
  const day = new Date(date + "T00:00:00");
  const diff = Math.round((today - day) / 86400000); // 何日前か
  if (diff < -14) throw new Error("future");
  const base = diff > 85 ? "https://archive-api.open-meteo.com/v1/archive" : "https://api.open-meteo.com/v1/forecast";
  const q = new URLSearchParams({
    latitude: loc.lat.toFixed(2), longitude: loc.lon.toFixed(2),
    hourly: "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m",
    wind_speed_unit: "ms", timezone: "Asia/Tokyo", start_date: date, end_date: date,
  });
  const j = await getJSON(base + "?" + q.toString());
  const h = j && j.hourly;
  if (!h || !Array.isArray(h.time)) throw new Error("format");
  const hh = (time || "12:00").slice(0, 2);
  const idx = h.time.indexOf(date + "T" + hh + ":00");
  if (idx < 0) throw new Error("nodata");
  const pick = (k, lo, hi) => (Array.isArray(h[k]) ? numIn(h[k][idx], lo, hi) : null);
  const wx = { temp: pick("temperature_2m", -60, 60), hum: pick("relative_humidity_2m", 0, 100), code: pick("weather_code", 0, 99), ws: pick("wind_speed_10m", 0, 100), wd: pick("wind_direction_10m", 0, 360), at: date + " " + hh + ":00", place: loc.name };
  if (wx.temp == null && wx.code == null && wx.ws == null) throw new Error("nodata");
  return wx;
}
function wxText(wx) {
  if (!wx) return "";
  const parts = [];
  if (wx.code != null) parts.push(WMO(wx.code)[0]);
  if (wx.temp != null) parts.push(wx.temp.toFixed(1) + "℃");
  if (wx.ws != null) parts.push((wx.wd != null ? dirName(wx.wd) + "の風 " : "風 ") + wx.ws.toFixed(1) + "m/s");
  if (wx.hum != null) parts.push("湿度" + Math.round(wx.hum) + "%");
  return parts.join("・");
}
function applyWx(wx) {
  F.wx = wx;
  if (wx.code != null && WMO(wx.code)[1]) { F.weather = WMO(wx.code)[1]; setChip($("#fWeather"), F.weather); }
  if (wx.temp != null) { F.temp = wx.temp.toFixed(1); $("#fTemp").value = F.temp; }
  if (wx.ws != null && (!F.wind || F.windAuto)) {
    F.wind = (wx.wd != null ? dirName(wx.wd) + "の風 " : "風 ") + wx.ws.toFixed(1) + "m/s";
    F.windAuto = true;
    $("#fWind").value = F.wind;
  }
  renderWxStatus();
  updatePost();
}
function renderWxStatus() {
  const s = $("#wxStatus");
  if (F && F.wx) {
    const [d, t] = F.wx.at.split(" ");
    const dd = d ? new Date(d + "T00:00:00") : null;
    s.textContent = "取得済み：" + (dd ? (dd.getMonth() + 1) + "/" + dd.getDate() + " " : "") + (t ? Number(t.slice(0, 2)) + "時 " : "") + F.wx.place + "　" + wxText(F.wx);
  } else if (getLoc()) {
    s.textContent = "場所：" + getLoc().name + "。保存するときにも自動で取得します。";
  } else {
    s.textContent = "「記録」タブの下で場所を設定すると、天気を自動で取得できます。";
  }
}
async function doWeather(silent) {
  const loc = getLoc();
  if (!loc) { if (!silent) { toast("先に場所を設定してください"); location.hash = "log"; setTimeout(() => $("#geoBtn").scrollIntoView({ block: "center" }), 50); } return false; }
  readForm();
  const btn = $("#wxBtn");
  btn.disabled = true; btn.textContent = "取得中…";
  try {
    const wx = await fetchWeather(F.date, F.time, loc);
    applyWx(wx);
    if (!silent) toast("天気を取得しました");
    return true;
  } catch (e) {
    const m = e && e.message === "future" ? "その日付の天気はまだ取得できません" :
      e && e.message === "nodata" ? "その日時の天気データがありませんでした" :
      e && e.name === "AbortError" ? "天気の取得に時間がかかりすぎました。電波の良い所で試してください" :
      "天気を取得できませんでした。通信状態を確認してください";
    if (!silent) toast(m);
    return false;
  } finally { btn.disabled = false; btn.textContent = "天気を自動で取得"; }
}

/* ---------- 日記フォーム ---------- */
let F = null; // 編集中の日記
function newId() {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return "e" + Date.now().toString(36) + a[0].toString(36) + a[1].toString(36);
}
function blankEntry() {
  return { id: newId(), date: todayStr(), time: nowHourStr(), types: ["スプリント"], menu: [], weather: "", temp: "", wind: "", windAuto: false, wx: null, rpe: 6, cond: "", body: "", post: "", postManual: false, createdAt: Date.now(), updatedAt: 0 };
}
const M = { dist: 150, reps: 3, sets: 1, timing: "hand" };

function buildDiary() {
  const ft = $("#fType");
  ft.innerHTML = TYPES.map((t) => `<button type="button" class="chip" data-v="${esc(t)}" aria-pressed="false">${esc(t)}</button>`).join("");
  ft.addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    const v = b.dataset.v, i = F.types.indexOf(v);
    if (i >= 0) F.types.splice(i, 1); else F.types.push(v);
    b.setAttribute("aria-pressed", i >= 0 ? "false" : "true");
    updatePost();
  });
  const fw = $("#fWeather");
  fw.innerHTML = WEATHER.map((t) => `<button type="button" class="chip" data-v="${esc(t)}" aria-pressed="false">${esc(t)}</button>`).join("");
  fw.addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    F.weather = F.weather === b.dataset.v ? "" : b.dataset.v;
    setChip(fw, F.weather);
    updatePost();
  });
  const fc = $("#fCond");
  fc.innerHTML = COND.map(([k, l]) => `<button type="button" class="chip" data-v="${esc(k)}" aria-pressed="false">調子 ${esc(k)} ${esc(l)}</button>`).join("");
  fc.addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    F.cond = F.cond === b.dataset.v ? "" : b.dataset.v;
    setChip(fc, F.cond);
    updatePost();
  });
  const md = $("#mDist");
  md.innerHTML = DISTS.map((d) => `<button type="button" class="chip num" data-v="${d}" aria-pressed="${d === 150}">${d}m</button>`).join("");
  chipGroup(md, (v) => { M.dist = Number(v); $("#mDistIn").value = v; });
  $("#mDistIn").addEventListener("input", (e) => { M.dist = Number(toHalf(e.target.value)) || 0; setChip(md, M.dist); });
  $$("[data-step]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.step;
    M[k] = Math.max(1, Math.min(k === "reps" ? 20 : 6, M[k] + Number(b.dataset.d)));
    $("#mReps").textContent = M.reps;
    $("#mSets").textContent = M.sets;
    renderTimeInputs();
  }));
  chipGroup($("#mTiming"), (v) => { M.timing = v; });
  $("#mAdd").addEventListener("click", addMenu);
  ["fDate", "fTime", "fTemp", "fBody"].forEach((id) => $("#" + id).addEventListener("input", readForm));
  $("#fWind").addEventListener("input", () => { F.windAuto = false; readForm(); });
  $("#fRpe").addEventListener("input", (e) => { $("#fRpeV").textContent = e.target.value; readForm(); });
  $("#wxBtn").addEventListener("click", () => doWeather(false));
  $("#pOpts").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true");
    savePostPrefs();
    updatePost();
  });
  $("#pTags").addEventListener("input", () => { savePostPrefs(); updatePost(); });
  $("#pText").addEventListener("input", () => {
    F.postManual = true; F.post = $("#pText").value; $("#pReset").hidden = false; updateCount(); updateXLink();
  });
  $("#pReset").addEventListener("click", () => { F.postManual = false; updatePost(); });
  $("#saveBtn").addEventListener("click", async () => {
    readForm();
    if (!F.wx && getLoc()) await doWeather(true);
    if (saveEntry(F)) { toast("保存しました"); $("#formTitle").textContent = "練習を編集"; }
  });
  // X のリンクはクリック時点の文で開く（天気の取得は待たない：ポップアップがブロックされないように）
  $("#xBtn").addEventListener("click", () => {
    readForm(); updateXLink();
    if (saveEntry(F)) $("#formTitle").textContent = "練習を編集";
  });
  $("#copyBtn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#pText").value); toast("コピーしました"); }
    catch (e) { $("#pText").select(); toast("選択しました。長押しでコピーしてください"); }
  });
  $("#newBtn").addEventListener("click", () => { loadForm(blankEntry()); window.scrollTo(0, 0); });
  const pp = lsGet(LS_POST, null);
  if (pp && typeof pp === "object") {
    $$("#pOpts .chip").forEach((c) => { if (typeof pp[c.dataset.k] === "boolean") c.setAttribute("aria-pressed", pp[c.dataset.k] ? "true" : "false"); });
    if (typeof pp.tags === "string") $("#pTags").value = pp.tags.slice(0, 100);
  }
  renderTimeInputs();
}
function savePostPrefs() {
  const o = { tags: $("#pTags").value };
  $$("#pOpts .chip").forEach((c) => { o[c.dataset.k] = c.getAttribute("aria-pressed") === "true"; });
  lsSet(LS_POST, o);
}
function renderTimeInputs() {
  const old = $$("#mTimes input").map((i) => i.value);
  let h = "";
  for (let s = 0; s < M.sets; s++) for (let r = 0; r < M.reps; r++) {
    const k = s * M.reps + r;
    const lab = (M.sets > 1 ? (s + 1) + "-" : "") + (r + 1) + "本目";
    h += `<label><b>${lab}</b><input class="num" inputmode="decimal" maxlength="8" id="mt${k}" aria-label="${M.sets > 1 ? (s + 1) + "セット目" : ""}${r + 1}本目のタイム" value="${esc(old[k] || "")}"></label>`;
  }
  $("#mTimes").innerHTML = h;
  $("#mSetRestWrap").hidden = M.sets < 2;
}
function addMenu() {
  const dist = Number(toHalf($("#mDistIn").value));
  if (!(dist > 0 && dist <= 50000)) { toast("距離を入れてください"); return; }
  const times = $$("#mTimes input").map((i) => { const v = parseTime(i.value); return isFinite(v) ? Math.round(v * 100) / 100 : null; });
  F.menu.push({ dist, reps: M.reps, sets: M.sets, rest: toHalf($("#mRest").value).trim().slice(0, 6), setRest: M.sets > 1 ? toHalf($("#mSetRest").value).trim().slice(0, 6) : "", timing: M.timing, times, note: $("#mNote").value.trim().slice(0, 100) });
  $$("#mTimes input").forEach((i) => { i.value = ""; });
  $("#mNote").value = "";
  renderMenuList();
  updatePost();
}
function menuLine(m) {
  let s = `${m.dist}m×${m.reps}${m.sets > 1 ? "×" + m.sets : ""}`;
  const rest = [m.rest ? "R" + m.rest + "分" : "", m.setRest ? "SR" + m.setRest + "分" : ""].filter(Boolean).join("/");
  if (rest) s += `（${rest}）`;
  const ts = (m.times || []).filter((t) => t != null);
  if (ts.length) {
    const dp = m.timing === "hand" ? 1 : 2;
    s += " " + (m.times || []).map((t) => (t == null ? "–" : fmt(t, dp))).join("/").replace(/(\/–)+$/, "");
    if (m.timing === "hand") s += "（手）";
  }
  if (m.note) s += " " + m.note;
  return s;
}
function renderMenuList() {
  $("#menuList").innerHTML = F.menu.map((m, i) => `<div class="menuitem"><span class="t num">${esc(menuLine(m))}</span><button type="button" class="btn small" data-mi="${i}" data-act="up" aria-label="上へ" ${i === 0 ? "disabled" : ""}>↑</button><button type="button" class="btn small danger" data-mi="${i}" data-act="del">削除</button></div>`).join("") || `<p class="hint">追加したメニューがここに並びます。</p>`;
  $$("#menuList [data-mi]").forEach((b) => b.addEventListener("click", () => {
    const i = Number(b.dataset.mi);
    if (b.dataset.act === "del") F.menu.splice(i, 1);
    else if (i > 0) { const t = F.menu[i - 1]; F.menu[i - 1] = F.menu[i]; F.menu[i] = t; }
    renderMenuList();
    updatePost();
  }));
}
function readForm() {
  const prevKey = F.date + " " + F.time;
  F.date = /^\d{4}-\d{2}-\d{2}$/.test($("#fDate").value) ? $("#fDate").value : todayStr();
  F.time = /^\d{2}:\d{2}$/.test($("#fTime").value) ? $("#fTime").value : "";
  if (F.wx && prevKey !== F.date + " " + F.time) { F.wx = null; renderWxStatus(); } // 日時を変えたら天気は取り直す
  F.temp = $("#fTemp").value.trim().slice(0, 6);
  F.wind = $("#fWind").value.trim().slice(0, 80);
  F.body = $("#fBody").value.slice(0, 5000);
  F.rpe = Number($("#fRpe").value);
  updatePost();
}
function loadForm(e) {
  F = clone(e);
  $("#fDate").value = F.date; $("#fTime").value = F.time || ""; $("#fTemp").value = F.temp || ""; $("#fWind").value = F.wind || "";
  $("#fBody").value = F.body || ""; $("#fRpe").value = F.rpe || 6; $("#fRpeV").textContent = F.rpe || 6;
  $$("#fType .chip").forEach((c) => c.setAttribute("aria-pressed", F.types.includes(c.dataset.v) ? "true" : "false"));
  setChip($("#fWeather"), F.weather);
  setChip($("#fCond"), F.cond);
  $("#formTitle").textContent = S.entries.some((x) => x.id === F.id) ? "練習を編集" : "今日の練習";
  renderMenuList();
  renderWxStatus();
  updatePost();
}
function opt(k) { const c = $(`#pOpts .chip[data-k="${k}"]`); return c && c.getAttribute("aria-pressed") === "true"; }
function autoPost() {
  const d = new Date(F.date + "T00:00:00");
  const wd = "日月火水木金土"[d.getDay()];
  const L = [`${d.getMonth() + 1}/${d.getDate()}(${wd}) 練習${F.types.length ? "【" + F.types.join("・") + "】" : ""}`];
  if (opt("menu") && F.menu.length) L.push(F.menu.map(menuLine).join("\n"));
  if (opt("cond")) {
    const c = [F.weather, F.temp ? F.temp + "℃" : "", F.wind, F.cond ? "調子" + F.cond : "", F.rpe ? "RPE" + F.rpe : ""].filter(Boolean).join(" ");
    if (c) L.push(c);
  }
  if (opt("body") && F.body.trim()) L.push(F.body.trim());
  if (opt("tags") && $("#pTags").value.trim()) L.push($("#pTags").value.trim());
  return L.join("\n\n");
}
function updatePost() {
  if (!F.postManual) { F.post = autoPost(); $("#pText").value = F.post; $("#pReset").hidden = true; }
  else { $("#pText").value = F.post; $("#pReset").hidden = false; }
  updateCount();
  updateXLink();
}
function updateCount() {
  const n = xLen($("#pText").value);
  const c = $("#pCount");
  c.textContent = n + " / 280" + (n > 280 ? "　長すぎます" : "");
  c.classList.toggle("over", n > 280);
}
function xUrl(text) { return "https://x.com/intent/post?text=" + encodeURIComponent(text); }
function updateXLink() { $("#xBtn").href = xUrl($("#pText").value); }

/* ---------- 記録一覧 ---------- */
let pendingDel = null;
function renderLog() {
  const es = S.entries.slice().sort((a, b) => b.date.localeCompare(a.date) || (b.time || "").localeCompare(a.time || "") || b.createdAt - a.createdAt);
  // まとめ
  const mon = new Date(); mon.setHours(0, 0, 0, 0); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  const monS = ymd(mon);
  const wk = es.filter((e) => e.date >= monS && !(e.types.length && e.types.every((t) => t === "休養")));
  $("#sWeek").textContent = new Set(wk.map((e) => e.date)).size;
  $("#sDist").textContent = wk.reduce((s, e) => s + e.menu.reduce((a, m) => a + m.dist * m.reps * m.sets, 0), 0).toLocaleString();
  $("#sTotal").textContent = new Set(es.map((e) => e.date)).size;
  // ベスト
  const best = {};
  es.forEach((e) => e.menu.forEach((m) => m.times.forEach((t) => {
    if (t == null) return;
    const k = m.dist, kk = m.timing === "hand" ? "hand" : "elec";
    best[k] = best[k] || { elec: null, hand: null };
    if (!best[k][kk] || t < best[k][kk].t) best[k][kk] = { t, date: e.date };
  })));
  const ks = Object.keys(best).map(Number).sort((a, b) => a - b);
  const cell = (x, dp) => (x ? `<span class="num lg">${fmt(x.t, dp)}</span><br><span class="hint">${esc(x.date.slice(5).replace("-", "/"))}</span>` : "—");
  $("#bestTable tbody").innerHTML = ks.map((k) => `<tr><td class="num">${k}m</td><td>${cell(best[k].elec, 2)}</td><td>${cell(best[k].hand, 1)}</td></tr>`).join("");
  $("#bestEmpty").hidden = ks.length > 0;
  $("#bestTable").hidden = ks.length === 0;
  // 一覧
  $("#entryList").innerHTML = es.length ? es.map((e) => {
    const d = new Date(e.date + "T00:00:00");
    const meta = [e.wx ? wxText(e.wx) : [e.weather, e.temp ? e.temp + "℃" : "", e.wind].filter(Boolean).join(" "), e.cond ? "調子" + e.cond : "", "RPE " + e.rpe].filter(Boolean).join("　");
    return `<div class="entry"><div class="head"><span class="date">${d.getMonth() + 1}/${d.getDate()}</span><span class="hint">${"日月火水木金土"[d.getDay()]}曜${e.time ? " " + esc(e.time) : ""}</span>${e.types.map((t) => `<span class="pill${t === "試合" ? " pb" : ""}">${esc(t)}</span>`).join("")}</div>
      ${e.menu.length ? `<div class="menu num">${e.menu.map((m) => esc(menuLine(m))).join("<br>")}</div>` : ""}
      ${meta ? `<div class="hint">${esc(meta)}</div>` : ""}
      ${e.body ? `<div class="body">${esc(e.body)}</div>` : ""}
      <div class="row"><button type="button" class="btn small" data-edit="${esc(e.id)}">編集</button><a class="btn small" href="${esc(xUrl(e.post || ""))}" target="_blank" rel="noopener noreferrer">Xでポスト</a><button type="button" class="btn small danger" data-del="${esc(e.id)}">${pendingDel === e.id ? "本当に削除する" : "削除"}</button></div></div>`;
  }).join("") : `<p class="hint">まだ記録がありません。「日記」タブで練習を書いて保存すると、ここに並びます。</p>`;
  $$("[data-edit]").forEach((b) => b.addEventListener("click", () => {
    const e = S.entries.find((x) => x.id === b.dataset.edit);
    if (e) { loadForm(e); location.hash = "diary"; window.scrollTo(0, 0); }
  }));
  $$("[data-del]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.del;
    if (pendingDel === id) { pendingDel = null; deleteEntry(id); toast("削除しました"); }
    else {
      pendingDel = id; renderLog();
      setTimeout(() => { if (pendingDel === id) { pendingDel = null; renderLog(); } }, 4000);
    }
  }));
  renderBackupInfo();
}

/* ---------- 場所の設定 ---------- */
function renderLoc() {
  const l = getLoc();
  $("#locNow").textContent = l ? "現在の設定：" + l.name + "（" + l.lat.toFixed(2) + ", " + l.lon.toFixed(2) + "）" : "未設定";
  if (F) renderWxStatus();
}
function buildLoc() {
  $("#geoBtn").addEventListener("click", () => {
    if (!navigator.geolocation) { toast("この端末では現在地を使えません。地名で探してください"); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { setLoc(p.coords.latitude, p.coords.longitude, "現在地"); toast("場所を設定しました"); },
      () => toast("現在地を取得できませんでした。地名で探してください"),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
    );
  });
  const search = async () => {
    const q = $("#locQ").value.trim().slice(0, 40);
    if (!q) return;
    const box = $("#locResults");
    box.textContent = "検索中…";
    try {
      const j = await getJSON("https://geocoding-api.open-meteo.com/v1/search?" + new URLSearchParams({ name: q, count: "6", language: "ja", format: "json" }).toString());
      const rs = (j && Array.isArray(j.results) ? j.results : []).filter((r) => numIn(r.latitude, -90, 90) != null && numIn(r.longitude, -180, 180) != null);
      box.textContent = "";
      if (!rs.length) { box.textContent = "見つかりませんでした。別の書き方で試してください（例：鳥取）"; return; }
      rs.forEach((r) => {
        // 外部からの文字列は textContent で入れる
        const b = document.createElement("button");
        b.type = "button"; b.className = "btn small locitem";
        const name = [r.name, r.admin1, r.country].filter((x) => typeof x === "string" && x).join("・").slice(0, 60);
        b.textContent = name;
        b.addEventListener("click", () => { setLoc(r.latitude, r.longitude, String(r.name || name).slice(0, 60)); box.textContent = ""; toast("場所を設定しました"); });
        box.appendChild(b);
      });
    } catch (e) { box.textContent = "検索できませんでした。通信状態を確認してください"; }
  };
  $("#locSearch").addEventListener("click", search);
  $("#locQ").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } });
  renderLoc();
}

/* ---------- バックアップ ---------- */
function renderBackupInfo() {
  const last = numIn(lsGet(LS_BACKUP, null), 0, 1e14);
  $("#lastBackup").textContent = last ? "最後に書き出した日：" + new Date(last).toLocaleDateString("ja-JP") : "まだ書き出していません";
  const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
  const warn = S.entries.length >= 3 && (days == null || days >= 14);
  $("#backupWarn").hidden = !warn;
  if (warn) $("#backupWarnText").textContent = (days == null ? "まだ一度もバックアップしていません。" : "最後のバックアップから" + days + "日たっています。") + "ブラウザのデータが消えると記録も消えるので、ときどきファイルに書き出してください。";
}
function exportData() {
  const data = { app: "sprint-log", version: 1, exportedAt: new Date().toISOString(), entries: S.entries };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "sprint-log-" + todayStr() + ".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  lsSet(LS_BACKUP, Date.now());
  renderBackupInfo();
  toast("書き出しました");
}
function importData(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast("ファイルが大きすぎます（5MBまで）"); return; }
  const rd = new FileReader();
  rd.onload = () => {
    let j;
    try { j = JSON.parse(String(rd.result)); } catch (e) { toast("このアプリのバックアップファイルではありません"); return; }
    if (!j || j.app !== "sprint-log" || !Array.isArray(j.entries)) { toast("このアプリのバックアップファイルではありません"); return; }
    const inc = j.entries.slice(0, 20000).map(sanitizeEntry).filter(Boolean);
    let add = 0, upd = 0;
    inc.forEach((e) => {
      const i = S.entries.findIndex((x) => x.id === e.id);
      if (i < 0) { S.entries.push(e); add++; }
      else if ((e.updatedAt || 0) > (S.entries[i].updatedAt || 0)) { S.entries[i] = e; upd++; }
    });
    persist();
    renderLog();
    toast("読み込みました（新規 " + add + " 件・更新 " + upd + " 件）");
  };
  rd.onerror = () => toast("ファイルを読めませんでした");
  rd.readAsText(file);
}
function buildBackup() {
  $("#exportBtn").addEventListener("click", exportData);
  $("#exportBtn2").addEventListener("click", exportData);
  $("#importFile").addEventListener("change", (e) => { importData(e.target.files && e.target.files[0]); e.target.value = ""; });
}

/* ---------- 換算タブ ---------- */
function fillDistSelect(el, val) { el.innerHTML = TDIST.map((d) => `<option value="${d}" ${d === val ? "selected" : ""}>${d}m</option>`).join(""); }
function renderConvert() {
  const d = Number($("#cDist").value);
  let t = parseTime($("#cTime").value);
  const hand = chipVal($("#cTiming")) === "hand";
  $("#cHandRow").hidden = !hand;
  $("#cHandResult").hidden = !hand;
  if (hand) {
    const off = Number(toHalf($("#cOffset").value)) || 0;
    const te = t + off;
    $("#cHandResult").innerHTML = isFinite(t) ? `<span class="sub">電気計時に換算</span><span class="big num">${fmt(te)}</span><span class="sub">手動 ${fmt(t, 1)} ＋ ${off.toFixed(2)}秒</span>` : "";
    t = te;
  }
  const r = convertAll(d, t);
  if (!r) { $("#cTable tbody").innerHTML = ""; $("#cNote").textContent = "タイムを入れてください（例：11.20、1:05.30）"; return; }
  $("#cTable tbody").innerHTML = r.times.map((x, j) => `<tr class="${TDIST[j] === d ? "me" : ""}"><td class="num">${TDIST[j]}m</td><td class="num">${fmt(x)}</td><td>${(TDIST[j] / x).toFixed(2)} m/s</td></tr>`).join("");
  $("#cNote").textContent = r.out ? "換算表の範囲（100mで10.00〜16.00秒相当）の外なので、端の傾きで延ばした推定値です。" : "電気計時の相当タイムです。";
}
function buildConvert() {
  fillDistSelect($("#cDist"), 100);
  chipGroup($("#cTiming"), () => { $("#cOffset").value = handOffset(Number($("#cDist").value)).toFixed(2); renderConvert(); });
  $("#cDist").addEventListener("change", () => { $("#cOffset").value = handOffset(Number($("#cDist").value)).toFixed(2); renderConvert(); });
  ["cTime", "cOffset"].forEach((id) => $("#" + id).addEventListener("input", renderConvert));
}

/* ---------- 風タブ ---------- */
function parseWind(s) { const v = Number(toHalf(s).trim().replace("±", "")); return isFinite(v) ? v : NaN; }
function buildWind() {
  chipGroup($("#wEvent"), renderWind);
  chipGroup($("#wMode"), renderWind);
  $("#wQuick").innerHTML = [-2, -1, 0, 1, 2, 3].map((w) => `<button type="button" class="chip num" data-w="${w}">${fmtWind(w)}</button>`).join("");
  $("#wQuick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-w]");
    if (!b) return;
    const w = Number(b.dataset.w);
    $("#wWind").value = (w > 0 ? "+" : "") + w.toFixed(1);
    renderWind();
  });
  ["wTime", "wWind", "wAlt"].forEach((id) => $("#" + id).addEventListener("input", renderWind));
}
function renderWind() {
  const ev = Number(chipVal($("#wEvent")));
  const mode = chipVal($("#wMode"));
  const t = parseTime($("#wTime").value);
  const w = parseWind($("#wWind").value);
  const H = Math.max(0, Math.min(4000, Number(toHalf($("#wAlt").value)) || 0));
  $("#wTimeLabel").textContent = mode === "to0" ? "記録（風あり）" : "無風でのタイム";
  if (!isFinite(t) || !isFinite(w) || Math.abs(w) > 10) {
    $("#wResult").innerHTML = ""; $("#wTable tbody").innerHTML = ""; $("#wNote").textContent = "タイムと風速（−10〜+10）を入れてください。";
    return;
  }
  const t0 = mode === "to0" ? toNoWind(ev, t, w, H) : t; // 無風・海抜0mのタイム
  const legal = w <= 2.0 ? `<span class="pill ok">公認（+2.0以下）</span>` : `<span class="pill pb">追い風参考</span>`;
  if (mode === "to0") {
    $("#wResult").innerHTML = `<span class="sub">無風なら</span><span class="big num">${fmt(t0)}</span><span class="sub">差 ${fmtSigned(t0 - t)}秒</span>${legal}`;
  } else {
    const tw = fromNoWind(ev, t, w, H);
    $("#wResult").innerHTML = `<span class="sub">風速 ${fmtWind(w)} なら</span><span class="big num">${fmt(tw)}</span><span class="sub">差 ${fmtSigned(tw - t)}秒</span>${legal}`;
  }
  const ws = [-3, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3];
  $("#wTable tbody").innerHTML = ws.map((x) => {
    const tx = fromNoWind(ev, t0, x, H);
    return `<tr class="${Math.abs(x - w) < 1e-9 ? "me" : ""}"><td class="num">${fmtWind(x)}</td><td class="num">${fmt(tx)}</td><td>${fmtSigned(tx - t)}</td></tr>`;
  }).join("");
  $("#wNote").textContent = (ev === 100
    ? "100mはMureikaの補正式（風速と標高から無風・海抜0mのタイムを推定）を使っています。トップ選手の+2.0m/sでおよそ0.10秒の差になる式です。"
    : "200mは風が後半の直線だけに効くとして、Mureika (2008) の200m補正表に合うようにした推定式です。100mより誤差が大きめです。")
    + " どちらも目安の値です。表は「同じ走りを別の風で走ったら」のタイムです。";
}

/* ---------- 設定タイム ---------- */
function buildPace() {
  fillDistSelect($("#pBaseDist"), 100);
  fillDistSelect($("#pDist"), 150);
  chipGroup($("#pTiming"), renderPace);
  ["pBaseDist", "pDist"].forEach((id) => $("#" + id).addEventListener("change", renderPace));
  ["pBaseTime", "pPct"].forEach((id) => $("#" + id).addEventListener("input", renderPace));
}
function renderPace() {
  const bd = Number($("#pBaseDist").value), d = Number($("#pDist").value);
  const bt = parseTime($("#pBaseTime").value), pct = Number(toHalf($("#pPct").value));
  const hand = chipVal($("#pTiming")) === "hand";
  const r = convertTo(bd, bt, d);
  if (!r) { $("#pResult").innerHTML = ""; $("#pTable tbody").innerHTML = ""; $("#pNote").textContent = "基準タイムを入れてください。"; return; }
  const off = hand ? handOffset(d) : 0;
  const at = (p) => r.t / (p / 100) - off;
  $("#pResult").innerHTML = isFinite(pct) && pct > 0 && pct <= 120
    ? `<span class="sub">${d}m を ${fmt(pct, pct % 1 ? 1 : 0)}% で</span><span class="big num">${fmt(at(pct), hand ? 1 : 2)}</span><span class="sub">${hand ? "手動計時の目安（−" + off.toFixed(2) + "秒）" : "電気計時"}</span>`
    : "";
  $("#pTable tbody").innerHTML = [100, 97, 95, 92, 90, 85, 80, 75, 70].map((p) => `<tr class="${p === pct ? "me" : ""}"><td class="num">${p}%</td><td class="num">${fmt(at(p), hand ? 1 : 2)}</td><td>${(d / (r.t / (p / 100))).toFixed(2)} m/s</td></tr>`).join("");
  $("#pNote").textContent = `${bd}m ${fmt(bt)} は ${d}m で ${fmt(r.t)}（電計）に相当します（距離換算表より）。` + (r.out ? " 基準タイムが換算表の範囲外のため推定値です。" : "");
}

/* ---------- 画面切り替え ---------- */
const VIEWS = ["diary", "log", "convert", "wind", "pace"];
function route() {
  const h = location.hash.replace("#", "");
  const v = VIEWS.includes(h) ? h : "diary";
  VIEWS.forEach((x) => $("#v-" + x).classList.toggle("on", x === v));
  $$("nav.tabs a").forEach((a) => { if (a.dataset.v === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
}

/* ---------- 起動 ---------- */
loadEntries();
buildDiary(); buildConvert(); buildWind(); buildPace(); buildLoc(); buildBackup();
loadForm(blankEntry());
renderConvert(); renderWind(); renderPace(); renderLog();
window.addEventListener("hashchange", route);
route();
// ブラウザにデータを消されにくくする（対応ブラウザのみ）
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
// オフラインでも開けるようにする
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
