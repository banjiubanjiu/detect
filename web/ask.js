// ============================================================
// Ask page · Agentic Retrieval client (B 档专业化)
//
// 5 大升级:
//   1. Token-by-token 流式输出 (text_delta 增量渲染)
//   2. 底部 sticky dock + textarea 自动展开
//   3. 代码块语法高亮 (highlight.js) + 复制按钮
//   4. 折叠 tool steps (默认折叠,只显示 Used N tools)
//   5. Action bar: Copy / Regenerate / 元信息
//
// 还做了:DOMPurify XSS 防护、智能 auto-scroll、Markdown 完整渲染。
// ============================================================

(() => {
  // ========== DOM ==========
  const form     = document.getElementById('askForm');
  const input    = document.getElementById('askInput');
  const sendBtn  = document.getElementById('askSendBtn');
  const stopBtn  = document.getElementById('askStopBtn');
  const clearBtn = document.getElementById('askClearBtn');
  const stream   = document.getElementById('askStream');
  const empty    = document.getElementById('askEmpty');
  const turnsEl  = document.getElementById('askTurns');
  const errEl    = document.getElementById('askError');
  const ctxBadge = document.getElementById('askCtxBadge');
  const ctxTurns = document.getElementById('askCtxTurns');

  // ========== 状态 ==========
  // history: 对话历史 [{role, content}, ...] (发给后端)
  // turns:   UI 上的 turn 元数据 [{question, answer, root, ...}]
  // inflight: 当前 AbortController
  // currentTurn: 正在生成的 turn 引用
  // atBottom: 用户是否在底部 (智能 auto-scroll)
  const state = {
    history: [],
    turns: [],
    inflight: null,
    currentTurn: null,
    atBottom: true,
  };

  // ========== 工具:Markdown 渲染 (sanitize + highlight) ==========
  function renderMarkdown(md) {
    if (!md) return '';
    const html = window.marked ? marked.parse(md) : escapeHtml(md);
    // DOMPurify 净化 (允许常用 markdown 标签)
    return window.DOMPurify
      ? DOMPurify.sanitize(html, {
          ADD_ATTR: ['target'],  // 链接 target=_blank 允许
        })
      : html;
  }

  function highlightAll(rootEl) {
    if (!window.hljs) return;
    rootEl.querySelectorAll('pre code').forEach(block => {
      // 没设置 language- 类的就 auto detect
      try { hljs.highlightElement(block); } catch {}
    });
    // 给每个 pre 加复制按钮
    rootEl.querySelectorAll('pre').forEach(pre => {
      if (pre.querySelector('.copy-code')) return;
      const btn = document.createElement('button');
      btn.className = 'copy-code';
      btn.type = 'button';
      btn.textContent = 'Copy';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const code = pre.querySelector('code')?.innerText || pre.innerText;
        const ok = await copyToClipboard(code);
        btn.textContent = ok ? 'Copied' : 'Failed';
        if (ok) btn.classList.add('is-done');
        setTimeout(() => {
          btn.textContent = 'Copy';
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

  // 复制文本到剪贴板,带 fallback (clipboard API 在某些上下文受限)
  async function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {}
    }
    // Fallback: textarea + execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  // ========== 智能 auto-scroll ==========
  // 用户向上滚 → 暂停 auto-scroll;用户滚回底部 → 恢复
  stream.addEventListener('scroll', () => {
    const distFromBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
    state.atBottom = distFromBottom < 80;
  });
  function scrollToBottom(force = false) {
    if (!force && !state.atBottom) return;
    stream.scrollTop = stream.scrollHeight;
  }

  // ========== textarea 自动展开 ==========
  function autoResize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }
  input.addEventListener('input', autoResize);

  // Enter 发送 / Shift+Enter 换行
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // ========== 推荐卡片点击 ==========
  document.querySelectorAll('.ae-card').forEach(el => {
    el.addEventListener('click', () => {
      input.value = el.dataset.q || el.textContent.trim();
      autoResize();
      input.focus();
      form.requestSubmit();
    });
  });

  // ========== 清空对话 ==========
  clearBtn.addEventListener('click', () => {
    if (state.inflight) state.inflight.abort();
    state.history = [];
    state.turns = [];
    state.currentTurn = null;
    state.inflight = null;
    turnsEl.innerHTML = '';
    empty.style.display = '';
    errEl.style.display = 'none';
    updateContextBadge();
    clearBtn.disabled = true;
    input.focus();
    state.atBottom = true;
  });

  // ========== Stop 按钮 ==========
  stopBtn.addEventListener('click', () => {
    if (state.inflight) state.inflight.abort();
  });

  // ========== Submit ==========
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q || state.inflight) return;
    await runQuery(q);
  });

  async function runQuery(question, { regenerate = false, removeAfter = null } = {}) {
    // regenerate: 重发上一个 user 消息,先把上一对从 history/UI 删掉
    if (regenerate && removeAfter !== null) {
      // 删除 removeAfter 之后的所有 turns 和 history
      state.turns.splice(removeAfter);
      // history 是 user/assistant 成对的,user index = removeAfter*2
      state.history = state.history.slice(0, removeAfter * 2);
      // DOM:删除 removeAfter 之后所有 turn 节点
      while (turnsEl.children.length > removeAfter) {
        turnsEl.removeChild(turnsEl.lastChild);
      }
    }

    state.inflight = new AbortController();
    errEl.style.display = 'none';

    // 隐藏空状态
    empty.style.display = 'none';

    // 创建新 turn
    const turn = createTurn(question);
    turnsEl.appendChild(turn.root);
    state.turns.push(turn);
    state.currentTurn = turn;

    // 锁住 UI
    input.value = '';
    autoResize();
    sendBtn.style.display = 'none';
    stopBtn.style.display = '';
    clearBtn.disabled = true;
    state.atBottom = true;
    scrollToBottom(true);

    const t0 = performance.now();
    let answerMd = '';
    let usage = null;
    let stepsCount = 0;
    let ok = false;

    // RAF 节流的 markdown 重渲染
    let pendingRender = false;
    function scheduleRender() {
      if (pendingRender) return;
      pendingRender = true;
      requestAnimationFrame(() => {
        pendingRender = false;
        turn.assistantEl.innerHTML = renderMarkdown(answerMd);
        highlightAll(turn.assistantEl);
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

      // 让 assistant 区进入流式状态 (光标动画)
      turn.assistantEl.classList.add('is-streaming');
      turn.assistantEl.style.display = '';

      // 解析 SSE
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
          const got = handleFrame(frame, turn, {
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
        // 中断:展示部分内容,不入历史
        turn.assistantEl.classList.remove('is-streaming');
        if (!answerMd) {
          turn.assistantEl.innerHTML = '<p style="color: var(--ink-40); font-style: italic;">(已停止)</p>';
        }
      } else {
        showError(err.message || String(err));
        turn.assistantEl.classList.remove('is-streaming');
      }
    } finally {
      turn.assistantEl.classList.remove('is-streaming');
      sendBtn.style.display = '';
      stopBtn.style.display = 'none';
      clearBtn.disabled = state.turns.length === 0;
      state.inflight = null;
      state.currentTurn = null;
      input.focus();

      // 完成才入历史 + 显示 action bar
      if (ok && answerMd) {
        // 最后再渲一次保证完整
        turn.assistantEl.innerHTML = renderMarkdown(answerMd);
        highlightAll(turn.assistantEl);

        state.history.push({ role: 'user', content: question });
        state.history.push({ role: 'assistant', content: answerMd });
        if (state.history.length > 20) state.history = state.history.slice(-20);
        updateContextBadge();

        // 渲染 action bar
        turn.answerMd = answerMd;
        const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
        renderActions(turn, { elapsed, steps: stepsCount, usage });
        scrollToBottom();
      }
    }
  }

  function updateContextBadge() {
    const turns = Math.floor(state.history.length / 2);
    if (turns > 0) {
      ctxBadge.classList.remove('is-hidden');
      ctxTurns.textContent = String(turns);
    } else {
      ctxBadge.classList.add('is-hidden');
    }
  }

  // ========== Turn 节点工厂 ==========
  function createTurn(question) {
    const root = document.createElement('div');
    root.className = 'ask-turn';

    // 用户消息 (右对齐窄卡片)
    const userWrap = document.createElement('div');
    userWrap.className = 'ask-user';
    const bubble = document.createElement('div');
    bubble.className = 'au-bubble';
    bubble.textContent = question;
    userWrap.appendChild(bubble);

    // 折叠 tools 区
    const toolsDetails = document.createElement('details');
    toolsDetails.className = 'ask-tools';
    const summary = document.createElement('summary');
    summary.innerHTML = '<span class="summary-text">思考中…</span>';
    const toolsBody = document.createElement('div');
    toolsBody.className = 'ask-tools-body';
    toolsDetails.appendChild(summary);
    toolsDetails.appendChild(toolsBody);

    // 助手答案
    const assistantEl = document.createElement('div');
    assistantEl.className = 'ask-assistant';

    root.appendChild(userWrap);
    root.appendChild(toolsDetails);
    root.appendChild(assistantEl);

    return {
      root,
      bubble,
      toolsDetails,
      toolsSummary: summary,
      toolsBody,
      assistantEl,
      question,
      answerMd: '',
      toolsCount: 0,
      stepDurations: [],
    };
  }

  // ========== SSE 帧处理 ==========
  function handleFrame(frame, turn, { onTextDelta }) {
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
        turn.toolsCount += 1;
        turn.stepDurations.push(data.model_ms || 0);
        appendToolStep(turn, data);
        updateToolsSummary(turn);
        return null;
      }

      case 'tool_result':
        attachToolResult(turn, data.step, data.summary);
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

  function appendToolStep(turn, data) {
    const div = document.createElement('div');
    div.className = 'ask-step';
    div.dataset.step = data.step || '';
    const args = formatArgs(data.args);
    div.innerHTML = `
      <div class="step-head">▸ STEP ${data.step} · ${data.model_ms}ms</div>
      <div class="step-name">${escapeHtml(data.name)}</div>
      <div class="step-args">${escapeHtml(args)}</div>
      <div class="step-result"></div>
    `;
    turn.toolsBody.appendChild(div);
    scrollToBottom();
  }

  function attachToolResult(turn, step, summary) {
    const target = turn.toolsBody.querySelector(`.ask-step[data-step="${step}"] .step-result`);
    if (!target || !summary) return;
    if (summary.error) {
      target.parentElement.classList.add('is-error');
      target.textContent = '✗ ' + summary.error;
      return;
    }
    let html = '';
    if (summary.text) html += `<div>${escapeHtml(summary.text)}</div>`;
    if (Array.isArray(summary.preview) && summary.preview.length) {
      html += '<ul>';
      for (const t of summary.preview) html += `<li>${escapeHtml(t || '')}</li>`;
      html += '</ul>';
    }
    target.innerHTML = html;
  }

  function updateToolsSummary(turn) {
    const totalMs = turn.stepDurations.reduce((a, b) => a + b, 0);
    const sec = (totalMs / 1000).toFixed(1);
    turn.toolsSummary.querySelector('.summary-text').textContent =
      `Used ${turn.toolsCount} tool${turn.toolsCount > 1 ? 's' : ''} · ${sec}s · click 展开`;
  }

  // ========== Action bar (Copy / Regenerate) ==========
  function renderActions(turn, { elapsed, steps, usage }) {
    if (turn.actionsEl) turn.actionsEl.remove();
    const bar = document.createElement('div');
    bar.className = 'ask-actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      const ok = await copyToClipboard(turn.answerMd);
      copyBtn.textContent = ok ? 'Copied' : 'Failed';
      if (ok) copyBtn.classList.add('is-done');
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
        copyBtn.classList.remove('is-done');
      }, 1500);
    });

    const regenBtn = document.createElement('button');
    regenBtn.type = 'button';
    regenBtn.textContent = 'Regenerate';
    regenBtn.addEventListener('click', () => {
      if (state.inflight) return;
      const idx = state.turns.indexOf(turn);
      if (idx < 0) return;
      runQuery(turn.question, { regenerate: true, removeAfter: idx });
    });

    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    const meta = document.createElement('span');
    meta.className = 'meta';
    const usageStr = usage
      ? ` · ${usage.total_tokens || (usage.prompt_tokens + usage.completion_tokens)} tok`
      : '';
    meta.textContent = `${steps} STEPS · ${elapsed}S${usageStr}`;

    bar.appendChild(copyBtn);
    bar.appendChild(regenBtn);
    bar.appendChild(spacer);
    bar.appendChild(meta);

    turn.root.appendChild(bar);
    turn.actionsEl = bar;
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

  // ========== 全局快捷键 ==========
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
