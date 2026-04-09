// Auto-detect: local dev (../data/) vs GitHub Pages (data/)
const IS_PAGES = location.hostname.includes('github.io');
const DATA = IS_PAGES ? 'data/latest.json' : '../data/latest.json';
const SRC = IS_PAGES ? 'data/' : '../data/';
const MO = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const LMO = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const INAMES = { war:'全面战争', conflict:'武装冲突', tension:'紧张对峙' };
const REGIONS_ORDER = ['欧洲','中东','非洲','亚太'];

// Source credibility — loaded from source_credibility.json, fallback to inline
let CRED_DB = null;
const CRED_FALLBACK = {
  't1': new Set(['understandingwar.org','crisisgroup.org','ohchr.org','un.org','congress.gov','cfr.org',
    'brookings.edu','csis.org','rand.org','iiss.org','chathamhouse.org','aei.org','atlanticcouncil.org',
    'hrw.org','icrc.org','ifrc.org','rescue.org','securitycouncilreport.org']),
  't2': new Set(['nytimes.com','bbc.com','reuters.com','aljazeera.com','cnn.com','bloomberg.com',
    'theguardian.com','apnews.com','rferl.org','npr.org','foreignaffairs.com','warontherocks.com',
    'russiamatters.org','ecfr.eu','globaltaiwan.org','gmfus.org','timep.org','snhr.org',
    'lowyinstitute.org','usni.org','eurasiareview.com']),
};

async function loadCredDB() {
  try {
    const r = await fetch(SRC + 'source_credibility.json');
    if (r.ok) CRED_DB = await r.json();
  } catch {}
}

/* ═══ Pipeline health ═══ */
let HEALTH = null;
async function loadHealth() {
  try {
    const r = await fetch(SRC + 'pipeline_health.json');
    if (r.ok) {
      HEALTH = await r.json();
      renderHealthBadge();
    }
  } catch {}
}

function renderHealthBadge() {
  const el = document.getElementById('healthBadge');
  if (!el || !HEALTH) return;
  const status = HEALTH.status || 'ok';
  const issueCount = (HEALTH.issues || []).length;
  const label = {
    ok: '● OK',
    degraded: `● ${issueCount}`,
    critical: `● ×${issueCount}`,
  }[status] || '●';
  const titleText = {
    ok: '管道健康',
    degraded: `${issueCount} 项异常（点击查看）`,
    critical: `${issueCount} 项严重异常（点击查看）`,
  }[status] || '';
  el.textContent = label;
  el.title = titleText;
  el.className = `health-badge health-${status}`;
  el.style.display = '';
}

function showHealthModal() {
  if (!HEALTH) return;
  const body = document.getElementById('healthModalBody');
  const llm = HEALTH.llm_coverage || {};
  const histo = HEALTH.date_histogram || [];
  const orphans = HEALTH.orphans || {};
  const issues = HEALTH.issues || [];

  // Build histogram — max count → bar width
  const maxCount = Math.max(1, ...histo.map(h => h.count));
  const histoHtml = histo.map(h => {
    const pct = (h.count / maxCount) * 100;
    const isToday = h === histo[histo.length - 1];
    return `<div class="h-histo-row ${isToday ? 'h-histo-today' : ''}">
      <span class="h-histo-date">${h.date.slice(5)}</span>
      <div class="h-histo-bar-wrap"><div class="h-histo-bar" style="width:${pct}%"></div></div>
      <span class="h-histo-count">${h.count}</span>
    </div>`;
  }).join('');

  // Issues
  const issuesHtml = issues.length
    ? issues.map(i => `<div class="h-issue h-sev-${i.severity}">
        <span class="h-issue-code">${i.code}</span>
        <span class="h-issue-msg">${esc(i.message)}</span>
      </div>`).join('')
    : '<div class="h-no-issues">无异常 ✓</div>';

  // Source breakdown
  const sources = Object.entries(HEALTH.by_source || {});
  const srcHtml = sources.map(([s, c]) => `<span class="h-src-chip"><b>${c}</b> ${s}</span>`).join('');

  body.innerHTML = `
    <div class="h-section">
      <div class="h-status h-${HEALTH.status}">状态: ${HEALTH.status.toUpperCase()}</div>
      <div class="h-generated">生成于 ${HEALTH.generated_at || '?'}</div>
    </div>

    <div class="h-section">
      <div class="h-label">源分布（共 ${HEALTH.total_unique_items} 条）</div>
      <div class="h-src-row">${srcHtml}</div>
    </div>

    <div class="h-section">
      <div class="h-label">LLM 覆盖率</div>
      <div class="h-grid">
        <div><span class="h-k">BLUF criticality</span><span class="h-v">${(llm.criticality_coverage*100).toFixed(1)}%</span></div>
        <div><span class="h-k">title_en</span><span class="h-v">${(llm.title_en_coverage*100).toFixed(1)}% <em>(缺 ${llm.missing_title_en})</em></span></div>
        <div><span class="h-k">summary_en</span><span class="h-v">${(llm.summary_en_coverage*100).toFixed(1)}% <em>(缺 ${llm.missing_summary_en})</em></span></div>
        <div><span class="h-k">clustered</span><span class="h-v">${llm.clustered} <em>(跨视角 ${llm.cross_bias_items})</em></span></div>
      </div>
    </div>

    <div class="h-section">
      <div class="h-label">最近 ${histo.length} 天日分布</div>
      <div class="h-histo">${histoHtml}</div>
    </div>

    <div class="h-section">
      <div class="h-label">Orphan 扫描</div>
      <div class="h-orphan">${orphans.orphan_count || 0} / ${orphans.checked || 0} (${((orphans.orphan_rate||0)*100).toFixed(1)}%)</div>
    </div>

    <div class="h-section">
      <div class="h-label">异常</div>
      <div class="h-issues">${issuesHtml}</div>
    </div>
  `;
  document.getElementById('healthModal').style.display = 'flex';
}

function closeHealthModal() {
  document.getElementById('healthModal').style.display = 'none';
}

/* ═══ I&W Warnings (#3 早期预警) ═══ */
let WARNINGS = null;
async function loadWarnings() {
  try {
    const r = await fetch(SRC + 'indicators.json');
    if (r.ok) {
      WARNINGS = await r.json();
      renderWarningsBadge();
    }
  } catch {}
}

function renderWarningsBadge() {
  const el = document.getElementById('warningsBadge');
  if (!el || !WARNINGS) return;
  const n = WARNINGS.total_warnings || 0;
  if (n === 0) {
    el.textContent = '⚠ 0';
    el.className = 'warnings-badge warnings-quiet';
    el.title = '全球冲突无异常';
  } else {
    el.textContent = `⚠ ${n}`;
    el.className = 'warnings-badge';
    el.title = `${n} 项预警 · ${WARNINGS.flagged_conflicts} 个冲突异常（点击查看）`;
  }
  el.style.display = '';
}

function showWarningsModal() {
  if (!WARNINGS) return;
  const body = document.getElementById('warningsModalBody');

  const flagIcon = {
    elevated: '↑', depressed: '↓',
    rising: '↑', falling: '↓',
    normal: '·', insufficient: '?'
  };
  const flagLabel = {
    elevated: 'elevated', depressed: 'depressed',
    rising: 'rising',   falling: 'falling',
    normal: 'normal',   insufficient: 'n/a'
  };

  const renderMetric = (key, m) => {
    const flag = m.flag || 'normal';
    const icon = flagIcon[flag] || '·';
    const deltaCls = (flag === 'elevated' || flag === 'rising') ? 'up'
                   : (flag === 'depressed' || flag === 'falling') ? 'down' : '';
    let deltaTxt = '';
    if (key === 'escalation_trend') {
      if (m.delta != null) deltaTxt = ` ${m.delta > 0 ? '+' : ''}${m.delta}`;
    } else if (m.delta_pct != null) {
      deltaTxt = ` ${m.delta_pct > 0 ? '+' : ''}${m.delta_pct}%`;
    }
    const baseTxt = (key === 'escalation_trend')
      ? (m.yesterday != null ? `昨日 ${m.yesterday}` : 'n/a')
      : (m.baseline != null ? `7日均 ${m.baseline}` : 'n/a');
    const todayTxt = m.today != null ? m.today : '–';
    return `<div class="iw-metric iw-${flag}">
      <div class="iw-metric-label">${icon} ${esc(m.label || key)}</div>
      <div class="iw-metric-value">${todayTxt}<span class="iw-metric-delta ${deltaCls}">${deltaTxt}</span></div>
      <div class="iw-metric-base">${baseTxt}</div>
    </div>`;
  };

  // Sort conflicts: warned first (by warning count desc), then quiet
  const entries = Object.entries(WARNINGS.conflicts || {});
  entries.sort((a, b) => (b[1].warnings.length || 0) - (a[1].warnings.length || 0));

  const conflictsHtml = entries.map(([cid, c]) => {
    const warnCount = c.warnings.length || 0;
    const tagCls = warnCount > 0 ? 'iw-conflict-tag has-warn' : 'iw-conflict-tag';
    const tagTxt = warnCount > 0 ? `${warnCount} 预警` : '正常';
    const metricsHtml = ['event_frequency', 'critical_count', 'escalation_trend']
      .map(k => renderMetric(k, c.metrics[k])).join('');
    return `<div class="iw-conflict">
      <div class="iw-conflict-head">
        <span class="iw-conflict-name">${esc(c.name)}</span>
        <span class="${tagCls}">${tagTxt}</span>
      </div>
      <div class="iw-metrics">${metricsHtml}</div>
    </div>`;
  }).join('');

  const subtitle = `基准日 ${WARNINGS.reference_date} · 总计 ${WARNINGS.total_warnings} 预警 · ${WARNINGS.flagged_conflicts}/${entries.length} 冲突异常`;

  body.innerHTML = `
    <div class="iw-subtitle">${subtitle}</div>
    ${entries.length === 0 ? '<div class="iw-quiet-msg">无数据</div>' : conflictsHtml}
  `;
  document.getElementById('warningsModal').style.display = 'flex';
}

function closeWarningsModal() {
  document.getElementById('warningsModal').style.display = 'none';
}

function getDomain(item) {
  if (item.url) {
    const m = item.url.match(/https?:\/\/(?:www\.)?([^/]+)/);
    if (m) return m[1];
  }
  return (item.source_label || '').replace('www.','');
}

function credInfo(item) {
  const d = getDomain(item);
  if (CRED_DB && CRED_DB.domains) {
    // Try exact match, then strip subdomains
    let info = CRED_DB.domains[d];
    if (!info) {
      const parts = d.split('.');
      if (parts.length > 2) info = CRED_DB.domains[parts.slice(-2).join('.')];
    }
    if (info) return info;
  }
  // Fallback
  if (item.source === 'gdelt') return { tier: 't2', bias: 'neutral', type: 'data', name: 'GDELT' };
  if (item.source === 'x') return { tier: 't3', bias: 'neutral', type: 'social' };
  if (item.source === 'youtube') return { tier: 't3', bias: 'neutral', type: 'social' };
  if (item.source === 'reddit') return { tier: 't3', bias: 'neutral', type: 'social' };
  if (CRED_FALLBACK.t1.has(d)) return { tier: 't1' };
  if (CRED_FALLBACK.t2.has(d)) return { tier: 't2' };
  return { tier: 't3' };
}

function credTier(item) {
  return credInfo(item).tier || 't3';
}

function biasLabel(item) {
  const info = credInfo(item);
  const bias = info.bias;
  if (!bias || bias === 'neutral') return '';
  const labels = CRED_DB && CRED_DB.bias_labels || {};
  const bl = labels[bias];
  if (!bl) return '';
  return `<span class="bias-tag bias-${bias}" title="${bl.zh}">${bl.zh}</span>`;
}

function credBadge(item) {
  const info = credInfo(item);
  const t = info.tier || 't3';
  const titles = { t1:'权威机构', t2:'主流媒体', t3:'社区/其他' };
  const bias = biasLabel(item);
  return `<span class="cred-tier cred-${t}" title="${titles[t]}">${titles[t]}</span>${bias}`;
}

/* ═══ Criticality (BLUF) ═══ */
function critBadge(item) {
  const c = item.criticality;
  if (c === 'critical') return '<span class="crit-badge critical" title="关键事件 — 必读">关键</span>';
  if (c === 'notable')  return '<span class="crit-badge notable"  title="重要进展">重要</span>';
  return '';
}
function critWeight(item) {
  return item.criticality === 'critical' ? 2 : item.criticality === 'notable' ? 1 : 0;
}

/**
 * effectiveWeight 综合 criticality 和 corroboration
 * cluster_bias_count >= 2 (跨媒体偏见印证) → +2.0, 等同于升级到 critical 层
 * cluster_size >= 4 (多源大簇) → +1.5
 * cluster_size >= 2 → +0.5
 * 这让 "3 源跨视角 background" 和 "critical 单源" 排序时大致等位
 */
function effectiveWeight(item) {
  let w = critWeight(item) * 2; // 0/2/4 基础
  const size = item.cluster_size || 0;
  const bias = item.cluster_bias_count || 0;
  if (bias >= 2) w += 4;         // 跨偏见印证 → 等同 critical 加成
  else if (size >= 4) w += 3;    // 4+ 源大簇
  else if (size >= 2) w += 1;    // 任意 cluster
  return w;
}

/* ═══ Cross-source corroboration ═══ */
function corrobBadge(item) {
  const size = item.cluster_size;
  if (!size || size < 2) return '';
  const biasCount = item.cluster_bias_count || 0;
  const crossBias = biasCount >= 2;
  const hl = (size >= 4 || crossBias) ? ' corrob-hl' : '';
  const label = crossBias ? `${size} 源·跨视角` : `${size} 源`;
  const title = crossBias
    ? `${size} 个独立来源印证（跨 ${biasCount} 种视角）`
    : `${size} 个独立来源印证`;
  return `<span class="corrob-badge${hl}" title="${title}">${label}</span>`;
}

let D, conflict = null, tab = 'military', cache = {}, currentView = 'overview', kbIdx = -1, globe = null;
let timeFilterDays = 30; // 0 = all

/* ═══ Escalation ═══ */
function escalation(items) {
  const now = new Date();
  const recent = items.filter(it => it.date && (now - new Date(it.date)) < 7 * 86400000);
  const prior = items.filter(it => it.date && (now - new Date(it.date)) >= 7 * 86400000 && (now - new Date(it.date)) < 14 * 86400000);
  const rc = recent.length, pc = prior.length;

  // Frequency score: -1 to +1
  const freqScore = pc > 0 ? (rc - pc) / Math.max(rc, pc) : (rc > 0 ? 0.5 : 0);

  // Goldstein severity: average of recent GDELT events (scale -10 to +10, lower = worse)
  const recentGS = recent.filter(it => it.metrics && it.metrics.goldstein).map(it => it.metrics.goldstein);
  const gsAvg = recentGS.length > 0 ? recentGS.reduce((s, v) => s + v, 0) / recentGS.length : 0;
  const gsScore = recentGS.length > 0 ? Math.max(-1, Math.min(1, -gsAvg / 10)) : 0;

  // Mention volume: high mentions = more significant
  const recentMentions = recent.filter(it => it.metrics && it.metrics.mentions).reduce((s, it) => s + it.metrics.mentions, 0);
  const priorMentions = prior.filter(it => it.metrics && it.metrics.mentions).reduce((s, it) => s + it.metrics.mentions, 0);
  const mentionScore = priorMentions > 0 ? Math.max(-1, Math.min(1, (recentMentions - priorMentions) / Math.max(recentMentions, priorMentions))) : 0;

  // Composite: weighted average → 0-100 index
  const raw = freqScore * 0.5 + gsScore * 0.3 + mentionScore * 0.2;
  const index = Math.round(Math.max(0, Math.min(100, (raw + 1) * 50)));

  if (index >= 62) return { label: '升级', cls: 'esc-up', arrow: '↑', index, raw };
  if (index <= 38) return { label: '缓和', cls: 'esc-down', arrow: '↓', index, raw };
  return { label: '稳定', cls: 'esc-stable', arrow: '→', index, raw };
}

/* ═══ SURGE 异常检测 (v2/A 组合) ═══
   某冲突近 7d 事件量 > 1.5 * 前 7d 且 >= 10, 或无基线时 >= 15
   返回 { cur, prior, delta } 或 null
*/
function detectSurge(items) {
  const now = Date.now();
  const d7 = 7 * 86400000;
  let cur = 0, prior = 0;
  for (const it of items) {
    if (!it.date) continue;
    const ts = new Date(it.date).getTime();
    if (isNaN(ts)) continue;
    const age = now - ts;
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
  'us-iran':         { lat: 32.4, lng: 53.7, zoom: 5 },
  'sudan':           { lat: 15.5, lng: 32.5, zoom: 5 },
  'myanmar':         { lat: 19.7, lng: 96.0, zoom: 5 },
  'yemen-houthi':    { lat: 15.3, lng: 44.2, zoom: 6 },
  'congo-drc':       { lat: -2.5, lng: 28.8, zoom: 5 },
  'syria':           { lat: 35.0, lng: 38.0, zoom: 6 },
  'taiwan-strait':   { lat: 24.0, lng: 119.0, zoom: 5 },
};

let detailMap = null;

async function boot() {
  initTheme();
  const [r] = await Promise.all([fetch(DATA), loadCredDB(), loadHealth(), loadWarnings()]);
  D = await r.json();
  mastDate();
  renderRegionNav();
  wireViewToggle();
  wireSearch();
  wireKeyboard();
  renderNewsTicker();
  checkAlertMode();
  showOverview();
  initGlobe();
  wireReader();
  loadAvatarBriefing();  // 数字人主播 (静默失败,不阻塞)
}

/* ═══ AI Anchor FAB — 数字人主播浮窗
   - 默认折叠为右下角头像泡泡
   - 点头像 → 展开卡片
   - 点 ▶ → 解除静音从头播放
   - 播放中点 ▮ → 暂停 (再点继续)
   - 视频结束 → 按钮变回 ▶
   - 点 － → 折叠回头像
   - 点 × → 关闭, localStorage 记录, 7 天内不再显示 (除非新视频)
*/
async function loadAvatarBriefing() {
  try {
    const r = await fetch('avatar/config.json', { cache: 'no-store' });
    if (!r.ok) return;
    const cfg = await r.json();
    const videos = (cfg && cfg.videos) || [];

    // 首页固定取 slug=01 (与 command.html 的 slug=02 区分)
    let pick = videos.find(v => v && v.slug === '01' && v.video);
    if (!pick) pick = videos.find(v => v && v.video);  // fallback
    if (!pick) return;

    // 关闭记忆: 7 天内同 video 不再显示
    const dismissKey = 'aaf_dismissed_video';
    const dismissedAt = parseInt(localStorage.getItem(dismissKey + '_ts') || '0');
    const dismissedSrc = localStorage.getItem(dismissKey);
    const sevenDays = 7 * 86400 * 1000;
    if (dismissedSrc === pick.video && Date.now() - dismissedAt < sevenDays) return;

    const wrap = document.getElementById('aiAnchorFab');
    const bubble = document.getElementById('aafBubble');
    const card = document.getElementById('aafCard');
    const video = document.getElementById('aafVideo');
    const src = document.getElementById('aafVideoSrc');
    const headline = document.getElementById('aafHeadline');
    const dateEl = document.getElementById('aafDate');
    const playBtn = document.getElementById('aafPlay');
    const minBtn = document.getElementById('aafMin');
    const closeBtn = document.getElementById('aafClose');
    if (!wrap || !video || !src) return;

    src.src = pick.video;
    video.load();
    if (headline) headline.textContent = pick.headline || '';
    if (dateEl) {
      const d = pick.date || '';
      const m2 = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m2) {
        const mo = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][parseInt(m2[2])-1];
        dateEl.textContent = `${mo} ${parseInt(m2[3])}, ${m2[1]}`;
      } else {
        dateEl.textContent = d;
      }
    }

    // 折叠/展开
    const expand = () => wrap.classList.remove('aaf-collapsed');
    const collapse = () => {
      wrap.classList.add('aaf-collapsed');
      if (!video.paused) { video.pause(); }
      playBtn.textContent = '▶';
      playBtn.classList.remove('aaf-playing');
    };
    bubble.addEventListener('click', expand);
    minBtn.addEventListener('click', collapse);
    closeBtn.addEventListener('click', () => {
      localStorage.setItem(dismissKey, pick.video);
      localStorage.setItem(dismissKey + '_ts', String(Date.now()));
      wrap.style.display = 'none';
      if (!video.paused) video.pause();
    });

    // 播放/暂停
    let unmuted = false;
    const togglePlay = () => {
      if (!unmuted) {
        video.muted = false;
        video.currentTime = 0;
        unmuted = true;
      }
      if (video.paused) {
        video.play().catch(() => {});
        playBtn.textContent = '⏸';
        playBtn.classList.add('aaf-playing');
      } else {
        video.pause();
        playBtn.textContent = '▶';
        playBtn.classList.remove('aaf-playing');
      }
    };
    playBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
    video.addEventListener('click', togglePlay);
    video.addEventListener('ended', () => {
      playBtn.textContent = '▶';
      playBtn.classList.remove('aaf-playing');
    });

    wrap.style.display = '';
  } catch (e) {
    console.warn('[avatar] 加载失败:', e);
  }
}

/* ═══ Alert mode (组合 A6)
   用 localStorage.lastVisit 判断是否有"上次访问以来"的新 critical
   事件,有 → 触发一次 1.8s 全屏红边光环
*/
function checkAlertMode() {
  const key = 'detect_last_visit';
  const lastVisit = parseInt(localStorage.getItem(key) || '0');
  localStorage.setItem(key, String(Date.now()));
  if (!lastVisit) return; // 第一次访问不触发
  // 找出 lastVisit 之后出现的 critical 事件 (按 date)
  const cutoffMs = lastVisit;
  let hasNew = false;
  outer: for (const c of Object.values(D.conflicts)) {
    for (const cat of Object.values(c.categories || {})) {
      for (const it of cat.items || []) {
        if (it.criticality !== 'critical' || !it.date) continue;
        const ts = new Date(it.date).getTime();
        if (!isNaN(ts) && ts >= cutoffMs) { hasNew = true; break outer; }
      }
    }
  }
  if (!hasNew) return;
  // 2 秒后触发一次,给用户一点时间先看清页面
  setTimeout(() => {
    const el = document.createElement('div');
    el.className = 'alert-mode-overlay';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2000);
  }, 2000);
}

/* ═══ News Ticker (组合 A4) ═══
   读最近 14 天 criticality==='critical' 事件,横向滚动显示
*/
function renderNewsTicker() {
  const wrap = document.getElementById('newsTicker');
  const track = document.getElementById('newsTickerTrack');
  if (!wrap || !track) return;
  const cutoff = Date.now() - 14 * 86400000;
  const critical = [];
  for (const [cid, c] of Object.entries(D.conflicts)) {
    for (const cat of Object.values(c.categories || {})) {
      for (const it of cat.items || []) {
        if (it.criticality !== 'critical' || !it.date) continue;
        const ts = new Date(it.date).getTime();
        if (isNaN(ts) || ts < cutoff) continue;
        critical.push({ ...it, _cid: cid });
      }
    }
  }
  if (!critical.length) { wrap.style.display = 'none'; return; }
  critical.sort((a, b) => new Date(b.date) - new Date(a.date));
  const top = critical.slice(0, 15);

  const codeOf = {
    'russia-ukraine':'RUA','israel-palestine':'ISR','us-iran':'IRN','sudan':'SDN',
    'myanmar':'MMR','yemen-houthi':'YEM','congo-drc':'COD','syria':'SYR','taiwan-strait':'TWN'
  };
  const itemHtml = it => `
    <span class="nt-item" data-id="${it.id}">
      <span class="nti-date">${it.date || ''}</span>
      <span class="nti-conflict">${codeOf[it._cid] || '?'}</span>
      ${esc(it.title || '')}
    </span>
  `;
  // 复制一份实现无缝循环: translateX(-50%) 正好移到第二份开头
  const once = top.map(itemHtml).join('');
  track.innerHTML = `<div class="nt-scroll">${once}${once}</div>`;
  wrap.style.display = '';

  // 点击 → 打开 reader
  track.querySelectorAll('.nt-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const it = top.find(x => x.id === id);
      if (it) {
        conflict = it._cid;
        document.querySelectorAll('.rn-chip').forEach(x => x.classList.toggle('on', x.dataset.k === conflict));
        openReader(id);
      }
    });
  });
}

/* ═══ Theme ═══ (默认 dark, 用户可切换到 light) */
function initTheme() {
  const saved = localStorage.getItem('theme');
  // 默认 dark; 仅当用户明确选了 light 才用 light
  if (saved !== 'light') {
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

  // Escalation-driven color: red(升级) → amber(稳定) → green(缓和)
  function escColor(index) {
    if (index >= 62) {
      const t = Math.min(1, (index - 62) / 38);
      return `rgb(${Math.round(180 + 75*t)},${Math.round(70 - 40*t)},${Math.round(50 - 30*t)})`;
    }
    if (index <= 38) {
      const t = Math.min(1, (38 - index) / 38);
      return `rgb(${Math.round(80 - 40*t)},${Math.round(160 + 40*t)},${Math.round(80 + 20*t)})`;
    }
    return '#d87030';
  }

  // Build point data from conflicts with escalation index
  const points = Object.entries(D.conflicts).map(([k, c]) => {
    const geo = CONFLICT_GEO[k];
    if (!geo) return null;
    const allItems = Object.values(c.categories).flatMap(cat => cat.items);
    const total = allItems.length;
    const esc = escalation(allItems);
    return {
      key: k,
      lat: geo.lat,
      lng: geo.lng,
      name: c.name,
      name_en: c.name_en,
      intensity: c.intensity || 'conflict',
      total,
      escIndex: esc.index,
      escLabel: esc.label,
      color: escColor(esc.index),
    };
  }).filter(Boolean);

  // Rings: speed & size driven by escalation
  const rings = points.map(p => ({
    lat: p.lat, lng: p.lng,
    maxR: p.escIndex >= 62 ? 5 : p.escIndex <= 38 ? 2 : 3,
    propagationSpeed: p.escIndex >= 62 ? 2.5 : 1.2,
    repeatPeriod: p.escIndex >= 62 ? 600 : 1200,
    color: p.color,
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
        <div style="font-size:11px;margin-top:3px">${d.total} reports · ${d.escLabel} ${d.escIndex}</div>
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
  if (_replayTimer) { clearInterval(_replayTimer); _replayTimer = null; }
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
      const surge = detectSurge(allItemsRaw);
      const surgeBadge = surge
        ? `<span class="ov-surge" title="近 7 天 ${surge.cur} 条 / 前 7 天 ${surge.prior} 条 · +${surge.delta}%">⚠ SURGE</span>`
        : '';

      return `
        <div class="ov-card" style="--d:${i * 40}ms" data-k="${k}" data-intensity="${c.intensity || 'conflict'}">
          <div class="ov-card-left">
            <div class="ov-card-name">
              ${c.name}
              <span class="ov-intensity ${c.intensity || 'conflict'}">${INAMES[c.intensity] || c.intensity}</span>
              <span class="ov-escalation ${escl.cls}">${escl.arrow} ${escl.label} <span class="esc-idx">${escl.index}</span></span>
              ${surgeBadge}
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
  renderStreamgraph();
  renderSparkWall();
}

/* ═══ Hot Reports ═══ */
function renderHotReports() {
  const el = document.getElementById('hotList');
  if (!el) return;

  // 热门榜 = 社交互动池 + 多源印证池, 分别排序后合并, 避免互动量压倒情报学信号
  // 前 7 槽给社交互动 top (传统 "hot")
  // 后 3 槽给多源印证簇 top, 按 size*(bias+1) 排序, 同 cluster 去重
  const engagementPool = [];
  const clusterPool = [];
  const seenCluster = new Set();
  const seenId = new Set();
  for (const [k, c] of Object.entries(D.conflicts)) {
    for (const cat of Object.values(c.categories)) {
      for (const it of cat.items) {
        if (seenId.has(it.id)) continue;
        seenId.add(it.id);
        const m = it.metrics || {};
        const engagement = (m.likes||0) + (m.retweets||0)*2 + (m.score||0) + (m.comments||0);
        const size = it.cluster_size || 0;
        if (engagement > 0) {
          engagementPool.push({ ...it, _score: engagement, _conflict: k, _cname: c.name });
        }
        if (size >= 2 && it.cluster_id && !seenCluster.has(it.cluster_id)) {
          seenCluster.add(it.cluster_id);
          const clusterScore = size * ((it.cluster_bias_count || 0) + 1);
          clusterPool.push({ ...it, _score: clusterScore * 100, _conflict: k, _cname: c.name });
        }
      }
    }
  }
  engagementPool.sort((a, b) => b._score - a._score);
  clusterPool.sort((a, b) => b._score - a._score);

  const top = [];
  const taken = new Set();
  for (const it of engagementPool.slice(0, 7)) {
    top.push(it);
    taken.add(it.id);
  }
  for (const it of clusterPool) {
    if (top.length >= 10) break;
    if (taken.has(it.id)) continue;
    top.push(it);
    taken.add(it.id);
  }
  // 兜底: 如果 cluster pool 不够 3 条, 用 engagement 的 8-10 名填满
  for (const it of engagementPool.slice(7)) {
    if (top.length >= 10) break;
    if (taken.has(it.id)) continue;
    top.push(it);
    taken.add(it.id);
  }

  const srcIcon = { x:'𝕏', reddit:'⬡', youtube:'▶', web:'◉' };

  el.innerHTML = top.map((it, i) => {
    const size = it.cluster_size || 0;
    const bias = it.cluster_bias_count || 0;
    let badges = '';
    if (size >= 2) {
      badges += `<span class="hot-cluster" title="这条事件被 ${size} 个独立源印证">${size}源</span>`;
    }
    if (bias >= 2) {
      badges += `<span class="hot-crossbias" title="跨 ${bias} 种媒体偏见印证,高可信度">跨${bias}偏见</span>`;
    }
    return `
    <div class="hot-item" data-k="${it._conflict}" data-id="${it.id}">
      <span class="hot-rank ${i < 3 ? 'top3' : ''}">${i + 1}</span>
      <div class="hot-body">
        <div class="hot-title">${esc(it.title)}</div>
        <div class="hot-meta">${srcIcon[it.source]||'◉'} ${it._cname} · ${it.date || ''}${badges}</div>
      </div>
      <span class="hot-score">${formatScore(it._score)}</span>
    </div>
  `;
  }).join('');

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

/* ═══ 30 天事件流 Streamgraph (方向 C) ═══
   d3.stack() offset silhouette, 9 冲突堆叠
   hover 流 → tooltip 显示冲突名 + 当日计数
   click 流 → 打开冲突详情
*/
function renderStreamgraph() {
  const el = document.getElementById('streamWrap');
  if (!el || typeof d3 === 'undefined') return;

  const days = 30;
  const now = new Date();
  const conflictIds = Object.keys(D.conflicts);

  // 按天 bucket
  const buckets = [];
  for (let i = 0; i < days; i++) {
    const dt = new Date(now - (days - 1 - i) * 86400000);
    const b = { date: dt, dayIdx: i };
    for (const cid of conflictIds) b[cid] = 0;
    buckets.push(b);
  }
  for (const cid of conflictIds) {
    const items = Object.values(D.conflicts[cid].categories).flatMap(cat => cat.items);
    for (const it of items) {
      if (!it.date) continue;
      const ts = new Date(it.date).getTime();
      if (isNaN(ts)) continue;
      const diff = Math.floor((now - ts) / 86400000);
      if (diff >= 0 && diff < days) {
        buckets[days - 1 - diff][cid]++;
      }
    }
  }

  // 颜色: 按 intensity 分族 + 同族内用不同明度区分
  const palette = {
    war:      ['#b82818', '#e84838', '#d83428'],
    conflict: ['#c86020', '#e88040', '#d87030'],
    tension:  ['#b89818', '#d8a830', '#c8a028'],
  };
  const grouped = { war: [], conflict: [], tension: [] };
  for (const cid of conflictIds) {
    const intensity = D.conflicts[cid].intensity || 'conflict';
    grouped[intensity].push(cid);
  }
  const colorMap = {};
  for (const [intensity, cids] of Object.entries(grouped)) {
    cids.forEach((cid, i) => {
      colorMap[cid] = palette[intensity][i % palette[intensity].length];
    });
  }

  // d3 stack
  const stack = d3.stack()
    .keys(conflictIds)
    .offset(d3.stackOffsetSilhouette)
    .order(d3.stackOrderInsideOut);
  const series = stack(buckets);

  // 布局
  el.innerHTML = '';
  const width = el.clientWidth || 600;
  const height = 180;
  const margin = { top: 8, right: 12, bottom: 24, left: 12 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const x = d3.scaleLinear().domain([0, days - 1]).range([0, innerW]);
  const yMin = d3.min(series, layer => d3.min(layer, d => d[0]));
  const yMax = d3.max(series, layer => d3.max(layer, d => d[1]));
  const y = d3.scaleLinear().domain([yMin, yMax]).range([innerH, 0]);

  const area = d3.area()
    .x((_, i) => x(i))
    .y0(d => y(d[0]))
    .y1(d => y(d[1]))
    .curve(d3.curveBasis);

  const svg = d3.select(el).append('svg')
    .attr('width', width).attr('height', height)
    .style('cursor', 'pointer');
  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  const tooltip = document.getElementById('streamTooltip');

  const paths = g.selectAll('path.stream-layer')
    .data(series)
    .join('path')
    .attr('class', 'stream-layer')
    .attr('d', area)
    .attr('fill', d => colorMap[d.key])
    .attr('stroke', 'none')
    .attr('opacity', 0.78)
    .attr('data-cid', d => d.key);

  paths
    .on('mouseenter', function(e, d) {
      d3.select(this).attr('opacity', 1);
      // 同时在 sparkwall 里高亮对应项
      document.querySelectorAll(`.spark-cell[data-cid="${d.key}"]`).forEach(c => c.classList.add('sc-hl'));
    })
    .on('mouseleave', function(e, d) {
      d3.select(this).attr('opacity', 0.78);
      if (tooltip) tooltip.style.display = 'none';
      document.querySelectorAll('.spark-cell.sc-hl').forEach(c => c.classList.remove('sc-hl'));
    })
    .on('mousemove', function(e, d) {
      if (!tooltip) return;
      const [mx] = d3.pointer(e, svg.node());
      const dayIdx = Math.max(0, Math.min(days - 1, Math.round(x.invert(mx - margin.left))));
      const b = buckets[dayIdx];
      const count = b[d.key];
      const name = D.conflicts[d.key]?.name || d.key;
      const dateStr = `${b.date.getMonth()+1}/${b.date.getDate()}`;
      tooltip.innerHTML = `<b>${esc(name)}</b><br><span class="st-date">${dateStr}</span> · <span class="st-count">${count} 条</span>`;
      tooltip.style.display = '';
      tooltip.style.left = (e.pageX - el.getBoundingClientRect().left + 12) + 'px';
      tooltip.style.top = (e.pageY - el.getBoundingClientRect().top - 10) + 'px';
    })
    .on('click', function(e, d) {
      conflict = d.key;
      tab = 'military';
      document.querySelectorAll('.rn-chip').forEach(x => x.classList.toggle('on', x.dataset.k === d.key));
      showConflict();
    });

  // X 轴日期标签
  const xAxisG = g.append('g').attr('transform', `translate(0,${innerH + 4})`);
  const ticks = [0, Math.floor(days / 4), Math.floor(days / 2), Math.floor(3 * days / 4), days - 1];
  xAxisG.selectAll('text')
    .data(ticks)
    .join('text')
    .attr('x', i => x(i))
    .attr('y', 12)
    .attr('text-anchor', 'middle')
    .attr('font-family', 'var(--mono)')
    .attr('font-size', 9)
    .attr('fill', 'var(--ink-40)')
    .text(i => {
      const b = buckets[i];
      return `${b.date.getMonth()+1}/${b.date.getDate()}`;
    });
}

/* ═══ 9 冲突 Sparkline Wall (方向 C) ═══
   3x3 网格, 每格一个冲突的 mini sparkline + escalation 标签
*/
function renderSparkWall() {
  const el = document.getElementById('sparkWall');
  if (!el) return;
  const entries = Object.entries(D.conflicts).map(([cid, c]) => {
    const items = Object.values(c.categories).flatMap(cat => cat.items);
    const esc_ = escalation(items);
    // 30 天桶
    const days = 30;
    const now = new Date();
    const buckets = new Array(days).fill(0);
    for (const it of items) {
      if (!it.date) continue;
      const ts = new Date(it.date).getTime();
      if (isNaN(ts)) continue;
      const diff = Math.floor((now - ts) / 86400000);
      if (diff >= 0 && diff < days) buckets[days - 1 - diff]++;
    }
    return { cid, c, esc: esc_, buckets, total: items.length };
  });
  // 按 escalation 降序
  entries.sort((a, b) => b.esc.index - a.esc.index);

  const codeOf = {
    'russia-ukraine':'RUA','israel-palestine':'ISR','us-iran':'IRN','sudan':'SDN',
    'myanmar':'MMR','yemen-houthi':'YEM','congo-drc':'COD','syria':'SYR','taiwan-strait':'TWN'
  };

  el.innerHTML = entries.map(e => {
    const max = Math.max(...e.buckets, 1);
    const w = 90, h = 26;
    const barW = w / e.buckets.length;
    const bars = e.buckets.map((v, i) => {
      if (v === 0) return '';
      const bh = (v / max) * (h - 2);
      return `<rect x="${i * barW}" y="${h - bh}" width="${barW - 0.5}" height="${bh}"/>`;
    }).join('');
    const color = e.c.intensity === 'war' ? 'var(--i-war)'
                : e.c.intensity === 'conflict' ? 'var(--i-conflict)'
                : 'var(--i-tension)';
    return `
      <div class="spark-cell" data-cid="${e.cid}" title="${esc(e.c.name)} · ${e.total} 条 · ${e.esc.label}">
        <div class="sc-head">
          <span class="sc-code">${codeOf[e.cid] || '?'}</span>
          <span class="sc-esc ${e.esc.cls}">${e.esc.arrow}${e.esc.index}</span>
        </div>
        <svg class="sc-spark" viewBox="0 0 ${w} ${h}" fill="${color}" opacity="0.7">${bars}</svg>
        <div class="sc-name">${esc(e.c.name)}</div>
      </div>
    `;
  }).join('');

  // click / hover 联动
  el.querySelectorAll('.spark-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      conflict = cell.dataset.cid;
      tab = 'military';
      document.querySelectorAll('.rn-chip').forEach(x => x.classList.toggle('on', x.dataset.k === cell.dataset.cid));
      showConflict();
    });
    cell.addEventListener('mouseenter', () => {
      // 高亮 streamgraph 对应 layer
      document.querySelectorAll(`.stream-layer[data-cid="${cell.dataset.cid}"]`).forEach(p => {
        p.setAttribute('opacity', '1');
      });
      document.querySelectorAll('.stream-layer').forEach(p => {
        if (p.getAttribute('data-cid') !== cell.dataset.cid) p.setAttribute('opacity', '0.3');
      });
    });
    cell.addEventListener('mouseleave', () => {
      document.querySelectorAll('.stream-layer').forEach(p => p.setAttribute('opacity', '0.78'));
    });
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

let _infraData = null;
let _infraLayers = {};
let _replayTimer = null;
let _frontlineLayer = null;
let _heatLayer = null;
let _replayMarkers = null;   // 当前 replay 的 marker 容器 (cluster 或 layerGroup)
let _replayUseCluster = true; // 用户偏好:是否启用聚类

function initDetailMap(key, c) {
  const el = document.getElementById('cdMap');
  const geo = CONFLICT_GEO[key];
  if (!geo || typeof L === 'undefined') { el.style.display = 'none'; document.getElementById('mapControls').style.display = 'none'; return; }
  el.style.display = '';
  document.getElementById('mapControls').style.display = '';

  // Destroy previous
  if (detailMap) { detailMap.remove(); detailMap = null; }
  if (_replayTimer) { clearInterval(_replayTimer); _replayTimer = null; }
  _infraLayers = {};

  detailMap = L.map(el, { zoomControl: true, scrollWheelZoom: false }).setView([geo.lat, geo.lng], geo.zoom);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OSM &amp; CartoDB', maxZoom: 12,
  }).addTo(detailMap);

  const colors = { war: '#e74c3c', conflict: '#d87030', tension: '#c89820' };
  const color = colors[c.intensity] || colors.conflict;

  // Conflict zone marker
  L.circleMarker([geo.lat, geo.lng], { radius: 18, color, fillColor: color, fillOpacity: 0.15, weight: 1.5 }).addTo(detailMap);
  L.circleMarker([geo.lat, geo.lng], { radius: 6, color, fillColor: color, fillOpacity: 0.8, weight: 0 }).addTo(detailMap);

  // Related conflicts
  (c.related || []).filter(k => D.conflicts[k] && CONFLICT_GEO[k]).forEach(k => {
    const rg = CONFLICT_GEO[k], rc = D.conflicts[k];
    const rcolor = colors[rc.intensity] || colors.conflict;
    L.circleMarker([rg.lat, rg.lng], { radius: 5, color: rcolor, fillColor: rcolor, fillOpacity: 0.5, weight: 0 })
      .bindTooltip(rc.name, { className: 'cd-map-tip', direction: 'top', offset: [0, -6] }).addTo(detailMap);
  });

  // ── Frontline layer (仅俄乌,DeepStateMap 占领区) ──
  initFrontlineLayer(key);

  // ── Timeline Replay (plots all items on map) ──
  const allItems = Object.values(c.categories).flatMap(cat => cat.items);
  initReplay(allItems, color);

  // ── Heat layer (只用真坐标,不误导) ──
  initHeatLayer(allItems);

  // ── Infrastructure Layers ──
  initInfraLayers();

  setTimeout(() => detailMap.invalidateSize(), 100);
}

function initReplay(items, color) {
  const dated = items.filter(it => it.date).sort((a, b) => a.date.localeCompare(b.date));
  if (dated.length < 3) { document.getElementById('replayBar').style.display = 'none'; return; }
  document.getElementById('replayBar').style.display = '';

  // Pre-assign a stable random position to each item (seeded by id/title hash)
  const center = detailMap.getCenter();
  dated.forEach(it => {
    const gm = it.gdelt_meta;
    if (gm && gm.geo_lat && (gm.geo_lat !== 0 || gm.geo_lon !== 0)) {
      it._lat = gm.geo_lat;
      it._lng = gm.geo_lon;
    } else {
      // Spread around conflict center with deterministic offset based on item id
      const h = (it.id || it.title || '').split('').reduce((s, c) => (s * 31 + c.charCodeAt(0)) | 0, 0);
      const angle = (h & 0xffff) / 0xffff * Math.PI * 2;
      const radius = 0.5 + (((h >> 16) & 0xff) / 255) * 2.5; // 0.5-3.0 degrees
      it._lat = center.lat + Math.sin(angle) * radius;
      it._lng = center.lng + Math.cos(angle) * radius;
    }
  });

  const srcColors = { web: '#4a9', reddit: '#d84e1c', x: '#1478c8', youtube: '#cc1818', gdelt: '#ff6b6b' };
  const dates = [...new Set(dated.map(it => it.date))].sort();
  const slider = document.getElementById('replaySlider');
  const dateEl = document.getElementById('replayDate');
  const countEl = document.getElementById('replayCount');
  const btn = document.getElementById('replayBtn');

  slider.max = dates.length - 1;
  slider.value = dates.length - 1;
  dateEl.textContent = dates[dates.length - 1];
  countEl.textContent = `${dated.length} 事件`;

  // 根据 cluster 开关选择容器;默认启用聚类
  const clusterToggle = document.getElementById('layerCluster');
  _replayUseCluster = clusterToggle ? clusterToggle.checked : true;
  const makeGroup = () => (_replayUseCluster && typeof L.markerClusterGroup === 'function')
    ? L.markerClusterGroup({
        showCoverageOnHover: false,
        spiderfyOnMaxZoom: true,
        maxClusterRadius: 45,
        disableClusteringAtZoom: 10,
      })
    : L.layerGroup();
  _replayMarkers = makeGroup().addTo(detailMap);

  function showUpTo(idx) {
    const cutoff = dates[idx];
    _replayMarkers.clearLayers();
    const visible = dated.filter(it => it.date <= cutoff);
    visible.forEach(it => {
      const clr = srcColors[it.source] || '#ff6b6b';
      L.circleMarker([it._lat, it._lng], {
        radius: it.gdelt_meta ? 5 : 4,
        color: clr, fillColor: clr, fillOpacity: 0.7, weight: 0,
      }).bindTooltip(`${it.title || ''}<br><span style="font-size:10px;opacity:0.7">${it.date} · ${srcN(it.source)}</span>`, {
        className: 'cd-map-tip',
      }).addTo(_replayMarkers);
    });
    dateEl.textContent = cutoff;
    countEl.textContent = `${visible.length} / ${dated.length}`;
  }

  // Cluster 开关: 切换时重建容器并重新渲染当前 slider 位置
  if (clusterToggle) {
    clusterToggle.onchange = function() {
      _replayUseCluster = this.checked;
      if (_replayMarkers) detailMap.removeLayer(_replayMarkers);
      _replayMarkers = makeGroup().addTo(detailMap);
      showUpTo(+slider.value);
    };
  }

  slider.oninput = () => showUpTo(+slider.value);

  let playing = false;
  btn.onclick = () => {
    if (playing) {
      clearInterval(_replayTimer);
      _replayTimer = null;
      btn.textContent = '▶ 回放';
      playing = false;
      return;
    }
    playing = true;
    btn.textContent = '⏸ 暂停';
    let idx = 0;
    slider.value = 0;
    showUpTo(0);
    _replayTimer = setInterval(() => {
      idx++;
      if (idx >= dates.length) {
        clearInterval(_replayTimer);
        _replayTimer = null;
        btn.textContent = '▶ 回放';
        playing = false;
        return;
      }
      slider.value = idx;
      showUpTo(idx);
    }, 500);
  };
}

async function initFrontlineLayer(conflictKey) {
  // 只对俄乌战争启用;其他冲突将来可以扩展其他数据源
  const wrap = document.getElementById('layerFrontlineWrap');
  const cb = document.getElementById('layerFrontline');
  if (conflictKey !== 'russia-ukraine') {
    if (wrap) wrap.style.display = 'none';
    return;
  }

  let geojson;
  try {
    const r = await fetch(SRC + 'frontline_ua.geojson');
    if (!r.ok) throw new Error('frontline_ua.geojson not found');
    geojson = await r.json();
  } catch (e) {
    if (wrap) wrap.style.display = 'none';
    return;
  }

  if (wrap) wrap.style.display = '';
  if (_frontlineLayer) {
    detailMap.removeLayer(_frontlineLayer);
    _frontlineLayer = null;
  }

  _frontlineLayer = L.geoJSON(geojson, {
    style: {
      color: '#e74c3c',
      weight: 1.2,
      opacity: 0.85,
      fillColor: '#c1272d',
      fillOpacity: 0.22,
    },
  });

  const meta = geojson._meta || {};
  const tipHtml = `<b>俄占区 · DeepStateMap</b><br>`
    + `<span style="font-size:10px;opacity:0.7">${meta.file || ''}</span>`;
  _frontlineLayer.bindTooltip(tipHtml, { className: 'cd-map-tip', sticky: true });

  if (cb && cb.checked) _frontlineLayer.addTo(detailMap);
  if (cb) {
    cb.onchange = function() {
      if (!_frontlineLayer) return;
      this.checked ? _frontlineLayer.addTo(detailMap) : detailMap.removeLayer(_frontlineLayer);
    };
  }
}

function initHeatLayer(items) {
  const cb = document.getElementById('layerHeat');
  if (!cb || typeof L.heatLayer !== 'function') return;

  // 只使用真实坐标 (GDELT 提供的 geo_lat/lon),避免把随机散布的点画成热力
  const realPoints = [];
  items.forEach(it => {
    const gm = it.gdelt_meta;
    if (gm && gm.geo_lat && gm.geo_lon && (gm.geo_lat !== 0 || gm.geo_lon !== 0)) {
      // intensity: critical 1.0, notable 0.6, 其他 0.4
      const w = it.criticality === 'critical' ? 1.0 : it.criticality === 'notable' ? 0.6 : 0.4;
      realPoints.push([gm.geo_lat, gm.geo_lon, w]);
    }
  });

  if (_heatLayer) {
    detailMap.removeLayer(_heatLayer);
    _heatLayer = null;
  }

  if (!realPoints.length) {
    // 没真坐标就隐藏 checkbox (避免用户打开看不到东西)
    const label = cb.closest('.layer-toggle');
    if (label) label.style.display = 'none';
    return;
  }
  const label = cb.closest('.layer-toggle');
  if (label) label.style.display = '';

  _heatLayer = L.heatLayer(realPoints, {
    radius: 28,
    blur: 22,
    maxZoom: 10,
    minOpacity: 0.35,
    gradient: { 0.2: '#3b5', 0.4: '#fc3', 0.7: '#f83', 1.0: '#e22' },
  });

  cb.checked = false;
  cb.onchange = function() {
    if (!_heatLayer) return;
    this.checked ? _heatLayer.addTo(detailMap) : detailMap.removeLayer(_heatLayer);
  };
}

async function initInfraLayers() {
  if (!_infraData) {
    try {
      const r = await fetch(SRC + 'infrastructure.json');
      if (r.ok) _infraData = await r.json();
    } catch {}
  }
  if (!_infraData || !detailMap) return;

  const iconOpts = (clr) => ({ radius: 4, color: clr, fillColor: clr, fillOpacity: 0.8, weight: 1 });

  // Military bases layer
  const basesLayer = L.layerGroup();
  (_infraData.military_bases || []).forEach(b => {
    const clr = b.country.includes('US') || b.country.includes('UK') ? '#4a90d9' : b.country.includes('RU') ? '#d94a4a' : '#d9c94a';
    L.circleMarker([b.lat, b.lng], iconOpts(clr))
      .bindTooltip(`<b>${b.name}</b><br>${b.country} · ${b.type}`, { className: 'cd-map-tip' })
      .addTo(basesLayer);
  });
  _infraLayers.bases = basesLayer;

  // Nuclear facilities layer
  const nuclearLayer = L.layerGroup();
  (_infraData.nuclear_facilities || []).forEach(n => {
    L.circleMarker([n.lat, n.lng], { radius: 6, color: '#ff0', fillColor: '#ff0', fillOpacity: 0.7, weight: 1.5 })
      .bindTooltip(`<b>☢ ${n.name}</b><br>${n.country} · ${n.type}${n.status ? ' · ' + n.status : ''}`, { className: 'cd-map-tip' })
      .addTo(nuclearLayer);
  });
  _infraLayers.nuclear = nuclearLayer;

  // Pipelines/cables layer
  const pipeLayer = L.layerGroup();
  const lineColors = { gas: '#4a90d9', oil: '#d94a4a', cable: '#8a6aaa', chokepoint: '#e74c3c' };
  (_infraData.pipelines_cables || []).forEach(p => {
    const clr = lineColors[p.type] || '#888';
    L.polyline(p.coords, { color: clr, weight: 2, opacity: 0.6, dashArray: p.type === 'cable' ? '4 4' : null })
      .bindTooltip(`<b>${p.name}</b><br>${p.type}`, { className: 'cd-map-tip', sticky: true })
      .addTo(pipeLayer);
  });
  _infraLayers.pipelines = pipeLayer;

  // Wire toggles
  document.getElementById('layerBases').onchange = function() { this.checked ? basesLayer.addTo(detailMap) : detailMap.removeLayer(basesLayer) };
  document.getElementById('layerNuclear').onchange = function() { this.checked ? nuclearLayer.addTo(detailMap) : detailMap.removeLayer(nuclearLayer) };
  document.getElementById('layerPipelines').onchange = function() { this.checked ? pipeLayer.addTo(detailMap) : detailMap.removeLayer(pipeLayer) };

  // Reset checkboxes
  document.getElementById('layerBases').checked = false;
  document.getElementById('layerNuclear').checked = false;
  document.getElementById('layerPipelines').checked = false;
}

function renderDataStrip(c) {
  const el = document.getElementById('dataStrip');
  const allItems = Object.values(c.categories).flatMap(cat => cat.items);
  const srcCount = {};
  allItems.forEach(it => { srcCount[it.source] = (srcCount[it.source] || 0) + 1 });
  const srcColors = { reddit:'var(--tag-reddit)', x:'var(--tag-x)', youtube:'var(--tag-yt)', web:'var(--tag-web)', gdelt:'var(--tag-gdelt)' };
  const srcNames = { reddit:'Reddit', x:'X', youtube:'YouTube', web:'Web', gdelt:'GDELT' };

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

  // Sort: effectiveWeight (criticality + corroboration) 降序
  //  - critical 单源 = 4, notable 单源 = 2, background 单源 = 0
  //  - 跨偏见 cluster (>=2 bias) 加 4  →  background+crossbias = 4 (=critical)
  //  - 4+ 源簇加 3, 2-3 源簇加 1
  // 然后按 date, 再用 richness 对同日事件加权
  const sorted = [...items].sort((a,b) => {
    const ew = effectiveWeight(b) - effectiveWeight(a);
    if (ew !== 0) return ew;
    const da = new Date(a.date), db = new Date(b.date);
    if (Math.abs(da - db) < 172800000) {
      const rich = s => (s.source==='web'?2:s.source==='youtube'?1:0) + (s.local_file?1:0);
      const d = rich(b) - rich(a);
      if (d !== 0) return d;
    }
    return db - da;
  });

  // BLUF 分层: effectiveWeight >= 2 默认可见, < 2 折叠在 "展开背景动态"
  // above 包括 critical (w=4)、notable (w=2)、background+crossbias (w=4)、background+4源 (w=3)
  // below 是弱 background (无 cluster 或 2-3 源小簇)
  const above = [];
  const below = [];
  for (const it of sorted) {
    if (effectiveWeight(it) >= 2) above.push(it);
    else below.push(it);
  }

  const renderStory = (it, i, isLead) => {
    const d = new Date(it.date);
    const day = isNaN(d) ? '--' : d.getDate();
    const mon = isNaN(d) ? '---' : MO[d.getMonth()];
    const rel = relTime(it.date);
    const cls = `crit-${it.criticality||'background'}`;

    if (isLead) {
      return `<div class="story lead ${cls}" style="--d:0ms" data-id="${it.id}">
        <div class="s-body">
          <div class="s-hl">${critBadge(it)}${esc(it.title)}</div>
          ${it.title_en ? `<div class="en-original">${esc(it.title_en)}</div>` : ''}
          <div class="s-meta">
            <span class="s-src ${it.source}">${srcN(it.source)}</span>
            <span class="s-from">${esc(it.source_label)}${credBadge(it)}${corrobBadge(it)}</span>
            ${nums(it.metrics)}
            <span class="s-time">${rel}</span>
          </div>
          <div class="s-dek">${esc(it.summary)}</div>
        </div>
      </div>`;
    }

    return `<div class="story ${cls}" style="--d:${i*35}ms" data-id="${it.id}">
      <div class="s-date"><span class="s-day">${day}</span><span class="s-mon">${mon}</span></div>
      <div class="s-body">
        <div class="s-hl">${critBadge(it)}${esc(it.title)}</div>
        ${it.title_en ? `<div class="en-original">${esc(it.title_en)}</div>` : ''}
        <div class="s-meta">
          <span class="s-src ${it.source}">${srcN(it.source)}</span>
          <span class="s-from">${esc(it.source_label)}${credBadge(it)}${corrobBadge(it)}</span>
          ${nums(it.metrics)}
          <span class="s-time">${rel}</span>
        </div>
        <div class="s-dek">${esc(it.summary)}</div>
      </div>
    </div>`;
  };

  // 如果 above 为空 (该分类全是弱背景), 降级为不折叠, 避免空页
  if (above.length === 0) {
    el.innerHTML = sorted.map((it, i) => renderStory(it, i, i === 0)).join('');
    return;
  }

  const aboveHtml = above.map((it, i) => renderStory(it, i, i === 0)).join('');
  const belowCount = below.length;
  let html = aboveHtml;
  if (belowCount > 0) {
    const belowHtml = below.map((it, i) => renderStory(it, i, false)).join('');
    html += `
      <div class="bluf-divider">
        <button class="bluf-toggle" type="button" data-bluf-toggle>
          <span>展开背景动态</span>
          <span class="bluf-toggle-count">${belowCount}</span>
        </button>
        <span class="bluf-divider-rule"></span>
        <span class="bluf-divider-label">BLUF · below the fold</span>
      </div>
      <div class="bluf-below" id="blufBelow">${belowHtml}</div>
    `;
  }
  el.innerHTML = html;

  // 折叠/展开交互
  const toggleBtn = el.querySelector('[data-bluf-toggle]');
  const belowEl = el.querySelector('#blufBelow');
  if (toggleBtn && belowEl) {
    toggleBtn.addEventListener('click', () => {
      const open = belowEl.classList.toggle('bluf-open');
      toggleBtn.querySelector('span:first-child').textContent = open ? '收起背景动态' : '展开背景动态';
    });
  }
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

/**
 * Reader 头部的"同事件其他源"面板 (组合 A3)
 * 如果当前 item 属于一个 cluster,显示同簇其他源的可点击链接
 */
function renderReaderCorrob(currentItem) {
  const el = document.getElementById('readerCorrob');
  if (!el) return;
  if (!currentItem.cluster_id || !currentItem.cluster_size || currentItem.cluster_size < 2) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  // 在所有冲突里找同簇成员
  const members = [];
  for (const c of Object.values(D.conflicts)) {
    for (const cat of Object.values(c.categories || {})) {
      for (const it of cat.items || []) {
        if (it.cluster_id === currentItem.cluster_id && it.id !== currentItem.id) {
          // 避免同一个 item 在多个 category 里重复
          if (!members.find(m => m.id === it.id)) members.push(it);
        }
      }
    }
  }
  if (!members.length) {
    el.style.display = 'none';
    return;
  }

  const biasCount = currentItem.cluster_bias_count || 0;
  const headline = biasCount >= 2
    ? `${currentItem.cluster_size} 个独立源印证 · 跨 ${biasCount} 种媒体视角`
    : `${currentItem.cluster_size} 个独立源印证`;

  el.innerHTML = `
    <div class="rc-head">
      <span class="rc-icon">★</span>
      <span class="rc-title">${headline}</span>
      <span class="rc-hint">同事件其他来源报道</span>
    </div>
    <div class="rc-list">
      ${members.map(m => `
        <div class="rc-item" data-id="${m.id}">
          <span class="rc-src ${m.source}">${srcN(m.source)}</span>
          <span class="rc-label">${esc(m.source_label || '')}</span>
          <span class="rc-date">${m.date || ''}</span>
          <span class="rc-sep">·</span>
          <span class="rc-title-text">${esc(m.title || '')}</span>
        </div>
      `).join('')}
    </div>
  `;
  el.style.display = '';

  // 点击簇成员 → 切换 reader 到那个 item
  el.querySelectorAll('.rc-item').forEach(row => {
    row.addEventListener('click', () => {
      openReader(row.dataset.id);
    });
  });
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
  const cb = corrobBadge(it);
  if (cb) metaParts.push(cb);
  const m = it.metrics || {};
  if (m.likes) metaParts.push(`${fmt(m.likes)} likes`);
  if (m.score) metaParts.push(`${fmt(m.score)} pts`);
  if (m.retweets) metaParts.push(`${fmt(m.retweets)} RT`);
  if (m.comments) metaParts.push(`${fmt(m.comments)} 评论`);
  document.getElementById('readerMeta').innerHTML = metaParts.join(' &middot; ');

  // 同一簇其他源链接 (组合 A3)
  renderReaderCorrob(it);

  const actionHtml = `
    <a class="ra-btn ra-dark" href="${it.url}" target="_blank" rel="noopener">查看原始来源</a>
    ${it.local_file ? `<a class="ra-btn ra-ghost" href="${SRC}${it.local_file}" target="_blank">下载原文</a>` : ''}
    <button class="ra-btn ra-ghost tts-btn" onclick="toggleTTS()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/><path d="M19.07 4.93a10 10 0 010 14.14"/></svg><span class="tts-label">朗读</span></button>
    <button class="ra-btn ra-ghost" onclick="copyArticle()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>复制全文</button>
    <button class="ra-btn ra-ghost" onclick="downloadPDF()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 18 15 15"/></svg>下载 PDF</button>
    ${it.local_file ? `<button class="ra-btn ra-ghost" onclick="downloadMarkdown()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>下载 Markdown</button>` : ''}
  `;
  document.getElementById('readerActionsTop').innerHTML = actionHtml;
  document.getElementById('readerActionsBot').innerHTML = actionHtml;

  // Stop any playing TTS when opening a new article
  stopTTS();

  // Load content — try .zh.md (Chinese translation) first, fall back to original
  _currentRawMarkdown = null;
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
          _currentRawMarkdown = zhRaw;
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
        _currentRawMarkdown = raw;
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
  stopTTS();
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

/* ═══ Text-to-Speech (双模型分流：CosyVoice + qwen-tts) ═══ */
// 按语言自动选声：中文 chunk → tts_voice_zh，英文 chunk → tts_voice_en
// State: { chunks: [], index: int, audio: HTMLAudioElement|null, playing: bool, paused: bool, loadingBlobUrl: str|null }
let _tts = null;
const TTS_CHUNK_MAX = 1500;         // chars per chunk (backend cap is 2000, leave headroom)

// Chinese voices — CosyVoice (broadcaster-grade) + qwen-tts (lighter personas)
const TTS_VOICES_ZH = [
  { id: 'longnan_v2',  label: 'longnan_v2 龙楠',    desc: '睿智青年男·有声书（默认）' },
  { id: 'longshuo_v2', label: 'longshuo_v2 龙硕',   desc: '博学多才男·新闻播报 ⭐' },
  { id: 'longshu_v2',  label: 'longshu_v2 龙书',    desc: '沉稳青年·播音员人设 ⭐' },
  { id: 'longsanshu',  label: 'longsanshu 龙三叔',  desc: '沉稳内敛·有声书精修' },
  { id: 'longyichen',  label: 'longyichen 龙逸尘',  desc: '洒脱活力·有声书' },
  { id: 'longanlang',  label: 'longanlang 龙安朗',  desc: '清新干净·语音助手' },
  { id: 'longanyun',   label: 'longanyun 龙安云',   desc: '温暖体贴·语音助手' },
  { id: 'Ethan',       label: 'Ethan 晨煦',         desc: 'qwen-tts 北方口音' },
  { id: 'Moon',        label: 'Moon 月白',          desc: 'qwen-tts 率性帅气' },
  { id: 'Kai',         label: 'Kai 凯',             desc: 'qwen-tts 沉稳舒缓' },
];

// English voices
const TTS_VOICES_EN = [
  { id: 'loongdavid_v2', label: 'loongdavid_v2', desc: 'American English male（默认）' },
];

function getTTSVoiceZh() { return localStorage.getItem('tts_voice_zh') || 'longnan_v2'; }
function getTTSVoiceEn() { return localStorage.getItem('tts_voice_en') || 'loongdavid_v2'; }
function setTTSVoiceZh(v) { localStorage.setItem('tts_voice_zh', v); }
function setTTSVoiceEn(v) { localStorage.setItem('tts_voice_en', v); }

// Detect dominant language of a chunk. Returns 'zh' or 'en'.
function detectTTSLang(text) {
  if (!text) return 'zh';
  const zhCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latCount = (text.match(/[a-zA-Z]/g) || []).length;
  // Chinese chars weight higher because each CJK char carries more information than a Latin letter
  return (zhCount * 3 >= latCount) ? 'zh' : 'en';
}

function voiceForChunk(text) {
  return detectTTSLang(text) === 'zh' ? getTTSVoiceZh() : getTTSVoiceEn();
}

function extractReaderText() {
  const body = document.getElementById('readerBody');
  if (!body) return '';
  const clone = body.cloneNode(true);

  // 1. Drop the read-time indicator (first child inserted at render time)
  const first = clone.firstElementChild;
  if (first && first.style && first.style.fontFamily && first.style.fontFamily.includes('mono')) {
    clone.removeChild(first);
  }

  // 2. Drop code blocks, tables, images — don't TTS well
  clone.querySelectorAll('pre, code, table, img, figure').forEach(el => el.remove());

  // 3. Drop the duplicated h1 (we prepend title separately below)
  clone.querySelectorAll('h1').forEach(el => el.remove());

  // 4. Strip metadata header: any <p> containing "原始链接" + trailing <hr>
  //    Markdown file structure is consistent:
  //      [optional h1 title]
  //      [optional reddit metadata line]
  //      **原始链接：** <URL>
  //      ---
  //      <actual content>
  clone.querySelectorAll('p').forEach(p => {
    const t = p.textContent || '';
    if (t.includes('原始链接') || t.includes('Original link')) {
      let next = p.nextElementSibling;
      while (next && next.tagName === 'HR') {
        const after = next.nextElementSibling;
        next.remove();
        next = after;
      }
      p.remove();
    }
  });

  // 5. Strip reddit-style metadata lines: "r/xxx | N pts | N comments | u/user | date"
  clone.querySelectorAll('p').forEach(p => {
    const t = p.textContent || '';
    if (/\d+\s*pts\s*\|\s*\d+\s*comments/.test(t) || /u\/[\w-]+\s*\|\s*\d{4}-\d{2}-\d{2}/.test(t)) {
      p.remove();
    }
  });

  // 6. If the first remaining element is a lone <hr>, drop it (header leftover)
  while (clone.firstElementChild && clone.firstElementChild.tagName === 'HR') {
    clone.firstElementChild.remove();
  }

  const bodyText = clone.textContent.replace(/\s+/g, ' ').trim();

  // 7. Prepend the clean title (from state) so TTS always starts with the headline
  const titleText = (_currentReaderItem && _currentReaderItem.title) || '';
  if (titleText && bodyText) {
    // Use 。 separator so the TTS pauses between title and body
    return titleText + '。' + bodyText;
  }
  return titleText || bodyText;
}

function splitTTSChunks(text, maxChars) {
  // Split on sentence terminators (CJK + Latin), keep delimiter with preceding sentence
  const parts = text.split(/(?<=[。！？!?])\s*|(?<=[.?!])\s+/).filter(s => s && s.trim());
  const out = [];
  let cur = '';
  for (const p of parts) {
    if (cur.length + p.length > maxChars && cur.length > 0) {
      out.push(cur);
      cur = p;
    } else {
      cur += (cur ? ' ' : '') + p;
    }
  }
  if (cur) out.push(cur);
  // Hard-split any chunk still over the cap (very long sentence without punctuation)
  const final = [];
  for (const c of out) {
    if (c.length <= maxChars) {
      final.push(c);
    } else {
      for (let i = 0; i < c.length; i += maxChars) {
        final.push(c.slice(i, i + maxChars));
      }
    }
  }
  return final;
}

function updateTTSButtons(label, state) {
  // state: 'idle' | 'loading' | 'playing' | 'paused'
  document.querySelectorAll('.tts-btn').forEach(btn => {
    const labelEl = btn.querySelector('.tts-label');
    if (labelEl) labelEl.textContent = label;
    btn.classList.remove('tts-loading', 'tts-playing-state', 'tts-paused-state');
    if (state === 'loading')  btn.classList.add('tts-loading');
    if (state === 'playing')  btn.classList.add('tts-playing-state');
    if (state === 'paused')   btn.classList.add('tts-paused-state');
  });
}

async function toggleTTS() {
  if (!_tts) {
    return startTTS();
  }
  if (_tts.paused) {
    // Resume
    _tts.paused = false;
    if (_tts.audio) {
      _tts.audio.play();
      updateTTSButtons(`⏸ ${_tts.index + 1}/${_tts.chunks.length}`, 'playing');
    }
    return;
  }
  // Pause
  _tts.paused = true;
  if (_tts.audio) {
    _tts.audio.pause();
    updateTTSButtons(`▶ ${_tts.index + 1}/${_tts.chunks.length}`, 'paused');
  }
}

async function startTTS() {
  const text = extractReaderText();
  if (!text) return;
  const chunks = splitTTSChunks(text, TTS_CHUNK_MAX);
  if (chunks.length === 0) return;

  _tts = { chunks, index: 0, audio: null, playing: true, paused: false };
  updateTTSButtons('加载中…', 'loading');
  await playChunk();
}

async function playChunk() {
  if (!_tts || _tts.paused) return;
  const { chunks, index } = _tts;
  if (index >= chunks.length) {
    stopTTS();
    return;
  }

  updateTTSButtons(`加载 ${index + 1}/${chunks.length}`, 'loading');

  let sessionId = null;
  try {
    // Step 1: create session on backend (fast — just stores text+voice)
    const chunkText = chunks[index];
    const voice = voiceForChunk(chunkText);
    const prep = await fetch('/api/tts/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: chunkText, voice }),
    });
    if (!prep.ok) {
      const err = await prep.json().catch(() => ({ error: `HTTP ${prep.status}` }));
      throw new Error(err.error || `HTTP ${prep.status}`);
    }
    sessionId = (await prep.json()).id;
  } catch (e) {
    console.error('[tts] prepare failed:', e);
    updateTTSButtons('失败', 'idle');
    setTimeout(() => { if (!_tts || !_tts.playing) updateTTSButtons('朗读', 'idle'); }, 2000);
    stopTTS();
    return;
  }

  // Session may have been cancelled while preparing
  if (!_tts || !_tts.playing) return;

  // Step 2: native <audio> element streams MP3 progressively from the GET URL.
  // Browser begins playback as soon as enough frames buffer (~1.5-2s for CosyVoice).
  const audio = new Audio(`/api/tts/play?id=${encodeURIComponent(sessionId)}`);
  _tts.audio = audio;

  audio.onplaying = () => {
    if (_tts && _tts.playing) updateTTSButtons(`⏸ ${index + 1}/${chunks.length}`, 'playing');
  };
  audio.onended = () => {
    if (!_tts || !_tts.playing) return;
    _tts.index += 1;
    _tts.audio = null;
    playChunk();
  };
  audio.onerror = () => {
    console.error('[tts] audio element error', audio.error);
    updateTTSButtons('失败', 'idle');
    setTimeout(() => { if (!_tts || !_tts.playing) updateTTSButtons('朗读', 'idle'); }, 2000);
    stopTTS();
  };

  try {
    await audio.play();
  } catch (e) {
    console.error('[tts] play() rejected:', e);
    stopTTS();
  }
}

function stopTTS() {
  if (_tts) {
    if (_tts.audio) {
      _tts.audio.pause();
      _tts.audio.src = '';  // abort streaming fetch
      _tts.audio = null;
    }
    _tts.playing = false;
    _tts = null;
  }
  updateTTSButtons('朗读', 'idle');
}

/* Voice picker — two sections, anchored next to gear button */
function toggleTTSVoicePicker(ev) {
  if (ev) { ev.stopPropagation(); ev.preventDefault(); }
  let menu = document.getElementById('ttsVoiceMenu');
  if (menu) {
    menu.remove();
    document.removeEventListener('click', closeTTSVoicePickerOnOutside, true);
    return;
  }
  const activeZh = getTTSVoiceZh();
  const activeEn = getTTSVoiceEn();
  const renderItem = (v, active, lang) => `
    <div class="tts-voice-item ${v.id === active ? 'tts-voice-active' : ''}" data-voice="${v.id}" data-lang="${lang}">
      <div class="tts-voice-label">${v.label}</div>
      <div class="tts-voice-desc">${v.desc}</div>
    </div>
  `;

  menu = document.createElement('div');
  menu.id = 'ttsVoiceMenu';
  menu.className = 'tts-voice-menu';
  menu.innerHTML = `
    <div class="tts-voice-head">中文朗读声音</div>
    ${TTS_VOICES_ZH.map(v => renderItem(v, activeZh, 'zh')).join('')}
    <div class="tts-voice-head" style="margin-top:6px">English 声音</div>
    ${TTS_VOICES_EN.map(v => renderItem(v, activeEn, 'en')).join('')}
    <div class="tts-voice-foot">根据正文语言自动切换。重新点"朗读"生效</div>
  `;
  const gear = document.querySelector('.tts-voice-gear');
  if (gear) {
    const rect = gear.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.left = Math.max(8, rect.right - 300) + 'px';
  }
  document.body.appendChild(menu);
  menu.querySelectorAll('.tts-voice-item').forEach(item => {
    item.onclick = () => {
      const voice = item.dataset.voice;
      const lang = item.dataset.lang;
      if (lang === 'zh') setTTSVoiceZh(voice);
      else setTTSVoiceEn(voice);
      if (_tts) stopTTS();
      menu.remove();
      document.removeEventListener('click', closeTTSVoicePickerOnOutside, true);
    };
  });
  setTimeout(() => document.addEventListener('click', closeTTSVoicePickerOnOutside, true), 0);
}

function closeTTSVoicePickerOnOutside(e) {
  const menu = document.getElementById('ttsVoiceMenu');
  if (!menu) return;
  if (menu.contains(e.target)) return;
  if (e.target.closest('.tts-voice-gear')) return;
  menu.remove();
  document.removeEventListener('click', closeTTSVoicePickerOnOutside, true);
}

/* ═══ Copy / Download ═══ */
function copyArticle() {
  const body = document.getElementById('readerBody');
  const title = document.getElementById('readerTitle').textContent;
  const text = title + '\n\n' + body.innerText;
  navigator.clipboard.writeText(text).then(() => {
    showToast('已复制到剪贴板');
  }).catch(() => {
    // Fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('已复制到剪贴板');
  });
}

function downloadPDF() {
  const title = document.getElementById('readerTitle').textContent;
  const meta = document.getElementById('readerMeta').textContent;
  const body = document.getElementById('readerBody');

  // Build a clean container for PDF rendering
  const container = document.createElement('div');
  container.style.cssText = 'font-family:sans-serif;color:#222;line-height:1.8;padding:20px';
  container.innerHTML = `
    <h1 style="font-size:22px;margin-bottom:8px">${esc(title)}</h1>
    <p style="font-size:11px;color:#999;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid #eee">${esc(meta)}</p>
    ${body.innerHTML}
  `;

  const filename = sanitizeFilename(title) + '.pdf';
  html2pdf().set({
    margin: [15, 15, 15, 15],
    filename: filename,
    image: { type: 'jpeg', quality: 0.95 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
    pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
  }).from(container).save().then(() => {
    showToast('PDF 已下载');
  });
}

function downloadMarkdown() {
  if (!_currentReaderItem) return;
  const it = _currentReaderItem;

  if (_currentRawMarkdown) {
    triggerDownload(_currentRawMarkdown, sanitizeFilename(it.title) + '.md', 'text/markdown');
    showToast('Markdown 已下载');
    return;
  }

  // Fallback: fetch the file
  if (it.local_file) {
    const zhFile = it.local_file.replace(/\.md$/, '.zh.md');
    fetch(SRC + zhFile).then(r => r.ok ? r.text() : fetch(SRC + it.local_file).then(r2 => r2.text()))
      .then(raw => {
        triggerDownload(raw, sanitizeFilename(it.title) + '.md', 'text/markdown');
        showToast('Markdown 已下载');
      });
  }
}

function triggerDownload(content, filename, mime) {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function sanitizeFilename(name) {
  return (name || 'article').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_').slice(0, 80);
}

function showToast(msg) {
  let t = document.getElementById('copyToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'copyToast';
    t.className = 'copy-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2000);
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

function srcN(s) { return {reddit:'Reddit',x:'X',youtube:'YouTube',web:'Web',gdelt:'GDELT'}[s]||s }

function nums(m) {
  if (!m) return '';
  const p = [];
  if (m.score) p.push(fmt(m.score)+' pts');
  if (m.likes) p.push(fmt(m.likes)+' likes');
  if (m.comments) p.push(fmt(m.comments)+' cmt');
  if (m.retweets) p.push(fmt(m.retweets)+' RT');
  if (m.views) p.push(m.views+' views');
  if (m.mentions) p.push(fmt(m.mentions)+' mentions');
  if (m.goldstein) p.push('GS:'+m.goldstein);
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
  const rows = [['conflict', 'category', 'date', 'title', 'source', 'source_label', 'credibility', 'bias', 'url']];
  for (const [k, c] of Object.entries(D.conflicts)) {
    for (const [catKey, cat] of Object.entries(c.categories)) {
      for (const it of filterByTime(cat.items)) {
        const ci = credInfo(it);
        rows.push([
          c.name, cat.label || catKey, it.date || '',
          (it.title || '').replace(/"/g, '""'),
          it.source || '', it.source_label || '',
          ci.tier || 't3', ci.bias || '',
          it.url || ''
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
    // Within the same day, use effective weight (criticality + corroboration)
    items.sort((a, b) => effectiveWeight(b) - effectiveWeight(a));
    for (const item of items) {
      html += `
        <div class="tl-item crit-${item.criticality||'background'}" style="--d:${(i++)*20}ms" data-id="${item.id}" data-ckey="${item._conflict}">
          <span class="tl-conflict-tag ${item._intensity}">${item._conflictName}</span>
          <div class="tl-body">
            <div class="tl-title">${critBadge(item)}${esc(item.title)}</div>
            <div class="tl-meta">
              <span class="s-src ${item.source}">${srcN(item.source)}</span>
              <span>${esc(item.source_label)}${credBadge(item)}${corrobBadge(item)}</span>
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
          <span>${esc(item.source_label)}${credBadge(item)}${corrobBadge(item)}</span>
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
let _currentRawMarkdown = null;

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
