// ============================================================
// Ask page · Agentic Retrieval client (multi-turn conversation)
// SSE over fetch (POST 不支持原生 EventSource,手动解析帧)
// ============================================================

(() => {
  const form     = document.getElementById('askForm');
  const input    = document.getElementById('askInput');
  const btn      = document.getElementById('askBtn');
  const clearBtn = document.getElementById('askClearBtn');
  const convo    = document.getElementById('askConversation');
  const errEl    = document.getElementById('askError');
  const ctxBadge = document.getElementById('askContextBadge');
  const ctxTurns = document.getElementById('askCtxTurns');

  // ========== 对话状态 ==========
  // history: 发给后端的消息数组,后端会把它 splice 到 OpenRouter 请求里
  // 格式: [{role: 'user'|'assistant', content: string}, ...]
  // 每完成一轮 (user→assistant) 才入库,不要在 inflight 时入。
  const state = {
    history: [],
    inflight: null,
    currentTurn: null,  // 当前正在生成的 turn DOM 节点
  };

  // 示例点击
  document.querySelectorAll('.ask-ex').forEach(el => {
    el.addEventListener('click', () => {
      input.value = el.dataset.q || el.textContent;
      input.focus();
      form.requestSubmit();
    });
  });

  // 清空对话
  clearBtn.addEventListener('click', () => {
    if (state.inflight) state.inflight.abort();
    state.history = [];
    state.inflight = null;
    state.currentTurn = null;
    convo.innerHTML = '';
    errEl.style.display = 'none';
    ctxBadge.style.display = 'none';
    clearBtn.disabled = true;
    input.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;

    // 中断上一个
    if (state.inflight) state.inflight.abort();
    state.inflight = new AbortController();

    errEl.style.display = 'none';
    errEl.textContent = '';

    // 创建一个新的 turn 节点(question + steps + loading + answer 占位)
    const turn = createTurn(q);
    convo.appendChild(turn.root);
    state.currentTurn = turn;

    // 清空输入并禁用按钮
    input.value = '';
    btn.disabled = true;
    btn.textContent = '...';
    clearBtn.disabled = true;

    // 自动滚到这个 turn 的顶部
    requestAnimationFrame(() => {
      turn.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    const t0 = performance.now();
    let answerText = '';   // 存原始 markdown,完成后入 history
    let ok = false;

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: q,
          history: state.history,  // ← 关键:把历史发回去
        }),
        signal: state.inflight.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
      }

      const reader  = res.body.getReader();
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
          const got = handleFrame(frame, turn, t0);
          if (got && got.answer) answerText = got.answer;
        }
      }
      ok = true;
    } catch (err) {
      if (err.name === 'AbortError') return;
      showError(err.message || String(err));
      turn.loadingEl.style.display = 'none';
      turn.root.classList.remove('is-pending');
    } finally {
      turn.loadingEl.style.display = 'none';
      turn.root.classList.remove('is-pending');
      btn.disabled = false;
      btn.textContent = '问';
      clearBtn.disabled = false;
      state.inflight = null;
      state.currentTurn = null;
      input.focus();

      // 成功完成才入历史(避免半截对话污染上下文)
      if (ok && answerText) {
        state.history.push({ role: 'user', content: q });
        state.history.push({ role: 'assistant', content: answerText });
        // 后端只取 history[-10],前端也截一下避免请求体过大
        if (state.history.length > 20) state.history = state.history.slice(-20);
        updateContextBadge();
      }
    }
  });

  function updateContextBadge() {
    const turns = Math.floor(state.history.length / 2);
    if (turns > 0) {
      ctxBadge.style.display = '';
      ctxTurns.textContent = String(turns);
    } else {
      ctxBadge.style.display = 'none';
    }
  }

  // ========== 单个 turn 节点工厂 ==========
  function createTurn(question) {
    const root = document.createElement('div');
    root.className = 'ask-turn is-pending';

    const qEl = document.createElement('div');
    qEl.className = 'ask-question';
    qEl.appendChild(document.createTextNode(question));

    const stepsEl = document.createElement('div');
    stepsEl.className = 'ask-steps';

    const loadingEl = document.createElement('div');
    loadingEl.className = 'ask-loading';
    loadingEl.textContent = '思考中';

    const answerEl = document.createElement('article');
    answerEl.className = 'ask-answer';
    answerEl.style.display = 'none';
    const answerLabel = document.createElement('div');
    answerLabel.className = 'ask-answer-label';
    answerLabel.textContent = 'ANSWER';
    const answerBody = document.createElement('div');
    const meta = document.createElement('div');
    meta.className = 'ask-meta';
    const metaSteps = document.createElement('span');
    const metaTime  = document.createElement('span');
    meta.appendChild(metaSteps);
    meta.appendChild(metaTime);
    answerEl.appendChild(answerLabel);
    answerEl.appendChild(answerBody);
    answerEl.appendChild(meta);

    root.appendChild(qEl);
    root.appendChild(stepsEl);
    root.appendChild(loadingEl);
    root.appendChild(answerEl);

    return { root, stepsEl, loadingEl, answerEl, answerBody, metaSteps, metaTime };
  }

  // ========== SSE 帧处理 ==========
  function handleFrame(frame, turn, t0) {
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
        appendStep(turn.stepsEl, { kind: 'start', text: `开始 · 模型 ${data.model}` });
        return null;

      case 'tool_call': {
        const argStr = formatArgs(data.args);
        appendStep(turn.stepsEl, {
          kind: 'call',
          step: data.step,
          name: data.name,
          args: argStr,
          ms: data.model_ms,
        });
        return null;
      }

      case 'tool_result':
        attachResult(turn.stepsEl, data.step, data.summary);
        return null;

      case 'answer': {
        turn.loadingEl.style.display = 'none';
        turn.answerEl.style.display = '';
        const md = data.text || '';
        turn.answerBody.innerHTML = window.marked ? marked.parse(md) : escapeHtml(md);
        const total = ((performance.now() - t0) / 1000).toFixed(2);
        turn.metaTime.textContent = `${total}s`;
        // 答案出来后温柔滚到答案
        requestAnimationFrame(() => {
          turn.answerEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
        });
        return { answer: md };
      }

      case 'done':
        if (typeof data.steps === 'number' && data.steps > 0) {
          turn.metaSteps.textContent = `${data.steps} STEPS`;
        }
        return null;

      case 'error':
        showError(data.message || '未知错误');
        turn.root.classList.add('is-error');
        return null;
    }
    return null;
  }

  function appendStep(stepsEl, { kind, step, name, args, ms, text }) {
    const div = document.createElement('div');
    div.className = 'ask-step';
    div.dataset.step = step || '';
    if (kind === 'start') {
      div.innerHTML = `<div class="step-head">▸ INIT</div><div class="step-name">${escapeHtml(text)}</div>`;
    } else {
      div.innerHTML = `
        <div class="step-head">▸ STEP ${step} · ${ms}ms</div>
        <div class="step-name">${escapeHtml(name)}</div>
        <div class="step-args">${escapeHtml(args)}</div>
        <div class="step-result"></div>
      `;
    }
    stepsEl.appendChild(div);
  }

  function attachResult(stepsEl, step, summary) {
    const target = stepsEl.querySelector(`.ask-step[data-step="${step}"] .step-result`);
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

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  // 快捷键: Ctrl/Cmd + K 聚焦输入框, Esc 取消生成
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      input.focus();
      input.select();
    }
    if (e.key === 'Escape' && state.inflight) {
      state.inflight.abort();
      state.inflight = null;
    }
  });
})();
