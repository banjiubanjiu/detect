/* ═══════════════════════════════════════════════════════════════
   战况追踪 · ANALYTICS — 分析工作台
   读同一份 latest.json, 不依赖 app.js/command.js, 独立运行
   ═══════════════════════════════════════════════════════════════ */

const IS_PAGES = location.hostname.includes('github.io');
const SRC = IS_PAGES ? 'data/' : '../data/';

const CONFLICTS_META = {
  'russia-ukraine':  { code: 'RUA', name: '俄乌战争' },
  'israel-palestine':{ code: 'ISR', name: '巴以冲突' },
  'us-iran':         { code: 'IRN', name: '美伊对峙' },
  'sudan':           { code: 'SDN', name: '苏丹内战' },
  'myanmar':         { code: 'MMR', name: '缅甸内战' },
  'yemen-houthi':    { code: 'YEM', name: '也门胡塞' },
  'congo-drc':       { code: 'COD', name: '刚果东部' },
  'syria':           { code: 'SYR', name: '叙利亚' },
  'taiwan-strait':   { code: 'TWN', name: '台海局势' },
};

/* 9 种高区分色板 (HSL 色相环 40° 均分) */
const CONFLICT_PALETTE = {
  'russia-ukraine':  '#d9463e',  // 红
  'israel-palestine':'#d97c26',  // 橙
  'us-iran':         '#c2a130',  // 金
  'sudan':           '#7fa836',  // 橄榄绿
  'myanmar':         '#3aa37d',  // 青绿
  'yemen-houthi':    '#3e8fb0',  // 青蓝
  'congo-drc':       '#5670b5',  // 靛蓝
  'syria':           '#8b5aa8',  // 紫
  'taiwan-strait':   '#b84780',  // 品红
};

/* 全局 */
let D = null;
let allItems = [];
let _filterDays = 30;          // 时间窗口 (0 = all)
let _hiddenConflicts = new Set(); // legend 隐藏的冲突
let _hoverConflict = null;     // watchlist hover 的冲突

/* ─────────────────────────────────────────────
   工具函数
───────────────────────────────────────────── */

function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function critWeight(item) {
  return item.criticality === 'critical' ? 2 : item.criticality === 'notable' ? 1 : 0;
}

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
  if (prior === 0 && cur < 15) return null;
  const delta = prior > 0 ? Math.round((cur - prior) / prior * 100) : 999;
  return { cur, prior, delta };
}

/* 时间过滤: 返回符合当前 _filterDays 的 item */
function filterByTime(items) {
  if (_filterDays === 0) return items;
  const cutoff = Date.now() - _filterDays * 86400000;
  return items.filter(it => it._date_ts >= cutoff);
}

/* ─────────────────────────────────────────────
   数据加载
───────────────────────────────────────────── */

async function loadAll() {
  try {
    const r = await fetch(SRC + 'latest.json');
    D = await r.json();
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px;color:#e84838;font-family:monospace">加载 latest.json 失败: ${e}</div>`;
    return;
  }

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
  renderTopStats();
  renderTimeFilter();
  renderLegend();
  renderStreamgraph();
  renderWatchlist();
  renderGoldsteinFloor();
}

/* ─────────────────────────────────────────────
   顶栏统计
───────────────────────────────────────────── */

function renderTopStats() {
  const windowItems = _filterDays > 0
    ? allItems.filter(it => it._date_ts >= Date.now() - _filterDays * 86400000)
    : allItems;
  document.getElementById('statTotal').textContent = windowItems.length.toLocaleString();
  // 簇数量
  const clusterIds = new Set();
  for (const it of windowItems) {
    if (it.cluster_id) clusterIds.add(it.cluster_id);
  }
  document.getElementById('statClusters').textContent = clusterIds.size;
}

/* ─────────────────────────────────────────────
   时间过滤
───────────────────────────────────────────── */

function renderTimeFilter() {
  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = parseInt(btn.dataset.t);
      _filterDays = t;
      document.querySelectorAll('.tf-btn').forEach(b => b.classList.toggle('tf-active', b.dataset.t === btn.dataset.t));
      renderTopStats();
      renderStreamgraph();
      renderWatchlist();
      renderGoldsteinFloor();
    });
  });
}

/* ─────────────────────────────────────────────
   Legend 图例 (顶部彩色 chip)
───────────────────────────────────────────── */

function renderLegend() {
  const el = document.getElementById('streamLegend');
  if (!el) return;
  const cids = Object.keys(CONFLICTS_META);
  el.innerHTML = cids.map(cid => {
    const meta = CONFLICTS_META[cid];
    const color = CONFLICT_PALETTE[cid];
    return `
      <span class="legend-chip" data-cid="${cid}">
        <span class="legend-swatch" style="background:${color}"></span>
        ${meta.code}
      </span>
    `;
  }).join('');

  el.querySelectorAll('.legend-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const cid = chip.dataset.cid;
      if (_hiddenConflicts.has(cid)) {
        _hiddenConflicts.delete(cid);
        chip.classList.remove('lc-off');
      } else {
        _hiddenConflicts.add(cid);
        chip.classList.add('lc-off');
      }
      renderStreamgraph();
    });
  });
}

/* ─────────────────────────────────────────────
   Streamgraph (大主图)
───────────────────────────────────────────── */

function renderStreamgraph() {
  const el = document.getElementById('streamWrap');
  if (!el || typeof d3 === 'undefined') return;

  const days = _filterDays > 0 ? _filterDays : 90;
  const now = new Date();
  const conflictIds = Object.keys(CONFLICTS_META).filter(cid => !_hiddenConflicts.has(cid));

  // 按天桶
  const buckets = [];
  for (let i = 0; i < days; i++) {
    const dt = new Date(now - (days - 1 - i) * 86400000);
    const b = { date: dt, dayIdx: i };
    for (const cid of conflictIds) b[cid] = 0;
    buckets.push(b);
  }
  for (const cid of conflictIds) {
    const items = allItems.filter(it => it._conflict === cid);
    for (const it of items) {
      if (!it._date_ts) continue;
      const diff = Math.floor((now - it._date_ts) / 86400000);
      if (diff >= 0 && diff < days) {
        buckets[days - 1 - diff][cid]++;
      }
    }
  }

  // d3 stack
  const stack = d3.stack()
    .keys(conflictIds)
    .offset(d3.stackOffsetSilhouette)
    .order(d3.stackOrderInsideOut);
  const series = stack(buckets);

  // 计算真实峰值 (非对称化之前)
  let peakDayTotal = 0;
  let peakDayIdx = -1;
  for (let i = 0; i < buckets.length; i++) {
    let total = 0;
    for (const cid of conflictIds) total += buckets[i][cid];
    if (total > peakDayTotal) {
      peakDayTotal = total;
      peakDayIdx = i;
    }
  }

  // 布局
  // 清掉旧 svg 但保留 tooltip div
  const tooltip = document.getElementById('streamTooltip');
  el.querySelectorAll('svg').forEach(s => s.remove());

  const width = el.clientWidth;
  const height = el.clientHeight;
  const margin = { top: 30, right: 60, bottom: 30, left: 50 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const x = d3.scaleLinear().domain([0, days - 1]).range([0, innerW]);
  const yMin = d3.min(series, layer => d3.min(layer, d => d[0])) || 0;
  const yMax = d3.max(series, layer => d3.max(layer, d => d[1])) || 1;
  const y = d3.scaleLinear().domain([yMin, yMax]).range([innerH, 0]);

  const area = d3.area()
    .x((_, i) => x(i))
    .y0(d => y(d[0]))
    .y1(d => y(d[1]))
    .curve(d3.curveBasis);

  const svg = d3.select(el).append('svg')
    .attr('width', width)
    .attr('height', height);

  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  // Y 轴网格 (虚线)
  const yGrid = d3.scaleLinear().domain([0, peakDayTotal]).range([innerH, 0]);
  const yTicks = [0, Math.ceil(peakDayTotal / 2), peakDayTotal];
  yTicks.forEach(tick => {
    // 因为 silhouette 是对称的,对应到 y 坐标要做映射
    // 这里简化: 只在图顶部画峰值标注, 不画完整网格
  });

  // Streams
  const paths = g.selectAll('path.stream-layer')
    .data(series)
    .join('path')
    .attr('class', 'stream-layer')
    .attr('d', area)
    .attr('fill', d => CONFLICT_PALETTE[d.key])
    .attr('stroke', 'none')
    .attr('opacity', 0.82)
    .attr('data-cid', d => d.key);

  paths
    .on('mouseenter', function(e, d) {
      // 突出这条,其余淡化
      g.selectAll('path.stream-layer').attr('opacity', 0.25);
      d3.select(this).attr('opacity', 1);
      // 同时高亮 watchlist 对应项
      document.querySelectorAll('.aw-item').forEach(r => r.classList.toggle('aw-hover', r.dataset.cid === d.key));
    })
    .on('mouseleave', function() {
      g.selectAll('path.stream-layer').attr('opacity', 0.82);
      document.querySelectorAll('.aw-item.aw-hover').forEach(r => r.classList.remove('aw-hover'));
    })
    .on('click', function(e, d) {
      // 跳到 archive 详情
      location.href = `./#${d.key}`;
    });

  // 今天竖线 (最右侧那天)
  const nowX = x(days - 1);
  g.append('line')
    .attr('class', 'stream-now-line')
    .attr('x1', nowX).attr('x2', nowX)
    .attr('y1', 0).attr('y2', innerH);
  g.append('text')
    .attr('class', 'stream-now-label')
    .attr('x', nowX + 4)
    .attr('y', 12)
    .text('NOW');

  // 峰值标注
  if (peakDayIdx >= 0 && peakDayTotal > 0) {
    const peakX = x(peakDayIdx);
    const peakY = 14;
    const peakDate = buckets[peakDayIdx].date;
    const peakLabel = `PEAK ${peakDate.getMonth()+1}/${peakDate.getDate()} · ${peakDayTotal} 条`;
    const labelPadding = 6;
    const labelWidth = peakLabel.length * 6.5 + labelPadding * 2;
    const labelX = Math.max(0, Math.min(innerW - labelWidth, peakX - labelWidth / 2));
    g.append('rect')
      .attr('x', labelX)
      .attr('y', 0)
      .attr('width', labelWidth)
      .attr('height', 18)
      .attr('fill', 'rgba(232,72,56,0.15)')
      .attr('stroke', 'rgba(232,72,56,0.6)')
      .attr('rx', 1);
    g.append('text')
      .attr('x', labelX + labelPadding)
      .attr('y', 12)
      .attr('font-family', 'var(--mono)')
      .attr('font-size', 10)
      .attr('fill', '#e84838')
      .attr('font-weight', 700)
      .text(peakLabel);
    // 从 label 到该日的连线
    g.append('line')
      .attr('x1', peakX).attr('x2', peakX)
      .attr('y1', 18).attr('y2', innerH)
      .attr('stroke', 'rgba(232,72,56,0.35)')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '2 3');
  }

  // X 轴日期标签 (底部,约 8 个 ticks)
  const nTicks = Math.min(8, days);
  const tickStep = Math.max(1, Math.floor(days / nTicks));
  const xAxisG = g.append('g').attr('transform', `translate(0,${innerH + 4})`);
  for (let i = 0; i < days; i += tickStep) {
    const b = buckets[i];
    xAxisG.append('text')
      .attr('class', 'stream-x-label')
      .attr('x', x(i))
      .attr('y', 14)
      .attr('text-anchor', 'middle')
      .text(`${b.date.getMonth()+1}/${b.date.getDate()}`);
  }
  // 最后一天强制显示
  const lastB = buckets[days - 1];
  xAxisG.append('text')
    .attr('class', 'stream-x-label')
    .attr('x', x(days - 1))
    .attr('y', 14)
    .attr('text-anchor', 'middle')
    .text(`${lastB.date.getMonth()+1}/${lastB.date.getDate()}`);

  // Y 轴 (左侧): peakDayTotal 标注
  const yAxisG = svg.append('g').attr('transform', `translate(${margin.left - 6},${margin.top})`);
  yAxisG.append('text')
    .attr('class', 'stream-y-label')
    .attr('x', 0).attr('y', 4)
    .attr('text-anchor', 'end')
    .text(`max ${peakDayTotal}/d`);
  yAxisG.append('text')
    .attr('class', 'stream-y-label')
    .attr('x', 0).attr('y', innerH + 4)
    .attr('text-anchor', 'end')
    .text(`0`);

  // Hover 垂直参考线 + tooltip (捕获 mousemove)
  const hoverLine = g.append('line')
    .attr('class', 'stream-hover-line')
    .attr('y1', 0).attr('y2', innerH)
    .style('display', 'none');

  svg.append('rect')
    .attr('class', 'stream-capture')
    .attr('x', margin.left).attr('y', margin.top)
    .attr('width', innerW).attr('height', innerH)
    .attr('fill', 'transparent')
    .style('cursor', 'crosshair')
    .on('mousemove', function(e) {
      const [mx, my] = d3.pointer(e, svg.node());
      const relX = mx - margin.left;
      const dayIdx = Math.max(0, Math.min(days - 1, Math.round(x.invert(relX))));
      const b = buckets[dayIdx];
      hoverLine.style('display', '').attr('x1', x(dayIdx)).attr('x2', x(dayIdx));

      // Tooltip 内容: 日期 + 全部冲突当日计数 (倒序)
      const rows = conflictIds.map(cid => ({
        cid, code: CONFLICTS_META[cid].code, name: CONFLICTS_META[cid].name,
        color: CONFLICT_PALETTE[cid], count: b[cid] || 0,
      }));
      const total = rows.reduce((s, r) => s + r.count, 0);
      rows.sort((a, b) => b.count - a.count);
      const rowHtml = rows.map(r => `
        <div class="stt-row ${r.count === 0 ? 'stt-zero' : ''}">
          <span class="stt-row-code">
            <span class="stt-row-swatch" style="background:${r.color}"></span>
            ${r.code}
          </span>
          <span class="stt-row-val">${r.count}</span>
        </div>
      `).join('');
      tooltip.innerHTML = `
        <div class="stt-date">${b.date.getMonth()+1}月${b.date.getDate()}日</div>
        <div class="stt-total">总计 ${total} 条事件</div>
        ${rowHtml}
      `;
      tooltip.style.display = '';
      // 定位 (避免出画面)
      const wrapRect = el.getBoundingClientRect();
      const tipRect = tooltip.getBoundingClientRect();
      let left = e.clientX - wrapRect.left + 16;
      let top  = e.clientY - wrapRect.top + 16;
      if (left + tipRect.width > wrapRect.width) left = e.clientX - wrapRect.left - tipRect.width - 16;
      if (top + tipRect.height > wrapRect.height) top = wrapRect.height - tipRect.height - 8;
      tooltip.style.left = left + 'px';
      tooltip.style.top  = top + 'px';
    })
    .on('mouseleave', function() {
      hoverLine.style('display', 'none');
      tooltip.style.display = 'none';
    });

  // 副标题更新 (显示当前窗口)
  const subEl = document.getElementById('streamSub');
  if (subEl) {
    subEl.textContent = `${days} 天窗口 · 总 ${buckets.reduce((s, b) => s + conflictIds.reduce((ss, c) => ss + b[c], 0), 0)} 条 · 峰值 ${peakDayTotal}/日 · hover 任一天查看明细`;
  }
}

/* ─────────────────────────────────────────────
   Watchlist 9 冲突横向条 (彭博风)
───────────────────────────────────────────── */

function renderWatchlist() {
  const el = document.getElementById('watchlist');
  if (!el) return;

  const days = _filterDays > 0 ? _filterDays : 30;
  const now = Date.now();
  const cutoff = now - days * 86400000;

  const entries = Object.entries(CONFLICTS_META).map(([cid, meta]) => {
    const items = allItems.filter(it => it._conflict === cid && it._date_ts >= cutoff);
    const total = items.length;
    const surge = detectSurge(items);

    // 30 天桶 (总是 30 天,不随 filter 变)
    const days30 = 30;
    const buckets = new Array(days30).fill(0);
    let peakDay = null, peakVal = 0;
    let minGS = null;
    for (const it of allItems) {
      if (it._conflict !== cid || !it._date_ts) continue;
      const diff = Math.floor((now - it._date_ts) / 86400000);
      if (diff >= 0 && diff < days30) {
        buckets[days30 - 1 - diff]++;
      }
      const gs = it.metrics?.goldstein;
      if (gs != null && (minGS == null || gs < minGS)) minGS = gs;
    }
    buckets.forEach((v, i) => {
      if (v > peakVal) { peakVal = v; peakDay = new Date(now - (days30 - 1 - i) * 86400000); }
    });

    // 7d vs 前 7d delta
    let cur7 = 0, prior7 = 0;
    for (let i = 0; i < days30; i++) {
      if (i >= days30 - 7) cur7 += buckets[i];
      else if (i >= days30 - 14) prior7 += buckets[i];
    }
    const delta = prior7 > 0 ? Math.round((cur7 - prior7) / prior7 * 100) : (cur7 > 0 ? 999 : 0);

    // 簇数
    const clusterIds = new Set();
    let crossBiasCount = 0;
    for (const it of items) {
      if (it.cluster_id) clusterIds.add(it.cluster_id);
      if (it.cluster_bias_count && it.cluster_bias_count >= 2) crossBiasCount++;
    }

    // escalation index 简化: 用 7d vs 前 7d delta 映射
    // (不依赖 app.js 的 escalation 完整算法)
    const escIdx = prior7 > 0
      ? Math.round(50 + (cur7 - prior7) / Math.max(cur7, prior7, 1) * 50)
      : 50;

    return {
      cid, meta, total, surge, buckets, peakDay, peakVal, minGS,
      cur7, delta, clusterIds: clusterIds.size, crossBiasCount, escIdx,
    };
  });

  // 按 cur7 (最近 7 天事件量) 降序
  entries.sort((a, b) => b.cur7 - a.cur7);

  el.innerHTML = entries.map(e => {
    const color = CONFLICT_PALETTE[e.cid];
    const deltaCls = e.delta > 10 ? 'up' : e.delta < -10 ? 'down' : 'flat';
    const deltaTxt = e.delta === 999 ? 'NEW' : (e.delta > 0 ? `+${e.delta}%` : `${e.delta}%`);
    const deltaArrow = e.delta > 10 ? '↑' : e.delta < -10 ? '↓' : '→';
    const surgeChip = e.surge ? `<span class="aw-surge">SURGE</span>` : '';

    // sparkline SVG
    const w = 180, h = 24;
    const max = Math.max(...e.buckets, 1);
    const barW = w / e.buckets.length;
    const bars = e.buckets.map((v, i) => {
      if (v === 0) return '';
      const bh = (v / max) * (h - 2);
      return `<rect x="${(i * barW).toFixed(2)}" y="${(h - bh).toFixed(2)}" width="${(barW - 0.3).toFixed(2)}" height="${bh.toFixed(2)}" fill="${color}" opacity="0.85"/>`;
    }).join('');

    const peakLabel = e.peakDay && e.peakVal > 0
      ? `${e.peakDay.getMonth()+1}/${e.peakDay.getDate()}`
      : '—';
    const gsTxt = e.minGS != null ? e.minGS.toFixed(1) : '—';
    const gsCls = (e.minGS != null && e.minGS <= -8) ? 'gs-severe' : '';
    const clusterTxt = e.clusterIds > 0
      ? `<span class="awc-num">${e.clusterIds}</span>${e.crossBiasCount > 0 ? ` · <span class="awc-cross">${e.crossBiasCount}X</span>` : ''}`
      : '<span style="color:var(--fg-faint)">—</span>';

    return `
      <div class="aw-item" data-cid="${e.cid}">
        <span class="aw-code" style="color:${color}">${e.meta.code}</span>
        <span class="aw-name">${escHtml(e.meta.name)}${surgeChip}</span>
        <span class="aw-total">${e.total}</span>
        <span class="aw-delta ${deltaCls}">${deltaArrow} ${deltaTxt}</span>
        <span class="aw-spark-wrap"><svg class="aw-spark-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}</svg></span>
        <span class="aw-peak">${peakLabel}</span>
        <span class="aw-gs ${gsCls}">${gsTxt}</span>
        <span class="aw-cluster">${clusterTxt}</span>
      </div>
    `;
  }).join('');

  // 交互: hover 高亮 streamgraph, dblclick 跳 archive
  el.querySelectorAll('.aw-item').forEach(row => {
    const cid = row.dataset.cid;
    row.addEventListener('mouseenter', () => {
      document.querySelectorAll('.stream-layer').forEach(p => {
        if (p.getAttribute('data-cid') === cid) p.setAttribute('opacity', '1');
        else p.setAttribute('opacity', '0.25');
      });
    });
    row.addEventListener('mouseleave', () => {
      document.querySelectorAll('.stream-layer').forEach(p => p.setAttribute('opacity', '0.82'));
    });
    row.addEventListener('click', () => {
      // 单击: 切换 active 状态, 高亮粘滞
      document.querySelectorAll('.aw-item.aw-active').forEach(r => {
        if (r !== row) r.classList.remove('aw-active');
      });
      row.classList.toggle('aw-active');
    });
    row.addEventListener('dblclick', () => {
      location.href = `./#${cid}`;
    });
  });
}

/* ─────────────────────────────────────────────
   Goldstein Floor 30 天柱状图
───────────────────────────────────────────── */

function renderGoldsteinFloor() {
  const el = document.getElementById('goldsteinChart');
  if (!el) return;

  const days = _filterDays > 0 && _filterDays <= 90 ? _filterDays : 30;
  const now = Date.now();
  const buckets = new Array(days).fill(null);

  for (const it of allItems) {
    if (!it._date_ts) continue;
    const gs = it.metrics?.goldstein;
    if (gs == null) continue;
    const diff = Math.floor((now - it._date_ts) / 86400000);
    if (diff < 0 || diff >= days) continue;
    const idx = days - 1 - diff;
    if (buckets[idx] == null || gs < buckets[idx]) buckets[idx] = gs;
  }

  el.innerHTML = buckets.map((gs, i) => {
    let sev = 0, h = 6;
    if (gs != null) {
      if (gs <= -9)      { sev = 4; h = 160; }
      else if (gs <= -7) { sev = 3; h = 130; }
      else if (gs <= -5) { sev = 2; h = 90;  }
      else if (gs <= -3) { sev = 1; h = 55;  }
      else               { sev = 0; h = 25;  }
    }
    const date = new Date(now - (days - 1 - i) * 86400000);
    const label = `${date.getMonth()+1}/${date.getDate()}`;
    const tip = gs != null
      ? `${label}: min goldstein ${gs.toFixed(1)}`
      : `${label}: (no GDELT data)`;
    return `<div class="gs-bar gs-sev-${sev}" style="height:${h}px" title="${tip}"></div>`;
  }).join('');
}

/* ─────────────────────────────────────────────
   启动
───────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', loadAll);
window.addEventListener('resize', () => {
  if (D) renderStreamgraph();
});
