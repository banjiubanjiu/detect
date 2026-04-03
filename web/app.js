// Auto-detect: local dev (../data/) vs GitHub Pages (data/)
const IS_PAGES = location.hostname.includes('github.io');
const DATA = IS_PAGES ? 'data/latest.json' : '../data/latest.json';
const SRC = IS_PAGES ? 'data/' : '../data/';
const MO = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const LMO = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const INAMES = { war:'全面战争', conflict:'武装冲突', tension:'紧张对峙' };
const REGIONS_ORDER = ['欧洲','中东','非洲','亚太'];

// Source credibility tiers
const CRED = {
  // T1: Official institutions, major wire services, established think tanks
  't1': new Set(['understandingwar.org','crisisgroup.org','ohchr.org','un.org','congress.gov','cfr.org',
    'brookings.edu','csis.org','rand.org','iiss.org','chathamhouse.org','aei.org','atlanticcouncil.org',
    'hrw.org','icrc.org','ifrc.org','rescue.org','securitycouncilreport.org']),
  // T2: Major media, regional specialists
  't2': new Set(['nytimes.com','bbc.com','reuters.com','aljazeera.com','cnn.com','bloomberg.com',
    'theguardian.com','apnews.com','rferl.org','npr.org','foreignaffairs.com','warontherocks.com',
    'russiamatters.org','ecfr.eu','globaltaiwan.org','gmfus.org','timep.org','snhr.org',
    'lowyinstitute.org','usni.org','eurasiareview.com']),
  // T3: Everything else (social media, forums, smaller outlets)
};

function credTier(item) {
  if (item.source === 'x' || item.source === 'youtube') return 't2';
  if (item.source === 'reddit') return 't3';
  const d = (item.source_label || '').replace('www.','');
  if (CRED.t1.has(d)) return 't1';
  if (CRED.t2.has(d)) return 't2';
  return 't3';
}

function credBadge(item) {
  const t = credTier(item);
  const titles = { t1:'权威机构', t2:'主流媒体', t3:'社区/其他' };
  return `<span class="cred-tier cred-${t}" title="${titles[t]}">${titles[t]}</span>`;
}

let D, conflict = null, tab = 'military', cache = {}, currentView = 'overview', kbIdx = -1, globe = null;
let timeFilterDays = 30; // 0 = all

/* ═══ Escalation ═══ */
function escalation(items) {
  const now = new Date();
  const recent = items.filter(it => it.date && (now - new Date(it.date)) < 7 * 86400000).length;
  const prior = items.filter(it => it.date && (now - new Date(it.date)) >= 7 * 86400000 && (now - new Date(it.date)) < 14 * 86400000).length;
  if (recent > prior * 1.3 && recent - prior >= 2) return { label: '升级', cls: 'esc-up', arrow: '↑' };
  if (prior > recent * 1.3 && prior - recent >= 2) return { label: '缓和', cls: 'esc-down', arrow: '↓' };
  return { label: '稳定', cls: 'esc-stable', arrow: '→' };
}

/* ═══ Time Filter ═══ */
function filterByTime(items) {
  if (timeFilterDays === 0) return items;
  const cutoff = new Date(Date.now() - timeFilterDays * 86400000);
  return items.filter(it => it.date && new Date(it.date) >= cutoff);
}

/* ═══ Sparkline ═══ */
function sparkline(items, intensity, days = 30) {
  const now = new Date();
  const buckets = new Array(days).fill(0);
  for (const it of items) {
    if (!it.date) continue;
    const diff = Math.floor((now - new Date(it.date)) / 86400000);
    if (diff >= 0 && diff < days) buckets[days - 1 - diff]++;
  }
  const max = Math.max(...buckets, 1);
  const w = 120, h = 32, bw = w / days, pad = 1;
  const color = { war: 'var(--i-war)', conflict: 'var(--i-conflict)', tension: 'var(--i-tension)' }[intensity] || 'var(--ink-25)';
  const bars = buckets.map((v, i) => {
    const bh = (v / max) * (h - 2);
    if (v === 0) return '';
    return `<rect x="${i * bw + pad/2}" y="${h - bh}" width="${bw - pad}" height="${bh}" rx="0.5"/>`;
  }).join('');
  const trend = buckets.slice(-7).reduce((s,v) => s+v, 0) - buckets.slice(-14, -7).reduce((s,v) => s+v, 0);
  const arrow = trend > 0 ? '↑' : trend < 0 ? '↓' : '→';
  const arrowColor = trend > 0 ? 'var(--red)' : trend < 0 ? 'var(--green)' : 'var(--ink-25)';
  return `<div class="spark-wrap">
    <svg class="spark-svg" viewBox="0 0 ${w} ${h}" fill="${color}" opacity="0.6">${bars}</svg>
    <span class="spark-trend" style="color:${arrowColor}">${arrow}</span>
    <span class="spark-label">30d</span>
  </div>`;
}

/* ═══ Globe coordinates ═══ */
const CONFLICT_GEO = {
  'russia-ukraine':  { lat: 48.5, lng: 35.0, zoom: 5 },
  'israel-palestine':{ lat: 31.5, lng: 34.5, zoom: 7 },
  'iran-war':        { lat: 32.4, lng: 53.7, zoom: 5 },
  'sudan':           { lat: 15.5, lng: 32.5, zoom: 5 },
  'myanmar':         { lat: 19.7, lng: 96.0, zoom: 5 },
  'yemen-houthis':   { lat: 15.3, lng: 44.2, zoom: 6 },
  'congo-drc':       { lat: -2.5, lng: 28.8, zoom: 5 },
  'syria':           { lat: 35.0, lng: 38.0, zoom: 6 },
  'taiwan-strait':   { lat: 24.0, lng: 119.0, zoom: 5 },
};

let detailMap = null;

async function boot() {
  initTheme();
  const r = await fetch(DATA);
  D = await r.json();
  mastDate();
  renderRegionNav();
  wireViewToggle();
  wireSearch();
  wireKeyboard();
  showOverview();
  initGlobe();
  wireReader();
}

/* ═══ Theme ═══ */
function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
  updateThemeBtn();
  document.getElementById('themeToggle').onclick = toggleTheme;
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('theme', 'light');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('theme', 'dark');
  }
  updateThemeBtn();
}

function updateThemeBtn() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = isDark ? 'LIGHT' : 'DARK';
}

/* ═══ Globe ═══ */
function initGlobe() {
  const wrap = document.getElementById('globeWrap');
  if (!wrap || typeof Globe === 'undefined') return;

  const COLORS = { war: '#e74c3c', conflict: '#d87030', tension: '#c89820' };
  const RINGS  = { war: '#e74c3c', conflict: '#d87030', tension: '#c89820' };

  // Build point data from conflicts
  const points = Object.entries(D.conflicts).map(([k, c]) => {
    const geo = CONFLICT_GEO[k];
    if (!geo) return null;
    const total = Object.values(c.categories).reduce((s, cat) => s + cat.items.length, 0);
    return {
      key: k,
      lat: geo.lat,
      lng: geo.lng,
      name: c.name,
      name_en: c.name_en,
      intensity: c.intensity || 'conflict',
      total,
      color: COLORS[c.intensity] || COLORS.conflict,
    };
  }).filter(Boolean);

  // Rings for active pulsing effect
  const rings = points.map(p => ({
    lat: p.lat, lng: p.lng,
    maxR: p.intensity === 'war' ? 4 : p.intensity === 'conflict' ? 3 : 2,
    propagationSpeed: p.intensity === 'war' ? 2 : 1.5,
    repeatPeriod: p.intensity === 'war' ? 800 : 1200,
    color: RINGS[p.intensity] || RINGS.conflict,
    key: p.key,
  }));

  const w = wrap.clientWidth;
  const h = wrap.clientHeight;

  globe = new Globe(wrap)
    .width(w)
    .height(h)
    .backgroundColor('rgba(0,0,0,0)')
    .globeImageUrl('//cdn.jsdelivr.net/npm/three-globe/example/img/earth-night.jpg')
    .atmosphereColor('#8a8a80')
    .atmosphereAltitude(0.2)
    // Conflict points
    .pointsData(points)
    .pointLat(d => d.lat)
    .pointLng(d => d.lng)
    .pointColor(d => d.color)
    .pointAltitude(d => d.intensity === 'war' ? 0.08 : d.intensity === 'conflict' ? 0.05 : 0.03)
    .pointRadius(d => d.intensity === 'war' ? 0.5 : d.intensity === 'conflict' ? 0.4 : 0.3)
    .pointLabel(d => `
      <div style="font-family:system-ui;font-size:13px;background:rgba(26,26,24,0.92);color:#f4efe6;padding:8px 12px;border-radius:4px;line-height:1.5;border-left:3px solid ${d.color}">
        <div style="font-weight:700">${d.name}</div>
        <div style="font-size:11px;opacity:0.7">${d.name_en}</div>
        <div style="font-size:11px;margin-top:3px">${d.total} reports</div>
      </div>
    `)
    // Pulsing rings
    .ringsData(rings)
    .ringLat(d => d.lat)
    .ringLng(d => d.lng)
    .ringMaxRadius(d => d.maxR)
    .ringPropagationSpeed(d => d.propagationSpeed)
    .ringRepeatPeriod(d => d.repeatPeriod)
    .ringColor(d => () => d.color)
    // Click to navigate
    .onPointClick(d => {
      conflict = d.key;
      tab = 'military';
      document.querySelectorAll('.rn-chip').forEach(x => x.classList.toggle('on', x.dataset.k === conflict));
      showConflict();
    });

  // Initial view: center on Middle East / Africa region
  globe.pointOfView({ lat: 25, lng: 45, altitude: 2.2 }, 0);

  // Auto-rotate
  const controls = globe.controls();
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.4;
  controls.enableZoom = false;

  // Responsive resize
  const ro = new ResizeObserver(() => {
    globe.width(wrap.clientWidth).height(wrap.clientHeight);
  });
  ro.observe(wrap);
}

function mastDate() {
  const d = new Date(D.updated_at);
  document.getElementById('mastDate').innerHTML =
    `${d.getFullYear()}年${LMO[d.getMonth()]}${d.getDate()}日<br><span style="font-size:10px;color:var(--ink-25)">最近更新</span>`;
}

/* ═══ Region Nav ═══ */
function renderRegionNav() {
  const byRegion = {};
  for (const [k, c] of Object.entries(D.conflicts)) {
    const r = c.region || '其他';
    if (!byRegion[r]) byRegion[r] = [];
    byRegion[r].push([k, c]);
  }

  const el = document.getElementById('regionNav');
  el.innerHTML = REGIONS_ORDER.filter(r => byRegion[r]).map(region => `
    <div class="rn-group">
      <div class="rn-label">${region}</div>
      <div class="rn-chips">
        ${byRegion[region].map(([k, c]) => `
          <div class="rn-chip" data-k="${k}">
            <span class="rn-dot ${c.intensity || 'conflict'}"></span>
            ${c.name}
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');

  el.querySelectorAll('.rn-chip').forEach(ch => {
    ch.onclick = () => {
      conflict = ch.dataset.k;
      tab = 'military';
      el.querySelectorAll('.rn-chip').forEach(x => x.classList.toggle('on', x.dataset.k === conflict));
      showConflict();
    };
  });
}

/* ═══ Overview ═══ */
function showOverview() {
  currentView = 'overview';
  conflict = null;
  kbIdx = -1;
  document.querySelectorAll('.rn-chip').forEach(x => x.classList.remove('on'));
  document.getElementById('overview').style.display = '';
  document.getElementById('conflictDetail').style.display = 'none';
  document.getElementById('timeline').style.display = 'none';
  document.getElementById('toolbar').style.display = '';
  document.getElementById('globeSection').style.display = '';
  document.getElementById('vizRow').style.display = '';

  const el = document.getElementById('overview');
  const sorted = Object.entries(D.conflicts).sort((a, b) => {
    const order = { war: 0, conflict: 1, tension: 2 };
    const d = (order[a[1].intensity] ?? 9) - (order[b[1].intensity] ?? 9);
    if (d !== 0) return d;
    // Same intensity: sort by item count descending
    const aTotal = Object.values(a[1].categories).reduce((s,c) => s+c.items.length, 0);
    const bTotal = Object.values(b[1].categories).reduce((s,c) => s+c.items.length, 0);
    return bTotal - aTotal;
  });

  // KPI stats
  const allConflictItems = Object.values(D.conflicts).flatMap(c => Object.values(c.categories).flatMap(cat => cat.items));
  const totalReports = allConflictItems.length;
  const now = new Date();
  const weekAgo = new Date(now - 7 * 86400000);
  const week2Ago = new Date(now - 14 * 86400000);
  const thisWeek = allConflictItems.filter(it => it.date && new Date(it.date) >= weekAgo).length;
  const lastWeek = allConflictItems.filter(it => it.date && new Date(it.date) >= week2Ago && new Date(it.date) < weekAgo).length;
  const weekDelta = thisWeek - lastWeek;
  const weekArrow = weekDelta > 0 ? '↑' : weekDelta < 0 ? '↓' : '→';
  const weekColor = weekDelta > 0 ? 'var(--red)' : weekDelta < 0 ? 'var(--green)' : 'var(--ink-25)';
  const sources = new Set(allConflictItems.map(it => it.source_label || it.source));
  const t1 = allConflictItems.filter(it => credTier(it) === 't1').length;
  const t1pct = totalReports ? Math.round(t1 / totalReports * 100) : 0;
  const wars = Object.values(D.conflicts).filter(c => c.intensity === 'war').length;
  const hottest = sorted[0] ? D.conflicts[sorted[0][0]].name : '—';

  el.innerHTML = `
    <h2 class="ov-title">全球冲突态势总览 <span style="font-family:var(--mono);font-size:12px;font-weight:400;color:var(--ink-40);margin-left:8px">${sorted.length} active</span></h2>
    <div class="kpi-strip">
      <div class="kpi-cell">
        <div class="kpi-val">${sorted.length}</div>
        <div class="kpi-label">活跃冲突</div>
        <div class="kpi-sub">${wars} 场战争</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-val">${totalReports}</div>
        <div class="kpi-label">总报道</div>
        <div class="kpi-sub">${sources.size} 个信息源</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-val" style="color:${weekColor}">+${thisWeek} <span class="kpi-arrow">${weekArrow}</span></div>
        <div class="kpi-label">本周新增</div>
        <div class="kpi-sub">上周 ${lastWeek}</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-val">${t1pct}%</div>
        <div class="kpi-label">T1 权威源</div>
        <div class="kpi-sub">智库/机构/通讯社</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-val kpi-hot">${hottest}</div>
        <div class="kpi-label">最活跃冲突</div>
        <div class="kpi-sub">${sorted[0] ? Object.values(D.conflicts[sorted[0][0]].categories).reduce((s,c)=>s+c.items.length,0) + ' reports' : ''}</div>
      </div>
    </div>
    ${D.briefing ? `<div class="briefing-card">
      <div class="briefing-header">
        <span class="briefing-icon">INTEL</span>
        <span class="briefing-title">每日态势简报</span>
        <span class="briefing-date">${D.briefing_date || ''}</span>
      </div>
      <div class="briefing-body">${esc(D.briefing)}</div>
    </div>` : ''}
    ${sorted.map(([k, c], i) => {
      const allItemsRaw = Object.values(c.categories).flatMap(cat => cat.items);
      const allItems = filterByTime(allItemsRaw);
      const total = allItems.length;
      const latest = allItems.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
      const parties = (c.parties || []).join(' vs ');
      const escl = escalation(allItemsRaw);

      return `
        <div class="ov-card" style="--d:${i * 40}ms" data-k="${k}" data-intensity="${c.intensity || 'conflict'}">
          <div class="ov-card-left">
            <div class="ov-card-name">
              ${c.name}
              <span class="ov-intensity ${c.intensity || 'conflict'}">${INAMES[c.intensity] || c.intensity}</span>
              <span class="ov-escalation ${escl.cls}">${escl.arrow} ${escl.label}</span>
            </div>
            <div class="ov-parties">${parties} · ${c.region} · 自 ${c.since}</div>
            <div class="ov-latest">${latest ? esc(latest.title) : '暂无数据'}</div>
          </div>
          <div class="ov-card-right">
            <span class="ov-count">${total}</span>
            <span class="ov-count-label">reports</span>
            ${sparkline(allItemsRaw, c.intensity)}
          </div>
        </div>
      `;
    }).join('')}
  `;

  el.querySelectorAll('.ov-card').forEach(card => {
    card.onclick = () => {
      conflict = card.dataset.k;
      tab = 'military';
      document.querySelectorAll('.rn-chip').forEach(x => x.classList.toggle('on', x.dataset.k === conflict));
      showConflict();
    };
  });

  renderHotReports();
  renderForceGraph();
}

/* ═══ Hot Reports ═══ */
function renderHotReports() {
  const el = document.getElementById('hotList');
  if (!el) return;

  const scored = [];
  for (const [k, c] of Object.entries(D.conflicts)) {
    for (const cat of Object.values(c.categories)) {
      for (const it of cat.items) {
        const m = it.metrics || {};
        const s = (m.likes||0) + (m.retweets||0)*2 + (m.score||0) + (m.comments||0);
        if (s > 0) scored.push({ ...it, _score: s, _conflict: k, _cname: c.name });
      }
    }
  }
  scored.sort((a, b) => b._score - a._score);
  const top = scored.slice(0, 10);

  const srcIcon = { x:'𝕏', reddit:'⬡', youtube:'▶', web:'◉' };

  el.innerHTML = top.map((it, i) => `
    <div class="hot-item" data-k="${it._conflict}" data-id="${it.id}">
      <span class="hot-rank ${i < 3 ? 'top3' : ''}">${i + 1}</span>
      <div class="hot-body">
        <div class="hot-title">${esc(it.title)}</div>
        <div class="hot-meta">${srcIcon[it.source]||'◉'} ${it._cname} · ${it.date || ''}</div>
      </div>
      <span class="hot-score">${formatScore(it._score)}</span>
    </div>
  `).join('');

  el.querySelectorAll('.hot-item').forEach(item => {
    item.onclick = () => {
      conflict = item.dataset.k;
      tab = 'military';
      document.querySelectorAll('.rn-chip').forEach(x => x.classList.toggle('on', x.dataset.k === conflict));
      showConflict();
    };
  });
}

function formatScore(n) {
  if (n >= 1000) return (n/1000).toFixed(1) + 'k';
  return String(n);
}

/* ═══ Force Graph ═══ */
function renderForceGraph() {
  const wrap = document.getElementById('forceWrap');
  if (!wrap || typeof d3 === 'undefined') return;
  wrap.innerHTML = '';

  const w = wrap.clientWidth;
  const h = wrap.clientHeight || 320;

  const COLORS = { war:'#b82818', conflict:'#c86020', tension:'#b89818' };
  const nodes = [];
  const links = [];
  const nodeMap = {};

  // Add conflict nodes
  for (const [k, c] of Object.entries(D.conflicts)) {
    const total = Object.values(c.categories).reduce((s, cat) => s + cat.items.length, 0);
    const node = { id: k, label: c.name, type: 'conflict', intensity: c.intensity, r: Math.max(12, Math.sqrt(total) * 4) };
    nodes.push(node);
    nodeMap[k] = node;
  }

  // Add party nodes and links
  for (const [k, c] of Object.entries(D.conflicts)) {
    for (const party of (c.parties || [])) {
      if (!nodeMap[party]) {
        nodeMap[party] = { id: party, label: party, type: 'actor', r: 6 };
        nodes.push(nodeMap[party]);
      }
      links.push({ source: k, target: party, type: 'party' });
    }
    // Related conflict links
    for (const rel of (c.related || [])) {
      if (D.conflicts[rel]) {
        links.push({ source: k, target: rel, type: 'related' });
      }
    }
  }

  // Deduplicate actors that appear in multiple conflicts (shared = thicker link already shown)
  const svg = d3.select(wrap).append('svg').attr('viewBox', `0 0 ${w} ${h}`);

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(d => d.type === 'related' ? 60 : 40))
    .force('charge', d3.forceManyBody().strength(d => d.type === 'conflict' ? -120 : -30))
    .force('center', d3.forceCenter(w / 2, h / 2))
    .force('collision', d3.forceCollide(d => d.r + 3))
    .force('x', d3.forceX(w / 2).strength(0.07))
    .force('y', d3.forceY(h / 2).strength(0.07));

  const link = svg.append('g')
    .selectAll('line')
    .data(links)
    .join('line')
    .attr('stroke', d => d.type === 'related' ? '#b82818' : '#c4c0b4')
    .attr('stroke-width', d => d.type === 'related' ? 1.5 : 0.8)
    .attr('stroke-dasharray', d => d.type === 'related' ? '4,3' : 'none')
    .attr('stroke-opacity', 0.5);

  const node = svg.append('g')
    .selectAll('g')
    .data(nodes)
    .join('g')
    .attr('cursor', 'pointer')
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
    );

  // Conflict nodes: colored circles
  node.filter(d => d.type === 'conflict')
    .append('circle')
    .attr('r', d => d.r)
    .attr('fill', d => COLORS[d.intensity] || COLORS.conflict)
    .attr('fill-opacity', 0.15)
    .attr('stroke', d => COLORS[d.intensity] || COLORS.conflict)
    .attr('stroke-width', 1.5);

  node.filter(d => d.type === 'conflict')
    .append('circle')
    .attr('r', 4)
    .attr('fill', d => COLORS[d.intensity] || COLORS.conflict);

  // Actor nodes: small gray dots
  node.filter(d => d.type === 'actor')
    .append('circle')
    .attr('r', d => d.r)
    .attr('fill', '#8a8a80')
    .attr('fill-opacity', 0.6);

  // Labels
  node.append('text')
    .text(d => d.label)
    .attr('dy', d => d.type === 'conflict' ? d.r + 12 : d.r + 10)
    .attr('text-anchor', 'middle')
    .attr('font-family', 'var(--sans)')
    .attr('font-size', d => d.type === 'conflict' ? '10px' : '8px')
    .attr('font-weight', d => d.type === 'conflict' ? '600' : '400')
    .attr('fill', d => d.type === 'conflict' ? '#1a1a18' : '#8a8a80');

  // Click conflict nodes to navigate
  node.filter(d => d.type === 'conflict').on('click', (e, d) => {
    conflict = d.id;
    tab = 'military';
    document.querySelectorAll('.rn-chip').forEach(x => x.classList.toggle('on', x.dataset.k === conflict));
    showConflict();
  });

  sim.on('tick', () => {
    link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });
}

/* ═══ Conflict Detail ═══ */
function showConflict() {
  currentView = 'conflict';
  document.getElementById('overview').style.display = 'none';
  document.getElementById('timeline').style.display = 'none';
  document.getElementById('globeSection').style.display = 'none';
  document.getElementById('vizRow').style.display = 'none';
  document.getElementById('toolbar').style.display = 'none';
  document.getElementById('viewToggle').style.display = 'none';
  document.getElementById('conflictDetail').style.display = '';

  const c = D.conflicts[conflict];

  document.getElementById('cdName').innerHTML =
    `${c.name} <span class="ov-intensity ${c.intensity}">${INAMES[c.intensity] || c.intensity}</span>`;
  document.getElementById('cdMeta').innerHTML =
    `<span style="font-family:var(--mono);font-size:11px">${c.name_en}</span> · ${(c.parties||[]).join(' vs ')}<br>${c.status === 'active' ? '进行中' : c.status} · 自 ${c.since}`;

  const borderColor = { war:'var(--i-war)', conflict:'var(--i-conflict)', tension:'var(--i-tension)' };
  const summaryEl = document.getElementById('cdSummary');
  summaryEl.innerHTML = c.briefing
    ? `<div class="cd-briefing"><span class="briefing-icon">INTEL</span> ${esc(c.briefing)}</div>${c.summary ? `<div class="cd-summary-text">${esc(c.summary)}</div>` : ''}`
    : esc(c.summary);
  summaryEl.style.borderLeftColor = borderColor[c.intensity] || 'var(--red)';

  document.getElementById('cdBack').onclick = showOverview;

  // Related conflicts
  const related = (c.related || []).filter(k => D.conflicts[k]);
  const cdRight = document.getElementById('cdRight');
  if (related.length) {
    cdRight.innerHTML = `<div class="related-strip">关联冲突：${related.map(k =>
      `<span class="related-link" onclick="conflict='${k}';tab='military';document.querySelectorAll('.rn-chip').forEach(x=>x.classList.toggle('on',x.dataset.k==='${k}'));showConflict()">${D.conflicts[k].name}</span>`
    ).join('、')}</div>`;
  } else {
    cdRight.innerHTML = '';
  }

  initDetailMap(conflict, c);
  renderDataStrip(c);
  renderCatTabs(c);
  renderRiver(c);
}

function initDetailMap(key, c) {
  const el = document.getElementById('cdMap');
  const geo = CONFLICT_GEO[key];
  if (!geo || typeof L === 'undefined') { el.style.display = 'none'; return; }
  el.style.display = '';

  // Destroy previous map instance
  if (detailMap) { detailMap.remove(); detailMap = null; }

  detailMap = L.map(el, { zoomControl: true, scrollWheelZoom: false }).setView([geo.lat, geo.lng], geo.zoom);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OSM &amp; CartoDB',
    maxZoom: 12,
  }).addTo(detailMap);

  // Conflict zone marker
  const colors = { war: '#e74c3c', conflict: '#d87030', tension: '#c89820' };
  const color = colors[c.intensity] || colors.conflict;

  // Pulsing circle
  L.circleMarker([geo.lat, geo.lng], {
    radius: 18, color: color, fillColor: color, fillOpacity: 0.15, weight: 1.5,
  }).addTo(detailMap);
  L.circleMarker([geo.lat, geo.lng], {
    radius: 6, color: color, fillColor: color, fillOpacity: 0.8, weight: 0,
  }).addTo(detailMap);

  // Related conflicts as smaller markers
  const related = (c.related || []).filter(k => D.conflicts[k] && CONFLICT_GEO[k]);
  related.forEach(k => {
    const rg = CONFLICT_GEO[k];
    const rc = D.conflicts[k];
    const rcolor = colors[rc.intensity] || colors.conflict;
    L.circleMarker([rg.lat, rg.lng], {
      radius: 5, color: rcolor, fillColor: rcolor, fillOpacity: 0.5, weight: 0,
    }).bindTooltip(rc.name, { className: 'cd-map-tip', direction: 'top', offset: [0, -6] })
    .addTo(detailMap);
  });

  // Fix tile rendering on hidden->shown container
  setTimeout(() => detailMap.invalidateSize(), 100);
}

function renderDataStrip(c) {
  const el = document.getElementById('dataStrip');
  const allItems = Object.values(c.categories).flatMap(cat => cat.items);
  const srcCount = {};
  allItems.forEach(it => { srcCount[it.source] = (srcCount[it.source] || 0) + 1 });
  const srcColors = { reddit:'var(--tag-reddit)', x:'var(--tag-x)', youtube:'var(--tag-yt)', web:'var(--tag-web)' };
  const srcNames = { reddit:'Reddit', x:'X', youtube:'YouTube', web:'Web' };

  let html = `
    <div class="ds-cell"><div class="ds-label">Reports</div><div class="ds-val">${allItems.length}</div></div>
    <div class="ds-cell"><div class="ds-label">Sources</div><div class="ds-val">${Object.keys(srcCount).length}<span class="ds-unit">platforms</span></div></div>
  `;
  for (const [k, v] of Object.entries(srcCount)) {
    html += `<div class="ds-cell"><div class="ds-label">${srcNames[k]||k}</div><div class="ds-val"><span class="ds-dot" style="background:${srcColors[k]}"></span>${v}</div></div>`;
  }
  el.innerHTML = html;
}

function renderCatTabs(c) {
  const el = document.getElementById('catTabs');
  el.innerHTML = Object.entries(c.categories).map(([k, cat]) =>
    `<div class="ct ${k===tab?'on':''}" data-k="${k}">${cat.label}<span class="ct-n">${cat.items.length}</span></div>`
  ).join('');
  el.querySelectorAll('.ct').forEach(t => {
    t.onclick = () => {
      tab = t.dataset.k;
      el.querySelectorAll('.ct').forEach(x => x.classList.toggle('on', x.dataset.k===tab));
      renderRiver(D.conflicts[conflict]);
    };
  });
}

function renderRiver(c) {
  const el = document.getElementById('river');
  const items = c.categories[tab]?.items || [];
  if (!items.length) { el.innerHTML = '<div class="cv-empty-msg">该分类暂无数据</div>'; return }

  // Sort: recent first, but within 2 days prefer richer content for lead story
  const sorted = [...items].sort((a,b) => {
    const da = new Date(a.date), db = new Date(b.date);
    if (Math.abs(da - db) < 172800000) {
      const rich = s => (s.source==='web'?2:s.source==='youtube'?1:0) + (s.local_file?1:0);
      const d = rich(b) - rich(a);
      if (d !== 0) return d;
    }
    return db - da;
  });
  el.innerHTML = sorted.map((it, i) => {
    const d = new Date(it.date);
    const day = isNaN(d) ? '--' : d.getDate();
    const mon = isNaN(d) ? '---' : MO[d.getMonth()];
    const rel = relTime(it.date);

    if (i === 0) {
      return `<div class="story lead" style="--d:0ms" data-id="${it.id}">
        <div class="s-body">
          <div class="s-hl">${esc(it.title)}</div>
          ${it.title_en ? `<div class="en-original">${esc(it.title_en)}</div>` : ''}
          <div class="s-meta">
            <span class="s-src ${it.source}">${srcN(it.source)}</span>
            <span class="s-from">${esc(it.source_label)}${credBadge(it)}</span>
            ${nums(it.metrics)}
            <span class="s-time">${rel}</span>
          </div>
          <div class="s-dek">${esc(it.summary)}</div>
        </div>
      </div>`;
    }

    return `<div class="story" style="--d:${i*35}ms" data-id="${it.id}">
      <div class="s-date"><span class="s-day">${day}</span><span class="s-mon">${mon}</span></div>
      <div class="s-body">
        <div class="s-hl">${esc(it.title)}</div>
        ${it.title_en ? `<div class="en-original">${esc(it.title_en)}</div>` : ''}
        <div class="s-meta">
          <span class="s-src ${it.source}">${srcN(it.source)}</span>
          <span class="s-from">${esc(it.source_label)}${credBadge(it)}</span>
          ${nums(it.metrics)}
          <span class="s-time">${rel}</span>
        </div>
        <div class="s-dek">${esc(it.summary)}</div>
      </div>
    </div>`;
  }).join('');
}

/* ═══ Reader (full-page article view) ═══ */
function wireReader() {
  document.addEventListener('click', e => {
    // Timeline items need to set conflict first
    const tlItem = e.target.closest('.tl-item');
    if (tlItem && tlItem.dataset.id) {
      conflict = tlItem.dataset.ckey;
      openReader(tlItem.dataset.id);
      return;
    }
    const story = e.target.closest('.story');
    if (story && story.dataset.id) openReader(story.dataset.id);
  });
  document.getElementById('readerBack').onclick = closeReader;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeReader() });
}

async function openReader(id) {
  const c = D.conflicts[conflict];
  let it = null;
  for (const cat of Object.values(c.categories)) {
    it = cat.items.find(i => i.id === id);
    if (it) break;
  }
  if (!it) return;

  // Hide main content, show reader
  document.querySelector('.masthead').style.display = 'none';
  document.getElementById('searchBar').style.display = 'none';
  document.getElementById('regionNav').style.display = 'none';
  document.getElementById('viewToggle').style.display = 'none';
  document.getElementById('overview').style.display = 'none';
  document.getElementById('conflictDetail').style.display = 'none';
  document.getElementById('timeline').style.display = 'none';
  document.getElementById('kbdHint').style.display = 'none';
  document.getElementById('reader').style.display = '';

  // Populate
  document.getElementById('readerTag').textContent =
    `${srcN(it.source)} / ${it.source_label} / ${it.date}`;
  document.getElementById('readerTitle').innerHTML = esc(it.title) +
    (it.title_en ? `<div class="reader-original">${esc(it.title_en)}</div>` : '');

  const metaParts = [
    `<span class="s-src ${it.source}" style="font-size:11px">${srcN(it.source)}</span>`,
    `<span>${esc(it.source_label)}</span>`,
    `<span>${it.date}</span>`,
  ];
  const m = it.metrics || {};
  if (m.likes) metaParts.push(`${fmt(m.likes)} likes`);
  if (m.score) metaParts.push(`${fmt(m.score)} pts`);
  if (m.retweets) metaParts.push(`${fmt(m.retweets)} RT`);
  if (m.comments) metaParts.push(`${fmt(m.comments)} 评论`);
  document.getElementById('readerMeta').innerHTML = metaParts.join(' &middot; ');

  const actionHtml = `
    <a class="ra-btn ra-dark" href="${it.url}" target="_blank" rel="noopener">查看原始来源</a>
    ${it.local_file ? `<a class="ra-btn ra-ghost" href="${SRC}${it.local_file}" target="_blank">下载原文</a>` : ''}
  `;
  document.getElementById('readerActionsTop').innerHTML = actionHtml;
  document.getElementById('readerActionsBot').innerHTML = actionHtml;

  // Load content — try .zh.md (Chinese translation) first, fall back to original
  const body = document.getElementById('readerBody');
  if (cache[id]) {
    body.innerHTML = cache[id];
  } else if (it.local_file) {
    body.innerHTML = '<p style="color:var(--ink-25);font-family:var(--mono);font-size:12px">Loading...</p>';

    const zhFile = it.local_file.replace(/\.md$/, '.zh.md');
    let loadedZh = false;

    // Try Chinese version first
    try {
      const zr = await fetch(SRC + zhFile);
      if (zr.ok) {
        const zhRaw = await zr.text();
        if (zhRaw.length > 200) {
          const zhHtml = cleanArticleHtml(marked.parse(zhRaw));
          body.innerHTML = zhHtml;
          cache[id] = zhHtml;
          loadedZh = true;

          // Also load original for toggle
          try {
            const or2 = await fetch(SRC + it.local_file);
            if (or2.ok) {
              const origRaw = await or2.text();
              _originalBody = cleanArticleHtml(marked.parse(origRaw));
            }
          } catch {}
        }
      }
    } catch {}

    // Fall back to original
    if (!loadedZh) {
      try {
        const r = await fetch(SRC + it.local_file);
        if (!r.ok) throw r.status;
        const raw = await r.text();
        const cleaned = cleanArticleHtml(marked.parse(raw));
        body.innerHTML = cleaned;
        cache[id] = cleaned;
      } catch { body.innerHTML = `<p>${esc(it.summary)}</p>` }
    }
  } else {
    body.innerHTML = `<p>${esc(it.summary)}</p>`;
  }

  // Add reading time estimate
  const { minutes, words } = estimateReadTime(body.innerHTML);
  const isZh = body.textContent && (body.textContent.match(/[\u4e00-\u9fff]/g) || []).length > body.textContent.length * 0.2;
  const readInfo = document.createElement('div');
  readInfo.style.cssText = 'font-family:var(--mono);font-size:11px;color:var(--ink-25);margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid var(--ink-08)';
  readInfo.textContent = `${words.toLocaleString()} ${isZh ? '字' : 'words'} · ${minutes} ${isZh ? '分钟阅读' : 'min read'}${isZh ? ' · 已翻译' : ''}`;
  body.insertBefore(readInfo, body.firstChild);

  // Style Reddit comments with avatars
  if (it.source === 'reddit') {
    styleRedditComments(body);
  }

  // Store current item for translation
  _currentReaderItem = it;
  // _originalBody is already set above when loading .zh.md, don't overwrite it

  // Show translate bar
  const tBar = document.getElementById('translateBar');
  const tBtn = document.getElementById('translateBtn');
  const tStatus = document.getElementById('translateStatus');
  // Remove old toggle
  const oldToggle = tBar.querySelector('.translate-toggle');
  if (oldToggle) oldToggle.remove();

  if (it.local_file) {
    tBar.style.display = 'flex';
    // Check if .zh.md exists (we'll know after body loads)
    const zhFile = it.local_file.replace(/\.md$/, '.zh.md');
    fetch(SRC + zhFile, { method: 'HEAD' }).then(r => {
      if (r.ok) {
        // Translation exists — show toggle
        tBtn.textContent = '已翻译';
        tBtn.disabled = true;
        tBtn.classList.add('done');
        tStatus.textContent = '';
        const toggle = document.createElement('span');
        toggle.className = 'translate-toggle';
        toggle.textContent = '查看原文';
        toggle.onclick = () => {
          const bd = document.getElementById('readerBody');
          if (toggle.textContent === '查看原文' && _originalBody) {
            bd.innerHTML = _originalBody;
            toggle.textContent = '查看译文';
          } else {
            if (cache[id]) bd.innerHTML = cache[id];
            toggle.textContent = '查看原文';
          }
        };
        tBar.appendChild(toggle);
      } else {
        // No translation — enable translate button
        tBtn.textContent = '翻译全文';
        tBtn.disabled = false;
        tBtn.classList.remove('done');
        tStatus.textContent = '';
      }
    }).catch(() => {
      tBtn.textContent = '翻译全文';
      tBtn.disabled = false;
      tBtn.classList.remove('done');
      tStatus.textContent = '';
    });
  } else {
    tBar.style.display = 'none';
  }

  // Show progress bar
  document.getElementById('readerProgress').style.display = 'block';
  document.getElementById('readerProgress').style.width = '0%';
  window._readerScrollHandler = () => {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    const pct = h > 0 ? Math.min(100, (window.scrollY / h) * 100) : 0;
    document.getElementById('readerProgress').style.width = pct + '%';
  };
  window.addEventListener('scroll', window._readerScrollHandler);

  window.scrollTo(0, 0);
}

function closeReader() {
  document.getElementById('reader').style.display = 'none';
  document.getElementById('readerProgress').style.display = 'none';
  if (window._readerScrollHandler) {
    window.removeEventListener('scroll', window._readerScrollHandler);
  }
  document.querySelector('.masthead').style.display = '';
  document.getElementById('searchBar').style.display = '';
  document.getElementById('regionNav').style.display = '';
  document.getElementById('viewToggle').style.display = '';
  document.getElementById('kbdHint').style.display = '';
  // Restore previous view
  if (currentView === 'timeline') {
    document.getElementById('timeline').style.display = '';
  } else if (conflict) {
    document.getElementById('conflictDetail').style.display = '';
  } else {
    document.getElementById('overview').style.display = '';
  }
}

/* ═══ Helpers ═══ */
function relTime(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  const diff = Math.floor((new Date() - d) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff <= 7) return `${diff}天前`;
  if (diff <= 30) return `${Math.floor(diff/7)}周前`;
  return '';
}

function srcN(s) { return {reddit:'Reddit',x:'X',youtube:'YouTube',web:'Web'}[s]||s }

function nums(m) {
  if (!m) return '';
  const p = [];
  if (m.score) p.push(fmt(m.score)+' pts');
  if (m.likes) p.push(fmt(m.likes)+' likes');
  if (m.comments) p.push(fmt(m.comments)+' cmt');
  if (m.retweets) p.push(fmt(m.retweets)+' RT');
  if (m.views) p.push(m.views+' views');
  return p.length ? `<span class="s-nums">${p.join(' · ')}</span>` : '';
}

/* ═══ View Toggle ═══ */
function wireViewToggle() {
  document.getElementById('viewToggle').addEventListener('click', e => {
    const btn = e.target.closest('.vt-btn');
    if (!btn) return;
    const v = btn.dataset.v;
    document.querySelectorAll('.vt-btn').forEach(b => b.classList.toggle('vt-active', b.dataset.v === v));
    if (v === 'overview') showOverview();
    else if (v === 'timeline') showTimeline();
  });

  // Time filter
  document.getElementById('timeFilter').addEventListener('click', e => {
    const btn = e.target.closest('.tf-btn');
    if (!btn) return;
    timeFilterDays = parseInt(btn.dataset.t);
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.toggle('tf-active', b === btn));
    if (currentView === 'overview') showOverview();
    else if (currentView === 'timeline') showTimeline();
  });

  // Export
  document.getElementById('exportJson').onclick = exportJson;
  document.getElementById('exportCsv').onclick = exportCsv;
}

function exportJson() {
  const blob = new Blob([JSON.stringify(D, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `conflict-data-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
}

function exportCsv() {
  const rows = [['conflict', 'category', 'date', 'title', 'source', 'source_label', 'url']];
  for (const [k, c] of Object.entries(D.conflicts)) {
    for (const [catKey, cat] of Object.entries(c.categories)) {
      for (const it of filterByTime(cat.items)) {
        rows.push([
          c.name, cat.label || catKey, it.date || '',
          (it.title || '').replace(/"/g, '""'),
          it.source || '', it.source_label || '', it.url || ''
        ]);
      }
    }
  }
  const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `conflict-data-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

/* ═══ Global Timeline ═══ */
function showTimeline() {
  currentView = 'timeline';
  conflict = null;
  kbIdx = -1;
  document.querySelectorAll('.rn-chip').forEach(x => x.classList.remove('on'));
  document.querySelectorAll('.vt-btn').forEach(b => b.classList.toggle('vt-active', b.dataset.v === 'timeline'));
  document.getElementById('overview').style.display = 'none';
  document.getElementById('conflictDetail').style.display = 'none';
  document.getElementById('toolbar').style.display = '';
  document.getElementById('timeline').style.display = '';
  document.getElementById('globeSection').style.display = 'none';
  document.getElementById('vizRow').style.display = 'none';

  // Collect all items from all conflicts
  const all = [];
  for (const [ckey, conf] of Object.entries(D.conflicts)) {
    for (const cat of Object.values(conf.categories)) {
      for (const item of cat.items) {
        all.push({ ...item, _conflict: ckey, _conflictName: conf.name, _intensity: conf.intensity });
      }
    }
  }

  all.sort((a, b) => new Date(b.date) - new Date(a.date));

  const el = document.getElementById('timeline');
  const PAGE = 40;
  window._tlAll = all;
  window._tlShown = PAGE;

  renderTimelineItems(el, all, PAGE);
  kbIdx = -1;
}

function renderTimelineItems(el, all, limit) {
  const shown = all.slice(0, limit);
  const byDate = {};
  for (const item of shown) {
    const d = item.date || 'unknown';
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(item);
  }

  let html = '';
  let i = 0;
  for (const [date, items] of Object.entries(byDate)) {
    const d = new Date(date);
    const label = isNaN(d) ? date : `${d.getFullYear()}年${LMO[d.getMonth()]}${d.getDate()}日`;
    html += `<div class="tl-day-header">${label}</div>`;
    for (const item of items) {
      html += `
        <div class="tl-item" style="--d:${(i++)*20}ms" data-id="${item.id}" data-ckey="${item._conflict}">
          <span class="tl-conflict-tag ${item._intensity}">${item._conflictName}</span>
          <div class="tl-body">
            <div class="tl-title">${esc(item.title)}</div>
            <div class="tl-meta">
              <span class="s-src ${item.source}">${srcN(item.source)}</span>
              <span>${esc(item.source_label)}${credBadge(item)}</span>
              ${nums(item.metrics)}
            </div>
          </div>
        </div>`;
    }
  }

  if (limit < all.length) {
    html += `<div class="tl-load-more" onclick="loadMoreTimeline()">显示更多 (${all.length - limit} 条剩余)</div>`;
  }

  el.innerHTML = html;
}

function loadMoreTimeline() {
  window._tlShown += 40;
  renderTimelineItems(document.getElementById('timeline'), window._tlAll, window._tlShown);
}

/* ═══ Search ═══ */
function wireSearch() {
  const input = document.getElementById('searchInput');
  let debounce = null;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => doSearch(input.value.trim()), 200);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { input.value = ''; doSearch(''); input.blur(); }
  });
}

function doSearch(q) {
  const countEl = document.getElementById('searchCount');
  if (!q) {
    countEl.textContent = '';
    // Restore current view
    if (currentView === 'timeline') showTimeline();
    else if (conflict) showConflict();
    else showOverview();
    return;
  }

  const ql = q.toLowerCase();
  const results = [];
  for (const [ckey, conf] of Object.entries(D.conflicts)) {
    for (const cat of Object.values(conf.categories)) {
      for (const item of cat.items) {
        if ((item.title || '').toLowerCase().includes(ql) ||
            (item.summary || '').toLowerCase().includes(ql) ||
            (item.source_label || '').toLowerCase().includes(ql)) {
          results.push({ ...item, _conflict: ckey, _conflictName: conf.name, _intensity: conf.intensity });
        }
      }
    }
  }

  countEl.textContent = `${results.length} 结果`;

  // Hide other views, show results in river or timeline area
  document.getElementById('overview').style.display = 'none';
  document.getElementById('conflictDetail').style.display = 'none';
  const tl = document.getElementById('timeline');
  tl.style.display = '';

  if (!results.length) {
    tl.innerHTML = `<div style="padding:60px 0;text-align:center;color:var(--ink-25)">没有找到 "${esc(q)}" 相关的报道</div>`;
    return;
  }

  results.sort((a, b) => new Date(b.date) - new Date(a.date));
  tl.innerHTML = results.map((item, i) => `
    <div class="tl-item" style="--d:${i*25}ms" data-id="${item.id}" data-ckey="${item._conflict}">
      <span class="tl-conflict-tag ${item._intensity}">${item._conflictName}</span>
      <div class="tl-body">
        <div class="tl-title">${esc(item.title)}</div>
        <div class="tl-meta">
          <span class="s-src ${item.source}">${srcN(item.source)}</span>
          <span>${esc(item.source_label)}${credBadge(item)}</span>
          ${nums(item.metrics)}
        </div>
      </div>
    </div>
  `).join('');

  kbIdx = -1;
}

/* ═══ Keyboard Navigation ═══ */
function wireKeyboard() {
  document.addEventListener('keydown', e => {
    // Don't intercept when typing in search
    if (document.activeElement === document.getElementById('searchInput')) {
      return;
    }
    // Don't intercept in reader view
    if (document.getElementById('reader').style.display !== 'none') {
      return;
    }

    if (e.key === '/') {
      e.preventDefault();
      document.getElementById('searchInput').focus();
      return;
    }

    const items = document.querySelectorAll('.story, .tl-item, .ov-card');
    if (!items.length) return;

    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      kbIdx = Math.min(kbIdx + 1, items.length - 1);
      updateKbFocus(items);
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      kbIdx = Math.max(kbIdx - 1, 0);
      updateKbFocus(items);
    } else if (e.key === 'Enter' && kbIdx >= 0 && kbIdx < items.length) {
      e.preventDefault();
      items[kbIdx].click();
    }
  });
}

function updateKbFocus(items) {
  items.forEach(el => el.classList.remove('kb-active'));
  if (kbIdx >= 0 && kbIdx < items.length) {
    items[kbIdx].classList.add('kb-active');
    items[kbIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

/* ═══ Article Translation ═══ */
let _currentReaderItem = null;
let _originalBody = null;

async function translateArticle() {
  if (!_currentReaderItem || !_currentReaderItem.local_file) return;

  const btn = document.getElementById('translateBtn');
  const status = document.getElementById('translateStatus');
  btn.disabled = true;
  btn.textContent = '翻译中...';
  status.textContent = '正在调用翻译服务，较长文章可能需要 30-60 秒';

  try {
    const r = await fetch(`/api/translate?file=${encodeURIComponent(_currentReaderItem.local_file)}`);
    const data = await r.json();

    if (data.translated) {
      _originalBody = document.getElementById('readerBody').innerHTML;
      const html = marked.parse(data.translated);
      const body = document.getElementById('readerBody');
      body.innerHTML = cleanArticleHtml(html);
      if (_currentReaderItem.source === 'reddit') styleRedditComments(body);

      // Update reading time
      const { minutes, words } = estimateReadTime(document.getElementById('readerBody').innerHTML);
      const readInfo = document.createElement('div');
      readInfo.style.cssText = 'font-family:var(--mono);font-size:11px;color:var(--ink-25);margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid var(--ink-08)';
      readInfo.textContent = `${words.toLocaleString()} 字 · ${minutes} 分钟阅读 · 已翻译`;
      document.getElementById('readerBody').insertBefore(readInfo, document.getElementById('readerBody').firstChild);

      btn.textContent = '已翻译';
      btn.classList.add('done');
      status.textContent = data.cached ? '(缓存)' : '';

      // Add toggle to show original
      const bar = document.getElementById('translateBar');
      let toggle = bar.querySelector('.translate-toggle');
      if (!toggle) {
        toggle = document.createElement('span');
        toggle.className = 'translate-toggle';
        toggle.textContent = '查看原文';
        toggle.onclick = () => {
          const body = document.getElementById('readerBody');
          if (toggle.textContent === '查看原文') {
            body.innerHTML = _originalBody;
            toggle.textContent = '查看译文';
          } else {
            const html2 = marked.parse(data.translated);
            body.innerHTML = cleanArticleHtml(html2);
            if (_currentReaderItem.source === 'reddit') styleRedditComments(body);
            toggle.textContent = '查看原文';
          }
        };
        bar.appendChild(toggle);
      }
    } else {
      btn.textContent = '翻译失败';
      status.textContent = data.error || '';
    }
  } catch (e) {
    btn.textContent = '翻译失败';
    status.textContent = e.message;
  }
}

function toggleLang() {
  document.body.classList.toggle('show-en');
  const btn = document.getElementById('langToggle');
  btn.textContent = document.body.classList.contains('show-en') ? '隐藏原文' : 'EN/中';
}

function fmt(n) { return n>=1000?(n/1000).toFixed(1).replace(/\.0$/,'')+'k':String(n) }
function esc(s) { const d=document.createElement('div'); d.textContent=s||''; return d.innerHTML }

function cleanArticleHtml(html) {
  const el = document.createElement('div');
  el.innerHTML = html;

  // Remove noise images — source-aware
  const isReddit = html.includes('reddit.com') || html.includes('r/') || html.includes('u/');
  el.querySelectorAll('img').forEach(img => {
    const src = (img.getAttribute('src') || '').toLowerCase();
    const alt = (img.getAttribute('alt') || '').toLowerCase();

    // Reddit: remove ALL images (avatars, snoo, preview thumbnails — content is text)
    if (isReddit && (src.includes('reddit') || src.includes('redd.it') || src.includes('avatar') ||
        alt.includes('avatar') || alt.includes('r/'))) {
      img.remove();
      return;
    }

    // General noise images
    const isNoise = src.includes('icon') || src.includes('logo') || src.includes('favicon') ||
                    src.includes('avatar') || src.includes('badge') || src.includes('emoji') ||
                    src.includes('.svg') || src.includes('1x1') || src.includes('pixel') ||
                    src.includes('styles.redditmedia') || src.includes('preview.redd.it') ||
                    alt.includes('icon') || alt.includes('logo') || alt.includes('avatar');
    if (isNoise) img.remove();
  });

  let text = el.innerHTML;

  // ── Phase 1: Remove structured boilerplate ──
  const noisePatterns = [
    // Navigation / UI chrome
    /Skip to (?:main )?content[^<]*/gi,
    /(?:Open|Close|Expand|Toggle)\s+(?:menu|navigation|settings|sidebar)[^<]*/gi,
    /(?:Log [Ii]n|Sign [Uu]p|Sign [Ii]n|Get (?:the )?[Aa]pp|Create account)[^<]*/gi,
    /Go to Reddit Home/gi,
    /Expand user menu/gi,
    /Open settings menu/gi,

    // Share / social buttons
    /\[!\[Image[^\]]*\]\([^\)]*\)\]\([^\)]*\)/g,
    /\[Share[^\]]*\]\([^\)]*\)/g,
    /\[Donate\]\([^\)]*\)/g,
    /\[DOWNLOAD PAGE\][^\n]*/g,
    /\[PRINT PAGE\][^\n]*/g,

    // Ad / cookie / privacy notices
    /Ad Feedback[\s\S]*?Cancel\s+Submit/gi,
    /Thank You![\s\S]*?Close/gi,
    /How relevant is this ad[\s\S]*?Submit/gi,
    /You rely on .{2,40} for truth and transparency[\s\S]*?(?:Allow all|Reject all|Manage preferences)[^\n]*/gi,
    /We process your personal information[\s\S]*?(?:Allow all|Reject all|Accept|Manage)[^\n]*/gi,
    /We use cookies[\s\S]*?(?:Accept|Reject|Manage)[^\n]*/gi,
    /This site is protected by reCAPTCHA[^\n]*/gi,

    // Reddit boilerplate
    /r\/\w+ • \d+[dhm] ago/g,
    /\d+ upvotes? · \d+ comments?/gi,
    /Join\s*\n/g,
    /Get the Reddit app/gi,

    // Markdown noise
    /^#{1,3}\s*\[.*?\]\(.*?\)\s*$/gm,
    /!\[Image \d+\]\(https:\/\/[^\)]*(?:icon|logo|svg|favicon|avatar|badge)[^\)]*\)/gi,
    /!\[Image \d+\]\(https:\/\/static\d*\.nyt\.com\/images\/icons\/[^\)]+\)/g,
    /!\[r\/\w+ -[^\]]*\]\([^\)]*\)/g,

    // Footer / recommended — scoped removal, NOT greedy to end of document
    /#{1,3}\s*(?:More (?:on|from|stories|articles)|Related (?:articles|stories|coverage|From)|Recommended|Also read|You may also like|Popular|Trending|Most read|Keep reading|Read next|What to read next)[^\n]*(?:\n(?!<h)[^\n]{0,200})*/gi,
    /#{1,3}\s*(?:About the author|About this|Contact us|Follow us|Stay informed|Sign up|Subscribe|Join us|Support)[^\n]*(?:\n(?!<h)[^\n]{0,200})*/gi,
    /(?:©|Copyright)\s*\d{4}[^\n]*(?:\n[^\n]{0,150})*/gi,
    /SIGN\s*UP[^\n]*(?:\n(?!<h)[^\n]{0,200})*/gi,
    /Related From[^\n]*(?:\n(?!<h)[^\n]{0,200})*/gi,
    /Ways to make a difference[^\n]*(?:\n(?!<h)[^\n]{0,200})*/gi,

    // Newsletter / CTA
    /Already a subscriber\?[^\n]*/gi,
    /This article appeared in[^\n]*/gi,

    // Jina Reader metadata
    /^Title:.*$/gm,
    /^URL Source:.*$/gm,
    /^Published Time:.*$/gm,
    /^Markdown Content:\s*/gm,
  ];

  for (const p of noisePatterns) {
    text = text.replace(p, '');
  }

  // ── Phase 2: DOM-level cleanup ──
  const el2 = document.createElement('div');
  el2.innerHTML = text;

  // Remove empty headings and paragraphs
  el2.querySelectorAll('h1,h2,h3,h4,h5,h6,p').forEach(node => {
    const t = node.textContent.trim();
    if (!t || t.length < 3) node.remove();
  });

  // Remove links that are just "[text]" with no real content around them
  el2.querySelectorAll('a').forEach(a => {
    // Keep links within paragraphs, remove standalone link-only elements
    if (a.parentElement && a.parentElement.children.length === 1 &&
        a.parentElement.textContent.trim() === a.textContent.trim() &&
        a.parentElement.tagName !== 'P' && a.parentElement.tagName !== 'LI') {
      a.parentElement.remove();
    }
  });

  text = el2.innerHTML;

  // Collapse whitespace
  text = text.replace(/(<br\s*\/?>[\s]*){3,}/gi, '<br><br>');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  // Guard: if we removed >90% of content, keep original
  if (html.length > 0 && text.length < html.length * 0.1) {
    return html;
  }

  return text;
}

function hashColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  const sat = 45 + (Math.abs(h >> 8) % 30);   // 45-75%
  const lit = 42 + (Math.abs(h >> 16) % 16);   // 42-58%
  return `hsl(${hue},${sat}%,${lit}%)`;
}

function styleRedditComments(container) {
  container.querySelectorAll('blockquote').forEach(bq => {
    // Strategy: split <p> elements by u/username pattern, create individual cards
    const paragraphs = bq.querySelectorAll('p');
    // Match u/username — handles <em> tags and empty usernames
    const userRe = /^\s*<strong>u\/((?:<\/?em>|[\w-])*)<\/strong>\s*(?:\((\d+)\s*pts?\))?\s*/;

    // Check if this blockquote has multiple user comments packed in
    let hasUsers = false;
    paragraphs.forEach(p => { if (userRe.test(p.innerHTML)) hasUsers = true; });
    if (!hasUsers) {
      // Single-comment blockquote (old format) — try matching the whole blockquote
      const m = bq.innerHTML.match(userRe);
      if (m) {
        const uname = m[1].replace(/<\/?em>/g, '') || '';
        const anon = !uname;
        const color = anon ? 'var(--ink-25,#999)' : hashColor(uname);
        const initials = anon ? '?' : uname.slice(0, 2).toUpperCase();
        const displayName = anon ? 'anonymous' : `u/${uname}`;
        let rest = bq.innerHTML.replace(m[0], '').replace(/^(<br\s*\/?>|\s)*/, '');
        bq.style.borderLeftColor = color;
        bq.innerHTML = `<div class="comment-header"><span class="comment-avatar" style="background:${color}">${initials}</span><span class="comment-user">${displayName}</span>${m[2] ? `<span class="comment-score">${m[2]} pts</span>` : ''}</div><div class="comment-text">${rest}</div>`;
      }
      return;
    }

    // Multi-comment blockquote: split into individual cards
    const cards = [];
    let current = null;

    paragraphs.forEach(p => {
      const m = p.innerHTML.match(userRe);
      if (m) {
        if (current) cards.push(current);
        const username = m[1].replace(/<\/?em>/g, '') || '';
        const text = p.innerHTML.replace(m[0], '').replace(/^(<br\s*\/?>|\s)*/, '').trim();
        current = { username, score: m[2] || '', lines: text ? [text] : [] };
      } else if (current) {
        // Continuation paragraph for the current user
        current.lines.push(p.innerHTML.trim());
      }
    });
    if (current) cards.push(current);

    // Replace the blockquote contents with styled cards
    bq.innerHTML = cards.map(c => {
      const anon = !c.username;
      const color = anon ? 'var(--ink-25,#999)' : hashColor(c.username);
      const initials = anon ? '?' : c.username.slice(0, 2).toUpperCase();
      const displayName = anon ? 'anonymous' : `u/${c.username}`;
      const body = c.lines.filter(l => l).join('<br>');
      return `<div class="comment-card" style="border-left-color:${color}">
        <div class="comment-header">
          <span class="comment-avatar" style="background:${color}">${initials}</span>
          <span class="comment-user">${displayName}</span>
          ${c.score ? `<span class="comment-score">${c.score} pts</span>` : ''}
        </div>
        <div class="comment-text">${body}</div>
      </div>`;
    }).join('');
    bq.classList.add('comment-stream');
  });
}

function estimateReadTime(html) {
  const el = document.createElement('div');
  el.innerHTML = html;
  const text = el.textContent || '';
  const words = text.split(/\s+/).filter(w => w.length > 0).length;
  // Chinese: ~400 chars/min, English: ~200 words/min
  const cnChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const enWords = words - cnChars;
  const minutes = Math.max(1, Math.round((cnChars / 400) + (enWords / 200)));
  return { minutes, words };
}

boot();
