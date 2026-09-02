/* ─── 階層モード ──────────────────────────────────────────────────────────
 * 複数部屋の切替・扉の両側自動生成・タグ辞書・検証・オーバービュー・zip 入出力。
 * index.html のエディタ（state / els / applyRulesAndRender など）をそのまま使い、
 * window.Floor のフックだけを index.html 側から呼ぶ。
 * ───────────────────────────────────────────────────────────────────────── */
(() => {
"use strict";

const FLOOR_KEY = "aiya-map-forge-floor-v1";
const SEED_URL  = "floors/stage02/floor.json";
const ROOM_HUES = [168, 14, 268, 40, 205, 330, 95, 0, 235, 60, 140, 300];
const KIND_COLOR = { start:"#b8306b", exit:"#227166", memo:"#6b5ca5", trig:"#cc4f2f", shadow:"#22241f", gimmick:"#d59e24" };
const KIND_LABEL = { start:"スポーン", exit:"扉", memo:"壁メモ", trig:"トリガー/ゾーン", shadow:"思念体", gimmick:"配置物" };

const F = { floor:null, active:null, pending:null, issues:[], layout:null, ovHits:[], ovDrag:null, highlight:null, hlRaf:0, ovRaf:0, idAtFocus:"" };
const ui = {};

// ─── 小道具 ─────────────────────────────────────────────────────────────
const q = sel => document.querySelector(sel);
const el = (tag, cls, text) => { const e=document.createElement(tag); if(cls) e.className=cls; if(text!==undefined) e.textContent=text; return e; };
const kindOf = t => t==="start" ? "start" : t.startsWith("exit,") ? "exit" : t.startsWith("memo_") ? "memo" : (/trigger$/.test(t) || t==="dmg_zone") ? "trig" : t==="shadow" ? "shadow" : "gimmick";
const exitTarget = t => t.startsWith("exit,") ? t.slice(5).trim() : null;
const roomById = id => F.floor ? F.floor.rooms.find(r => r.id===id) || null : null;
const roomIndex = room => F.floor ? F.floor.rooms.indexOf(room) : -1;
const roomHue = room => ROOM_HUES[Math.max(0, roomIndex(room)) % ROOM_HUES.length];
const roomColor = (room, l=64, s=55) => `hsl(${roomHue(room)} ${s}% ${l}%)`;
const shortOf = id => roomById(id)?.short || String(id).replace(/^\d\d-/, "");
const nameOf = id => { const r=roomById(id); return r ? `${r.short||r.id}` : id; };
const hexA = (hex, a) => { const n=parseInt(hex.slice(1),16); return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`; };
const roomPoints = room => room===F.active ? state.points : room.points;
const roomMap = room => room===F.active ? state.sourceMap : room.map;
const setStatus = msg => { els.status.textContent = msg; };
const inFloor = () => !!F.floor;

// ─── 部屋の切替 ────────────────────────────────────────────────────────────
function stash(room) {
  if (!room) return;
  room.map = state.sourceMap; room.points = state.points;
  room.history = state.history; room.future = state.future;
  room.id = els.id.value.trim() || room.id; room.type = els.type.value.trim();
}

function activate(room, { fit=true } = {}) {
  if (!room) return;
  if (F.active && F.active !== room) stash(F.active);
  F.active = room;
  state.sourceMap = room.map; state.points = room.points;
  state.history = room.history || []; state.future = room.future || [];
  state.selections = null; state.preview = null;
  els.id.value = room.id; els.type.value = room.type || "";
  const h = room.map.length, w = room.map[0]?.length || 0;
  els.size.value = Math.max(w, h); els.cut.value = Math.max(w, h);
  applyRulesAndRender();
  if (fit) fitView();
  renderTabs(); renderRoomMeta();
}

function switchBy(delta) {
  if (!inFloor() || !F.active) return;
  const i = roomIndex(F.active), n = F.floor.rooms.length;
  activate(F.floor.rooms[(i + delta + n) % n]);
}

// ─── 永続化 ────────────────────────────────────────────────────────────────
function serializeFloor() {
  if (!F.floor) return null;
  if (F.active) stash(F.active);
  return {
    schema: F.floor.schema || "aiya-floor/v1", id: F.floor.id, name: F.floor.name, note: F.floor.note || "",
    tags: F.floor.tags || {},
    rooms: F.floor.rooms.map(r => ({ file:r.file, id:r.id, name:r.name, short:r.short, type:r.type||"", pos:r.pos||null, map:r.map, points:r.points }))
  };
}

function saveFloor() {
  try {
    if (!F.floor) { localStorage.removeItem(FLOOR_KEY); return; }
    localStorage.setItem(FLOOR_KEY, JSON.stringify({ floor: serializeFloor(), activeId: F.active?.id || null, overviewOpen: !ui.overview.hidden }));
  } catch {}
}

function loadFloorLocal() {
  try {
    const saved = JSON.parse(localStorage.getItem(FLOOR_KEY) || "null");
    if (!saved?.floor?.rooms?.length) return false;
    setFloor(saved.floor, saved.activeId, { fit:true });
    ui.overview.hidden = saved.overviewOpen === false;
    return true;
  } catch { localStorage.removeItem(FLOOR_KEY); return false; }
}

// ─── 階層の構築 ────────────────────────────────────────────────────────────
function normalizeRoom(raw, fallbackFile) {
  const map = normalizeImportedMap(raw.map);
  const points = normalizeImportedPoints(raw.points, map[0].length, map.length);
  const id = String(raw.id ?? "").trim() || "ROOM";
  return {
    file: raw.file || fallbackFile || `${id}.json`, id,
    name: raw.name || id, short: raw.short || shortFrom(id),
    type: raw.type ? String(raw.type) : "", pos: raw.pos && Number.isFinite(raw.pos.x) ? { x:raw.pos.x, y:raw.pos.y } : null,
    map, points, history: [], future: []
  };
}
const shortFrom = id => String(id).replace(/^\d\d-/, "").slice(0, 8);

function setFloor(payload, activeId, { fit=true } = {}) {
  const rooms = (payload.rooms || []).map(r => normalizeRoom(r));
  if (!rooms.length) throw new Error("部屋がありません。");
  F.active = null; F.pending = null; closePop(); hideBanner();
  F.floor = { schema:"aiya-floor/v1", id: payload.id || "floor", name: payload.name || "階層", note: payload.note || "", tags: payload.tags || {}, rooms };
  const start = rooms.find(r => r.id===activeId) || rooms.find(r => r.points.some(p => p.tag==="start")) || rooms[0];
  ui.strip.hidden = false; ui.section.hidden = false; ui.overview.hidden = false; ui.empty.hidden = true;
  activate(start, { fit });
  saveFloor();
}

function closeFloor() {
  if (!inFloor()) return;
  if (!confirm(`階層「${F.floor.name}」を閉じて単一マップモードに戻ります。\n（ブラウザに保存された階層データも消えます。書き出しは済んでいますか？）`)) return;
  F.floor = null; F.active = null; F.pending = null; closePop(); hideBanner();
  localStorage.removeItem(FLOOR_KEY);
  ui.strip.hidden = true; ui.section.hidden = true; ui.overview.hidden = true; ui.chipsWrap.hidden = true; ui.empty.hidden = false;
  state.history = []; state.future = [];
  applyRulesAndRender();
  setStatus("単一マップモードに戻りました。");
}

async function loadSeed() {
  if (inFloor() && !confirm("現在の階層を置き換えて第2階層（現行データ）を読み込みます。よろしいですか？")) return;
  try {
    setStatus("第2階層を読み込み中…");
    const manifest = await (await fetch(SEED_URL, { cache:"no-store" })).json();
    const base = SEED_URL.slice(0, SEED_URL.lastIndexOf("/") + 1);
    const rooms = await Promise.all(manifest.rooms.map(async m => {
      const res = await fetch(base + m.file, { cache:"no-store" });
      if (!res.ok) throw new Error(`${m.file} を取得できません (${res.status})`);
      const j = await res.json();
      return { ...m, ...j, name: m.name, short: m.short, file: m.file };
    }));
    setFloor({ ...manifest, rooms }, null);
    setStatus(`第2階層を読み込みました（${rooms.length} 部屋）。`);
  } catch (e) {
    alert(`読み込みに失敗しました: ${e.message}\n\nfile:// で開いている場合は fetch が使えません。GitHub Pages か、ローカルの HTTP サーバー経由で開くか、「ファイルから読み込む」で floors/stage02 の JSON をまとめて選択してください。`);
    setStatus("読み込み失敗。");
  }
}

function loadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  Promise.all(files.map(f => f.text().then(t => ({ name:f.name, json:JSON.parse(t) })).catch(e => { throw new Error(`${f.name}: ${e.message}`); })))
    .then(entries => {
      const manifest = entries.find(e => typeof e.json?.schema==="string" && e.json.schema.startsWith("aiya-floor"))?.json;
      const mapFiles = entries.filter(e => Array.isArray(e.json?.map));
      const embedded = (manifest?.rooms || []).filter(r => Array.isArray(r.map));
      if (!mapFiles.length && !embedded.length) throw new Error("マップ JSON（map 配列を持つファイル）が見つかりません。");
      if (inFloor() && !confirm("現在の階層を置き換えます。よろしいですか？")) return;
      const rooms = [];
      if (manifest) {
        for (const m of manifest.rooms || []) {
          const hit = mapFiles.find(e => e.name===m.file) || mapFiles.find(e => e.json.id===m.id);
          if (hit) { rooms.push({ ...m, ...hit.json, name:m.name, short:m.short, file:m.file || hit.name }); hit.used = true; }
          else if (Array.isArray(m.map)) rooms.push({ ...m });
        }
      }
      for (const e of mapFiles) if (!e.used) rooms.push({ ...e.json, file:e.name });
      setFloor({ id: manifest?.id || "custom", name: manifest?.name || "読み込んだ階層", note: manifest?.note || "", tags: manifest?.tags || {}, rooms }, null);
      setStatus(`${rooms.length} 部屋を読み込みました${manifest ? "（マニフェストあり）" : ""}。`);
    })
    .catch(e => alert(`読み込みに失敗しました: ${e.message}`));
}

// ─── 書き出し ──────────────────────────────────────────────────────────────
function roomPayload(room) {
  const final = applyRulesTo(roomMap(room), state.rules);
  const c = compressMap(final, roomPoints(room));
  const out = { id: room.id };
  if (room.type) out.type = room.type;
  out.size = c.size; out.map = c.map; out.points = c.points;
  return out;
}
const roomFileName = room => room.file || `${F.floor.id}-${room.id}.json`;
// Unity 側の書式（2スペース・末尾改行）に合わせる。無編集なら元ファイルとバイト一致する
const roomText = room => JSON.stringify(roomPayload(room), null, 2) + "\n";

function manifestPayload() {
  return {
    schema:"aiya-floor/v1", id:F.floor.id, name:F.floor.name, note:F.floor.note || "",
    rooms: F.floor.rooms.map(r => ({ file: roomFileName(r), id:r.id, name:r.name, short:r.short, ...(r.pos ? { pos:r.pos } : {}) })),
    tags: F.floor.tags || {}
  };
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportZip() {
  if (!inFloor()) return;
  stash(F.active);
  const files = F.floor.rooms.map(r => ({ name: roomFileName(r), text: roomText(r) }));
  files.push({ name:"floor.json", text: JSON.stringify(manifestPayload(), null, 2) + "\n" });
  if (window.JSZip) {
    const zip = new JSZip();
    const dir = zip.folder(F.floor.id);
    for (const f of files) dir.file(f.name, f.text);
    const blob = await zip.generateAsync({ type:"blob" });
    downloadBlob(blob, `${F.floor.id}-maps.zip`);
    setStatus(`zip を書き出しました（${files.length} ファイル）。`);
  } else {
    for (const f of files) downloadBlob(new Blob([f.text], { type:"application/json" }), f.name);
    setStatus(`JSZip が読み込めなかったため ${files.length} ファイルを個別にダウンロードしました。`);
  }
}

function downloadActiveRoom() {
  stash(F.active);
  downloadBlob(new Blob([roomText(F.active)], { type:"application/json" }), roomFileName(F.active));
  setStatus(`${roomFileName(F.active)} を書き出しました。`);
}

async function copyActiveRoom() {
  stash(F.active);
  await navigator.clipboard.writeText(roomText(F.active));
  setStatus(`${F.active.short} の JSON をコピーしました。`);
}

// ─── 辞書 ─────────────────────────────────────────────────────────────────
function dictFor(roomId) {
  const t = F.floor?.tags || {};
  return [...(t["*"] || []), ...(t[roomId] || [])];
}
function dictLabel(roomId, tag) {
  const k = kindOf(tag);
  if (k==="exit") { const target = exitTarget(tag); const r = roomById(target); return r ? `扉 → ${r.name}` : `扉 → ${target}（階層内に無い）`; }
  return dictFor(roomId).find(d => d.tag===tag)?.label || "";
}
function isKnownTag(roomId, tag) {
  const k = kindOf(tag);
  if (k==="exit" || k==="start") return true;
  return dictFor(roomId).some(d => d.tag===tag);
}

// ─── 検証 ─────────────────────────────────────────────────────────────────
function validate() {
  const issues = [];
  if (!inFloor()) { F.issues = issues; return issues; }
  const rooms = F.floor.rooms;
  const push = (sev, room, cell, msg) => issues.push({ sev, roomId: room?.id ?? null, cell, msg });

  const idCount = new Map();
  for (const r of rooms) idCount.set(r.id, (idCount.get(r.id) || 0) + 1);
  for (const r of rooms) if (idCount.get(r.id) > 1) push("error", r, null, `部屋 id「${r.id}」が重複しています`);

  let starts = 0;
  for (const r of rooms) {
    const pts = roomPoints(r), map = roomMap(r);
    const tagCount = new Map(), dupReported = new Set();
    for (const p of pts) tagCount.set(p.tag, (tagCount.get(p.tag) || 0) + 1);
    for (const p of pts) {
      const tag = p.tag, k = kindOf(tag), cell = p.position;
      const tile = map[cell.y]?.[cell.x];
      if (tag==="start") starts++;
      if (k==="exit") {
        const target = exitTarget(tag);
        const t = roomById(target);
        if (!target) push("error", r, cell, "扉タグの行き先が空です（exit,<部屋id>）");
        else if (!t) push("error", r, cell, `扉の行き先「${target}」が階層内にありません`);
        else if (t === r) push("warn", r, cell, "扉が自分の部屋を指しています");
        else if (!roomPoints(t).some(pp => exitTarget(pp.tag)===r.id)) push("error", r, cell, `${t.short} に「exit,${r.id}」の戻り扉がありません（到着地点が決まりません）`);
        if (tile === -2 || tile === undefined) push("warn", r, cell, `扉「${tag}」が空セル(-2)の上にあります`);
      } else {
        // 壁メモ・掛け絵・start など壁タイル上の配置は正規の使い方なので、空セル(-2)だけをエラーにする
        if (tile === -2 || tile === undefined) push("error", r, cell, `「${tag}」が空セル(-2)の上にあります`);
        if (!isKnownTag(r.id, tag)) push("info", r, cell, `「${tag}」は辞書に無いタグです（Unity 側の配線を確認）`);
      }
      if (tagCount.get(tag) > 1 && !dupReported.has(tag)) {
        dupReported.add(tag);
        push("warn", r, cell, tag === "start" ? "start が同じ部屋に複数あります" : k === "exit" ? `${shortOf(exitTarget(tag))} への扉が同じ部屋に ${tagCount.get(tag)} 個あります（到着地点が曖昧になります）` : `タグ「${tag}」が同じ部屋に ${tagCount.get(tag)} 個あります`);
      }
    }
    if (!tag0(map)) push("warn", r, null, "床(0)のセルがありません");
  }
  if (starts === 0) push("error", null, null, "階層に「start」がありません（先頭部屋に1つ必要）");
  else if (starts > 1) push("warn", null, null, `「start」が ${starts} 個あります（階層で1つが基本）`);

  // 到達性
  const startRoom = rooms.find(r => roomPoints(r).some(p => p.tag==="start")) || rooms[0];
  const seen = new Set([startRoom.id]); const queue = [startRoom];
  while (queue.length) {
    const a = queue.shift();
    for (const p of roomPoints(a)) { const t = roomById(exitTarget(p.tag) || ""); if (t && !seen.has(t.id)) { seen.add(t.id); queue.push(t); } }
  }
  for (const r of rooms) if (!seen.has(r.id)) push("warn", r, null, `${r.short} には start の部屋から扉をたどって到達できません`);

  const order = { error:0, warn:1, info:2 };
  issues.sort((a, b) => order[a.sev] - order[b.sev]);
  F.issues = issues;
  return issues;
}
const tag0 = map => map.some(row => row.some(v => v===0));
const issueCounts = roomId => {
  const c = { error:0, warn:0, info:0 };
  for (const i of F.issues) if (roomId===undefined || i.roomId===roomId) c[i.sev]++;
  return c;
};

// ─── 接続一覧 ─────────────────────────────────────────────────────────────
function connections() {
  const out = [];
  if (!inFloor()) return out;
  for (const a of F.floor.rooms) for (const p of roomPoints(a)) {
    const target = exitTarget(p.tag); if (target===null) continue;
    const b = roomById(target);
    const back = b ? roomPoints(b).find(pp => exitTarget(pp.tag)===a.id) : null;
    out.push({ a, cellA: p.position, b, cellB: back?.position || null, target, status: !b ? "bad" : !back ? "half" : "ok" });
  }
  return out;
}

// ─── 描画フック（メインキャンバス） ───────────────────────────────────────
function footprint(ctx, x, y, tw, fill, stroke, lw) {
  const p = gridToWorld(x, y), py = p.y + tw * 0.27, sy = tw * 0.285;
  ctx.save(); ctx.beginPath();
  ctx.moveTo(p.x, py); ctx.lineTo(p.x + tw/2, py + sy); ctx.lineTo(p.x, py + sy*2); ctx.lineTo(p.x - tw/2, py + sy); ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 2; ctx.stroke(); }
  ctx.restore();
}

function drawPoint(point, ctx, tw) {
  const tag = point.tag, k = kindOf(tag), color = KIND_COLOR[k];
  const p = gridToWorld(point.position.x, point.position.y), cx = p.x, cy = p.y + tw * 0.555;
  footprint(ctx, point.position.x, point.position.y, tw, hexA(color, 0.28), color, 2);
  ctx.save();
  ctx.fillStyle = color; ctx.strokeStyle = "#22241f"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, tw * 0.13, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  if (k==="exit") { ctx.fillStyle = "#fffdf8"; ctx.beginPath(); ctx.arc(cx, cy, tw * 0.05, 0, Math.PI * 2); ctx.fill(); }
  const label = k==="exit" ? `→ ${shortOf(exitTarget(tag))}` : tag;
  ctx.font = `900 ${Math.max(9, tw * 0.24)}px "Avenir Next","Gill Sans","Trebuchet MS",sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  ctx.lineWidth = 3.5; ctx.strokeStyle = "rgba(255,253,248,0.95)"; ctx.lineJoin = "round";
  ctx.strokeText(label, cx, cy - tw * 0.2); ctx.fillStyle = k==="exit" ? color : "#22241f"; ctx.fillText(label, cx, cy - tw * 0.2);
  ctx.restore();
}

function drawOverlay(ctx) {
  const tw = tileW();
  if (F.pending && F.active && F.active.id===F.pending.to && state.hover) {
    footprint(ctx, state.hover.x, state.hover.y, tw, "rgba(34,113,102,0.25)", "#227166", 3);
  }
  if (F.highlight) {
    const t = (performance.now() - F.highlight.t0) / 1500;
    if (t >= 1) { F.highlight = null; return; }
    const p = gridToWorld(F.highlight.x, F.highlight.y);
    const cx = p.x, cy = p.y + tw * 0.555, r = tw * (0.3 + t * 1.2);
    ctx.save(); ctx.globalAlpha = 1 - t; ctx.strokeStyle = "#cc4f2f"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 0.57, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
}

function pulse(x, y) {
  F.highlight = { x, y, t0: performance.now() };
  cancelAnimationFrame(F.hlRaf);
  const loop = () => { if (!F.highlight) return; scheduleDraw(); F.hlRaf = requestAnimationFrame(loop); };
  loop();
}

function jumpTo(roomId, cell) {
  const room = roomById(roomId); if (!room) return;
  if (room !== F.active) activate(room, { fit: !cell });
  if (!cell) return;
  const rect = els.stage.getBoundingClientRect(), tw = tileW();
  const p = gridToWorld(cell.x, cell.y);
  state.zoom = Math.max(state.zoom, 1);
  state.panX = rect.width / 2 - p.x * state.zoom;
  state.panY = rect.height / 2 - (p.y + tw * 0.555) * state.zoom;
  pulse(cell.x, cell.y);
}

// ─── 扉ツール ─────────────────────────────────────────────────────────────
function showBanner(text) { ui.banner.textContent = text; ui.banner.classList.add("visible"); }
function hideBanner() { ui.banner.classList.remove("visible"); }

function doorClick(cell, event) {
  if (!inFloor()) { setStatus("扉ツールは階層モードで使います。まず階層を読み込んでください。"); return; }
  if (!cell) return;
  if (F.pending) {
    if (F.active.id !== F.pending.to) { const t = roomById(F.pending.to); if (t) activate(t); setStatus(`戻り扉は「${nameOf(F.pending.to)}」に置きます。セルをクリックしてください（Esc で中止）。`); return; }
    if (pointIndexAt(cell) >= 0) { setStatus("そのセルにはすでにポイントがあります。別のセルを選んでください。"); return; }
    pushHistory();
    state.points.push({ position:{ x:cell.x, y:cell.y }, tag:`exit,${F.pending.from}` });
    const from = F.pending.from, to = F.pending.to; F.pending = null; hideBanner();
    applyRulesAndRender();
    setStatus(`接続完了: ${nameOf(from)} ⇄ ${nameOf(to)}`);
    pulse(cell.x, cell.y);
    return;
  }
  const idx = pointIndexAt(cell);
  if (idx >= 0) {
    const pt = state.points[idx];
    if (kindOf(pt.tag)==="exit") openDoorEdit(cell, idx, event);
    else setStatus(`(${cell.x},${cell.y}) にはポイント「${pt.tag}」があります。扉は空いているセルに置いてください。`);
    return;
  }
  openDoorCreate(cell, event);
}

function popAt(event) {
  const rect = els.stage.getBoundingClientRect();
  let x = (event?.clientX ?? rect.left + rect.width/2) - rect.left + 14;
  let y = (event?.clientY ?? rect.top + rect.height/2) - rect.top - 10;
  ui.pop.innerHTML = ""; ui.pop.classList.add("open");
  requestAnimationFrame(() => {
    const w = ui.pop.offsetWidth, h = ui.pop.offsetHeight;
    x = Math.max(8, Math.min(x, rect.width - w - 8)); y = Math.max(8, Math.min(y, rect.height - h - 8));
    ui.pop.style.left = `${x}px`; ui.pop.style.top = `${y}px`;
  });
  ui.pop.style.left = `${x}px`; ui.pop.style.top = `${y}px`;
}
function closePop() { ui.pop.classList.remove("open"); ui.pop.innerHTML = ""; }

function roomSelect(excludeId, current) {
  const sel = document.createElement("select");
  for (const r of F.floor.rooms) {
    if (r.id===excludeId) continue;
    const o = el("option", "", `${r.short} — ${r.name} (${r.id})`); o.value = r.id; sel.appendChild(o);
  }
  const other = el("option", "", "その他の id を入力…"); other.value = "__other__"; sel.appendChild(other);
  if (current && [...sel.options].some(o => o.value===current)) sel.value = current;
  return sel;
}

function openDoorCreate(cell, event) {
  popAt(event);
  const title = el("div", "pop-title", "扉を追加");
  const sub = el("div", "pop-sub", `${F.active.short}（${F.active.name}） (${cell.x},${cell.y})`);
  const lab = el("label", "", "接続先の部屋");
  const sel = roomSelect(F.active.id); lab.appendChild(sel);
  const other = document.createElement("input"); other.placeholder = "例: 02-GATE"; other.style.display = "none"; lab.appendChild(other);
  sel.addEventListener("change", () => { other.style.display = sel.value==="__other__" ? "" : "none"; if (sel.value==="__other__") other.focus(); });
  const chk = el("label", "check"); const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = true;
  chk.append(cb, document.createTextNode("相手の部屋に戻り扉も置く（続けてセルをクリック）"));
  const row = el("div", "row");
  const ok = el("button", "primary", "追加"); const cancel = el("button", "", "キャンセル");
  ok.addEventListener("click", () => {
    const target = sel.value==="__other__" ? other.value.trim() : sel.value;
    if (!target) { other.focus(); return; }
    pushHistory();
    state.points.push({ position:{ x:cell.x, y:cell.y }, tag:`exit,${target}` });
    applyRulesAndRender(); closePop();
    const t = roomById(target);
    if (cb.checked && t) beginReturnDoor(F.active.id, target);
    else setStatus(t ? `扉 → ${t.short} を追加しました。` : `扉 → ${target} を追加しました（階層内に無い id）。`);
  });
  cancel.addEventListener("click", closePop);
  row.append(ok, cancel);
  ui.pop.append(title, sub, lab, chk, row);
  sel.focus();
}

function beginReturnDoor(fromId, toId) {
  const t = roomById(toId); if (!t) return;
  F.pending = { from: fromId, to: toId };
  activate(t);
  selectTool("door");
  showBanner(`「${nameOf(toId)}」に ${nameOf(fromId)} への戻り扉を置くセルをクリック — Esc で中止`);
  setStatus(`戻り扉を置くセルをクリックしてください（${nameOf(toId)} → ${nameOf(fromId)}）。`);
}

function cancelPending() { if (!F.pending) return; F.pending = null; hideBanner(); setStatus("戻り扉の配置を中止しました。検証パネルに「戻り扉がありません」が残ります。"); validateAndRender(); }

function openDoorEdit(cell, idx, event) {
  const pt = state.points[idx], target = exitTarget(pt.tag), t = roomById(target);
  const back = t ? roomPoints(t).find(pp => exitTarget(pp.tag)===F.active.id) : null;
  popAt(event);
  const title = el("div", "pop-title", `扉 → ${t ? t.short : target}`);
  const sub = el("div", "pop-sub", t ? `${F.active.short} (${cell.x},${cell.y}) → ${t.name}${back ? ` (${back.position.x},${back.position.y}) 戻り扉あり` : " — 戻り扉なし"}` : `行き先「${target}」は階層内にありません`);
  const row1 = el("div", "row");
  if (back) { const b = el("button", "", "相手の扉へ"); b.addEventListener("click", () => { closePop(); jumpTo(t.id, back.position); }); row1.appendChild(b); }
  else if (t) { const b = el("button", "primary", "戻り扉を置く"); b.addEventListener("click", () => { closePop(); beginReturnDoor(F.active.id, t.id); }); row1.appendChild(b); }
  const lab = el("label", "", "接続先を変更");
  const sel = roomSelect(F.active.id, target); lab.appendChild(sel);
  const other = document.createElement("input"); other.placeholder = "例: 02-GATE"; other.style.display = "none"; lab.appendChild(other);
  sel.addEventListener("change", () => { other.style.display = sel.value==="__other__" ? "" : "none"; });
  const row2 = el("div", "row");
  const apply = el("button", "", "変更を適用");
  apply.addEventListener("click", () => {
    const nt = sel.value==="__other__" ? other.value.trim() : sel.value;
    if (!nt || nt===target) { closePop(); return; }
    pushHistory();
    pt.tag = `exit,${nt}`;
    if (back && confirm(`${t.short} の古い戻り扉 (${back.position.x},${back.position.y}) を削除しますか？`)) removePointIn(t, back);
    applyRulesAndRender(); closePop();
    const nr = roomById(nt);
    if (nr && !roomPoints(nr).some(pp => exitTarget(pp.tag)===F.active.id) && confirm(`${nr.short} に戻り扉を置きますか？（続けてセルをクリック）`)) beginReturnDoor(F.active.id, nr.id);
  });
  const del = el("button", "danger", back ? "両側削除" : "削除");
  del.addEventListener("click", () => {
    if (!confirm(back ? `この扉と ${t.short} の戻り扉を両方削除します。よろしいですか？` : "この扉を削除します。よろしいですか？")) return;
    pushHistory();
    if (back) removePointIn(t, back);
    state.points.splice(idx, 1);
    applyRulesAndRender(); closePop();
  });
  const close = el("button", "", "閉じる"); close.addEventListener("click", closePop);
  row2.append(apply, del, close);
  ui.pop.append(title, sub, row1, lab, row2);
}

function removePointIn(room, point) {
  const arr = roomPoints(room); const i = arr.indexOf(point); if (i >= 0) arr.splice(i, 1);
}

function beforeRemovePoint(point) {
  if (!inFloor() || kindOf(point.tag)!=="exit") return true;
  const t = roomById(exitTarget(point.tag)); if (!t || t===F.active) return true;
  const backs = roomPoints(t).filter(pp => exitTarget(pp.tag)===F.active.id);
  if (!backs.length) return true;
  if (confirm(`${t.short} 側の戻り扉（${backs.map(b => `(${b.position.x},${b.position.y})`).join(" ")}）も削除しますか？\n\nOK = 両側削除　キャンセル = この扉だけ削除`)) for (const b of backs) removePointIn(t, b);
  return true;
}

// ─── 右ペイン ─────────────────────────────────────────────────────────────
function renderTabs() {
  ui.tabs.innerHTML = "";
  if (!inFloor()) return;
  for (const r of F.floor.rooms) {
    const c = issueCounts(r.id);
    const b = el("button", `room-tab${r===F.active ? " active" : ""}`); b.type = "button";
    b.title = `${r.name}\n${r.id} · ${roomMap(r)[0].length}x${roomMap(r).length} · ポイント ${roomPoints(r).length}`;
    const sw = el("span", "swatch"); sw.style.background = roomColor(r);
    const label = el("span", "", r.short); const sub = el("span", "sub", r.name); label.appendChild(sub);
    b.append(sw, label);
    if (c.error) b.appendChild(el("span", "badge", String(c.error)));
    else if (c.warn) b.appendChild(el("span", "badge warn", String(c.warn)));
    b.addEventListener("click", () => activate(r));
    ui.tabs.appendChild(b);
  }
  const add = el("button", "room-tab add", "＋ 部屋"); add.type = "button"; add.title = "左の「サイズ／下部カット」で新しい部屋を作る";
  add.addEventListener("click", addRoom);
  ui.tabs.appendChild(add);
  ui.floorName.textContent = F.floor.name;
}

function addRoom() {
  const id = prompt("新しい部屋の JSON id（例: 02-GATE）", `${F.floor.id.replace(/^stage0?/, "0")}-NEW`.replace(/^(\d\d)-/, "$1-"));
  if (!id) return;
  if (roomById(id.trim())) { alert("その id はすでにあります。"); return; }
  const name = prompt("部屋の表示名", id) || id;
  stash(F.active);
  const map = makeDefaultMap();
  const room = { file:`${F.floor.id}-${id.trim().replace(/^\d\d-/, "")}.json`, id:id.trim(), name, short: shortFrom(id.trim()), type:"", pos:null, map, points:[], history:[], future:[] };
  F.floor.rooms.push(room);
  activate(room);
  setStatus(`部屋「${name}」を追加しました。扉ツールで他の部屋とつなげます。`);
}

function deleteRoom() {
  if (!inFloor() || F.floor.rooms.length <= 1) { alert("最後の部屋は削除できません。"); return; }
  const r = F.active;
  const refs = connections().filter(c => c.target===r.id).length;
  if (!confirm(`部屋「${r.name}」(${r.id}) を削除します。${refs ? `\n他の部屋の ${refs} 個の扉がこの部屋を指しています（未解決になります）。` : ""}\nよろしいですか？`)) return;
  const i = roomIndex(r); F.floor.rooms.splice(i, 1); F.active = null;
  activate(F.floor.rooms[Math.min(i, F.floor.rooms.length - 1)]);
  setStatus(`部屋「${r.name}」を削除しました。`);
}

function renderRoomMeta() {
  if (!inFloor()) return;
  ui.roomName.value = F.active.name; ui.roomShort.value = F.active.short; ui.roomFile.value = roomFileName(F.active);
}

function renderIssues() {
  const c = issueCounts();
  ui.summary.innerHTML = "";
  if (!F.issues.length) { const ok = el("span", "sev ok", "✓"); ui.summary.append(ok, el("span", "", "問題なし — Unity に持ち込めます")); }
  else {
    if (c.error) ui.summary.append(el("span", "sev error", String(c.error)), el("span", "", "エラー"));
    if (c.warn) ui.summary.append(el("span", "sev warn", String(c.warn)), el("span", "", "警告"));
    if (c.info) ui.summary.append(el("span", "sev info", String(c.info)), el("span", "", "情報"));
  }
  ui.issues.innerHTML = "";
  for (const i of F.issues) {
    const d = el("div", `issue ${i.sev}`);
    d.appendChild(el("span", `sev ${i.sev}`, i.sev==="error" ? "E" : i.sev==="warn" ? "W" : "i"));
    const body = el("div"); body.appendChild(el("div", "msg", i.msg));
    body.appendChild(el("div", "where", `${i.roomId ? nameOf(i.roomId) : "階層全体"}${i.cell ? ` (${i.cell.x},${i.cell.y})` : ""}`));
    d.appendChild(body);
    d.addEventListener("click", () => { if (i.roomId) jumpTo(i.roomId, i.cell); });
    ui.issues.appendChild(d);
  }
}

function renderConnections() {
  ui.conns.innerHTML = "";
  const list = connections();
  if (!list.length) { ui.conns.appendChild(el("div", "hint", "扉がありません。扉ツールでセルをクリックして追加します。")); return; }
  for (const c of list) {
    const row = el("div", `conn ${c.status}`);
    const path = el("span", "path");
    path.append(el("b", "", c.a.short), el("span", "cell", `(${c.cellA.x},${c.cellA.y})`), el("span", "arrow", c.status==="ok" ? "⇄" : c.status==="half" ? "→" : "✕"),
      el("b", "", c.b ? c.b.short : c.target), el("span", "cell", c.cellB ? `(${c.cellB.x},${c.cellB.y})` : c.b ? "戻り扉なし" : "未解決"));
    path.addEventListener("click", () => jumpTo(c.a.id, c.cellA));
    row.appendChild(path);
    if (c.cellB) { const b = el("button", "", "相手へ"); b.addEventListener("click", () => jumpTo(c.b.id, c.cellB)); row.appendChild(b); }
    else if (c.b) { const b = el("button", "primary", "戻り扉"); b.addEventListener("click", () => { if (F.active !== c.a) activate(c.a); beginReturnDoor(c.a.id, c.b.id); }); row.appendChild(b); }
    else row.appendChild(el("span"));
    ui.conns.appendChild(row);
  }
}

function renderChips() {
  ui.chips.innerHTML = ""; ui.datalist.innerHTML = "";
  if (!inFloor()) { ui.chipsWrap.hidden = true; return; }
  ui.chipsWrap.hidden = false;
  const counts = new Map();
  for (const p of state.points) counts.set(p.tag, (counts.get(p.tag) || 0) + 1);
  const dict = dictFor(F.active.id);
  const seen = new Set();
  const entries = [];
  for (const d of dict) { entries.push({ tag:d.tag, label:d.label, known:true }); seen.add(d.tag); }
  for (const p of state.points) if (!seen.has(p.tag) && kindOf(p.tag)!=="exit") { entries.push({ tag:p.tag, label:"辞書に無いタグ", known:false }); seen.add(p.tag); }
  for (const e of entries) {
    const n = counts.get(e.tag) || 0;
    const chip = el("button", `chip ${n ? "placed" : "missing"}${e.known ? "" : " unknown"}${n > 1 ? " dup" : ""}`); chip.type = "button";
    chip.title = `${e.label}${n ? `\n配置済み ×${n} — クリックで移動` : "\n未配置 — クリックで配置モード"}`;
    const k = el("span", "k"); k.style.background = KIND_COLOR[kindOf(e.tag)];
    chip.append(k, el("span", "", e.tag));
    if (n) chip.appendChild(el("span", "n", `×${n}`));
    chip.addEventListener("click", () => {
      els.pointTag.value = e.tag; saveLocal();
      if (n) { const p = state.points.find(pp => pp.tag===e.tag); jumpTo(F.active.id, p.position); }
      else { selectTool("point"); setStatus(`クリックで「${e.tag}」を配置します（${e.label}）。`); }
    });
    ui.chips.appendChild(chip);
  }
  const all = new Set();
  for (const r of F.floor.rooms) { for (const d of dictFor(r.id)) all.add(d.tag); for (const p of roomPoints(r)) all.add(p.tag); }
  for (const t of [...all].sort()) { const o = document.createElement("option"); o.value = t; ui.datalist.appendChild(o); }
}

function decoratePointRow(row, point) {
  if (!inFloor()) return;
  const k = kindOf(point.tag); row.classList.add(k);
  const input = row.querySelector("input");
  if (input) { input.setAttribute("list", "tagDatalist"); input.addEventListener("change", () => applyRulesAndRender()); }
  const bad = F.issues.some(i => i.sev==="error" && i.roomId===F.active.id && i.cell && i.cell.x===point.position.x && i.cell.y===point.position.y);
  if (bad) row.classList.add("bad");
  const label = dictLabel(F.active.id, point.tag);
  row.appendChild(el("span", "tag-label", label || (k==="start" ? "初期スポーン" : "辞書に無いタグ")));
  const pos = row.querySelector(".point-pos");
  if (pos) { pos.style.cursor = "pointer"; pos.title = "クリックでこのセルへ"; pos.addEventListener("click", () => jumpTo(F.active.id, point.position)); }
}

function hoverExtra(cell) {
  if (!cell) return "";
  const p = state.points.find(pp => pp.position.x===cell.x && pp.position.y===cell.y);
  return p ? ` | point ${p.tag}${inFloor() ? (dictLabel(F.active.id, p.tag) ? ` — ${dictLabel(F.active.id, p.tag)}` : "") : ""}` : "";
}

// ─── オーバービュー ───────────────────────────────────────────────────────
function roomBox(room) {
  const map = roomMap(room), tw = tileW();
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  for (let y = 0; y < map.length; y++) for (let x = 0; x < map[y].length; x++) {
    if (map[y][x] === -2) continue;
    const p = gridToWorld(x, y);
    minX = Math.min(minX, p.x - tw/2); maxX = Math.max(maxX, p.x + tw/2); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y + tw);
  }
  if (!Number.isFinite(minX)) { minX = -tw; maxX = tw; minY = 0; maxY = tw; }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX)/2, cy: (minY + maxY)/2 };
}
const cellWorld = (x, y) => { const tw = tileW(), p = gridToWorld(x, y); return { x: p.x, y: p.y + tw * 0.555 }; };

function computeLayout() {
  const rooms = F.floor.rooms, tw = tileW();
  const boxes = new Map(rooms.map(r => [r, roomBox(r)]));
  const exitsOf = r => roomPoints(r).filter(p => kindOf(p.tag)==="exit");
  const hub = rooms.reduce((best, r) => exitsOf(r).length > exitsOf(best).length ? r : best, rooms[0]);
  const pos = new Map();
  pos.set(hub, hub.pos || { x:0, y:0 });
  const queue = [hub];
  while (queue.length) {
    const a = queue.shift(), ab = boxes.get(a), pa = pos.get(a);
    for (const e of exitsOf(a)) {
      const b = roomById(exitTarget(e.tag)); if (!b || pos.has(b)) continue;
      if (b.pos) { pos.set(b, b.pos); queue.push(b); continue; }
      const d = cellWorld(e.position.x, e.position.y), bb = boxes.get(b);
      const ang = Math.atan2((d.y - ab.cy) * 1.6, d.x - ab.cx);
      const dist = Math.hypot(ab.w, ab.h) / 2 + Math.hypot(bb.w, bb.h) / 2 + tw * 1.5;
      pos.set(b, { x: pa.x + Math.cos(ang) * dist, y: pa.y + Math.sin(ang) * dist * 0.8 });
      queue.push(b);
    }
  }
  let ux = 0, maxY = -Infinity;
  for (const [r, p] of pos) maxY = Math.max(maxY, p.y + boxes.get(r).h / 2);
  for (const r of rooms) if (!pos.has(r)) { if (r.pos) { pos.set(r, r.pos); continue; } const bb = boxes.get(r); pos.set(r, { x: ux + bb.w/2, y: maxY + tw * 2 + bb.h/2 }); ux += bb.w + tw * 2; }
  // 重なり解消
  for (let it = 0; it < 24; it++) {
    let moved = false;
    for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i], b = rooms[j], pa = pos.get(a), pb = pos.get(b), ba = boxes.get(a), bb = boxes.get(b);
      const m = tw * 1.2;
      const ox = (ba.w + bb.w) / 2 + m - Math.abs(pa.x - pb.x), oy = (ba.h + bb.h) / 2 + m - Math.abs(pa.y - pb.y);
      if (ox > 0 && oy > 0) {
        moved = true;
        const fa = a.pos ? 0 : 1, fb = b.pos ? 0 : 1, tot = fa + fb || 1;
        if (ox < oy) { const s = Math.sign(pa.x - pb.x) || 1; const na = { ...pa, x: pa.x + s * ox * fa / tot }, nb = { ...pb, x: pb.x - s * ox * fb / tot }; pos.set(a, na); pos.set(b, nb); }
        else { const s = Math.sign(pa.y - pb.y) || 1; const na = { ...pa, y: pa.y + s * oy * fa / tot }, nb = { ...pb, y: pb.y - s * oy * fb / tot }; pos.set(a, na); pos.set(b, nb); }
      }
    }
    if (!moved) break;
  }
  return { pos, boxes, hub };
}

function drawOverview(cv) {
  if (!inFloor()) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  cv.width = Math.floor(rect.width * dpr); cv.height = Math.floor(rect.height * dpr);
  const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  const tw = tileW();
  const { pos, boxes, hub } = computeLayout();
  F.layout = { pos, boxes };
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  for (const [r, p] of pos) { const b = boxes.get(r); minX = Math.min(minX, p.x - b.w/2); maxX = Math.max(maxX, p.x + b.w/2); minY = Math.min(minY, p.y - b.h/2); maxY = Math.max(maxY, p.y + b.h/2 + tw * 1.2); }
  const pad = 14, big = cv.classList.contains("overview-big");
  const s = Math.min((rect.width - pad*2) / (maxX - minX), (rect.height - pad*2) / (maxY - minY), big ? 1.2 : 0.6);
  const ox = (rect.width - (maxX - minX) * s) / 2 - minX * s, oy = (rect.height - (maxY - minY) * s) / 2 - minY * s;
  const W = (r, wx, wy) => { const p = pos.get(r), b = boxes.get(r); return { x: (p.x - b.cx + wx) * s + ox, y: (p.y - b.cy + wy) * s + oy }; };
  F.ovHits = []; F.ovScale = s;

  // 部屋
  for (const r of F.floor.rooms) {
    const map = roomMap(r), b = boxes.get(r), p = pos.get(r);
    const tl = { x: (p.x - b.w/2) * s + ox, y: (p.y - b.h/2) * s + oy }, w = b.w * s, h = b.h * s;
    F.ovHits.push({ room:r, x:tl.x, y:tl.y, w, h: h + 14 });
    ctx.save();
    ctx.fillStyle = r===F.active ? hexA("#d59e24", 0.18) : "rgba(255,253,248,0.55)";
    ctx.fillRect(tl.x - 4, tl.y - 4, w + 8, h + 8);
    ctx.strokeStyle = r===F.active ? "#d59e24" : "rgba(34,36,31,0.35)"; ctx.lineWidth = r===F.active ? 3 : 1;
    ctx.strokeRect(tl.x - 4, tl.y - 4, w + 8, h + 8);
    ctx.restore();
    for (let y = 0; y < map.length; y++) for (let x = 0; x < map[y].length; x++) {
      const id = map[y][x]; if (id === -2) continue;
      const g = gridToWorld(x, y), d = W(r, g.x - tw/2, g.y);
      const img = imageCache.get(id);
      if (img && s * tw >= 4) ctx.drawImage(img, d.x, d.y, tw * s, tw * s);
      else { ctx.fillStyle = id===0 ? "#cfd9c9" : "#7d8a99"; ctx.fillRect(d.x, d.y + tw*s*0.27, tw*s, tw*s*0.57); }
    }
    for (const pt of roomPoints(r)) {
      const k = kindOf(pt.tag), c = cellWorld(pt.position.x, pt.position.y), d = W(r, c.x, c.y);
      ctx.fillStyle = KIND_COLOR[k]; ctx.strokeStyle = "#22241f"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(d.x, d.y, k==="exit" || k==="start" ? Math.max(3, 4.5 * s / 0.6) : Math.max(2, 3 * s / 0.6), 0, Math.PI*2); ctx.fill(); ctx.stroke();
    }
    // ラベル
    const cnt = issueCounts(r.id);
    const label = `${r.short}${big ? `  ${r.name}` : ""}`;
    ctx.save();
    ctx.font = `900 ${big ? 13 : 11}px "Avenir Next","Gill Sans","Trebuchet MS",sans-serif`;
    const tws = ctx.measureText(label).width + 12;
    const lx = tl.x + w/2 - tws/2, ly = tl.y + h + 2;
    ctx.fillStyle = roomColor(r, 70); ctx.strokeStyle = "#22241f"; ctx.lineWidth = 1.5;
    ctx.fillRect(lx, ly, tws, big ? 18 : 15); ctx.strokeRect(lx, ly, tws, big ? 18 : 15);
    ctx.fillStyle = "#22241f"; ctx.textBaseline = "middle"; ctx.textAlign = "center";
    ctx.fillText(label, lx + tws/2, ly + (big ? 9 : 7.5));
    if (r===hub) { ctx.font = `800 9px sans-serif`; ctx.fillStyle = "#6b6e66"; ctx.fillText("HUB", lx + tws/2, ly - 6); }
    if (cnt.error) { ctx.fillStyle = "#cc4f2f"; ctx.beginPath(); ctx.arc(tl.x + w + 2, tl.y - 2, 7, 0, Math.PI*2); ctx.fill(); ctx.fillStyle = "#fffdf8"; ctx.font = "900 9px sans-serif"; ctx.fillText(String(cnt.error), tl.x + w + 2, tl.y - 1.5); }
    ctx.restore();
  }
  // 接続線
  for (const c of connections()) {
    const a = W(c.a, cellWorld(c.cellA.x, c.cellA.y).x, cellWorld(c.cellA.x, c.cellA.y).y);
    let bpt;
    if (c.cellB) bpt = W(c.b, cellWorld(c.cellB.x, c.cellB.y).x, cellWorld(c.cellB.x, c.cellB.y).y);
    else if (c.b) { const p = pos.get(c.b); bpt = { x: p.x * s + ox, y: p.y * s + oy }; }
    ctx.save();
    ctx.lineCap = "round";
    if (c.status==="ok") { ctx.strokeStyle = "rgba(34,113,102,0.85)"; ctx.lineWidth = big ? 2.5 : 2; }
    else if (c.status==="half") { ctx.strokeStyle = "#d59e24"; ctx.lineWidth = 2; ctx.setLineDash([4, 4]); }
    else { ctx.strokeStyle = "#cc4f2f"; ctx.lineWidth = 2; }
    if (bpt) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(bpt.x, bpt.y); ctx.stroke(); }
    else { ctx.beginPath(); ctx.moveTo(a.x - 6, a.y - 6); ctx.lineTo(a.x + 6, a.y + 6); ctx.moveTo(a.x + 6, a.y - 6); ctx.lineTo(a.x - 6, a.y + 6); ctx.stroke(); }
    ctx.restore();
  }
}

function scheduleOverview() {
  if (F.ovRaf) return;
  F.ovRaf = requestAnimationFrame(() => { F.ovRaf = 0; if (!ui.overview.hidden) drawOverview(ui.ovCanvas); if (ui.bigModal.classList.contains("open")) drawOverview(ui.bigCanvas); });
}

function bindOverviewCanvas(cv) {
  cv.addEventListener("pointerdown", e => {
    const rect = cv.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
    const hit = [...F.ovHits].reverse().find(h => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
    if (!hit) return;
    const p = F.layout.pos.get(hit.room);
    F.ovDrag = { cv, room: hit.room, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener("pointermove", e => {
    if (!F.ovDrag || F.ovDrag.cv !== cv) return;
    const dx = e.clientX - F.ovDrag.sx, dy = e.clientY - F.ovDrag.sy;
    if (!F.ovDrag.moved && Math.hypot(dx, dy) < 4) return;
    F.ovDrag.moved = true; cv.classList.add("dragging");
    F.ovDrag.room.pos = { x: F.ovDrag.ox + dx / F.ovScale, y: F.ovDrag.oy + dy / F.ovScale };
    scheduleOverview();
  });
  const end = e => {
    if (!F.ovDrag || F.ovDrag.cv !== cv) return;
    const d = F.ovDrag; F.ovDrag = null; cv.classList.remove("dragging");
    try { cv.releasePointerCapture(e.pointerId); } catch {}
    if (d.moved) saveFloor(); else activate(d.room);
  };
  cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
}

function resetLayout() { if (!inFloor()) return; for (const r of F.floor.rooms) r.pos = null; saveFloor(); scheduleOverview(); }

// ─── 変更フック ────────────────────────────────────────────────────────────
function validateAndRender() {
  validate(); renderIssues(); renderConnections(); renderChips(); renderTabs(); scheduleOverview(); saveFloor();
}

function onEditorChange() {
  if (!inFloor()) return;
  stash(F.active);
  validateAndRender();
}

function onIdChange() {
  if (!inFloor()) return;
  const oldId = F.idAtFocus || F.active.id, newId = els.id.value.trim();
  if (!newId) { els.id.value = oldId; return; }
  if (newId === oldId) return;
  if (roomById(newId)) { alert(`id「${newId}」は別の部屋で使われています。`); els.id.value = oldId; return; }
  const refs = [];
  for (const r of F.floor.rooms) if (r !== F.active) for (const p of roomPoints(r)) if (exitTarget(p.tag)===oldId) refs.push(p);
  if (refs.length && confirm(`他の部屋の ${refs.length} 個の扉が「${oldId}」を指しています。「${newId}」に書き換えますか？`)) for (const p of refs) p.tag = `exit,${newId}`;
  F.active.id = newId;
  if (F.active.file && F.active.file.includes(oldId.replace(/^\d\d-/, ""))) { /* ファイル名はそのまま（ユーザーが右ペインで変更できる） */ }
  F.idAtFocus = newId;
  applyRulesAndRender(); renderRoomMeta();
}

// ─── 初期化 ────────────────────────────────────────────────────────────────
function init() {
  Object.assign(ui, {
    strip: q("#roomStrip"), tabs: q("#roomTabs"), floorName: q("#floorName"),
    banner: q("#doorBanner"), pop: q("#floorPop"),
    overview: q("#overview"), ovCanvas: q("#overviewCanvas"), bigModal: q("#overviewModal"), bigCanvas: q("#overviewBigCanvas"),
    section: q("#floorSection"), summary: q("#issueSummary"), issues: q("#issueList"), conns: q("#connList"),
    roomName: q("#roomNameInput"), roomShort: q("#roomShortInput"), roomFile: q("#roomFileInput"),
    chips: q("#tagChips"), chipsWrap: q("#tagChipsWrap"), datalist: q("#tagDatalist"),
    fileInput: q("#floorFilesInput"), empty: q("#floorEmpty")
  });
  q("#loadSeedBtn").addEventListener("click", loadSeed);
  q("#loadSeedBtn2")?.addEventListener("click", loadSeed);
  q("#loadFilesBtn").addEventListener("click", () => ui.fileInput.click());
  q("#loadFilesBtn2")?.addEventListener("click", () => ui.fileInput.click());
  ui.fileInput.addEventListener("change", () => { loadFiles(ui.fileInput.files); ui.fileInput.value = ""; });
  q("#exportZipBtn").addEventListener("click", () => exportZip().catch(e => alert(`書き出しに失敗しました: ${e.message}`)));
  q("#exportRoomBtn").addEventListener("click", downloadActiveRoom);
  q("#closeFloorBtn").addEventListener("click", closeFloor);
  q("#deleteRoomBtn").addEventListener("click", deleteRoom);
  q("#toggleOverviewBtn").addEventListener("click", () => { ui.overview.hidden = !ui.overview.hidden; saveFloor(); scheduleOverview(); });
  q("#overviewCloseBtn").addEventListener("click", () => { ui.overview.hidden = true; saveFloor(); });
  q("#overviewBigBtn").addEventListener("click", () => { ui.bigModal.classList.add("open"); ui.bigModal.setAttribute("aria-hidden", "false"); scheduleOverview(); });
  q("#overviewResetBtn").addEventListener("click", resetLayout);
  q("#overviewBigResetBtn").addEventListener("click", resetLayout);
  q("#closeOverviewBigBtn").addEventListener("click", closeBig);
  ui.bigModal.addEventListener("click", e => { if (e.target===ui.bigModal) closeBig(); });
  bindOverviewCanvas(ui.ovCanvas); bindOverviewCanvas(ui.bigCanvas);
  new ResizeObserver(() => scheduleOverview()).observe(ui.ovCanvas);

  ui.roomName.addEventListener("input", () => { if (!inFloor()) return; F.active.name = ui.roomName.value; renderTabs(); saveFloor(); scheduleOverview(); });
  ui.roomShort.addEventListener("input", () => { if (!inFloor()) return; F.active.short = ui.roomShort.value.trim() || shortFrom(F.active.id); renderTabs(); saveFloor(); scheduleOverview(); scheduleDraw(); });
  ui.roomFile.addEventListener("change", () => { if (!inFloor()) return; F.active.file = ui.roomFile.value.trim() || roomFileName(F.active); ui.roomFile.value = F.active.file; saveFloor(); });
  els.id.addEventListener("focus", () => { F.idAtFocus = F.active?.id || ""; });
  els.id.addEventListener("change", onIdChange);

  // 階層モードでは単体エクスポートも部屋の書式（type なし・id,size,map,points）で出す
  els.export.addEventListener("click", e => { if (inFloor()) { e.stopImmediatePropagation(); downloadActiveRoom(); } }, true);
  els.exportCopy.addEventListener("click", e => { if (inFloor()) { e.stopImmediatePropagation(); copyActiveRoom().catch(() => setStatus("クリップボードに書き込めませんでした。")); } }, true);

  window.addEventListener("keydown", e => {
    if (e.key==="Escape") { if (F.pending) cancelPending(); closePop(); if (ui.bigModal.classList.contains("open")) closeBig(); }
    if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key==="[") { switchBy(-1); e.preventDefault(); }
    if (e.key==="]") { switchBy(1); e.preventDefault(); }
  });

  if (!loadFloorLocal()) { ui.strip.hidden = true; ui.section.hidden = true; ui.overview.hidden = true; ui.chipsWrap.hidden = true; }
  // タイル画像の読み込み後にオーバービューを描き直す
  setTimeout(scheduleOverview, 600); setTimeout(scheduleOverview, 2000);
}
function closeBig() { ui.bigModal.classList.remove("open"); ui.bigModal.setAttribute("aria-hidden", "true"); }

window.Floor = { onEditorChange, drawPoint, drawOverlay, doorClick, beforeRemovePoint, decoratePointRow, hoverExtra, active: inFloor, kindOf, KIND_COLOR, KIND_LABEL, state: F,
  debug: { roomPayload, roomText, manifestPayload, loadFiles, exportZip, connections, validate, activate, roomById, jumpTo, beginReturnDoor } };
init();
})();
