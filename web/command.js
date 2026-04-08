/* ═══════════════════════════════════════════════════════════════
   STRATCOM WATCH — Command Center
   读同一份 data/latest.json + pipeline_health.json
   不依赖 app.js,独立运行
   ═══════════════════════════════════════════════════════════════ */

const IS_PAGES = location.hostname.includes('github.io');
const SRC = IS_PAGES ? 'data/' : '../data/';

/* 9 个冲突的代号 + 中心坐标(和 app.js 一致) */
const CONFLICTS_META = {
  'russia-ukraine':  { code: 'RUA', name: '俄乌战争',    lat: 48.5, lng: 35.0 },
  'israel-palestine':{ code: 'ISR', name: '巴以冲突',    lat: 31.5, lng: 34.5 },
  'us-iran':         { code: 'IRN', name: '美伊对峙',    lat: 32.4, lng: 53.7 },
  'sudan':           { code: 'SDN', name: '苏丹内战',    lat: 15.5, lng: 32.5 },
  'myanmar':         { code: 'MMR', name: '缅甸内战',    lat: 19.7, lng: 96.0 },
  'yemen-houthi':    { code: 'YEM', name: '也门胡塞',    lat: 15.3, lng: 44.2 },
  'congo-drc':       { code: 'COD', name: '刚果东部',    lat: -2.5, lng: 28.8 },
  'syria':           { code: 'SYR', name: '叙利亚',      lat: 35.0, lng: 38.0 },
  'taiwan-strait':   { code: 'TWN', name: '台海局势',    lat: 24.0, lng: 119.0 },
};

/* 国家中心坐标表(ISO3) — 用于 GDELT 弧线起止 */
const COUNTRY_CENTROIDS = {
  USA: [39.8, -98.6], RUS: [61.5, 105.3], UKR: [48.4, 31.2],
  ISR: [31.0, 34.9],  IRN: [32.4, 53.7],  IRQ: [33.2, 43.7],
  SDN: [12.9, 30.2],  SSD: [7.9, 29.7],   MMR: [21.9, 95.9],
  YEM: [15.6, 48.5],  COD: [-4.0, 21.8],  SYR: [34.8, 38.9],
  TWN: [23.7, 120.9], CHN: [35.9, 104.2], PSE: [31.9, 35.2],
  LBN: [33.8, 35.9],  KWT: [29.3, 47.5],  SAU: [23.9, 45.1],
  TUR: [38.9, 35.2],  JOR: [30.6, 36.2],  EGY: [26.0, 30.8],
  ARE: [23.4, 53.8],  QAT: [25.4, 51.2],  AFG: [33.9, 67.7],
  PAK: [30.4, 69.3],  IDN: [-0.8, 113.9], POL: [51.9, 19.1],
  DEU: [51.2, 10.4],  FRA: [46.2, 2.2],   GBR: [55.4, -3.4],
  ITA: [41.9, 12.6],  RWA: [-2.0, 29.9],  ETH: [9.1, 40.5],
  KEN: [-0.0, 37.9],  PRK: [40.3, 127.5], KOR: [35.9, 127.8],
  JPN: [36.2, 138.3], IND: [20.6, 78.9],  HUN: [47.2, 19.5],
  ROU: [45.9, 24.9],  BLR: [53.7, 27.9],  GEO: [42.3, 43.4],
};

/* 全局状态 */
let D = null;        // latest.json
let HEALTH = null;   // pipeline_health.json
let allItems = [];   // 所有事件扁平化
let globe = null;
let _arcIndex = 0;
let _arcTimer = null;

/* v2: 交互 / 过滤 / 弧线队列 状态 */
let _feedFilter = null;      // cid | null — 当前 feed 过滤的冲突
let _feedFilterSticky = false; // 是否粘滞 (click) vs 临时 (hover)
let _arcQueue = [];          // 全部有效弧,按 date 倒序
let _arcVisible = [];        // 当前在地球上的弧 (有 _addedAt 时间戳)
let _arcQueueIdx = 0;        // 循环指针
let _arcQueueTimer = null;
const ARC_LIFETIME_MS = 6500;
const ARC_SPAWN_MS = 2200;

/* ─────────────────────────────────────────────
   工具函数
───────────────────────────────────────────── */

function escalation(items) {
  const now = new Date();
  const recent = items.filter(it => it.date && (now - new Date(it.date)) < 7 * 86400000);
  const prior  = items.filter(it => it.date && (now - new Date(it.date)) >= 7 * 86400000 && (now - new Date(it.date)) < 14 * 86400000);
  const rc = recent.length, pc = prior.length;

  const freqScore = pc > 0 ? (rc - pc) / Math.max(rc, pc) : (rc > 0 ? 0.5 : 0);
  const recentGS = recent.filter(it => it.metrics && it.metrics.goldstein != null).map(it => it.metrics.goldstein);
  const gsAvg = recentGS.length > 0 ? recentGS.reduce((s, v) => s + v, 0) / recentGS.length : 0;
  const gsScore = recentGS.length > 0 ? Math.max(-1, Math.min(1, -gsAvg / 10)) : 0;
  const recentMentions = recent.filter(it => it.metrics && it.metrics.mentions).reduce((s, it) => s + it.metrics.mentions, 0);
  const priorMentions  = prior.filter(it => it.metrics && it.metrics.mentions).reduce((s, it) => s + it.metrics.mentions, 0);
  const mentionScore = priorMentions > 0 ? Math.max(-1, Math.min(1, (recentMentions - priorMentions) / Math.max(recentMentions, priorMentions))) : 0;

  const raw = freqScore * 0.5 + gsScore * 0.3 + mentionScore * 0.2;
  const index = Math.round(Math.max(0, Math.min(100, (raw + 1) * 50)));

  if (index >= 62) return { label: '升级', cls: 'esc-up',    arrow: '↑', index };
  if (index <= 38) return { label: '缓和', cls: 'esc-down',  arrow: '↓', index };
  return              { label: '稳定', cls: 'esc-stable',arrow: '→', index };
}

function humanAgo(isoStr) {
  if (!isoStr) return '—';
  const diffMs = Date.now() - new Date(isoStr).getTime();
  const h = Math.floor(diffMs / 3600000);
  const m = Math.floor((diffMs % 3600000) / 60000);
  if (h < 1) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ─────────────────────────────────────────────
   数据加载
───────────────────────────────────────────── */

async function loadAll() {
  const [latest, health] = await Promise.allSettled([
    fetch(SRC + 'latest.json').then(r => r.json()),
    fetch(SRC + 'pipeline_health.json').then(r => r.ok ? r.json() : null).catch(() => null),
  ]);

  if (latest.status !== 'fulfilled') {
    document.body.innerHTML = `<div style="padding:40px;color:#e74c3c;font-family:monospace">
      加载 latest.json 失败: ${latest.reason}</div>`;
    return;
  }

  D = latest.value;
  HEALTH = health.status === 'fulfilled' ? health.value : null;

  allItems = [];
  for (const [cid, c] of Object.entries(D.conflicts)) {
    for (const cat of Object.values(c.categories || {})) {
      for (const it of cat.items || []) {
        it._conflict = cid;
        it._date_ts = it.date ? new Date(it.date).getTime() : 0;
        allItems.push(it);
      }
    }
  }

  renderAll();
}

function renderAll() {
  startClock();
  renderTopBar();
  renderNewsTicker();
  renderConflictRail();
  renderInfraStats();
  initGlobe();
  renderFeed();
  renderGoldsteinFloor();
  renderPipelineDots();
  checkAlertMode();
}

/* 组合 A6: Alert mode 边框脉冲 */
function checkAlertMode() {
  const key = 'detect_last_visit';
  const lastVisit = parseInt(localStorage.getItem(key) || '0');
  localStorage.setItem(key, String(Date.now()));
  if (!lastVisit) return;
  const hasNew = allItems.some(it =>
    it.criticality === 'critical' && it._date_ts && it._date_ts >= lastVisit
  );
  if (!hasNew) return;
  setTimeout(() => {
    const el = document.createElement('div');
    el.className = 'alert-mode-overlay';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2000);
  }, 2000);
}

/* 组合 A4: News Ticker */
function renderNewsTicker() {
  const wrap = document.getElementById('ccTicker');
  const track = document.getElementById('ccTickerTrack');
  if (!wrap || !track) return;
  const cutoff = Date.now() - 14 * 86400000;
  const critical = allItems.filter(it => {
    if (it.criticality !== 'critical' || !it._date_ts) return false;
    return it._date_ts >= cutoff;
  }).sort((a, b) => b._date_ts - a._date_ts).slice(0, 15);

  if (!critical.length) {
    wrap.style.display = 'none';
    document.body.classList.add('no-ticker');
    return;
  }
  const itemHtml = it => {
    const meta = CONFLICTS_META[it._conflict] || { code: '?' };
    return `
      <span class="cct-item" data-url="${esc(it.url || '#')}">
        <span class="ccti-date">${it.date || ''}</span>
        <span class="ccti-conflict">${meta.code}</span>
        ${esc(it.title || '')}
      </span>
    `;
  };
  const once = critical.map(itemHtml).join('');
  track.innerHTML = `<div class="cct-scroll">${once}${once}</div>`;
  wrap.style.display = '';

  track.querySelectorAll('.cct-item').forEach(el => {
    el.addEventListener('click', () => {
      const url = el.dataset.url;
      if (url && url !== '#') window.open(url, '_blank', 'noopener');
    });
  });
}

/* ─────────────────────────────────────────────
   ① 顶栏
───────────────────────────────────────────── */

function startClock() {
  const el = document.getElementById('tbClock');
  const tick = () => {
    const d = new Date();
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    const Y  = d.getUTCFullYear();
    const M  = String(d.getUTCMonth() + 1).padStart(2, '0');
    const D  = String(d.getUTCDate()).padStart(2, '0');
    el.textContent = `${Y}-${M}-${D}  ${hh}:${mm}:${ss} UTC`;
  };
  tick();
  setInterval(tick, 1000);
}

function renderTopBar() {
  document.getElementById('tbEvents').textContent = allItems.length.toLocaleString();
  document.getElementById('tbUpdated').textContent = 'last update: ' + humanAgo(D.updated_at);

  const live = document.getElementById('tbLive');
  if (HEALTH) {
    const status = HEALTH.status || 'ok';
    const label = { ok: '● LIVE', degraded: '● DEGRADED', critical: '● CRITICAL' }[status] || '● UNKNOWN';
    live.textContent = label;
    live.classList.add('live-' + status);
  } else {
    live.textContent = '● LIVE';
    live.classList.add('live-ok');
  }
}

/* ─────────────────────────────────────────────
   ② 左栏
───────────────────────────────────────────── */

/**
 * 检测某冲突是否处于 SURGE 状态(v2 B1):
 *   近 7d 事件量 > 1.5 * 前 7d 事件量 且 近 7d >= 10
 */
function detectSurge(items) {
  const now = Date.now();
  const d7 = 7 * 86400000;
  let cur = 0, prior = 0;
  for (const it of items) {
    if (!it._date_ts) continue;
    const age = now - it._date_ts;
    if (age < 0) continue;
    if (age < d7) cur++;
    else if (age < 2 * d7) prior++;
  }
  if (cur < 10) return null;
  if (prior > 0 && cur < prior * 1.5) return null;
  if (prior === 0 && cur < 15) return null; // 无基线时要求更高
  const delta = prior > 0 ? Math.round((cur - prior) / prior * 100) : 999;
  return { cur, prior, delta };
}

function renderConflictRail() {
  const el = document.getElementById('conflictRail');
  const rows = Object.entries(D.conflicts).map(([cid, c]) => {
    const items = Object.values(c.categories || {}).flatMap(cat => cat.items || []);
    const esc_ = escalation(items);
    const surge = detectSurge(items);
    const meta = CONFLICTS_META[cid] || { code: cid.slice(0,3).toUpperCase(), name: cid };
    return { cid, meta, esc: esc_, surge, items, name: c.name || meta.name };
  });
  // 按 escalation index 降序
  rows.sort((a, b) => b.esc.index - a.esc.index);

  el.innerHTML = rows.map(r => {
    const surgeHtml = r.surge
      ? `<span class="cr-surge" title="近 7 天 ${r.surge.cur} 条 / 前 7 天 ${r.surge.prior} 条 · +${r.surge.delta}%">⚠ SURGE</span>`
      : '';
    return `
      <div class="conflict-row" data-cid="${r.cid}" title="hover 过滤 feed · click 粘滞 · dblclick 打开 archive">
        <span class="cr-code">${r.meta.code}</span>
        <div class="cr-bar-wrap"><div class="cr-bar ${r.esc.cls}" style="width:${r.esc.index}%"></div></div>
        <span class="cr-arrow ${r.esc.cls}">${r.esc.arrow}</span>
        <span class="cr-name">${esc(r.name)}${surgeHtml}</span>
      </div>
    `;
  }).join('');

  // 交互绑定 (v2 A1)
  el.querySelectorAll('.conflict-row').forEach(row => {
    const cid = row.dataset.cid;
    const geo = CONFLICTS_META[cid];

    // hover → 临时过滤 feed + globe 飞过去
    row.addEventListener('mouseenter', () => {
      if (_feedFilterSticky) return; // 已粘滞,不响应 hover
      setFeedFilter(cid, false);
      row.classList.add('cr-hover');
      if (geo && globe) {
        globe.pointOfView({ lat: geo.lat, lng: geo.lng, altitude: 1.5 }, 900);
      }
    });
    row.addEventListener('mouseleave', () => {
      if (_feedFilterSticky) return;
      row.classList.remove('cr-hover');
      setFeedFilter(null, false);
    });

    // click → 粘滞过滤 (toggle)
    row.addEventListener('click', (ev) => {
      ev.preventDefault();
      const isActive = _feedFilter === cid && _feedFilterSticky;
      if (isActive) {
        // 取消粘滞
        _feedFilterSticky = false;
        setFeedFilter(null, false);
        row.classList.remove('cr-active');
      } else {
        // 清除其他 active
        el.querySelectorAll('.conflict-row.cr-active').forEach(r => r.classList.remove('cr-active'));
        _feedFilterSticky = true;
        setFeedFilter(cid, true);
        row.classList.add('cr-active');
        if (geo && globe) {
          globe.pointOfView({ lat: geo.lat, lng: geo.lng, altitude: 1.5 }, 900);
        }
      }
    });

    // dblclick → 跳 archive
    row.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      location.href = `./#${cid}`;
    });
  });
}

async function renderInfraStats() {
  try {
    const r = await fetch(SRC + 'infrastructure.json');
    if (!r.ok) return;
    const infra = await r.json();
    document.getElementById('irBases').textContent = (infra.military_bases || []).length;
    document.getElementById('irNuke').textContent  = (infra.nuclear_facilities || []).length;
    document.getElementById('irChoke').textContent = (infra.pipelines_cables || []).filter(p => p.type === 'chokepoint').length;
  } catch {}
}

/* ─────────────────────────────────────────────
   ③ 中间 Globe + 弧线
───────────────────────────────────────────── */

function initGlobe() {
  const wrap = document.getElementById('globeWrap');
  if (typeof Globe === 'undefined') {
    wrap.innerHTML = '<div style="color:#9aa0a8;padding:20px;font-family:monospace">globe.gl 加载失败</div>';
    return;
  }

  // 等布局稳定再读尺寸(避免 grid 1fr 第一帧返回 0)
  const center = document.querySelector('.cc-center');
  const width  = center.clientWidth;
  const height = center.clientHeight;

  // Globe 实例
  globe = Globe()(wrap)
    .width(width)
    .height(height)
    .globeImageUrl('https://unpkg.com/three-globe@2/example/img/earth-night.jpg')
    .bumpImageUrl('https://unpkg.com/three-globe@2/example/img/earth-topology.png')
    .backgroundColor('rgba(0,0,0,0)')
    .showAtmosphere(true)
    .atmosphereColor('#4a9eff')
    .atmosphereAltitude(0.15);

  // 9 个冲突点
  const conflictPoints = Object.entries(D.conflicts).map(([cid, c]) => {
    const items = Object.values(c.categories || {}).flatMap(cat => cat.items || []);
    const esc_ = escalation(items);
    const meta = CONFLICTS_META[cid] || { lat: 0, lng: 0, code: '?' };
    const color = esc_.cls === 'esc-up' ? '#e74c3c' : esc_.cls === 'esc-down' ? '#3fb570' : '#d9a636';
    return {
      lat: meta.lat, lng: meta.lng,
      size: 0.3 + esc_.index / 100 * 0.9,
      color,
      label: `${meta.code}  ${esc_.index}`,
      cid,
    };
  });

  globe
    .pointsData(conflictPoints)
    .pointLat(d => d.lat)
    .pointLng(d => d.lng)
    .pointColor(d => d.color)
    .pointAltitude(d => d.size * 0.1)
    .pointRadius(d => 0.5 + d.size * 0.4)
    .pointLabel(d => `<div style="font-family:monospace;font-size:11px;background:rgba(10,11,13,0.85);padding:6px 10px;border:1px solid #2a2f36;color:#e8e9eb">${d.label}</div>`);

  // 弧线层 (v2 C1: 时间队列化)
  // 不再一次性 arcsData 全部,而是按时间倒序排队,每 ARC_SPAWN_MS 弹一条
  _arcQueue = buildGDELTArcs();
  document.getElementById('arcCount').textContent = `${_arcQueue.length} arcs in queue`;

  globe
    .arcsData([])
    .arcStartLat(d => d.srcLat)
    .arcStartLng(d => d.srcLng)
    .arcEndLat(d => d.dstLat)
    .arcEndLng(d => d.dstLng)
    .arcColor(d => d.color)
    .arcStroke(0.5)
    .arcAltitude(0.3)
    .arcDashLength(0.55)
    .arcDashGap(0.1)
    .arcDashInitialGap(0.5)
    .arcDashAnimateTime(3000)
    .arcLabel(d => `<div style="font-family:monospace;font-size:10px;background:rgba(10,11,13,0.85);padding:4px 8px;border:1px solid #2a2f36;color:#e8e9eb">${d.src} → ${d.dst}<br><span style="opacity:.6">${esc(d.title || '')}</span></div>`);

  if (_arcQueue.length > 0) startArcQueue();

  // v2 B2: critical 事件 → ringsData 持续脉冲
  const criticalRings = buildCriticalRings();
  document.getElementById('arcCount').textContent += ` · ${criticalRings.length} critical pulse`;
  globe
    .ringsData(criticalRings)
    .ringLat(d => d.lat)
    .ringLng(d => d.lng)
    .ringColor(() => (t => `rgba(232, 72, 56, ${1 - t})`))
    .ringMaxRadius(4)
    .ringPropagationSpeed(1.8)
    .ringRepeatPeriod(2200);

  // 初始视角: 对准俄乌中东视场
  globe.pointOfView({ lat: 30, lng: 40, altitude: 2.2 }, 0);

  // 自动旋转
  if (globe.controls) {
    const controls = globe.controls();
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;
    controls.enableZoom = true;
    controls.enablePan = false;
  }

  // 按钮控制
  document.querySelectorAll('.gc-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      document.querySelectorAll('.gc-btn').forEach(b => b.classList.remove('gc-active'));
      if (act === 'rotate') {
        globe.controls().autoRotate = true;
        btn.classList.add('gc-active');
      } else if (act === 'pause') {
        globe.controls().autoRotate = false;
        btn.classList.add('gc-active');
      } else if (act === 'reset') {
        globe.controls().autoRotate = false;
        globe.pointOfView({ lat: 30, lng: 40, altitude: 2.2 }, 1000);
        document.querySelector('[data-act="pause"]').classList.add('gc-active');
      }
    });
  });

  // Resize — 用 cc-center 的尺寸而非 globe-wrap
  window.addEventListener('resize', () => {
    const c = document.querySelector('.cc-center');
    globe.width(c.clientWidth).height(c.clientHeight);
  });
}

function buildGDELTArcs() {
  const arcs = [];
  const gdelt = allItems.filter(it => it.source === 'gdelt' && it.gdelt_meta);
  for (const it of gdelt) {
    const m = it.gdelt_meta;
    const a1 = (m.actor1_country || '').trim().toUpperCase();
    const a2 = (m.actor2_country || '').trim().toUpperCase();
    if (!a1 || !a2 || a1 === 'NAN' || a2 === 'NAN' || a1 === a2) continue;
    const src = COUNTRY_CENTROIDS[a1];
    const dst = COUNTRY_CENTROIDS[a2];
    if (!src || !dst) continue;
    const gs = m.goldstein_scale || it.metrics?.goldstein || 0;
    const color = gs < -7 ? ['rgba(232,72,56,0.15)', 'rgba(232,72,56,0.98)']
                : gs < -5 ? ['rgba(232,128,64,0.15)', 'rgba(232,128,64,0.98)']
                          : ['rgba(217,166,54,0.15)', 'rgba(217,166,54,0.98)'];
    arcs.push({
      srcLat: src[0], srcLng: src[1],
      dstLat: dst[0], dstLng: dst[1],
      src: a1, dst: a2,
      color,
      title: it.title || '',
      gs,
      _date_ts: it._date_ts || 0,
    });
  }
  // 按时间倒序 — 最新事件先出队
  arcs.sort((a, b) => b._date_ts - a._date_ts);
  return arcs;
}

/**
 * v2 C1: 弧线时间队列
 * 每 ARC_SPAWN_MS 弹一条新弧,每条生命 ARC_LIFETIME_MS 后自动消失
 * 全部弧播完后从头循环
 */
function startArcQueue() {
  if (_arcQueueTimer) clearInterval(_arcQueueTimer);

  const tick = () => {
    const now = Date.now();
    // 过期剔除
    _arcVisible = _arcVisible.filter(a => (now - a._addedAt) < ARC_LIFETIME_MS);
    // 新增一条
    if (_arcQueue.length > 0) {
      const next = { ..._arcQueue[_arcQueueIdx % _arcQueueIdx_len()], _addedAt: now };
      _arcVisible.push(next);
      _arcQueueIdx++;
    }
    if (globe) globe.arcsData([..._arcVisible]);
  };
  // 立即弹第一条,不用等 interval
  tick();
  _arcQueueTimer = setInterval(tick, ARC_SPAWN_MS);
}
function _arcQueueIdx_len() { return _arcQueue.length || 1; }

/**
 * v2 B2: 从 criticality==='critical' 事件构建 ringsData
 * 优先用 gdelt_meta 真坐标, 否则用冲突中心 (带微小偏移防重叠)
 */
function buildCriticalRings() {
  const rings = [];
  const now = Date.now();
  const cutoff = 14 * 86400000; // 14 天内
  // 按冲突中心偏移计数,避免多条 critical 叠在同一像素
  const offsetByConflict = {};
  for (const it of allItems) {
    if (it.criticality !== 'critical') continue;
    if (!it._date_ts || (now - it._date_ts) > cutoff) continue;

    let lat, lng;
    const gm = it.gdelt_meta;
    if (gm && gm.geo_lat && (gm.geo_lat !== 0 || gm.geo_lon !== 0)) {
      lat = gm.geo_lat;
      lng = gm.geo_lon;
    } else {
      const meta = CONFLICTS_META[it._conflict];
      if (!meta) continue;
      const n = offsetByConflict[it._conflict] = (offsetByConflict[it._conflict] || 0) + 1;
      const angle = (n * 2.4) % (Math.PI * 2); // 黄金角散开
      const r = 1.2 + (n % 4) * 0.4;
      lat = meta.lat + Math.sin(angle) * r;
      lng = meta.lng + Math.cos(angle) * r;
    }
    rings.push({ lat, lng });
  }
  return rings;
}

/* ─────────────────────────────────────────────
   ④ 右栏 Live Feed (自动滚动)
───────────────────────────────────────────── */

let _feedTimer = null;
let _feedPaused = false;

/**
 * 计算当前可见 feed 项 (v2 版: 分两段)
 *   段 A: 顶部"印证簇"区 — 按 cluster_size * (bias_count+1) 降序取最强 6 条
 *          (去重:一个 cluster_id 只取一条代表)
 *          加 _pinned=true 标记用于渲染分隔
 *   段 B: 时间倒序 80 条 (排除已在段 A 的 item)
 * 总容量 ~86 条
 */
function computeFeedItems() {
  let pool = allItems.filter(it => it.date);
  if (_feedFilter) pool = pool.filter(it => it._conflict === _feedFilter);

  // 段 A: 最强 cluster 代表 (每 cluster_id 只取 1 条, 最新的那条)
  const byCluster = {};
  for (const it of pool) {
    if (!it.cluster_id || !it.cluster_size || it.cluster_size < 2) continue;
    const prev = byCluster[it.cluster_id];
    if (!prev || (it._date_ts > prev._date_ts)) {
      byCluster[it.cluster_id] = it;
    }
  }
  const pinned = Object.values(byCluster)
    .sort((a, b) => {
      const sa = (a.cluster_size || 0) * ((a.cluster_bias_count || 0) + 1);
      const sb = (b.cluster_size || 0) * ((b.cluster_bias_count || 0) + 1);
      if (sb !== sa) return sb - sa;
      return b._date_ts - a._date_ts;
    })
    .slice(0, 6)
    .map(it => ({ ...it, _pinned: true }));

  const pinnedIds = new Set(pinned.map(it => it.id));

  // 段 B: 时间倒序 80 条,排除已钉住的
  const chrono = pool
    .filter(it => !pinnedIds.has(it.id))
    .sort((a, b) => b._date_ts - a._date_ts)
    .slice(0, 80);

  return [...pinned, ...chrono];
}

/**
 * 构建 feed 行 HTML (v2 B3: 含 N 源印证 + 跨偏见 徽章)
 */
function feedRowHtml(it) {
  const cid = it._conflict;
  const meta = CONFLICTS_META[cid] || { code: '?' };
  const crit = it.criticality === 'critical' ? 'crit' : it.criticality === 'notable' ? 'note' : '';

  let badges = '';
  if (it.cluster_size && it.cluster_size >= 2) {
    badges += `<span class="fr-cluster" title="这条事件被 ${it.cluster_size} 个独立源印证">${it.cluster_size}源</span>`;
  }
  if (it.cluster_bias_count && it.cluster_bias_count >= 2) {
    badges += `<span class="fr-crossbias" title="跨 ${it.cluster_bias_count} 种媒体偏见印证,高可信度">跨${it.cluster_bias_count}偏见</span>`;
  }

  const pinnedCls = it._pinned ? ' feed-row-pinned' : '';
  return `
    <div class="feed-row${pinnedCls}" data-url="${esc(it.url || '#')}" data-cid="${cid}">
      <div class="fr-time">${it.date || ''}</div>
      <div class="fr-body">
        <span class="fr-tag ${crit}">${meta.code}</span>
        ${badges}
        <span class="fr-title">${esc(it.title || '(无标题)')}</span>
      </div>
    </div>
  `;
}

/**
 * 重新渲染 feed 行 (不重新绑定 scroll/hover 监听)
 * v2: 分 pinned (印证簇) 和 chrono (时间倒序) 两段, 中间加分隔
 */
function rerenderFeedRows() {
  const el = document.getElementById('feedBody');
  const sub = document.getElementById('feedSub');
  const items = computeFeedItems();
  const pinnedCount = items.filter(it => it._pinned).length;
  const chronoCount = items.length - pinnedCount;

  const filterLabel = _feedFilter
    ? `${(CONFLICTS_META[_feedFilter]||{}).code || '?'} · ${chronoCount}${pinnedCount ? ` + ${pinnedCount}印证` : ''}`
    : `${pinnedCount ? `${pinnedCount}印证 · ` : ''}${chronoCount} recent`;
  sub.textContent = filterLabel;

  let html = '';
  let sepPainted = false;
  items.forEach(it => {
    if (!it._pinned && !sepPainted && pinnedCount > 0) {
      html += `<div class="feed-sep"><span>时间倒序</span></div>`;
      sepPainted = true;
    } else if (!html && it._pinned) {
      html += `<div class="feed-sep feed-sep-pin"><span>★ 多源印证 · 高可信度</span></div>`;
    }
    html += feedRowHtml(it);
  });
  el.innerHTML = html || '<div class="fr-empty">no events</div>';

  el.querySelectorAll('.feed-row').forEach(row => {
    row.addEventListener('click', () => {
      const url = row.dataset.url;
      if (url && url !== '#') window.open(url, '_blank', 'noopener');
    });
  });
  el.scrollTop = 0;
}

/**
 * v2 A1: 设置 feed 过滤器,触发重渲染
 */
function setFeedFilter(cid, sticky) {
  _feedFilter = cid;
  rerenderFeedRows();
}

function renderFeed() {
  const el = document.getElementById('feedBody');
  rerenderFeedRows();

  // Hover 暂停滚动
  el.addEventListener('mouseenter', () => { _feedPaused = true; });
  el.addEventListener('mouseleave', () => { _feedPaused = false; });

  // 每 4 秒把 scrollTop 下移一行 (除非悬停)
  if (_feedTimer) clearInterval(_feedTimer);
  _feedTimer = setInterval(() => {
    if (_feedPaused) return;
    const first = el.querySelector('.feed-row');
    if (!first) return;
    const rowH = first.offsetHeight + 1;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) {
      el.scrollTop = 0; // 滚到底了,循环
    } else {
      el.scrollTop += rowH;
    }
  }, 4000);
}

/* ─────────────────────────────────────────────
   ⑤ 底栏 Goldstein floor (30 天)
───────────────────────────────────────────── */

function renderGoldsteinFloor() {
  const el = document.getElementById('goldsteinChart');
  const now = new Date();
  const days = 30;

  // 每天桶: 该日 goldstein 最小值 (负数越小越严重)
  const buckets = new Array(days).fill(null);
  for (const it of allItems) {
    if (!it.date) continue;
    const gs = it.metrics?.goldstein;
    if (gs == null) continue;
    const diff = Math.floor((now - new Date(it.date)) / 86400000);
    if (diff < 0 || diff >= days) continue;
    const idx = days - 1 - diff;
    if (buckets[idx] == null || gs < buckets[idx]) buckets[idx] = gs;
  }

  // 映射 goldstein → 严重度档 0-4 + 高度
  el.innerHTML = buckets.map((gs, i) => {
    let sev = 0, h = 4;
    if (gs != null) {
      if (gs <= -9)      { sev = 4; h = 44; }
      else if (gs <= -7) { sev = 3; h = 36; }
      else if (gs <= -5) { sev = 2; h = 26; }
      else if (gs <= -3) { sev = 1; h = 18; }
      else               { sev = 0; h = 10; }
    }
    const date = new Date(now - (days - 1 - i) * 86400000);
    const label = `${date.getUTCMonth()+1}/${date.getUTCDate()}`;
    const tip = gs != null ? `${label}: min goldstein ${gs.toFixed(1)}` : `${label}: (no data)`;
    return `<div class="bb-bar bb-sev-${sev}" style="height:${h}px" title="${tip}"></div>`;
  }).join('');
}

/* ─────────────────────────────────────────────
   Pipeline 心跳灯
───────────────────────────────────────────── */

function renderPipelineDots() {
  if (!HEALTH || !HEALTH.by_source) return;
  const by = HEALTH.by_source || {};
  document.querySelectorAll('.pd-dot').forEach(dot => {
    const src = dot.dataset.src;
    const n = by[src] || 0;
    dot.classList.remove('pd-ok', 'pd-warn', 'pd-err');
    dot.classList.add(n > 0 ? 'pd-ok' : 'pd-err');
    dot.title = `${src}: ${n} items`;
  });
}

/* ─────────────────────────────────────────────
   键盘快捷键 (组合 A5)
   1-9: 选冲突 (按左栏显示顺序)
   space: 切换 globe 自转
   esc: 清除过滤
   r: 重置视角
   / : focus 无 (为将来留)
───────────────────────────────────────────── */
function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    // 避免在 input/textarea 里触发
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const k = e.key;
    if (k >= '1' && k <= '9') {
      const idx = parseInt(k) - 1;
      const rows = document.querySelectorAll('.conflict-row');
      if (idx < rows.length) {
        rows[idx].click();
        e.preventDefault();
      }
      return;
    }
    if (k === ' ' || k === 'Spacebar') {
      if (globe && globe.controls) {
        const ctrl = globe.controls();
        ctrl.autoRotate = !ctrl.autoRotate;
        document.querySelectorAll('.gc-btn').forEach(b => b.classList.remove('gc-active'));
        document.querySelector(`[data-act="${ctrl.autoRotate ? 'rotate' : 'pause'}"]`)
          ?.classList.add('gc-active');
      }
      e.preventDefault();
      return;
    }
    if (k === 'Escape') {
      // 清除 feed 过滤
      _feedFilterSticky = false;
      setFeedFilter(null, false);
      document.querySelectorAll('.conflict-row').forEach(r => {
        r.classList.remove('cr-active', 'cr-hover');
      });
      e.preventDefault();
      return;
    }
    if (k === 'r' || k === 'R') {
      if (globe) {
        globe.controls().autoRotate = false;
        globe.pointOfView({ lat: 30, lng: 40, altitude: 2.2 }, 1000);
        document.querySelectorAll('.gc-btn').forEach(b => b.classList.remove('gc-active'));
        document.querySelector('[data-act="pause"]')?.classList.add('gc-active');
      }
      e.preventDefault();
      return;
    }
  });
}

/* ─────────────────────────────────────────────
   启动
───────────────────────────────────────────── */

/* ─────────────────────────────────────────────
   虚拟值班员 — 数字人主播 (Wan2.2-S2V)
───────────────────────────────────────────── */
async function loadAnchorBriefing() {
  try {
    const r = await fetch('avatar/config.json', { cache: 'no-store' });
    if (!r.ok) return;
    const cfg = await r.json();
    const videos = (cfg && cfg.videos) || [];
    const playable = videos.filter(v => v && v.video);
    if (playable.length === 0) return;

    // 命令中心固定取最新一条 (而不是 index.html 那种随机)
    const pick = playable[0];

    const wrap = document.getElementById('ccAnchor');
    const video = document.getElementById('ccaVideo');
    const src = document.getElementById('ccaVideoSrc');
    const headline = document.getElementById('ccaHeadline');
    const dateEl = document.getElementById('ccaDate');
    const sound = document.getElementById('ccaSound');
    if (!wrap || !video || !src) return;

    src.src = pick.video;
    video.load();
    video.play().catch(() => {});  // autoplay muted 一般允许

    if (headline) headline.textContent = pick.headline || '';
    if (dateEl) dateEl.textContent = (pick.date || '').replace(/-/g, '.');

    if (sound) {
      sound.addEventListener('click', () => {
        video.muted = !video.muted;
        sound.textContent = video.muted ? 'MUTE' : 'LIVE';
        sound.classList.toggle('live', !video.muted);
        if (!video.muted) {
          video.currentTime = 0;
          video.play().catch(() => {});
        }
      });
    }

    wrap.style.display = '';
  } catch (e) {
    console.warn('[anchor] 加载失败:', e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadAll();
  wireKeyboard();
  loadAnchorBriefing();
});
