"use strict";
/*
 * インターバルタイマー
 * - 時間は「スタートしてからの経過時間」で管理する（画面が裏に回っても時間がずれない）
 * - 音は Web Audio で、先の合図までまとめて予約して鳴らす（タイマー処理の遅れに左右されない）
 * - 設定とプリセットはこの端末の localStorage にだけ保存する
 */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
let toastT;
function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2000); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

/* ---------- 設定 ---------- */
const LS_CFG = "sprinttimer.config.v1";
const LS_PRESETS = "sprinttimer.presets.v1";
const LIMITS = { work: [1, 3600], rest: [0, 3600], rounds: [1, 99], sets: [1, 20], setRest: [0, 3600], prep: [0, 60] };
const BUILTIN = [
  { name: "タバタ 20/10×8", work: 20, rest: 10, rounds: 8, sets: 1, setRest: 60, prep: 10 },
  { name: "30/30×10", work: 30, rest: 30, rounds: 10, sets: 1, setRest: 60, prep: 10 },
  { name: "40/20×8", work: 40, rest: 20, rounds: 8, sets: 1, setRest: 60, prep: 10 },
  { name: "10秒×5（r50秒）", work: 10, rest: 50, rounds: 5, sets: 1, setRest: 120, prep: 10 },
];
function clampInt(v, [lo, hi]) { v = Math.round(Number(v)); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo; }
function sanitizeCfg(c) {
  const d = BUILTIN[0];
  c = c && typeof c === "object" ? c : {};
  const out = {};
  Object.keys(LIMITS).forEach((k) => { out[k] = clampInt(c[k] != null ? c[k] : d[k], LIMITS[k]); });
  out.countdown = [0, 3, 5].includes(c.countdown) ? c.countdown : 3;
  out.volume = clampInt(c.volume != null ? c.volume : 80, [0, 100]);
  return out;
}
let CFG = sanitizeCfg(lsGet(LS_CFG, null));
function parseSec(s) {
  s = String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[：]/g, ":").trim();
  if (!s) return NaN;
  if (s.includes(":")) { const [m, r] = s.split(":"); return Number(m) * 60 + Number(r); }
  return Number(s);
}
function fmtSec(sec) { sec = Math.max(0, Math.round(sec)); const m = Math.floor(sec / 60), s = sec % 60; return m + ":" + String(s).padStart(2, "0"); }
function fmtBig(sec, segDur) { return segDur >= 60 ? fmtSec(sec) : String(Math.max(0, sec)); }
const TIME_KEYS = ["work", "rest", "setRest", "prep"];

/* ---------- 流れ（区間の並び）を作る ---------- */
const NAMES = { prep: "準備", work: "ワーク", rest: "レスト", setrest: "セット間レスト", done: "終了" };
function buildPlan(c) {
  const p = [];
  if (c.prep > 0) p.push({ type: "prep", dur: c.prep, round: 0, set: 1 });
  for (let s = 1; s <= c.sets; s++) {
    for (let r = 1; r <= c.rounds; r++) {
      p.push({ type: "work", dur: c.work, round: r, set: s });
      if (r < c.rounds && c.rest > 0) p.push({ type: "rest", dur: c.rest, round: r, set: s }); // 最後のラウンドのあとはレストなし
    }
    if (s < c.sets && c.setRest > 0) p.push({ type: "setrest", dur: c.setRest, round: c.rounds, set: s });
  }
  let t = 0;
  p.forEach((x) => { x.start = t; t += x.dur; x.end = t; });
  return p;
}

/* ---------- 状態 ---------- */
const T = { plan: buildPlan(CFG), running: false, started: false, startAt: 0, frozen: 0, lastIdx: -1, raf: 0 };
function totalDur() { return T.plan.length ? T.plan[T.plan.length - 1].end : 0; }
function elapsed() { return T.running ? (performance.now() - T.startAt) / 1000 : T.frozen; }
function segAt(t) { return T.plan.findIndex((x) => t < x.end); } // -1 なら終了

/* ---------- 音 ---------- */
const A = { ctx: null, master: null, nodes: [] };
function audioInit() {
  if (!A.ctx) {
    // iPhone：マナーモードでも鳴らす（Safari 16.4 以降）
    try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) {}
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    A.ctx = new AC();
    A.master = A.ctx.createGain();
    A.master.connect(A.ctx.destination);
  }
  A.master.gain.value = CFG.volume / 100;
  if (A.ctx.state !== "running") A.ctx.resume().catch(() => {});
  return true;
}
function tone(at, freq, len) {
  const o = A.ctx.createOscillator(), g = A.ctx.createGain();
  o.type = "sine"; o.frequency.value = freq;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(0.9, at + 0.01);
  g.gain.setValueAtTime(0.9, at + len - 0.05);
  g.gain.linearRampToValueAtTime(0, at + len);
  o.connect(g); g.connect(A.master);
  o.start(at); o.stop(at + len + 0.02);
  A.nodes.push(o);
}
function cancelSounds() { A.nodes.forEach((o) => { try { o.stop(); } catch (e) {} }); A.nodes = []; }
// 今の位置から最後までの合図を、まとめて予約する
function scheduleSounds() {
  cancelSounds();
  if (!A.ctx) return;
  const now = elapsed(), base = A.ctx.currentTime + 0.05;
  const at = (t) => base + (t - now);
  T.plan.forEach((x, i) => {
    if (x.end <= now) return;
    for (let k = CFG.countdown; k >= 1; k--) {
      const t = x.end - k;
      if (t > now && t > x.start) tone(at(t), 880, 0.12); // 3・2・1 の短い音
    }
    const nx = T.plan[i + 1];
    if (!nx) { [0, 0.28, 0.56].forEach((d) => tone(at(x.end) + d, 1320, 0.2)); } // 終了：3回
    else if (nx.type === "work") tone(at(x.end), 1320, 0.5); // ワーク開始：高い長い音
    else tone(at(x.end), 620, 0.5); // レスト開始：低い長い音
  });
}

/* ---------- 画面スリープを防ぐ ---------- */
let wake = null;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator && !wake) { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => { wake = null; }); }
    if (!on && wake) { await wake.release(); wake = null; }
  } catch (e) {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && T.running) { keepAwake(true); if (A.ctx && A.ctx.state !== "running") A.ctx.resume().then(scheduleSounds).catch(() => {}); }
});

/* ---------- 操作 ---------- */
function start() {
  audioInit();
  if (!T.started) { T.plan = buildPlan(CFG); T.frozen = 0; T.lastIdx = -1; T.started = true; if (T.plan[0].type === "work" && A.ctx) tone(A.ctx.currentTime + 0.05, 1320, 0.5); }
  T.startAt = performance.now() - T.frozen * 1000;
  T.running = true;
  scheduleSounds();
  keepAwake(true);
  document.body.classList.add("running");
  loop();
}
function pause() {
  T.frozen = elapsed();
  T.running = false;
  cancelSounds();
  keepAwake(false);
  cancelAnimationFrame(T.raf);
  render();
}
function reset() {
  T.running = false; T.started = false; T.frozen = 0; T.lastIdx = -1;
  cancelSounds(); keepAwake(false); cancelAnimationFrame(T.raf);
  document.body.classList.remove("running");
  T.plan = buildPlan(CFG);
  render();
}
function skip() {
  const i = segAt(elapsed());
  if (i < 0) return;
  const t = T.plan[i].end;
  if (T.running) T.startAt = performance.now() - t * 1000; else T.frozen = t;
  if (T.running) scheduleSounds();
  render();
}
function finish() {
  T.running = false; T.frozen = totalDur();
  keepAwake(false); cancelAnimationFrame(T.raf);
  render();
}
function loop() {
  render();
  if (!T.running) return;
  if (elapsed() >= totalDur()) { finish(); return; }
  T.raf = requestAnimationFrame(loop);
}
// 時間が見えないあいだ（画面が裏など）も区切りを進めるための予備
setInterval(() => { if (T.running && document.visibilityState !== "visible") render(); }, 500);

/* ---------- 表示 ---------- */
function render() {
  const t = elapsed();
  const i = T.started ? segAt(t) : -2;
  const startBtn = $("#startBtn");
  if (i === -2) { // スタート前
    const p0 = T.plan[0];
    document.body.dataset.phase = "idle";
    $("#phase").textContent = "準備OK";
    $("#time").textContent = fmtBig(p0 ? p0.dur : 0, p0 ? p0.dur : 0);
    $("#bar").style.width = "0%";
    $("#round").textContent = `ラウンド 0/${CFG.rounds}`;
    $("#set").textContent = `セット 1/${CFG.sets}`;
    $("#set").hidden = CFG.sets < 2;
    $("#next").textContent = p0 ? `スタートを押すと、${NAMES[p0.type]} ${p0.dur}秒 から始まります` : "";
    $("#total").textContent = "合計 " + fmtSec(totalDur());
    startBtn.textContent = "スタート"; startBtn.classList.remove("pause");
    $("#skipBtn").disabled = true;
    return;
  }
  if (i === -1) { // 終了
    document.body.dataset.phase = "done";
    $("#phase").textContent = "終了";
    $("#time").textContent = "おつかれ";
    $("#bar").style.width = "100%";
    $("#round").textContent = `ラウンド ${CFG.rounds}/${CFG.rounds}`;
    $("#next").textContent = "リセットを押すと最初に戻ります";
    $("#total").textContent = "合計 " + fmtSec(totalDur());
    startBtn.textContent = "もう一度"; startBtn.classList.remove("pause");
    $("#skipBtn").disabled = true;
    if (T.lastIdx !== -1) { T.lastIdx = -1; if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]); }
    return;
  }
  const x = T.plan[i], nx = T.plan[i + 1];
  const remain = Math.ceil(x.end - t - 1e-6);
  document.body.dataset.phase = x.type;
  $("#phase").textContent = NAMES[x.type];
  $("#time").textContent = fmtBig(remain, x.dur);
  $("#bar").style.width = Math.min(100, ((t - x.start) / x.dur) * 100).toFixed(1) + "%";
  $("#round").textContent = `ラウンド ${x.round}/${CFG.rounds}`;
  $("#set").textContent = `セット ${x.set}/${CFG.sets}`;
  $("#set").hidden = CFG.sets < 2;
  $("#next").textContent = nx ? `次：${NAMES[nx.type]} ${nx.dur}秒${nx.type === "work" ? `（ラウンド ${nx.round}/${CFG.rounds}${CFG.sets > 1 ? "・セット " + nx.set : ""}）` : ""}` : "これが最後です";
  $("#total").textContent = "残り " + fmtSec(totalDur() - t) + " ／ 合計 " + fmtSec(totalDur());
  startBtn.textContent = T.running ? "一時停止" : "再開";
  startBtn.classList.toggle("pause", T.running);
  $("#skipBtn").disabled = false;
  if (i !== T.lastIdx) { if (T.lastIdx >= 0 && navigator.vibrate) navigator.vibrate(x.type === "work" ? 400 : 200); T.lastIdx = i; }
}

/* ---------- 設定画面 ---------- */
function fillForm() {
  TIME_KEYS.forEach((k) => { $("#" + k).value = CFG[k] >= 60 && k !== "prep" ? fmtSec(CFG[k]) : String(CFG[k]); });
  $("#rounds").value = CFG.rounds; $("#sets").value = CFG.sets;
  $$("#countdown .chip").forEach((c) => c.setAttribute("aria-pressed", String(Number(c.dataset.v) === CFG.countdown)));
  $("#volume").value = CFG.volume;
  $("#setRestField").hidden = CFG.sets < 2;
  renderPresets();
}
function applyCfg(save) {
  if (save) lsSet(LS_CFG, CFG);
  if (!T.started) { T.plan = buildPlan(CFG); render(); }
  $("#setRestField").hidden = CFG.sets < 2;
  renderPresets();
}
function readField(k) {
  const v = TIME_KEYS.includes(k) ? parseSec($("#" + k).value) : Number($("#" + k).value);
  if (!isFinite(v)) return;
  CFG[k] = clampInt(v, LIMITS[k]);
  applyCfg(true);
}
function samePreset(p) { return Object.keys(LIMITS).every((k) => p[k] === CFG[k]); }
function getPresets() {
  const v = lsGet(LS_PRESETS, []);
  return Array.isArray(v) ? v.slice(0, 30).map((p) => (p && typeof p.name === "string" && p.name.trim() ? Object.assign(sanitizeCfg(p), { name: p.name.slice(0, 20) }) : null)).filter(Boolean) : [];
}
let pendingDel = null;
function renderPresets() {
  const all = BUILTIN.concat(getPresets());
  $("#presets").innerHTML = all.map((p, i) => `<button type="button" class="chip" data-p="${i}" aria-pressed="${samePreset(p)}">${esc(p.name)}</button>`).join("");
  const mine = getPresets();
  $("#myPresets").innerHTML = mine.map((p, i) => `<div class="item"><span>${esc(p.name)}<br><span class="hint">ワーク${p.work}秒・レスト${p.rest}秒×${p.rounds}${p.sets > 1 ? "×" + p.sets + "セット" : ""}</span></span><button type="button" class="btn small danger" data-del="${i}">${pendingDel === i ? "本当に削除する" : "削除"}</button></div>`).join("");
  $$("#myPresets [data-del]").forEach((b) => b.addEventListener("click", () => {
    const i = Number(b.dataset.del);
    if (pendingDel === i) { pendingDel = null; const m = getPresets(); m.splice(i, 1); lsSet(LS_PRESETS, m); toast("削除しました"); }
    else { pendingDel = i; setTimeout(() => { if (pendingDel === i) { pendingDel = null; renderPresets(); } }, 4000); }
    renderPresets();
  }));
}
function buildSettings() {
  $("#presets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-p]");
    if (!b) return;
    const p = BUILTIN.concat(getPresets())[Number(b.dataset.p)];
    if (!p) return;
    Object.keys(LIMITS).forEach((k) => { CFG[k] = p[k]; });
    fillForm(); applyCfg(true);
  });
  $$("[data-k]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.k;
    CFG[k] = clampInt(CFG[k] + Number(b.dataset.d), LIMITS[k]);
    fillForm(); applyCfg(true);
  }));
  Object.keys(LIMITS).forEach((k) => {
    $("#" + k).addEventListener("change", () => { readField(k); fillForm(); });
    $("#" + k).addEventListener("input", () => readField(k));
  });
  $("#countdown").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    CFG.countdown = Number(b.dataset.v); fillForm(); applyCfg(true);
  });
  $("#volume").addEventListener("input", (e) => { CFG.volume = clampInt(e.target.value, [0, 100]); if (A.master) A.master.gain.value = CFG.volume / 100; lsSet(LS_CFG, CFG); });
  $("#testBtn").addEventListener("click", () => {
    if (!audioInit()) { toast("このブラウザでは音を鳴らせません"); return; }
    const t0 = A.ctx.currentTime + 0.05;
    tone(t0, 880, 0.12); tone(t0 + 1, 880, 0.12); tone(t0 + 2, 880, 0.12); tone(t0 + 3, 1320, 0.5);
  });
  $("#saveBtn").addEventListener("click", () => {
    const name = $("#presetName").value.trim().slice(0, 20);
    if (!name) { toast("プリセットの名前を入れてください"); return; }
    const m = getPresets().filter((p) => p.name !== name);
    m.push(Object.assign({}, CFG, { name }));
    lsSet(LS_PRESETS, m);
    $("#presetName").value = "";
    renderPresets();
    toast("保存しました");
  });
  $("#startBtn").addEventListener("click", () => {
    if (T.started && segAt(elapsed()) === -1) { reset(); start(); return; } // もう一度
    if (T.running) pause(); else start();
  });
  $("#resetBtn").addEventListener("click", reset);
  $("#skipBtn").addEventListener("click", skip);
}

buildSettings();
fillForm();
render();
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
