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
const LS_TPL = "sprintlog.template.v1";
const LS_VENUES = "sprintlog.venues.v1";
const LS_SESSIONS = "sprintlog.sessions.v1";
const LS_LASTVENUE = "sprintlog.lastVenue.v1";
const S = { entries: [] };

const WEATHER = ["晴れ", "くもり", "雨", "雪", "室内"];
const COND = [["◎", "絶好調"], ["○", "良い"], ["△", "いまいち"], ["×", "不調"]];
const INTS = ["弱", "中", "強"];
const MARKS = ["試合", "休養"];
const FAT = { 1: "とても楽", 2: "楽", 3: "楽", 4: "ややきつい", 5: "きつい", 6: "きつい", 7: "かなりきつい", 8: "かなりきつい", 9: "ほぼ限界", 10: "限界" };
const DISTS = [30, 50, 60, 80, 100, 120, 150, 200, 250, 300, 400];
const KINDS = ["SD", "加速走", "流し", "テンポ走", "イーブン走", "セット走", "坂ダッシュ", "牽引走", "TT", "その他"];
const LINKS = ["10秒", "20秒", "30秒", "1分", "ウォーク20m", "ウォーク50m", "ジョグ"];
const RELAYS = ["4×100m", "4×400m", "その他"];
const ROUNDS = ["予選", "準決勝", "決勝", "TR"];
const RACE_EVENTS = ["60", "100", "200", "300", "400", "relay"];
const OCATS = ["ジョグ", "ストレッチ", "ドリル", "補強", "プライオ・跳躍", "パワーマックス", "ケア", "自由記入"];
const OCAT_POST_DEFAULT = { "ジョグ": false, "ストレッチ": false, "ケア": false, "ドリル": true, "補強": true, "プライオ・跳躍": true, "パワーマックス": true, "自由記入": true };
const PLYO = ["バウンディング", "ホッピング", "片脚ホップ", "立ち幅跳び", "立ち五段跳び", "ボックスジャンプ", "メディシンボール投げ", "その他"];
const WEIGHT_EX = ["スクワット", "ハーフスクワット", "デッドリフト", "ベンチプレス", "クリーン", "スナッチ", "ランジ", "ヒップスラスト", "ステップアップ", "カーフレイズ", "懸垂", "その他"];

/* ---------- 読み込んだデータの検査（旧い形式からの移行も兼ねる） ---------- */
function timeOrNull(t) { return numIn(t, 0.01, 36000); }
function newUid() { const a = new Uint32Array(1); crypto.getRandomValues(a); return "u" + a[0].toString(36); }
function uidOf(v) { return typeof v === "string" && /^u[a-z0-9]{1,15}$/.test(v) ? v : newUid(); }
function sanitizeRun(m) {
  if (!m || typeof m !== "object") return null;
  let segs = Array.isArray(m.segs) ? m.segs : (m.dist != null ? [m.dist] : []);
  segs = segs.slice(0, 6).map((x) => numIn(x, 1, 50000)).filter((x) => x != null).map(Math.round);
  if (!segs.length) return null;
  const reps = Math.round(numIn(m.reps, 1, 20) || 1), sets = Math.round(numIn(m.sets, 1, 6) || 1);
  const times = Array.isArray(m.times) ? m.times.slice(0, 120).map((t) =>
    Array.isArray(t) ? segs.map((_, k) => timeOrNull(t[k])) : (segs.length === 1 ? [timeOrNull(t)] : segs.map(() => null))) : [];
  return {
    uid: uidOf(m.uid), up: m.up === true, segs, reps, sets, times,
    kind: KINDS.includes(m.kind) ? m.kind : "", kindName: str(m.kindName, 20), link: str(m.link, 30),
    rest: str(m.rest, 8), setRest: str(m.setRest, 8), timing: m.timing === "elec" ? "elec" : "hand", note: str(m.note, 100),
  };
}
function sanitizeWeight(g) {
  if (!g || typeof g !== "object" || !str(g.name, 30)) return null;
  return { uid: uidOf(g.uid), name: str(g.name, 30), kg: str(g.kg, 30), reps: Math.round(numIn(g.reps, 1, 100) || 1), sets: Math.round(numIn(g.sets, 1, 20) || 1), note: str(g.note, 60) };
}
function sanitizeExtra(o) {
  if (!o || typeof o !== "object" || !OCATS.includes(o.cat)) return null;
  const sets = numIn(o.sets, 1, 20);
  return {
    uid: uidOf(o.uid), up: o.up === true, cat: o.cat, name: str(o.name, 30), amt: str(o.amt, 20), sets: sets ? Math.round(sets) : null,
    kp: str(o.kp, 6), watt: str(o.watt, 5), memo: str(o.memo, o.cat === "自由記入" ? 100 : 60), post: typeof o.post === "boolean" ? o.post : OCAT_POST_DEFAULT[o.cat],
  };
}
function sanitizeRace(x) {
  if (!x || typeof x !== "object") return null;
  const time = timeOrNull(x.time);
  if (time == null) return null;
  const relay = x.event === "relay";
  const dist = relay ? null : numIn(x.dist, 1, 50000);
  if (!relay && dist == null) return null;
  const n = (v, lo, hi) => { const r = numIn(v, lo, hi); return r == null ? null : Math.round(r); };
  return {
    event: relay ? "relay" : "ind", dist: dist == null ? null : Math.round(dist), time,
    wind: relay ? null : numIn(x.wind, -20, 20), timing: x.timing === "hand" ? "hand" : "elec",
    round: ROUNDS.includes(x.round) ? x.round : "", place: n(x.place, 1, 999), heat: n(x.heat, 1, 999), lane: n(x.lane, 1, 20),
    relayType: relay && RELAYS.includes(x.relayType) ? x.relayType : (relay ? "4×100m" : ""), relayName: relay ? str(x.relayName, 20) : "",
    leg: relay ? n(x.leg, 1, 4) : null, split: relay ? timeOrNull(x.split) : null,
  };
}
function sanitizeEntry(e) {
  if (!e || typeof e !== "object") return null;
  if (typeof e.id !== "string" || !/^e[a-z0-9]{4,40}$/.test(e.id)) return null;
  if (typeof e.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return null;
  const arr = (v, max, f) => (Array.isArray(v) ? v.slice(0, max).map(f).filter(Boolean) : []);
  // 旧形式の types（試合・休養）を marks に移す
  const marks = Array.isArray(e.marks) ? e.marks.filter((m) => MARKS.includes(m)) : (Array.isArray(e.types) ? e.types.filter((m) => MARKS.includes(m)) : []);
  let wx = null;
  if (e.wx && typeof e.wx === "object") {
    wx = { temp: numIn(e.wx.temp, -60, 60), hum: numIn(e.wx.hum, 0, 100), code: numIn(e.wx.code, 0, 99), ws: numIn(e.wx.ws, 0, 100), wd: numIn(e.wx.wd, 0, 360), at: str(e.wx.at, 16), place: str(e.wx.place, 60) };
  }
  const fat = numIn(e.fatigue, 1, 10) || (e.fatigue === undefined ? numIn(e.rpe, 1, 10) : null);
  return {
    id: e.id, date: e.date, time: typeof e.time === "string" && /^\d{2}:\d{2}$/.test(e.time) ? e.time : "",
    timeEnd: typeof e.timeEnd === "string" && /^\d{2}:\d{2}$/.test(e.timeEnd) ? e.timeEnd : "",
    venue: str(e.venue, 40), session: str(e.session, 40), upMode: e.upMode === "detail" ? "detail" : "short",
    order: Array.isArray(e.order) ? e.order.slice(0, 200).filter((u) => typeof u === "string" && /^u[a-z0-9]{1,15}$/.test(u)) : [],
    marks: Array.from(new Set(marks)), intensity: INTS.includes(e.intensity) ? e.intensity : "",
    meet: str(e.meet, 60), races: arr(e.races, 20, sanitizeRace),
    menu: arr(e.menu, 50, sanitizeRun), weights: arr(e.weights, 30, sanitizeWeight), extras: arr(e.extras, 30, sanitizeExtra),
    weather: WEATHER.includes(e.weather) ? e.weather : "", temp: str(e.temp, 6), wind: str(e.wind, 80), windAuto: e.windAuto === true, wx,
    fatigue: fat ? Math.round(fat) : null, cond: COND.some(([k]) => k === e.cond) ? e.cond : "",
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

/* ---------- 表示用の文 ---------- */
function restStr(v) { return /^\d+(\.\d+)?$/.test(v) ? v + "分" : v; } // 数字だけなら「分」を付ける
function segsStr(segs) { return segs.join("+"); }
function menuKey(m) { return segsStr(m.segs) + "m"; }
function kindLabel(m) { return m.kind === "その他" ? (m.kindName || "") : m.kind; }
function menuLine(m, cont) {
  const k = cont ? "" : kindLabel(m); // 同じ種類が続くときは名前を省く
  let s = (k ? k + " " : "") + (m.segs.length > 1 ? `(${segsStr(m.segs)})` : m.segs[0] + "m") + `×${m.reps}${m.sets > 1 ? "×" + m.sets : ""}`;
  // つなぎ／本数間 r／セット間 R
  const inner = [m.segs.length > 1 && m.link ? "つなぎ " + m.link : "", m.rest ? "r" + restStr(m.rest) : "", m.sets > 1 && m.setRest ? "R" + restStr(m.setRest) : ""].filter(Boolean).join("／");
  if (inner) s += `（${inner}）`;
  const dp = m.timing === "hand" ? 1 : 2;
  const reps = m.times.map((rep) => (rep && rep.some((t) => t != null) ? rep.map((t) => (t == null ? "–" : fmt(t, dp))).join("+") : "–"));
  while (reps.length && reps[reps.length - 1] === "–") reps.pop();
  if (reps.length) s += " " + reps.join("/") + (m.timing === "hand" ? "（手）" : "");
  if (m.note) s += " " + m.note;
  return s;
}
function weightLine(g, cont) {
  const kg = g.kg ? (/^[\d.]+$/.test(g.kg) ? g.kg + "kg" : g.kg + (/kg$/i.test(g.kg) ? "" : "kg")) : "";
  if (cont) return `${kg || g.name}×${g.reps}×${g.sets}${g.note ? " " + g.note : ""}`; // 同じ種目が続くときは種目名を省く
  return `${g.name}${kg ? " " + kg : ""}×${g.reps}×${g.sets}${g.note ? " " + g.note : ""}`;
}
function extraLine(o, cont) {
  if (o.cat === "自由記入") return o.memo; // 種類なし：書いた文だけ
  // 同じ種類が続くときは種類名（パワーマックス、ドリルなど）を省き、内容だけを書く
  const head = cont ? o.name : o.cat === "プライオ・跳躍" ? (o.name || "プライオ") : o.cat + (o.name ? (o.cat === "補強" ? " " + o.name : "（" + o.name + "）") : "");
  const kp = o.cat === "パワーマックス" && o.kp ? " " + o.kp + "kp" : "";
  const amt = o.amt ? (o.sets && o.sets > 1 ? ` ${o.amt}×${o.sets}` : ` ${o.amt}`) : (o.sets && o.sets > 1 ? ` ×${o.sets}` : "");
  const watt = o.cat === "パワーマックス" && o.watt ? ` 最大${o.watt}W` : "";
  return (head + kp + amt + watt + (o.memo ? " " + o.memo : "")).trim() || o.cat;
}
// 練習の流れ：ラン・ウエイト・その他を、保存された順番（order）で1列に並べる
function flowItems(e) {
  const all = [].concat(e.menu.map((it) => ({ t: "run", it })), e.weights.map((it) => ({ t: "w", it })), e.extras.map((it) => ({ t: "o", it })));
  const pos = (u) => { const i = e.order.indexOf(u); return i < 0 ? 1e6 : i; };
  return all.map((x, n) => ({ x, n })).sort((a, b) => pos(a.x.it.uid) - pos(b.x.it.uid) || a.n - b.n).map((a) => a.x);
}
function syncOrder(e) { e.order = flowItems(e).map((x) => x.it.uid); }
function itemLine(x, cont) { return x.t === "run" ? menuLine(x.it, cont) : x.t === "w" ? weightLine(x.it, cont) : extraLine(x.it, cont); }
// 「同じメニュー」の目印。これが前の行と同じなら、名前を省いて書く
function groupKey(x) {
  if (x.t === "run") return kindLabel(x.it) ? "r:" + kindLabel(x.it) : null;
  if (x.t === "w") return "w:" + x.it.name;
  if (x.it.cat === "プライオ・跳躍") return x.it.name ? "p:" + x.it.name : null;
  if (x.it.cat === "自由記入") return null;
  return "o:" + x.it.cat;
}
// 並んだ項目を、同じメニューが続くところは名前を省いて文にする
function joinLines(items) {
  let prev = null;
  return items.map((x) => {
    const k = groupKey(x), cont = k != null && k === prev;
    prev = k;
    return itemLine(x, cont);
  });
}
// 本文の行。アップの項目は最初のアップの位置に1行でまとめる
function flowLines(e, forPost) {
  const items = flowItems(e);
  const ups = items.filter((x) => x.it.up);
  const out = [];
  let upDone = false, prevKey = null;
  items.forEach((x) => {
    if (x.it.up) {
      if (upDone) return;
      upDone = true;
      out.push(forPost && e.upMode !== "detail" ? "アップ" : "アップ（" + joinLines(ups).join("・") + "）");
      prevKey = null;
      return;
    }
    if (forPost && x.t === "o" && !x.it.post) return;
    const k = groupKey(x), cont = k != null && k === prevKey;
    prevKey = k;
    out.push(itemLine(x, cont));
  });
  return out;
}
function raceName(x) { return x.event === "relay" ? (x.relayType === "その他" ? (x.relayName || "リレー") : x.relayType + "R") : x.dist + "m"; }
function raceLine(x, mark) {
  let s = raceName(x) + (x.round ? " " + x.round : "") + " " + fmt(x.time, x.timing === "hand" ? 1 : 2) + (x.timing === "hand" ? "（手）" : "");
  if (x.event !== "relay" && windAffected(x.dist) && x.wind != null) s += `（${fmtWind(x.wind)}）`;
  if (x.place) s += ` ${x.place}着`;
  if (x.event === "relay" && (x.leg || x.split)) s += `（${x.leg ? x.leg + "走" : ""}${x.leg && x.split ? " " : ""}${x.split ? "区間" + fmt(x.split, x.timing === "hand" ? 1 : 2) : ""}）`;
  const hl = [x.heat ? x.heat + "組" : "", x.lane ? x.lane + "レーン" : ""].filter(Boolean).join("");
  if (hl) s += " " + hl;
  if (mark) s += " " + mark;
  return s;
}
// 見出し：中身から自動（ラン・ウエイト・その他）＋試合・休養
function headTokens(e) {
  const t = [];
  e.marks.forEach((m) => t.push(m));
  if (e.menu.length) t.push("ラン");
  if (e.weights.length) t.push("ウエイト");
  if (e.extras.length) t.push("その他");
  return t;
}
function placeLine(e) { return [e.venue ? "@" + e.venue : "", e.session].filter(Boolean).join(" "); }
function headLine(e, withPlace) {
  const d = new Date(e.date + "T00:00:00");
  const t = headTokens(e);
  const inner = t.join("・") + (e.intensity ? (t.length ? "／" : "") + e.intensity : "");
  return `${d.getMonth() + 1}/${d.getDate()}(${"日月火水木金土"[d.getDay()]})${inner ? "【" + inner + "】" : ""}${e.marks.includes("試合") && e.meet ? " " + e.meet : ""}${withPlace && placeLine(e) ? " " + placeLine(e) : ""}`;
}

/* ---------- 日記フォーム ---------- */
let F = null; // 編集中の日記
function newId(prefix) {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return prefix + Date.now().toString(36) + a[0].toString(36) + a[1].toString(36);
}
function blankEntry() {
  return { id: newId("e"), date: todayStr(), time: nowHourStr(), timeEnd: "", venue: lsGet(LS_LASTVENUE, "") || "", session: "", upMode: "short", order: [], marks: [], intensity: "", meet: "", races: [], menu: [], weights: [], extras: [], weather: "", temp: "", wind: "", windAuto: false, wx: null, fatigue: null, cond: "", body: "", post: "", postManual: false, createdAt: Date.now(), updatedAt: 0 };
}
function chipsHTML(list, pressed, cls) { return list.map((t) => `<button type="button" class="chip${cls ? " " + cls : ""}" data-v="${esc(t)}" aria-pressed="${t === pressed}">${esc(t)}</button>`).join(""); }
function toggleChips(el, getter, setter) {
  el.addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    setter(getter() === b.dataset.v ? "" : b.dataset.v);
  });
}

function buildDiary() {
  // 強度・試合/休養
  toggleChips($("#fInt"), () => F.intensity, (v) => { F.intensity = v; setChip($("#fInt"), v); updatePost(); });
  $("#fMarks").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    const v = b.dataset.v, i = F.marks.indexOf(v);
    if (i >= 0) F.marks.splice(i, 1); else F.marks.push(v);
    syncMarks();
    updatePost();
  });
  // 天気・疲労・調子
  const fw = $("#fWeather");
  fw.innerHTML = chipsHTML(WEATHER, "");
  toggleChips(fw, () => F.weather, (v) => { F.weather = v; setChip(fw, v); updatePost(); });
  const ff = $("#fFat");
  ff.innerHTML = Array.from({ length: 10 }, (_, i) => `<button type="button" class="chip num" data-v="${i + 1}" aria-pressed="false">${i + 1}</button>`).join("");
  toggleChips(ff, () => (F.fatigue ? String(F.fatigue) : ""), (v) => { F.fatigue = v ? Number(v) : null; syncFat(); updatePost(); });
  const fc = $("#fCond");
  fc.innerHTML = COND.map(([k, l]) => `<button type="button" class="chip" data-v="${esc(k)}" aria-pressed="false">${esc(k)} ${esc(l)}</button>`).join("");
  toggleChips(fc, () => F.cond, (v) => { F.cond = v; setChip(fc, v); updatePost(); });

  ["fDate", "fTime", "fTimeEnd", "fTemp", "fBody", "fMeet"].forEach((id) => $("#" + id).addEventListener("input", readForm));
  $("#fWind").addEventListener("input", () => { F.windAuto = false; readForm(); });
  $("#wxBtn").addEventListener("click", () => doWeather(false));

  // 投稿
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
    if (!F.wx && wxLoc()) await doWeather(true);
    afterSave(saveEntry(F));
  });
  // X のリンクはクリック時点の文で開く（天気の取得は待たない：ポップアップがブロックされないように）
  $("#xBtn").addEventListener("click", () => { readForm(); updateXLink(); afterSave(saveEntry(F)); });
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
}
function afterSave(ok) {
  if (!ok) return;
  $("#formTitle").textContent = "練習を編集";
  const marks = F.races.map((x, i) => raceMark(F, i));
  toast(marks.includes("PB") ? "保存しました。PB更新です！" : marks.includes("SB") ? "保存しました。SB更新です" : "保存しました");
}
function savePostPrefs() {
  const o = { tags: $("#pTags").value };
  $$("#pOpts .chip").forEach((c) => { o[c.dataset.k] = c.getAttribute("aria-pressed") === "true"; });
  lsSet(LS_POST, o);
}
function syncMarks() {
  $$("#fMarks .chip").forEach((c) => c.setAttribute("aria-pressed", F.marks.includes(c.dataset.v) ? "true" : "false"));
  $("#raceCard").hidden = !(F.marks.includes("試合") || F.races.length);
}
function syncFat() {
  setChip($("#fFat"), F.fatigue ? String(F.fatigue) : "");
  $("#fFatV").textContent = F.fatigue ? F.fatigue + "（" + FAT[F.fatigue] + "）" : "—";
}
function syncCounts() {
  $("#runCount").textContent = F.menu.length ? F.menu.length + "件" : "";
  $("#weightCount").textContent = F.weights.length ? F.weights.length + "件" : "";
  $("#extraCount").textContent = F.extras.length ? F.extras.length + "件" : "";
  $("#headPreview").textContent = "見出し：" + headLine(F);
}
function readForm() {
  const prevKey = F.date + " " + F.time;
  F.date = /^\d{4}-\d{2}-\d{2}$/.test($("#fDate").value) ? $("#fDate").value : todayStr();
  F.time = /^\d{2}:\d{2}$/.test($("#fTime").value) ? $("#fTime").value : "";
  F.timeEnd = /^\d{2}:\d{2}$/.test($("#fTimeEnd").value) ? $("#fTimeEnd").value : "";
  if (F.wx && prevKey !== F.date + " " + F.time) { F.wx = null; renderWxStatus(); } // 日時を変えたら天気は取り直す
  F.temp = $("#fTemp").value.trim().slice(0, 6);
  F.wind = $("#fWind").value.trim().slice(0, 80);
  F.body = $("#fBody").value.slice(0, 5000);
  F.meet = $("#fMeet").value.trim().slice(0, 60);
  updatePost();
}
function loadForm(e) {
  F = clone(e);
  $("#fDate").value = F.date; $("#fTime").value = F.time || ""; $("#fTimeEnd").value = F.timeEnd || ""; $("#fTemp").value = F.temp || ""; $("#fWind").value = F.wind || "";
  $("#fBody").value = F.body || ""; $("#fMeet").value = F.meet || "";
  setChip($("#fInt"), F.intensity);
  setChip($("#fWeather"), F.weather);
  setChip($("#fCond"), F.cond);
  syncFat(); syncMarks();
  $("#formTitle").textContent = S.entries.some((x) => x.id === F.id) ? "練習を編集" : "今日の練習";
  $("#weightCard").open = F.weights.length > 0;
  $("#extraCard").open = F.extras.length > 0;
  setChip($("#upMode"), F.upMode);
  renderVenueChips();
  renderMenuList(); renderWeightList(); renderExtraList(); renderRaceList();
  renderWxStatus();
  updatePost();
}
function opt(k) { const c = $(`#pOpts .chip[data-k="${k}"]`); return c && c.getAttribute("aria-pressed") === "true"; }
function autoPost() {
  const L = [headLine(F, opt("venue"))];
  if (F.races.length) L.push(F.races.map((x, i) => raceLine(x, raceMark(F, i))).join("\n"));
  if (opt("menu")) {
    const lines = flowLines(F, true);
    if (lines.length) L.push(lines.join("\n"));
  }
  if (opt("cond")) {
    const c = [F.weather, F.temp ? F.temp + "℃" : "", F.wind, F.fatigue ? "疲労度" + F.fatigue : "", F.cond ? "調子" + F.cond : ""].filter(Boolean).join(" ");
    if (c) L.push(c);
  }
  if (opt("body") && F.body.trim()) L.push(F.body.trim());
  if (opt("tags") && $("#pTags").value.trim()) L.push($("#pTags").value.trim());
  return L.join("\n\n");
}
function updatePost() {
  if (!F) return;
  if (!F.postManual) { F.post = autoPost(); $("#pText").value = F.post; $("#pReset").hidden = true; }
  else { $("#pText").value = F.post; $("#pReset").hidden = false; }
  syncCounts();
  renderFlow();
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

// ±の間の数字を押すとキーボードで書き換えられるようにする
function bindStepInput(sel, lo, hi, apply) {
  const el = $(sel);
  let last = Number(el.value) || lo;
  const read = (commit) => {
    const v = Math.round(Number(toHalf(el.value)));
    if (isFinite(v) && v >= lo && v <= hi) { if (v !== last) { last = v; apply(v); } if (commit) el.value = v; }
    else if (commit) { el.value = last; if (el.value !== "" && toHalf(el.value) !== "") toast(lo + "〜" + hi + "の数字を入れてください"); }
  };
  // 押したら全体を選んで、すぐ打ち直せるようにする
  const selAll = () => { try { el.setSelectionRange(0, el.value.length); } catch (e) { el.select(); } };
  el.addEventListener("focus", () => { last = Number(el.value) || last; selAll(); setTimeout(selAll, 0); });
  el.addEventListener("mouseup", (e) => e.preventDefault()); // クリック直後に選択が外れないように
  el.addEventListener("input", () => read(false));
  el.addEventListener("change", () => read(true));
  el.addEventListener("blur", () => read(true));
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } });
  // ±ボタンで変わったときも、覚えている値を合わせる
  el.closest(".stepper").addEventListener("click", () => { last = Number(el.value) || last; });
}

// 並べ替え・削除つきの一覧（ラン・ウエイト・その他・試合で共通）
function renderItemList(el, items, lineFn, onChange, extraBtn, noMove) {
  el.innerHTML = items.map((it, i) => `<div class="menuitem"><span class="t num">${esc(lineFn(it, i))}</span>${extraBtn ? extraBtn(it, i) : ""}${noMove ? "" : `<button type="button" class="btn small" data-i="${i}" data-act="up" aria-label="上へ" ${i === 0 ? "disabled" : ""}>↑</button>`}<button type="button" class="btn small danger" data-i="${i}" data-act="del">削除</button></div>`).join("");
  el.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => {
    const i = Number(b.dataset.i);
    if (b.dataset.act === "del") items.splice(i, 1);
    else if (b.dataset.act === "up" && i > 0) { const t = items[i - 1]; items[i - 1] = items[i]; items[i] = t; }
    else if (b.dataset.act === "post") items[i].post = !items[i].post;
    onChange();
  }));
}

/* ---------- ランメニュー ---------- */
const M = { segs: [150], reps: 3, sets: 1, timing: "hand", kind: "" };
function parseSegs(s) {
  const parts = toHalf(s).replace(/[＋]/g, "+").split("+").map((p) => p.trim()).filter(Boolean);
  const segs = parts.slice(0, 6).map((p) => Math.round(Number(p.replace(/m$/i, ""))));
  return segs.length && segs.every((x) => x > 0 && x <= 50000) ? segs : null;
}
function buildRun() {
  const mk = $("#mKind");
  mk.innerHTML = chipsHTML(KINDS, "");
  toggleChips(mk, () => M.kind, (v) => { M.kind = v; setChip(mk, v); $("#mKindNameWrap").hidden = v !== "その他"; });
  const md = $("#mDist");
  md.innerHTML = DISTS.map((d) => `<button type="button" class="chip num" data-v="${d}" aria-pressed="${d === 150}">${d}m</button>`).join("");
  md.addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    const inp = $("#mDistIn");
    // 「＋区間」を押した直後なら区間として足す。そうでなければ置き換える
    inp.value = /\+\s*$/.test(inp.value) ? inp.value.replace(/\s*$/, "") + b.dataset.v : b.dataset.v;
    onDistInput();
  });
  $("#mPlus").addEventListener("click", () => { const inp = $("#mDistIn"); if (!/\+\s*$/.test(inp.value)) inp.value = inp.value.trim() + "+"; inp.focus(); });
  $("#mDistIn").addEventListener("input", onDistInput);
  bindStepInput("#mReps", 1, 20, (v) => { M.reps = v; renderTimeInputs(); });
  bindStepInput("#mSets", 1, 6, (v) => { M.sets = v; renderTimeInputs(); });
  $$("[data-step]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.step;
    M[k] = Math.max(1, Math.min(k === "reps" ? 20 : 6, M[k] + Number(b.dataset.d)));
    $("#mReps").value = M.reps;
    $("#mSets").value = M.sets;
    renderTimeInputs();
  }));
  $("#mLinkChips").innerHTML = chipsHTML(LINKS, "");
  $("#mLinkChips").addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (b) $("#mLink").value = b.dataset.v; });
  chipGroup($("#mTiming"), (v) => { M.timing = v; });
  $("#mAdd").addEventListener("click", addMenu);
  renderTimeInputs();
}
function onDistInput() {
  const segs = parseSegs($("#mDistIn").value);
  const one = segs && segs.length === 1 ? segs[0] : null;
  setChip($("#mDist"), one == null ? "" : String(one));
  if (segs && segsStr(segs) !== segsStr(M.segs)) { M.segs = segs; renderTimeInputs(); }
}
function renderTimeInputs() {
  const old = {};
  $$("#mTimes input").forEach((i) => { old[i.id] = i.value; });
  const multi = M.segs.length > 1;
  let h = "";
  for (let s = 0; s < M.sets; s++) for (let r = 0; r < M.reps; r++) {
    const k = s * M.reps + r;
    const lab = (M.sets > 1 ? (s + 1) + "-" : "") + (r + 1) + "本目";
    const ins = M.segs.map((d, j) => `<input class="num" inputmode="decimal" maxlength="8" id="mt${k}_${j}" aria-label="${lab} ${d}mのタイム" placeholder="${multi ? d : ""}" value="${esc(old["mt" + k + "_" + j] || "")}">`).join(multi ? `<span class="plus">+</span>` : "");
    h += multi ? `<div class="rep"><b>${lab}</b><div class="segs">${ins}</div></div>` : `<label><b>${lab}</b>${ins}</label>`;
  }
  const t = $("#mTimes");
  t.innerHTML = h;
  t.classList.toggle("multi", multi);
  $("#mSetRestWrap").hidden = M.sets < 2;
  $("#mLinkWrap").hidden = !multi;
}
function addMenu() {
  const segs = parseSegs($("#mDistIn").value);
  if (!segs) { toast("距離を 150 や 250+50 のように入れてください"); return; }
  M.segs = segs;
  const n = M.reps * M.sets;
  const times = [];
  for (let k = 0; k < n; k++) times.push(segs.map((_, j) => { const el = $(`#mt${k}_${j}`); const v = el ? parseTime(el.value) : NaN; return isFinite(v) ? Math.round(v * 100) / 100 : null; }));
  const item = sanitizeRun({ segs, reps: M.reps, sets: M.sets, times, kind: M.kind, kindName: $("#mKindName").value.trim(), link: segs.length > 1 ? $("#mLink").value.trim() : "", rest: toHalf($("#mRest").value).trim(), setRest: M.sets > 1 ? toHalf($("#mSetRest").value).trim() : "", timing: M.timing, note: $("#mNote").value.trim() });
  if (!item) { toast("追加できませんでした"); return; }
  F.menu.push(item); F.order.push(item.uid);
  $$("#mTimes input").forEach((i) => { i.value = ""; });
  $("#mNote").value = "";
  renderMenuList();
  updatePost();
}
function renderMenuList() { renderItemList($("#menuList"), F.menu, menuLine, () => { renderMenuList(); updatePost(); }, null, true); }

/* ---------- ウエイト ---------- */
const G = { reps: 5, sets: 3 };
function buildWeight() {
  const ex = $("#gEx");
  ex.innerHTML = chipsHTML(WEIGHT_EX, "スクワット");
  chipGroup(ex, (v) => { $("#gName").value = v === "その他" ? "" : v; if (v === "その他") $("#gName").focus(); });
  bindStepInput("#gReps", 1, 100, (v) => { G.reps = v; });
  bindStepInput("#gSets", 1, 20, (v) => { G.sets = v; });
  $$("[data-gstep]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.gstep;
    G[k] = Math.max(1, Math.min(k === "reps" ? 100 : 20, G[k] + Number(b.dataset.d)));
    $("#gReps").value = G.reps; $("#gSets").value = G.sets;
  }));
  $("#gAdd").addEventListener("click", () => {
    const g = sanitizeWeight({ name: $("#gName").value.trim(), kg: toHalf($("#gKg").value).trim().replace(/\s+/g, ""), reps: G.reps, sets: G.sets, note: $("#gNote").value.trim() });
    if (!g) { toast("種目名を入れてください"); return; }
    F.weights.push(g); F.order.push(g.uid);
    $("#gKg").value = ""; $("#gNote").value = "";
    renderWeightList(); updatePost();
  });
}
function renderWeightList() { renderItemList($("#weightList"), F.weights, weightLine, () => { renderWeightList(); updatePost(); }, null, true); }

/* ---------- その他の練習 ---------- */
const O = { cat: "ジョグ", sets: 1 };
const OCAT_UI = {
  "ジョグ": { name: false, nameLabel: "", amt: true, amtLabel: "時間・距離", sets: false, chips: ["10分", "15分", "20分", "30分", "2km", "3km", "5km"] },
  "ストレッチ": { name: true, nameLabel: "内容（任意）", amt: true, amtLabel: "時間（任意）", sets: false, chips: ["10分", "15分", "20分"] },
  "ドリル": { name: true, nameLabel: "内容（任意。例：ミニハードル、A・B・Cスキップ）", amt: false, sets: false, chips: [] },
  "補強": { name: true, nameLabel: "種目（例：体幹、腹筋、背筋）", amt: true, amtLabel: "回数・時間", sets: true, chips: ["10回", "20回", "30回", "30秒", "1分"] },
  "プライオ・跳躍": { name: true, nameLabel: "種目", amt: true, amtLabel: "回数・距離", sets: true, chips: ["5回", "10回", "20回", "20m", "30m", "50m"] },
  "パワーマックス": { name: false, nameLabel: "", amt: true, amtLabel: "時間・回数", sets: true, pm: true, chips: ["5秒", "10秒", "20秒", "30秒", "60秒"] },
  "自由記入": { name: false, nameLabel: "", amt: false, sets: false, free: true, chips: [] },
  "ケア": { name: true, nameLabel: "内容（任意。例：アイシング、マッサージ）", amt: false, sets: false, chips: [] },
};
function buildExtra() {
  const oc = $("#oCat");
  oc.innerHTML = chipsHTML(OCATS, O.cat);
  chipGroup(oc, (v) => { O.cat = v; syncExtraForm(); });
  const op = $("#oPlyo");
  op.innerHTML = chipsHTML(PLYO, "バウンディング");
  chipGroup(op, (v) => { $("#oName").value = v === "その他" ? "" : v; if (v === "その他") $("#oName").focus(); });
  $("#oAmtChips").addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (b) $("#oAmt").value = b.dataset.v; });
  $$("[data-ostep]").forEach((b) => b.addEventListener("click", () => { O.sets = Math.max(1, Math.min(20, O.sets + Number(b.dataset.ostep))); $("#oSets").value = O.sets; }));
  bindStepInput("#oSets", 1, 20, (v) => { O.sets = v; });
  $("#oAdd").addEventListener("click", () => {
    const ui = OCAT_UI[O.cat];
    const name = ui.name ? $("#oName").value.trim() : "";
    if (O.cat === "プライオ・跳躍" && !name) { toast("種目を選んでください"); return; }
    if (ui.free && !$("#oMemo").value.trim()) { toast("書く内容を入れてください"); return; }
    const o = sanitizeExtra({ cat: O.cat, name, amt: ui.amt ? toHalf($("#oAmt").value).trim() : "", sets: ui.sets ? O.sets : null, memo: $("#oMemo").value.trim(), kp: ui.pm ? toHalf($("#oKp").value).trim() : "", watt: ui.pm ? toHalf($("#oWatt").value).trim() : "" });
    if (!o) return;
    F.extras.push(o); F.order.push(o.uid);
    $("#oAmt").value = ""; $("#oMemo").value = ""; $("#oWatt").value = "";
    if (O.cat !== "プライオ・跳躍") $("#oName").value = "";
    renderExtraList(); updatePost();
  });
  $("#oSaveTpl").addEventListener("click", () => {
    const runs = F.menu.filter((m) => m.up);
    if (!F.extras.length && !runs.length) { toast("先に練習を追加してください"); return; }
    // その他の練習と、アップにしたランを、今の順番で登録する
    lsSet(LS_TPL, { items: flowItems(F).filter((x) => x.t === "o" || (x.t === "run" && x.it.up)).map((x) => ({ t: x.t, it: Object.assign({}, x.it, { times: [] }) })) });
    renderTplInfo();
    toast("いつものセットに登録しました");
  });
  $("#oUseTpl").addEventListener("click", () => {
    const t = getTpl();
    if (!t.length) { toast("まだ登録されていません。追加してから「登録」を押してください"); return; }
    t.forEach((x) => {
      const it = Object.assign({}, x.it, { uid: newUid() });
      if (x.t === "run") F.menu.push(it); else F.extras.push(it);
      F.order.push(it.uid);
    });
    renderMenuList(); renderExtraList(); updatePost();
  });
  syncExtraForm(); renderTplInfo();
}
function getTpl() {
  const t = lsGet(LS_TPL, null);
  if (Array.isArray(t)) return t.slice(0, 30).map(sanitizeExtra).filter(Boolean).map((it) => ({ t: "o", it })); // 旧形式
  if (!t || !Array.isArray(t.items)) return [];
  return t.items.slice(0, 40).map((x) => (x && x.t === "run" ? { t: "run", it: sanitizeRun(x.it) } : { t: "o", it: sanitizeExtra(x && x.it) })).filter((x) => x.it);
}
function renderTplInfo() { const t = getTpl(); $("#oTplInfo").textContent = t.length ? "いつものセット：" + t.map((x) => (x.it.up ? "[アップ]" : "") + itemLine(x)).join("、") : "よくやる内容（アップにしたランも）を追加してから「登録」を押すと、次から1回で入れられます。"; }
function syncExtraForm() {
  const ui = OCAT_UI[O.cat];
  $("#oPlyo").hidden = O.cat !== "プライオ・跳躍";
  $("#oNameWrap").hidden = !ui.name;
  $("#oNameLabel").textContent = ui.nameLabel;
  $("#oAmtWrap").hidden = !ui.amt;
  $("#oAmtLabel").textContent = ui.amtLabel || "";
  $("#oSetsWrap").hidden = !ui.sets;
  $("#oAmtRow").hidden = !ui.amt && !ui.sets;
  $("#oPmRow").hidden = !ui.pm;
  // 自由記入はメモ欄だけを使う
  $("#oMemoLabel").textContent = ui.free ? "書く内容（用意されていないメニューなど）" : "メモ（任意）";
  $("#oMemo").maxLength = ui.free ? 100 : 60;
  $("#oMemo").placeholder = ui.free ? "例：メディシンボール投げ上げ 10回×3、補強サーキット" : "例：回転重視、左脚に張り";
  $("#oAmtChips").innerHTML = chipsHTML(ui.chips, "", "num");
  $("#oName").value = O.cat === "プライオ・跳躍" ? (chipVal($("#oPlyo")) === "その他" ? "" : chipVal($("#oPlyo")) || "") : "";
  $("#oAmt").value = "";
}
function renderExtraList() {
  renderItemList($("#extraList"), F.extras, extraLine, () => { renderExtraList(); updatePost(); },
    (o, i) => `<button type="button" class="btn small${o.post ? "" : " off"}" data-i="${i}" data-act="post" aria-pressed="${o.post}">${o.post ? "投稿に入れる" : "投稿に入れない"}</button>`, true);
}

/* ---------- 試合結果 ---------- */
const X = { event: "100", timing: "elec", round: "", relayType: "4×100m", leg: "" };
function buildRace() {
  const xe = $("#xEvent");
  xe.innerHTML = RACE_EVENTS.map((v) => `<button type="button" class="chip num" data-v="${v}" aria-pressed="${v === X.event}">${v === "relay" ? "リレー" : v + "m"}</button>`).join("");
  chipGroup(xe, (v) => { X.event = v; if (v !== "relay") $("#xDist").value = v; syncRaceForm(); });
  $("#xDist").addEventListener("input", () => { setChip(xe, String(Number(toHalf($("#xDist").value)))); X.event = "ind"; syncRaceForm(); });
  chipGroup($("#xRelayType"), (v) => { X.relayType = v; $("#xRelayNameWrap").hidden = v !== "その他"; });
  toggleChips($("#xLeg"), () => X.leg, (v) => { X.leg = v; setChip($("#xLeg"), v); });
  toggleChips($("#xRound"), () => X.round, (v) => { X.round = v; setChip($("#xRound"), v); });
  chipGroup($("#xTiming"), (v) => { X.timing = v; });
  $("#xAdd").addEventListener("click", addRace);
  syncRaceForm();
}
function syncRaceForm() {
  const relay = X.event === "relay";
  const d = Number(toHalf($("#xDist").value));
  $("#xDistRow").hidden = relay;
  $("#xRelay").hidden = !relay;
  $("#xSplitWrap").hidden = !relay;
  $("#xWindWrap").hidden = relay || !(d > 0 && windAffected(d));
  $("#xTimeLabel").textContent = relay ? "チームのタイム" : "タイム";
}
function addRace() {
  const relay = X.event === "relay";
  const time = parseTime($("#xTime").value);
  if (!isFinite(time)) { toast("タイムを入れてください（例：11.20）"); return; }
  const ws = $("#xWind").value.trim();
  const wind = !relay && ws ? parseWind(ws) : null;
  if (!relay && ws && (!isFinite(wind) || Math.abs(wind) > 20)) { toast("風速は +1.2 や -0.5 のように入れてください"); return; }
  const num = (id) => { const v = Number(toHalf($(id).value)); return $(id).value.trim() && isFinite(v) ? v : null; };
  const split = relay ? parseTime($("#xSplit").value) : NaN;
  const x = sanitizeRace({
    event: relay ? "relay" : "ind", dist: relay ? null : Number(toHalf($("#xDist").value)), time: Math.round(time * 100) / 100,
    wind: wind == null ? null : wind, timing: X.timing, round: X.round, place: num("#xPlace"), heat: num("#xHeat"), lane: num("#xLane"),
    relayType: X.relayType, relayName: $("#xRelayName").value.trim(), leg: X.leg ? Number(X.leg) : null, split: isFinite(split) ? Math.round(split * 100) / 100 : null,
  });
  if (!x) { toast("距離とタイムを確認してください"); return; }
  F.races.push(x);
  if (!F.marks.includes("試合")) F.marks.push("試合");
  ["#xTime", "#xWind", "#xPlace", "#xHeat", "#xLane", "#xSplit"].forEach((id) => { $(id).value = ""; });
  syncMarks(); renderRaceList(); updatePost();
}
function renderRaceList() {
  renderItemList($("#raceList"), F.races, (x, i) => raceLine(x, raceMark(F, i)), () => { renderRaceList(); syncMarks(); updatePost(); });
}

/* ---------- 自己記録（PB・SB） ---------- */
const LS_REC = "sprintlog.records.v1";
const REC_EVENTS = [60, 100, 150, 200, 300, 400];
const R = { list: [], timing: "elec", pending: null };
function sanitizeRec(r) {
  if (!r || typeof r !== "object") return null;
  if (typeof r.id !== "string" || !/^r[a-z0-9]{4,40}$/.test(r.id)) return null;
  const dist = numIn(r.dist, 1, 50000), time = numIn(r.time, 0.01, 36000);
  if (dist == null || time == null) return null;
  if (typeof r.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return null;
  return { id: r.id, dist: Math.round(dist), time, wind: numIn(r.wind, -20, 20), timing: r.timing === "hand" ? "hand" : "elec", date: r.date, meet: str(r.meet, 60) };
}
function loadRecs() { const raw = lsGet(LS_REC, []); R.list = Array.isArray(raw) ? raw.map(sanitizeRec).filter(Boolean) : []; }
function saveRecs() { if (!lsSet(LS_REC, R.list)) toast("保存できませんでした。端末の空き容量を確認してください"); }
function windAffected(d) { return d <= 200; }
// 公認として扱える記録か（電気計時、かつ200m以下は追い風2.0以下。風速未入力は公認扱い）
function isLegal(r) { return r.timing === "elec" && !(windAffected(r.dist) && r.wind != null && r.wind > 2.0); }
function recLabel(r, dp) {
  const w = windAffected(r.dist) && r.wind != null ? `（${fmtWind(r.wind)}）` : "";
  return fmt(r.time, r.timing === "hand" ? 1 : dp) + (r.timing === "hand" ? "（手）" : "") + w;
}
// 日記の試合結果を記録の形にする
function raceRecs(e, upto) {
  const out = [];
  e.races.forEach((x, i) => {
    if (upto != null && i >= upto) return;
    if (x.event !== "ind") return;
    out.push({ id: "x" + e.id + "-" + i, dist: x.dist, time: x.time, wind: x.wind, timing: x.timing, date: e.date, meet: [e.meet, x.round].filter(Boolean).join(" "), src: "race" });
  });
  return out;
}
// 手入力の記録＋保存済みの日記の試合結果（skipId の日記は除く）
function allRecs(skipId) {
  let a = R.list.slice();
  S.entries.forEach((e) => { if (e.id !== skipId) a = a.concat(raceRecs(e)); });
  return a;
}
function bestOf(list) { return list.reduce((b, r) => (!b || r.time < b.time ? r : b), null); }
function pbOf(list, d, year) { return bestOf(list.filter((r) => r.dist === d && isLegal(r) && (!year || r.date.startsWith(year + "-")))); }
// 日記 e の i 番目のレースが、その時点で PB か SB か
function raceMark(e, i) {
  const x = e.races[i];
  if (!x || x.event !== "ind") return "";
  const me = { dist: x.dist, time: x.time, wind: x.wind, timing: x.timing };
  if (!isLegal(me)) return "";
  const prior = allRecs(e.id).filter((r) => r.date <= e.date).concat(raceRecs(e, i));
  const pb = pbOf(prior, x.dist);
  if (!pb || x.time < pb.time) return "PB";
  const sb = pbOf(prior, x.dist, e.date.slice(0, 4));
  if (!sb || x.time < sb.time) return "SB";
  return "";
}
function buildRecords() {
  loadRecs();
  const ev = $("#rEvent");
  ev.innerHTML = REC_EVENTS.map((d) => `<button type="button" class="chip num" data-v="${d}" aria-pressed="${d === 100}">${d}m</button>`).join("");
  chipGroup(ev, (v) => { $("#rDist").value = v; syncRecWind(); });
  $("#rDist").addEventListener("input", () => { setChip(ev, String(Number(toHalf($("#rDist").value)))); syncRecWind(); });
  chipGroup($("#rTiming"), (v) => { R.timing = v; });
  $("#rDate").value = todayStr();
  $("#sbYear").textContent = new Date().getFullYear();
  $("#rAdd").addEventListener("click", () => {
    const dist = Number(toHalf($("#rDist").value)), time = parseTime($("#rTime").value);
    if (!(dist > 0 && dist <= 50000)) { toast("距離を入れてください"); return; }
    if (!isFinite(time)) { toast("タイムを入れてください（例：11.20）"); return; }
    const ws = $("#rWind").value.trim();
    const wind = ws ? parseWind(ws) : null;
    if (ws && (!isFinite(wind) || Math.abs(wind) > 20)) { toast("風速は +1.2 や -0.5 のように入れてください"); return; }
    const rec = sanitizeRec({ id: newId("r"), dist, time: Math.round(time * 100) / 100, wind, timing: R.timing, date: $("#rDate").value || todayStr(), meet: $("#rMeet").value.trim() });
    if (!rec) { toast("記録を追加できませんでした"); return; }
    const before = pbOf(allRecs(), rec.dist);
    R.list.push(rec); saveRecs();
    $("#rTime").value = ""; $("#rWind").value = ""; $("#rMeet").value = "";
    renderRecords();
    toast(isLegal(rec) && (!before || rec.time < before.time) ? "PB更新！ おめでとうございます" : "記録を追加しました");
  });
  syncRecWind();
}
function syncRecWind() { const d = Number(toHalf($("#rDist").value)); $("#rWind").disabled = !(d > 0 && windAffected(d)); if ($("#rWind").disabled) $("#rWind").value = ""; }
function renderRecords() {
  const year = String(new Date().getFullYear());
  const all = allRecs();
  const ds = Array.from(new Set(all.map((r) => r.dist))).sort((a, b) => a - b);
  $("#pbTable tbody").innerHTML = ds.map((d) => {
    const pb = pbOf(all, d), sb = pbOf(all, d, year);
    const ref = bestOf(all.filter((r) => r.dist === d && !isLegal(r)));
    const refHtml = ref && (!pb || ref.time < pb.time) ? `<br><span class="hint">参考 ${esc(recLabel(ref, 2))}</span>` : "";
    const cell = (r) => (r ? `<span class="num lg${r === pb ? " pbmark" : ""}">${esc(fmt(r.time))}</span><br><span class="hint">${esc(r.date.replace(/-/g, "/"))}${windAffected(d) && r.wind != null ? " " + fmtWind(r.wind) : ""}${r.meet ? " " + esc(r.meet) : ""}</span>` : "—");
    return `<tr><td class="num">${d}m</td><td>${cell(pb)}${refHtml}</td><td>${cell(sb)}</td></tr>`;
  }).join("");
  $("#pbEmpty").hidden = ds.length > 0;
  $("#pbTable").hidden = ds.length === 0;
  // リレー（チームのベスト）
  const relays = {};
  S.entries.forEach((e) => e.races.forEach((x) => {
    if (x.event !== "relay") return;
    const k = raceName(x);
    if (!relays[k] || x.time < relays[k].x.time) relays[k] = { x, e };
  }));
  const rk = Object.keys(relays).sort();
  $("#relayBox").hidden = rk.length === 0;
  $("#relayTable tbody").innerHTML = rk.map((k) => {
    const { x, e } = relays[k];
    return `<tr><td>${esc(k)}</td><td><span class="num lg">${esc(fmt(x.time, x.timing === "hand" ? 1 : 2))}</span>${x.timing === "hand" ? "（手）" : ""}<br><span class="hint">${esc(e.date.replace(/-/g, "/"))}</span></td><td class="hint">${esc([e.meet, x.round].filter(Boolean).join(" "))}${x.leg ? "<br>" + x.leg + "走" : ""}${x.split ? " 区間" + esc(fmt(x.split, x.timing === "hand" ? 1 : 2)) : ""}</td></tr>`;
  }).join("");
  // 手で入れた記録の一覧
  const rs = R.list.slice().sort((a, b) => b.date.localeCompare(a.date));
  $("#recList").innerHTML = rs.length ? `<h3>手で入れた記録</h3>` + rs.map((r) => `<div class="menuitem"><span class="t"><span class="num lg">${r.dist}m ${esc(recLabel(r, 2))}</span><br><span class="hint">${esc(r.date.replace(/-/g, "/"))}${r.meet ? "　" + esc(r.meet) : ""}${isLegal(r) ? "" : "　PB・SBの対象外"}</span></span><button type="button" class="btn small danger" data-rdel="${esc(r.id)}">${R.pending === r.id ? "本当に削除する" : "削除"}</button></div>`).join("") + `<p class="hint">試合結果から入った記録は、日記を編集すると直せます。</p>` : "";
  $$("[data-rdel]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.rdel;
    if (R.pending === id) { R.pending = null; R.list = R.list.filter((x) => x.id !== id); saveRecs(); renderRecords(); toast("削除しました"); }
    else { R.pending = id; renderRecords(); setTimeout(() => { if (R.pending === id) { R.pending = null; renderRecords(); } }, 4000); }
  }));
}

/* ---------- 練習ベスト（ランメニューごと） ---------- */
function renderPracBest() {
  const B = {}; // key -> { segs, elec:{one,avg}, hand:{one,avg} }
  S.entries.forEach((e) => e.menu.forEach((m) => {
    if (m.up) return; // アップのランは入れない
    const k = menuKey(m);
    B[k] = B[k] || { segs: m.segs, elec: { one: null, avg: null }, hand: { one: null, avg: null } };
    const b = B[k][m.timing];
    const full = m.times.filter((rep) => rep && rep.length === m.segs.length && rep.every((t) => t != null));
    full.forEach((rep) => {
      const tot = rep.reduce((a, t) => a + t, 0);
      if (!b.one || tot < b.one.t) b.one = { t: tot, split: rep, date: e.date, link: m.link, kind: kindLabel(m) };
    });
    if (full.length >= 2) {
      const avg = full.reduce((a, rep) => a + rep.reduce((x, t) => x + t, 0), 0) / full.length;
      if (!b.avg || avg < b.avg.t) b.avg = { t: avg, n: full.length, date: e.date, link: m.link, kind: kindLabel(m) };
    }
  }));
  const keys = Object.keys(B).filter((k) => ["elec", "hand"].some((tm) => B[k][tm].one)).sort((a, b) => B[a].segs.reduce((x, y) => x + y, 0) - B[b].segs.reduce((x, y) => x + y, 0) || a.localeCompare(b));
  const dd = (d) => d.slice(5).replace("-", "/");
  $("#pracBest").innerHTML = keys.length ? keys.map((k) => {
    const multi = B[k].segs.length > 1;
    const rows = ["elec", "hand"].filter((tm) => B[k][tm].one).map((tm) => {
      const dp = tm === "hand" ? 1 : 2, b = B[k][tm];
      const one = `1本 <span class="num lg">${fmt(b.one.t, dp)}</span>${multi ? `（${b.one.split.map((t) => fmt(t, dp)).join("+")}）` : ""} <span class="hint">${dd(b.one.date)}${b.one.kind ? " " + esc(b.one.kind) : ""}${multi && b.one.link ? " つなぎ " + esc(b.one.link) : ""}</span>`;
      const avg = b.avg ? `平均 <span class="num lg">${fmt(b.avg.t, dp)}</span> <span class="hint">${b.avg.n}本 ${dd(b.avg.date)}${multi && b.avg.link ? " つなぎ " + esc(b.avg.link) : ""}</span>` : `<span class="hint">平均は2本以上測った日から出ます</span>`;
      return `<div class="pbrow"><span class="pill">${tm === "hand" ? "手動" : "電気"}</span><div>${one}<br>${avg}</div></div>`;
    }).join("");
    return `<div class="entry"><div class="date">${esc(multi ? segsStr(B[k].segs) : k)}</div>${rows}</div>`;
  }).join("") : `<p class="hint">ランメニューにタイムを入れて保存すると、メニューごとのベストが出ます。</p>`;
}

/* ---------- 記録タブ ---------- */
let pendingDel = null;
function renderLog() {
  const es = S.entries.slice().sort((a, b) => b.date.localeCompare(a.date) || (b.time || "").localeCompare(a.time || "") || b.createdAt - a.createdAt);
  // 今週のまとめ
  const mon = new Date(); mon.setHours(0, 0, 0, 0); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  const monS = ymd(mon);
  const wk = es.filter((e) => e.date >= monS && !e.marks.includes("休養"));
  $("#sWeek").textContent = new Set(wk.map((e) => e.date)).size;
  $("#sStrong").textContent = new Set(wk.filter((e) => e.intensity === "強").map((e) => e.date)).size;
  $("#sDist").textContent = wk.reduce((s, e) => s + e.menu.reduce((a, m) => a + m.segs.reduce((x, y) => x + y, 0) * m.reps * m.sets, 0), 0).toLocaleString();
  // 一覧
  $("#entryList").innerHTML = es.length ? es.map((e) => {
    const d = new Date(e.date + "T00:00:00");
    const meta = [e.wx ? wxText(e.wx) : [e.weather, e.temp ? e.temp + "℃" : "", e.wind].filter(Boolean).join(" "), e.fatigue ? "疲労度 " + e.fatigue : "", e.cond ? "調子" + e.cond : ""].filter(Boolean).join("　");
    const lines = [].concat(e.races.map((x, i) => raceLine(x, raceMark(e, i))), flowLines(e, false));
    return `<div class="entry"><div class="head"><span class="date">${d.getMonth() + 1}/${d.getDate()}</span><span class="hint">${"日月火水木金土"[d.getDay()]}曜${e.time ? " " + esc(e.time) + (e.timeEnd ? "–" + esc(e.timeEnd) : "") : ""}</span>${headTokens(e).map((t) => `<span class="pill${t === "試合" ? " pb" : ""}">${esc(t)}</span>`).join("")}${e.intensity ? `<span class="pill int">強度 ${esc(e.intensity)}</span>` : ""}</div>
      ${(e.meet && e.races.length) || placeLine(e) ? `<div class="hint">${esc([e.races.length ? e.meet : "", placeLine(e)].filter(Boolean).join("　"))}</div>` : ""}
      ${lines.length ? `<div class="menu num">${lines.map(esc).join("<br>")}</div>` : ""}
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
  renderRecords();
  renderPracBest();
  renderBackupInfo();
}
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
    if (!r.ok) { const e = new Error("http"); e.status = r.status; throw e; }
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
  } else if (wxLoc()) {
    s.textContent = "場所：" + wxLoc().name + "。保存するときにも自動で取得します。";
  } else {
    s.textContent = "会場に場所を登録するか、下の「天気を取る場所」を設定すると、天気を自動で取得できます。";
  }
}
async function doWeather(silent) {
  const loc = wxLoc();
  if (!loc) { if (!silent) { $("#locBox").open = true; $("#wxStatus").textContent = "先に、下の「天気を取る場所」を設定してください。"; $("#locBox").scrollIntoView({ block: "center" }); } return false; }
  readForm();
  const btn = $("#wxBtn");
  btn.disabled = true; btn.textContent = "取得中…";
  try {
    const wx = await fetchWeather(F.date, F.time, loc);
    applyWx(wx);
    if (!silent) toast("天気を取得しました");
    return true;
  } catch (e) {
    const m = e && e.message === "future" ? "その日付の天気はまだ取得できません（予報は2週間先まで）" :
      e && e.message === "nodata" ? "その日時の天気データがありませんでした" :
      e && e.message === "format" ? "天気サービスから予想と違う返事が来ました（format）" :
      e && e.message === "http" ? "天気サービスがエラーを返しました（HTTP " + e.status + "）。少し時間をおいて試してください" :
      e && e.name === "AbortError" ? "天気の取得に時間がかかりすぎました（10秒）。電波の良い所で試してください" :
      e && e.name === "TypeError" ? "天気サービス（api.open-meteo.com）につながりませんでした。圏外か、広告ブロッカーやコンテンツブロッカーで止められている可能性があります（" + String(e.message).slice(0, 60) + "）" :
      "天気を取得できませんでした（" + String(e && e.message).slice(0, 60) + "）";
    // 失敗の理由は消えないように画面に残す
    if (!silent) { toast("天気を取得できませんでした"); $("#wxStatus").textContent = m; }
    return false;
  } finally { btn.disabled = false; btn.textContent = "天気を自動で取得"; }
}

/* ---------- 場所の設定 ---------- */
function renderLoc() {
  const l = getLoc();
  $("#locSummary").textContent = "天気を取る場所：" + (l ? l.name + "（" + l.lat.toFixed(2) + ", " + l.lon.toFixed(2) + "）・変更する" : "未設定（ここを押して設定）");
  if (F) renderWxStatus();
}
function buildLoc() {
  $("#geoBtn").addEventListener("click", () => {
    if (!navigator.geolocation) { toast("この端末では現在地を使えません。地名で探してください"); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { setLoc(p.coords.latitude, p.coords.longitude, "現在地（" + new Date().toLocaleDateString("ja-JP") + "）"); $("#locBox").open = false; toast("場所を設定しました"); },
      (err) => { $("#locResults").textContent = err && err.code === 1 ? "位置情報の使用が許可されていません。端末の設定でブラウザの位置情報を許可するか、地名で探してください。" : "現在地を取得できませんでした。地名で探してください。"; },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
    );
  });
  const search = async () => {
    const q = $("#locQ").value.trim().slice(0, 40);
    if (!q) return;
    const box = $("#locResults");
    box.textContent = "検索中…";
    try {
      const j = await getJSON("https://geocoding-api.open-meteo.com/v1/search?" + new URLSearchParams({ name: q, count: "10", language: "ja", format: "json" }).toString());
      // 同じ名前の地名が複数あるので、日本の候補を先に、人口の多い順に並べる
      const rs = (j && Array.isArray(j.results) ? j.results : [])
        .filter((r) => r && numIn(r.latitude, -90, 90) != null && numIn(r.longitude, -180, 180) != null)
        .sort((a, b) => (b.country_code === "JP") - (a.country_code === "JP") || (numIn(b.population, 0, 1e10) || 0) - (numIn(a.population, 0, 1e10) || 0));
      box.textContent = "";
      if (!rs.length) { box.textContent = "見つかりませんでした。別の書き方で試してください（例：鳥取）"; return; }
      rs.forEach((r) => {
        // 外部からの文字列は textContent で入れる
        const b = document.createElement("button");
        b.type = "button"; b.className = "btn small locitem";
        const name = [r.name, r.admin2, r.admin1, r.country_code === "JP" ? "" : r.country].filter((x) => typeof x === "string" && x).join("・").slice(0, 60);
        b.textContent = name;
        b.addEventListener("click", () => { setLoc(r.latitude, r.longitude, String(r.name || name).slice(0, 60)); box.textContent = ""; $("#locBox").open = false; toast("場所を設定しました"); });
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
  const data = { app: "sprint-log", version: 3, exportedAt: new Date().toISOString(), entries: S.entries, records: R.list };
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
    let radd = 0;
    if (Array.isArray(j.records)) {
      j.records.slice(0, 5000).map(sanitizeRec).filter(Boolean).forEach((r) => { if (!R.list.some((x) => x.id === r.id)) { R.list.push(r); radd++; } });
      saveRecs();
    }
    renderLog();
    toast("読み込みました（日記 新規 " + add + " 件・更新 " + upd + " 件、試合記録 " + radd + " 件）");
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


/* ---------- 練習の流れ（順番とアップ） ---------- */
function buildFlow() {
  chipGroup($("#upMode"), (v) => { F.upMode = v === "detail" ? "detail" : "short"; updatePost(); });
}
function renderFlow() {
  if (!F) return;
  syncOrder(F);
  const items = flowItems(F);
  const el = $("#flowList");
  $("#flowCard").hidden = items.length === 0;
  $("#upModeWrap").hidden = !items.some((x) => x.it.up);
  const tag = { run: "ラン", w: "ウエイト", o: "その他" };
  el.innerHTML = items.map((x, i) => `<div class="menuitem${x.it.up ? " isup" : ""}"><span class="t"><span class="pill">${x.it.up ? "アップ" : tag[x.t]}</span> <span class="num">${esc(itemLine(x))}</span></span>${x.t === "w" ? "" : `<button type="button" class="btn small${x.it.up ? " on" : ""}" data-f="${i}" data-act="up" aria-pressed="${x.it.up}">アップ</button>`}<button type="button" class="btn small" data-f="${i}" data-act="mv-1" aria-label="上へ" ${i === 0 ? "disabled" : ""}>↑</button><button type="button" class="btn small" data-f="${i}" data-act="mv1" aria-label="下へ" ${i === items.length - 1 ? "disabled" : ""}>↓</button></div>`).join("");
  el.querySelectorAll("[data-f]").forEach((b) => b.addEventListener("click", () => {
    const i = Number(b.dataset.f), a = b.dataset.act;
    if (a === "up") items[i].it.up = !items[i].it.up;
    else {
      const j = i + (a === "mv1" ? 1 : -1);
      if (j < 0 || j >= F.order.length) return;
      const t = F.order[i]; F.order[i] = F.order[j]; F.order[j] = t;
    }
    renderMenuList(); renderExtraList();
    updatePost();
  }));
}

/* ---------- 会場・練習会 ---------- */
const V = { pending: null, lat: null, lon: null, place: "" };
function getVenues() {
  const v = lsGet(LS_VENUES, []);
  return Array.isArray(v) ? v.slice(0, 50).map((x) => (x && typeof x === "object" && str(x.name, 40) ? { name: str(x.name, 40), lat: numIn(x.lat, -90, 90), lon: numIn(x.lon, -180, 180), place: str(x.place, 60) } : null)).filter(Boolean) : [];
}
function getSessions() { const v = lsGet(LS_SESSIONS, []); return Array.isArray(v) ? v.slice(0, 50).map((x) => str(x, 40)).filter(Boolean) : []; }
// 天気を取る場所：会場に場所が登録されていればそこ、なければ「天気を取る場所」
function wxLoc() {
  const v = F && F.venue ? getVenues().find((x) => x.name === F.venue) : null;
  if (v && v.lat != null && v.lon != null) return { lat: v.lat, lon: v.lon, name: v.name };
  return getLoc();
}
function renderVenueChips() {
  const vs = getVenues(), ss = getSessions();
  const vn = vs.map((v) => v.name);
  if (F.venue && !vn.includes(F.venue)) vn.push(F.venue); // 登録を消した会場も、過去の日記では表示する
  $("#fVenue").innerHTML = vn.length ? chipsHTML(vn, F.venue) : `<span class="hint">下の「会場・練習会を登録する」から登録すると、ここで選べます。</span>`;
  const sn = ss.slice();
  if (F.session && !sn.includes(F.session)) sn.push(F.session);
  $("#fSession").innerHTML = sn.length ? chipsHTML(sn, F.session) : `<span class="hint">普段と違う練習会を登録すると、ここで選べます。</span>`;
  $("#vList").innerHTML = vs.map((v) => `<div class="menuitem"><span class="t">${esc(v.name)}<br><span class="hint">${v.lat != null ? "天気：" + esc(v.place || "登録した場所") + "（" + v.lat.toFixed(2) + ", " + v.lon.toFixed(2) + "）" : "場所なし"}</span></span><button type="button" class="btn small danger" data-vdel="${esc(v.name)}">${V.pending === "v:" + v.name ? "本当に削除する" : "削除"}</button></div>`).join("");
  $("#sList").innerHTML = ss.map((n) => `<div class="menuitem"><span class="t">${esc(n)}</span><button type="button" class="btn small danger" data-sdel="${esc(n)}">${V.pending === "s:" + n ? "本当に削除する" : "削除"}</button></div>`).join("");
  const del = (key, fn) => { if (V.pending === key) { V.pending = null; fn(); } else { V.pending = key; setTimeout(() => { if (V.pending === key) { V.pending = null; renderVenueChips(); } }, 4000); } renderVenueChips(); };
  $$("[data-vdel]").forEach((b) => b.addEventListener("click", () => del("v:" + b.dataset.vdel, () => lsSet(LS_VENUES, getVenues().filter((x) => x.name !== b.dataset.vdel)))));
  $$("[data-sdel]").forEach((b) => b.addEventListener("click", () => del("s:" + b.dataset.sdel, () => lsSet(LS_SESSIONS, getSessions().filter((x) => x !== b.dataset.sdel)))));
}
function renderVLoc() { $("#vLocInfo").textContent = V.lat != null ? "場所：" + (V.place || "今いる場所") + "（" + V.lat.toFixed(2) + ", " + V.lon.toFixed(2) + "）" : "場所：なし（天気は「天気を取る場所」で取得します）"; }
function buildVenue() {
  toggleChips($("#fVenue"), () => F.venue, (v) => {
    F.venue = v; setChip($("#fVenue"), v);
    if (v) lsSet(LS_LASTVENUE, v);
    if (F.wx) { F.wx = null; } // 会場が変われば天気は取り直す
    renderWxStatus(); updatePost();
  });
  toggleChips($("#fSession"), () => F.session, (v) => { F.session = v; setChip($("#fSession"), v); updatePost(); });
  $("#vGeo").addEventListener("click", () => {
    if (!navigator.geolocation) { toast("この端末では現在地を使えません。地名で探してください"); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { V.lat = Math.round(p.coords.latitude * 100) / 100; V.lon = Math.round(p.coords.longitude * 100) / 100; V.place = "今いる場所"; renderVLoc(); },
      (err) => { $("#vResults").textContent = err && err.code === 1 ? "位置情報の使用が許可されていません。地名で探してください。" : "現在地を取得できませんでした。地名で探してください。"; },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
  });
  const search = async () => {
    const q = $("#vQ").value.trim().slice(0, 40);
    if (!q) return;
    const box = $("#vResults");
    box.textContent = "検索中…";
    try {
      const rs = await geoSearch(q);
      box.textContent = "";
      if (!rs.length) { box.textContent = "見つかりませんでした。別の書き方で試してください（例：鳥取）"; return; }
      rs.forEach((r) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "btn small locitem";
        b.textContent = r.label;
        b.addEventListener("click", () => { V.lat = Math.round(r.lat * 100) / 100; V.lon = Math.round(r.lon * 100) / 100; V.place = r.name; box.textContent = ""; renderVLoc(); });
        box.appendChild(b);
      });
    } catch (e) { box.textContent = "検索できませんでした。通信状態を確認してください"; }
  };
  $("#vSearch").addEventListener("click", search);
  $("#vQ").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } });
  $("#vAdd").addEventListener("click", () => {
    const name = $("#vName").value.trim().slice(0, 40);
    if (!name) { toast("会場の名前を入れてください"); return; }
    const vs = getVenues().filter((x) => x.name !== name); // 同じ名前は上書き
    vs.push({ name, lat: V.lat, lon: V.lon, place: V.place });
    lsSet(LS_VENUES, vs);
    $("#vName").value = ""; $("#vQ").value = ""; V.lat = V.lon = null; V.place = ""; renderVLoc();
    F.venue = name; lsSet(LS_LASTVENUE, name); F.wx = null;
    renderVenueChips(); renderWxStatus(); updatePost();
    toast("会場を登録しました");
  });
  $("#sAdd").addEventListener("click", () => {
    const name = $("#sName").value.trim().slice(0, 40);
    if (!name) { toast("練習会の名前を入れてください"); return; }
    const ss = getSessions().filter((x) => x !== name); ss.push(name); lsSet(LS_SESSIONS, ss);
    $("#sName").value = "";
    F.session = name;
    renderVenueChips(); updatePost();
    toast("練習会を登録しました");
  });
  renderVLoc();
}
// 地名検索（日本の候補を先に、人口の多い順）
async function geoSearch(q) {
  const j = await getJSON("https://geocoding-api.open-meteo.com/v1/search?" + new URLSearchParams({ name: q, count: "10", language: "ja", format: "json" }).toString());
  return (j && Array.isArray(j.results) ? j.results : [])
    .filter((r) => r && numIn(r.latitude, -90, 90) != null && numIn(r.longitude, -180, 180) != null)
    .sort((a, b) => (b.country_code === "JP") - (a.country_code === "JP") || (numIn(b.population, 0, 1e10) || 0) - (numIn(a.population, 0, 1e10) || 0))
    .map((r) => ({ lat: r.latitude, lon: r.longitude, name: String(r.name || "").slice(0, 60), label: [r.name, r.admin2, r.admin1, r.country_code === "JP" ? "" : r.country].filter((x) => typeof x === "string" && x).join("・").slice(0, 60) }));
}

/* ---------- 起動 ---------- */
loadEntries();
buildRecords();
buildDiary(); buildRun(); buildWeight(); buildExtra(); buildRace(); buildFlow(); buildVenue();
buildConvert(); buildWind(); buildPace(); buildLoc(); buildBackup();
loadForm(blankEntry());
renderConvert(); renderWind(); renderPace(); renderLog();
window.addEventListener("hashchange", route);
route();
// 旧い形式で保存されていたデータを新しい形式で保存し直す
persist();
// ブラウザにデータを消されにくくする（対応ブラウザのみ）
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
// オフラインでも開けるようにする
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
