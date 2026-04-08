// ============================================================
// Intelligence Desk · Case Briefing System
//
// 设计语言:情报问答 (不是聊天)
//   - 每次问答 = 一个 CASE FILE
//   - REQUEST / TRACE / BRIEF 三段式
//   - 侧栏 ACTIVE WATCH 真实数据 + SUGGESTED QUERIES
//
// 核心功能保留:
//   - Token 流式 (text_delta)
//   - Tool calling 多轮
//   - 多轮对话历史
//   - DOMPurify XSS / hljs 高亮 / Markdown 完整渲染
//   - 智能 auto-scroll
// ============================================================

(() => {
  // ════════════ DOM ════════════
  const form     = document.getElementById('askForm');
  const input    = document.getElementById('askInput');
  const sendBtn  = document.getElementById('askSendBtn');
  const stopBtn  = document.getElementById('askStopBtn');
  const clearBtn = document.getElementById('watchNewBtn');
  const errEl    = document.getElementById('filebarError');
  const fpStatus = document.getElementById('fpStatus');

  const empty   = document.getElementById('caseEmpty');
  const caseList = document.getElementById('caseList');

  // Status strip + watch chips (两套同源)
  const dsConflicts = document.getElementById('dsConflicts');
  const dsSources   = document.getElementById('dsSources');
  const dsCritical  = document.getElementById('dsCritical');
  const dsRecent    = document.getElementById('dsRecent');
  const wcConflicts = document.getElementById('wcConflicts');
  const wcSources   = document.getElementById('wcSources');
  const wcCritical  = document.getElementById('wcCritical');
  const wcRecent    = document.getElementById('wcRecent');

  // Watch session
  const wsOpen    = document.getElementById('wsOpen');
  const wsContext = document.getElementById('wsContext');
  const wsTokens  = document.getElementById('wsTokens');
  const watchSuggestions = document.getElementById('watchSuggestions');

  // ════════════ State ════════════
  const state = {
    history: [],         // [{role, content}, ...] 发给后端
    cases: [],           // [{root, ...}, ...] UI 案件
    inflight: null,
    currentCase: null,
    atBottom: true,
    caseCounter: 0,      // 递增 CASE 编号
    totalTokens: 0,
  };

  // ════════════ ACTIVE WATCH 数据加载 ════════════
  loadActiveWatch();

  async function loadActiveWatch() {
    try {
      const res = await fetch('/data/latest.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderActiveWatch(data);
    } catch (e) {
      console.error('Failed to load latest.json:', e);
      watchSuggestions.innerHTML = '<div class="ws-loading">数据加载失败</div>';
    }
  }

  function renderActiveWatch(data) {
    const conflicts = data.conflicts || {};
    const conflictKeys = Object.keys(conflicts);

    // 1. 4 个数据指标
    const total = data.stats?.total_items || 0;
    let critical = 0;
    let recent24h = 0;
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24*60*60*1000);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);
    const todayStr = now.toISOString().slice(0, 10);

    // 收集所有 critical 事件
    const allCrit = [];
    for (const [cid, c] of Object.entries(conflicts)) {
      for (const [catid, cat] of Object.entries(c.categories || {})) {
        for (const item of (cat.items || [])) {
          if (item.criticality === 'critical') {
            critical++;
            allCrit.push({
              ...item,
              conflict_id: cid,
              conflict_name: c.name,
              category: catid,
              category_label: cat.label,
            });
          }
          // 24h 内的事件
          if (item.date && (item.date === todayStr || item.date === yesterdayStr)) {
            recent24h++;
          }
        }
      }
    }

    // 写入 status strip 和 watch chips (两边同步)
    const setNum = (els, val) => els.forEach(el => el.textContent = val);
    setNum([dsConflicts, wcConflicts], conflictKeys.length);
    setNum([dsSources, wcSources], total.toLocaleString('en-US'));
    setNum([dsCritical, wcCritical], critical);
    setNum([dsRecent, wcRecent], recent24h);

    // 2. SUGGESTED QUERIES — 取最新 5 条 critical 事件
    allCrit.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const top = allCrit.slice(0, 6);
    if (top.length === 0) {
      watchSuggestions.innerHTML = '<div class="ws-loading">暂无 critical 事件</div>';
      return;
    }
    watchSuggestions.innerHTML = '';
    top.forEach(item => {
      const div = document.createElement('div');
      div.className = 'ws-item';
      const title = item.title || item.title_en || '(无标题)';
      const safeTitle = escapeHtml(title);
      const conflictName = escapeHtml(item.conflict_name || item.conflict_id);
      const catLabel = escapeHtml(item.category_label || item.category);
      const date = escapeHtml(item.date || '');
      const sourceLabel = escapeHtml(item.source_label || item.source || '');
      div.innerHTML = `
        <div class="ws-item-title">${safeTitle}</div>
        <div class="ws-item-meta">
          <span class="ws-conflict">${conflictName}</span>
          <span class="ws-sep">·</span>${catLabel}
          <span class="ws-sep">·</span>${date}
          <span class="ws-sep">·</span>${sourceLabel}
        </div>
      `;
      div.addEventListener('click', () => {
        const q = `详细说明"${title}"的来龙去脉、各方反应和最新进展。`;
        input.value = q;
        autoResize();
        input.focus();
        input.scrollIntoView({ behavior: 'smooth', block: 'end' });
      });
      watchSuggestions.appendChild(div);
    });
  }

  // ════════════ Markdown / sanitize / highlight ════════════
  function renderMarkdown(md) {
    if (!md) return '';
    const html = window.marked ? marked.parse(md) : escapeHtml(md);
    return window.DOMPurify
      ? DOMPurify.sanitize(html, { ADD_ATTR: ['target'] })
      : html;
  }

  function highlightAll(rootEl) {
    if (!window.hljs) return;
    rootEl.querySelectorAll('pre code').forEach(block => {
      try { hljs.highlightElement(block); } catch {}
    });
    rootEl.querySelectorAll('pre').forEach(pre => {
      if (pre.querySelector('.copy-code')) return;
      const btn = document.createElement('button');
      btn.className = 'copy-code';
      btn.type = 'button';
      btn.textContent = 'COPY';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const code = pre.querySelector('code')?.innerText || pre.innerText;
        const ok = await copyToClipboard(code);
        btn.textContent = ok ? 'COPIED' : 'FAILED';
        if (ok) btn.classList.add('is-done');
        setTimeout(() => {
          btn.textContent = 'COPY';
          btn.classList.remove('is-done');
        }, 1500);
      });
      pre.appendChild(btn);
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  async function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {}
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }

  // ════════════ Smart auto-scroll ════════════
  window.addEventListener('scroll', () => {
    const distFromBottom = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
    state.atBottom = distFromBottom < 200;
  });
  function scrollToBottom(force = false) {
    if (!force && !state.atBottom) return;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  }

  // ════════════ Textarea ════════════
  function autoResize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }
  input.addEventListener('input', autoResize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // ════════════ Clear (NEW DOSSIER) ════════════
  clearBtn.addEventListener('click', () => {
    if (state.inflight) state.inflight.abort();
    state.history = [];
    state.cases = [];
    state.currentCase = null;
    state.inflight = null;
    state.caseCounter = 0;
    state.totalTokens = 0;
    caseList.innerHTML = '';
    empty.style.display = '';
    errEl.style.display = 'none';
    updateSession();
    clearBtn.disabled = true;
    fpStatus.textContent = '系统待命 · 接受查询';
    input.focus();
    state.atBottom = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Stop
  stopBtn.addEventListener('click', () => {
    if (state.inflight) state.inflight.abort();
  });

  // Submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q || state.inflight) return;
    await runQuery(q);
  });

  // ════════════ Run query (主循环) ════════════
  async function runQuery(question, { regenerate = false, removeAfter = null } = {}) {
    if (regenerate && removeAfter !== null) {
      state.cases.splice(removeAfter);
      state.history = state.history.slice(0, removeAfter * 2);
      while (caseList.children.length > removeAfter) {
        caseList.removeChild(caseList.lastChild);
      }
    }

    state.inflight = new AbortController();
    errEl.style.display = 'none';
    empty.style.display = 'none';

    state.caseCounter += 1;
    const caseObj = createCase(state.caseCounter, question);
    caseList.appendChild(caseObj.root);
    state.cases.push(caseObj);
    state.currentCase = caseObj;

    input.value = '';
    autoResize();
    sendBtn.style.display = 'none';
    stopBtn.style.display = '';
    clearBtn.disabled = true;
    fpStatus.textContent = `正在处理 CASE #${String(state.caseCounter).padStart(3, '0')} · 检索中`;
    state.atBottom = true;
    requestAnimationFrame(() => {
      caseObj.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    const t0 = performance.now();
    let answerMd = '';
    let usage = null;
    let stepsCount = 0;
    let ok = false;

    let pendingRender = false;
    function scheduleRender() {
      if (pendingRender) return;
      pendingRender = true;
      requestAnimationFrame(() => {
        pendingRender = false;
        caseObj.briefBody.innerHTML = renderMarkdown(answerMd);
        highlightAll(caseObj.briefBody);
        scrollToBottom();
      });
    }

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history: state.history }),
        signal: state.inflight.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
      }

      caseObj.briefBody.classList.add('is-streaming');

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const got = handleFrame(frame, caseObj, {
            onTextDelta(t) {
              answerMd += t;
              scheduleRender();
            },
          });
          if (got && got.fullText) answerMd = got.fullText;
          if (got && got.usage) usage = got.usage;
          if (got && got.steps != null) stepsCount = got.steps;
        }
      }
      ok = true;
    } catch (err) {
      if (err.name === 'AbortError') {
        caseObj.briefBody.classList.remove('is-streaming');
        if (!answerMd) {
          caseObj.briefBody.innerHTML = '<p style="color: var(--ink-40); font-style: italic;">— CASE ABORTED · 操作员中断 —</p>';
        }
        caseObj.statusEl.textContent = 'ABORTED';
        caseObj.statusEl.classList.remove('is-active');
      } else {
        showError(err.message || String(err));
        caseObj.briefBody.classList.remove('is-streaming');
        caseObj.statusEl.textContent = 'ERROR';
        caseObj.statusEl.classList.remove('is-active');
      }
    } finally {
      caseObj.briefBody.classList.remove('is-streaming');
      sendBtn.style.display = '';
      stopBtn.style.display = 'none';
      clearBtn.disabled = state.cases.length === 0;
      state.inflight = null;
      state.currentCase = null;
      input.focus();

      if (ok && answerMd) {
        caseObj.briefBody.innerHTML = renderMarkdown(answerMd);
        highlightAll(caseObj.briefBody);

        state.history.push({ role: 'user', content: question });
        state.history.push({ role: 'assistant', content: answerMd });
        if (state.history.length > 20) state.history = state.history.slice(-20);

        if (usage) {
          state.totalTokens += usage.total_tokens || 0;
        }
        const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
        caseObj.answerMd = answerMd;
        caseObj.statusEl.textContent = 'CLOSED';
        caseObj.statusEl.classList.remove('is-active');

        // 处理 trace section 的最终态:实际工具调用数 vs loop 轮数
        finalizeTrace(caseObj);

        renderCaseFoot(caseObj, { elapsed, usage });
        updateSession();
        fpStatus.textContent = `就绪 · 上一查询 ${caseObj.toolsCount} 次检索 · ${elapsed}s · ${(usage?.total_tokens || 0).toLocaleString('en-US')} token`;
        scrollToBottom();
      } else if (!ok) {
        fpStatus.textContent = '系统待命 · 上一查询已中断';
      }
    }
  }

  function updateSession() {
    wsOpen.textContent = state.cases.length;
    const turns = Math.floor(state.history.length / 2);
    wsContext.textContent = `${turns} ROUND${turns === 1 ? '' : 'S'}`;
    if (turns > 0) wsContext.classList.add('is-active');
    else wsContext.classList.remove('is-active');
    wsTokens.textContent = state.totalTokens.toLocaleString('en-US');
  }

  // ════════════ Case File 工厂 ════════════
  function createCase(n, question) {
    const root = document.createElement('article');
    root.className = 'case-card';

    const numStr = `CASE #${String(n).padStart(3, '0')}`;
    const now = new Date();
    const filed = `FILED ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')} · ANALYST`;

    // Head
    const head = document.createElement('div');
    head.className = 'case-head';
    head.innerHTML = `
      <span class="case-num">${numStr}</span>
      <span class="case-meta">${filed}</span>
      <span class="case-status is-active">ACTIVE</span>
    `;
    const statusEl = head.querySelector('.case-status');

    // REQUEST section
    const reqSec = document.createElement('div');
    reqSec.className = 'case-section';
    reqSec.innerHTML = `<div class="cs-label">REQUEST</div>`;
    const reqBody = document.createElement('div');
    reqBody.className = 'cs-request';
    reqBody.textContent = '"' + question + '"';
    reqSec.appendChild(reqBody);

    // TRACE section (默认折叠)
    const traceSec = document.createElement('div');
    traceSec.className = 'case-section';
    const traceLabel = document.createElement('div');
    traceLabel.className = 'cs-label';
    traceLabel.innerHTML = `<span>TRACE</span><span class="cs-info" id="trace-info-${n}">检索中…</span>`;
    traceSec.appendChild(traceLabel);

    const details = document.createElement('details');
    details.className = 'cs-trace';
    const summary = document.createElement('summary');
    summary.textContent = '展开检索过程';
    const traceBody = document.createElement('div');
    traceBody.className = 'trace-body';
    details.appendChild(summary);
    details.appendChild(traceBody);
    traceSec.appendChild(details);

    // BRIEF section
    const briefSec = document.createElement('div');
    briefSec.className = 'case-section';
    briefSec.innerHTML = `<div class="cs-label">BRIEF</div>`;
    const briefWrap = document.createElement('div');
    briefWrap.className = 'cs-brief';
    const briefRule = document.createElement('div');
    briefRule.className = 'brief-rule';
    const briefBody = document.createElement('div');
    briefBody.className = 'brief-body';
    briefWrap.appendChild(briefRule);
    briefWrap.appendChild(briefBody);
    briefSec.appendChild(briefWrap);

    root.appendChild(head);
    root.appendChild(reqSec);
    root.appendChild(traceSec);
    root.appendChild(briefSec);

    return {
      root,
      n,
      question,
      head,
      statusEl,
      traceLabel,
      traceInfo: traceLabel.querySelector('.cs-info'),
      traceDetails: details,
      traceBody,
      briefBody,
      answerMd: '',
      toolsCount: 0,
      stepDurations: [],
    };
  }

  // ════════════ SSE 帧处理 ════════════
  function handleFrame(frame, caseObj, { onTextDelta }) {
    let event = 'message';
    let dataStr = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
    }
    if (!dataStr) return null;
    let data;
    try { data = JSON.parse(dataStr); } catch { return null; }

    switch (event) {
      case 'start':
        return null;

      case 'tool_call': {
        caseObj.toolsCount += 1;
        caseObj.stepDurations.push(data.model_ms || 0);
        appendTraceStep(caseObj, data);
        updateTraceInfo(caseObj);
        return null;
      }

      case 'tool_result':
        attachTraceResult(caseObj, data.step, data.summary);
        return null;

      case 'text_delta':
        onTextDelta(data.text || '');
        return null;

      case 'answer_done':
        return { fullText: data.full_text };

      case 'done':
        return { steps: data.steps, usage: data.usage };

      case 'error':
        showError(data.message || '未知错误');
        return null;
    }
    return null;
  }

  function appendTraceStep(caseObj, data) {
    const div = document.createElement('div');
    div.className = 'trace-step';
    div.dataset.step = data.step || '';
    const args = formatArgs(data.args);
    div.innerHTML = `
      <div>
        <span class="ts-num">OP ${String(data.step).padStart(2, '0')}</span>
        <span class="ts-tool">${escapeHtml(data.name)}()</span>
        <span class="ts-time">${data.model_ms}ms</span>
      </div>
      <div class="ts-args">${escapeHtml(args)}</div>
      <div class="ts-result"></div>
    `;
    caseObj.traceBody.appendChild(div);
    scrollToBottom();
  }

  function attachTraceResult(caseObj, step, summary) {
    const target = caseObj.traceBody.querySelector(`.trace-step[data-step="${step}"] .ts-result`);
    if (!target || !summary) return;
    if (summary.error) {
      target.parentElement.classList.add('is-error');
      target.textContent = '✗ ' + summary.error;
      return;
    }
    let html = '';
    if (summary.text) html += `<div>→ ${escapeHtml(summary.text)}</div>`;
    if (Array.isArray(summary.preview) && summary.preview.length) {
      html += '<ul>';
      for (const t of summary.preview) html += `<li>${escapeHtml(t || '')}</li>`;
      html += '</ul>';
    }
    target.innerHTML = html;
  }

  function updateTraceInfo(caseObj) {
    const totalMs = caseObj.stepDurations.reduce((a, b) => a + b, 0);
    const sec = (totalMs / 1000).toFixed(1);
    caseObj.traceInfo.textContent = `${caseObj.toolsCount} 次检索 · ${sec}s`;
  }

  // 答案完成后调用:根据 toolsCount 决定 trace section 的展示
  function finalizeTrace(caseObj) {
    if (caseObj.toolsCount === 0) {
      // 模型没调工具,直接基于上下文答复
      caseObj.traceInfo.textContent = '无检索 · 直接答复';
      caseObj.traceDetails.style.display = 'none';
    } else {
      updateTraceInfo(caseObj);
    }
  }

  // ════════════ Case foot (action bar) ════════════
  function renderCaseFoot(caseObj, { elapsed, usage }) {
    if (caseObj.footEl) caseObj.footEl.remove();
    const foot = document.createElement('div');
    foot.className = 'case-foot';

    // 信心等级:根据是否有检索 + token 数粗略评估
    const conf = document.createElement('span');
    conf.className = 'cf-conf';
    conf.textContent = caseObj.toolsCount > 0 ? 'A1 CONFIDENCE' : 'B2 CONFIDENCE';

    const meta = document.createElement('span');
    meta.className = 'cf-meta';
    const usageStr = usage
      ? ` · ${(usage.total_tokens || 0).toLocaleString('en-US')} token`
      : '';
    const tcStr = caseObj.toolsCount > 0
      ? `${caseObj.toolsCount} 次检索`
      : '无检索';
    meta.textContent = ` ${tcStr} · ${elapsed}s${usageStr}`;

    const spacer = document.createElement('span');
    spacer.className = 'cf-spacer';

    const followBtn = document.createElement('button');
    followBtn.type = 'button';
    followBtn.textContent = '⊕ 追问';
    followBtn.addEventListener('click', () => {
      input.value = '';
      autoResize();
      input.focus();
      input.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = '⎘ 复制简报';
    copyBtn.addEventListener('click', async () => {
      const ok = await copyToClipboard(caseObj.answerMd);
      copyBtn.textContent = ok ? '✓ 已复制' : '✗ 失败';
      if (ok) copyBtn.classList.add('is-done');
      setTimeout(() => {
        copyBtn.textContent = '⎘ 复制简报';
        copyBtn.classList.remove('is-done');
      }, 1500);
    });

    const regenBtn = document.createElement('button');
    regenBtn.type = 'button';
    regenBtn.textContent = '↻ 重新检索';
    regenBtn.addEventListener('click', () => {
      if (state.inflight) return;
      const idx = state.cases.indexOf(caseObj);
      if (idx < 0) return;
      runQuery(caseObj.question, { regenerate: true, removeAfter: idx });
    });

    foot.appendChild(conf);
    foot.appendChild(meta);
    foot.appendChild(spacer);
    foot.appendChild(followBtn);
    foot.appendChild(copyBtn);
    foot.appendChild(regenBtn);

    caseObj.root.appendChild(foot);
    caseObj.footEl = foot;
  }

  function showError(msg) {
    errEl.style.display = '';
    errEl.textContent = '✗ ' + msg;
  }

  function formatArgs(args) {
    if (!args || typeof args !== 'object') return '';
    const keys = Object.keys(args);
    if (keys.length === 0) return '(无参数)';
    return keys.map(k => `${k}=${JSON.stringify(args[k])}`).join('  ');
  }

  // ════════════ 全局快捷键 ════════════
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      input.focus();
      input.select();
    }
    if (e.key === 'Escape' && state.inflight) {
      state.inflight.abort();
    }
  });
})();
