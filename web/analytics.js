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
let HEALTH = null;            // pipeline_health.json
let CRED = null;              // source_credibility.json
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
  // 并行加载 latest + pipeline_health + source_credibility
  const [latest, health, cred] = await Promise.allSettled([
    fetch(SRC + 'latest.json').then(r => r.json()),
    fetch(SRC + 'pipeline_health.json').then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(SRC + 'source_credibility.json').then(r => r.ok ? r.json() : null).catch(() => null),
  ]);

  if (latest.status !== 'fulfilled') {
    document.body.innerHTML = `<div style="padding:40px;color:#e84838;font-family:monospace">加载 latest.json 失败: ${latest.reason}</div>`;
    return;
  }
  D = latest.value;
  HEALTH = health.status === 'fulfilled' ? health.value : null;
  CRED = cred.status === 'fulfilled' ? cred.value : null;

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
  renderMetaBanner();    // A
  renderBlufStrip();     // C
  renderLegend();
  renderStreamgraph();
  renderWatchlist();
  renderGoldsteinFloor();
  renderSourceLineage(); // B
  renderClusterDetail(); // D
  renderFooter();        // A footer
  wireMethodPopover();   // A popover
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
      renderMetaBanner();
      renderBlufStrip();
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

/* ═══════════════════════════════════════════════════════════════
   A · Meta banner + Methodology popover + Footer
═══════════════════════════════════════════════════════════════ */

function humanAgo(isoStr) {
  if (!isoStr) return '—';
  const diffMs = Date.now() - new Date(isoStr).getTime();
  if (isNaN(diffMs)) return '—';
  const h = Math.floor(diffMs / 3600000);
  const m = Math.floor((diffMs % 3600000) / 60000);
  if (h < 1) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function renderMetaBanner() {
  const el = document.getElementById('metaText');
  if (!el) return;
  const updated = D.updated_at;
  const updatedDate = updated ? new Date(updated) : null;
  const utcStr = updatedDate
    ? `${updatedDate.getUTCFullYear()}-${String(updatedDate.getUTCMonth()+1).padStart(2,'0')}-${String(updatedDate.getUTCDate()).padStart(2,'0')} ${String(updatedDate.getUTCHours()).padStart(2,'0')}:${String(updatedDate.getUTCMinutes()).padStart(2,'0')} UTC`
    : '—';
  const ago = humanAgo(updated);
  el.innerHTML = `Data as of <strong>${utcStr}</strong> · 更新 <strong>${ago}</strong> · ${allItems.length} events · 9 conflicts tracked · cluster sim ≥ 0.5 · escalation = freq×0.5 + GS×0.3 + mentions×0.2`;
}

function wireMethodPopover() {
  const link = document.getElementById('methodLink');
  const pop = document.getElementById('methodPopover');
  const close = document.getElementById('methodClose');
  if (!link || !pop) return;
  link.addEventListener('click', (e) => {
    e.stopPropagation();
    pop.classList.toggle('amb-open');
  });
  if (close) close.addEventListener('click', () => pop.classList.remove('amb-open'));
  document.addEventListener('click', (e) => {
    if (!pop.contains(e.target) && e.target !== link) {
      pop.classList.remove('amb-open');
    }
  });
}

function renderFooter() {
  const el = document.getElementById('footerLastBuild');
  if (!el) return;
  const ts = HEALTH?.generated_at;
  el.textContent = ts ? humanAgo(ts) : '—';
}

/* ═══════════════════════════════════════════════════════════════
   C · BLUF Critical Events 顶部要点条
═══════════════════════════════════════════════════════════════ */

function renderBlufStrip() {
  const el = document.getElementById('blufCards');
  if (!el) return;

  const days = _filterDays > 0 ? _filterDays : 14;
  const cutoff = Date.now() - days * 86400000;

  // 找窗口内 critical 事件,按 effectiveScore 降序取 5 条
  const candidates = allItems
    .filter(it => it.criticality === 'critical' && it._date_ts >= cutoff)
    .map(it => {
      const clusterScore = (it.cluster_size || 0) * ((it.cluster_bias_count || 0) + 1);
      const recencyScore = Math.max(0, 14 - (Date.now() - it._date_ts) / 86400000);
      const score = clusterScore * 2 + recencyScore;
      return { ...it, _score: score };
    })
    .sort((a, b) => b._score - a._score)
    .slice(0, 5);

  if (!candidates.length) {
    el.innerHTML = `<div style="grid-column:1/-1;padding:20px;color:var(--fg-dim2);font-family:var(--mono);font-size:11px;text-align:center">该时间窗口内没有 critical 事件</div>`;
    return;
  }

  el.innerHTML = candidates.map(it => {
    const meta = CONFLICTS_META[it._conflict] || { code: '?' };
    const date = it.date || '';
    const dateShort = date.slice(5);

    // 信号 chips (BLUF 永远显示 CRITICAL 作底,加成可选叠加)
    const signals = [`<span class="bc-sig bcs-surge">CRITICAL</span>`];
    if (it.cluster_size && it.cluster_size >= 2) {
      signals.push(`<span class="bc-sig bcs-cluster">${it.cluster_size}源</span>`);
    }
    if (it.cluster_bias_count && it.cluster_bias_count >= 2) {
      signals.push(`<span class="bc-sig bcs-cross">跨${it.cluster_bias_count}视角</span>`);
    }
    const gs = it.metrics?.goldstein;
    if (gs != null && gs <= -8) {
      signals.push(`<span class="bc-sig bcs-gs">GS ${gs.toFixed(1)}</span>`);
    }
    // 来源标签作为附加信号
    if (it.source_label) {
      signals.push(`<span class="bc-sig" style="background:var(--bg-raise);color:var(--fg-dim);border:1px solid var(--line-hi)">${escHtml(it.source_label.slice(0, 14))}</span>`);
    }

    return `
      <div class="bluf-card" data-url="${escHtml(it.url || '#')}">
        <div class="bc-meta">
          <span class="bc-date">${dateShort}</span>
          <span class="bc-conflict">${meta.code}</span>
        </div>
        <div class="bc-title">${escHtml(it.title || '(无标题)')}</div>
        <div class="bc-signals">${signals.join('')}</div>
      </div>
    `;
  }).join('');

  el.querySelectorAll('.bluf-card').forEach(card => {
    card.addEventListener('click', () => {
      const url = card.dataset.url;
      if (url && url !== '#') window.open(url, '_blank', 'noopener');
    });
  });
}

/* ═══════════════════════════════════════════════════════════════
   B · Source Lineage 信源透明度
═══════════════════════════════════════════════════════════════ */

/**
 * 从 source_credibility.json 解析某域名的 bias / tier
 * 平台聚合源 (reddit/x/youtube/twitter) → fallback 到 neutral, 与 Python 端逻辑一致
 */
const PLATFORM_DOMAINS = new Set(['reddit.com', 'x.com', 'twitter.com', 'youtube.com', 'youtu.be']);

function lookupBias(domain) {
  if (PLATFORM_DOMAINS.has(domain)) return { bias: 'neutral', tier: '—' };
  if (!CRED) return { bias: 'unknown', tier: '—' };
  const domains = CRED.domains || {};
  if (domains[domain]) {
    return { bias: domains[domain].bias || 'unknown', tier: domains[domain].tier || '—' };
  }
  const parts = domain.split('.');
  if (parts.length > 2) {
    const parent = parts.slice(-2).join('.');
    if (domains[parent]) {
      return { bias: domains[parent].bias || 'unknown', tier: domains[parent].tier || '—' };
    }
  }
  return { bias: 'unknown', tier: '—' };
}

const BIAS_LABELS = {
  'western':         'WEST',
  'arab':            'ARAB',
  'russian-state':   'RU-ST',
  'russian-independent': 'RU-IND',
  'ukrainian':       'UKR',
  'iranian':         'IRN',
  'israeli':         'ISR',
  'chinese':         'CHN',
  'neutral':         'NEUTRAL',
  'unknown':         '—',
};
const BIAS_COLORS = {
  'western':         '#4a9eff',
  'arab':            '#d97c26',
  'russian-state':   '#e84838',
  'russian-independent': '#c792e7',
  'ukrainian':       '#ffd550',
  'iranian':         '#3fb570',
  'israeli':         '#88c0ff',
  'chinese':         '#ff6e60',
  'neutral':         '#a8a8a8',
  'unknown':         '#3a3e44',
};

function renderSourceLineage() {
  // ① By source bars
  const barsEl = document.getElementById('sourceBars');
  if (barsEl) {
    const bySource = HEALTH?.by_source || {
      // fallback: 从 allItems 现算
      web: allItems.filter(it => it.source === 'web').length,
      x: allItems.filter(it => it.source === 'x').length,
      reddit: allItems.filter(it => it.source === 'reddit').length,
      gdelt: allItems.filter(it => it.source === 'gdelt').length,
      youtube: allItems.filter(it => it.source === 'youtube').length,
    };
    const sourceColors = {
      web: '#4a9eff', x: '#88c0ff', reddit: '#d97c26',
      youtube: '#e84838', gdelt: '#c792e7',
    };
    const max = Math.max(...Object.values(bySource), 1);
    const sorted = Object.entries(bySource).sort((a, b) => b[1] - a[1]);
    barsEl.innerHTML = sorted.map(([src, count]) => {
      const pct = (count / max) * 100;
      const color = sourceColors[src] || '#888';
      return `
        <div class="asgb-item">
          <span class="asgb-label">${src}</span>
          <div class="asgb-bar-wrap"><div class="asgb-bar" style="width:${pct}%;background:${color}"></div></div>
          <span class="asgb-count">${count}</span>
        </div>
      `;
    }).join('');
  }

  // ② Top domains
  const listEl = document.getElementById('domainList');
  if (listEl) {
    const top = HEALTH?.top_domains || {};
    // 按 count 降序
    const entries = Object.entries(top)
      .map(([domain, info]) => ({
        domain,
        count: info.count || 0,
        last_date: info.last_date || '—',
        ...lookupBias(domain),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 14);
    listEl.innerHTML = entries.map((d, i) => {
      const biasLabel = BIAS_LABELS[d.bias] || d.bias || '—';
      return `
        <div class="asgd-item">
          <span class="asgd-rank">${i + 1}</span>
          <span class="asgd-name" title="${d.domain}">${d.domain}</span>
          <span class="asgd-count">${d.count}</span>
          <span class="asgd-bias bias-${d.bias}">${biasLabel}</span>
          <span class="asgd-date">${d.last_date.slice(5) || '—'}</span>
        </div>
      `;
    }).join('');
  }

  // ③ Bias distribution 横条
  const distEl = document.getElementById('biasDist');
  if (distEl) {
    const top = HEALTH?.top_domains || {};
    const biasTotals = {};
    for (const [domain, info] of Object.entries(top)) {
      const { bias } = lookupBias(domain);
      biasTotals[bias] = (biasTotals[bias] || 0) + (info.count || 0);
    }
    const grandTotal = Object.values(biasTotals).reduce((s, v) => s + v, 0);
    const sortedBias = Object.entries(biasTotals).sort((a, b) => b[1] - a[1]);
    distEl.innerHTML = sortedBias.map(([bias, n]) => {
      const pct = (n / grandTotal) * 100;
      const label = BIAS_LABELS[bias] || bias;
      const color = BIAS_COLORS[bias] || '#888';
      return `<div class="abd-segment" style="width:${pct}%;background:${color}" title="${label}: ${n} 条 (${pct.toFixed(1)}%)">${pct >= 6 ? label : ''}</div>`;
    }).join('');
  }
}

/* ═══════════════════════════════════════════════════════════════
   D · Cluster Detail 印证簇详细
═══════════════════════════════════════════════════════════════ */

function renderClusterDetail() {
  const el = document.getElementById('clusterList');
  const subEl = document.getElementById('clusterSub');
  if (!el) return;

  // 按 cluster_id 聚合所有成员 (去重: 每个 item 可能在多个 category 出现)
  const clusters = {};
  const seenIds = new Set();
  for (const it of allItems) {
    if (!it.cluster_id || !it.cluster_size || it.cluster_size < 2) continue;
    const itemKey = `${it.id}`;
    if (seenIds.has(itemKey)) continue;
    seenIds.add(itemKey);
    if (!clusters[it.cluster_id]) {
      clusters[it.cluster_id] = {
        cluster_id: it.cluster_id,
        cluster_size: it.cluster_size,
        cluster_bias_count: it.cluster_bias_count || 0,
        members: [],
        conflict: it._conflict,
      };
    }
    clusters[it.cluster_id].members.push(it);
  }

  // 按 (size × (bias_count + 1)) 降序
  const sorted = Object.values(clusters).sort((a, b) => {
    const sa = a.cluster_size * (a.cluster_bias_count + 1);
    const sb = b.cluster_size * (b.cluster_bias_count + 1);
    if (sb !== sa) return sb - sa;
    // 平手时按最新成员的日期
    const da = Math.max(...a.members.map(m => m._date_ts || 0));
    const db = Math.max(...b.members.map(m => m._date_ts || 0));
    return db - da;
  });

  if (subEl) {
    subEl.textContent = `cluster_size × bias_count 排序 · ${sorted.length} 个簇 · 跨偏见 ★`;
  }

  if (!sorted.length) {
    el.innerHTML = `<div style="padding:20px;color:var(--fg-dim2);font-family:var(--mono);font-size:11px;text-align:center">暂无 cluster (cluster_corroboration.py 未运行?)</div>`;
    return;
  }

  el.innerHTML = sorted.slice(0, 8).map(c => {
    const crossBias = c.cluster_bias_count >= 2;
    const conflictMeta = CONFLICTS_META[c.conflict] || { code: '?' };
    // 选第一条最新的作为代表标题
    const sortedMembers = [...c.members].sort((a, b) => (b._date_ts || 0) - (a._date_ts || 0));
    const headline = sortedMembers[0].title || sortedMembers[0].title_en || '(无标题)';

    const memberRows = sortedMembers.map(m => {
      const label = m.source_label || m.source || '';
      const title = m.title_en || m.title || '';
      return `
        <div class="cc-member" data-url="${escHtml(m.url || '#')}">
          <span class="cc-mem-source">${escHtml(label.slice(0, 16))}</span>
          <span class="cc-mem-title" title="${escHtml(title)}">${escHtml(title)}</span>
        </div>
      `;
    }).join('');

    return `
      <div class="cluster-card ${crossBias ? 'cc-cross' : ''}">
        <div class="cc-head">
          <span class="cc-size">${c.cluster_size}源</span>
          ${crossBias ? `<span class="cc-cross-tag">★ 跨${c.cluster_bias_count}视角</span>` : ''}
          <span class="cc-conflict">${conflictMeta.code}</span>
        </div>
        <div class="cc-headline">${escHtml(headline)}</div>
        <div class="cc-members">${memberRows}</div>
      </div>
    `;
  }).join('');

  // 点击成员行打开原文
  el.querySelectorAll('.cc-member').forEach(row => {
    row.addEventListener('click', () => {
      const url = row.dataset.url;
      if (url && url !== '#') window.open(url, '_blank', 'noopener');
    });
  });
}

/* ─────────────────────────────────────────────
   启动
───────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', loadAll);
window.addEventListener('resize', () => {
  if (D) renderStreamgraph();
});
