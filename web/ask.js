// ============================================================
// Ask page · Agentic Retrieval client
// SSE over fetch (POST 不支持原生 EventSource,手动解析帧)
// ============================================================

(() => {
  const form    = document.getElementById('askForm');
  const input   = document.getElementById('askInput');
  const btn     = document.getElementById('askBtn');
  const stepsEl = document.getElementById('askSteps');
  const loadEl  = document.getElementById('askLoading');
  const ansEl   = document.getElementById('askAnswer');
  const ansBody = document.getElementById('askAnswerBody');
  const metaSt  = document.getElementById('askMetaSteps');
  const metaTm  = document.getElementById('askMetaTime');
  const errEl   = document.getElementById('askError');

  // 示例点击
  document.querySelectorAll('.ask-ex').forEach(el => {
    el.addEventListener('click', () => {
      input.value = el.dataset.q || el.textContent;
      input.focus();
      form.requestSubmit();
    });
  });

  let inflight = null;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;

    // 中断上一个
    if (inflight) inflight.abort();
    inflight = new AbortController();

    // 重置 UI
    errEl.style.display = 'none';
    errEl.textContent = '';
    stepsEl.innerHTML = '';
    stepsEl.style.display = '';
    ansEl.style.display = 'none';
    ansBody.innerHTML = '';
    metaSt.textContent = '';
    metaTm.textContent = '';
    loadEl.style.display = '';
    btn.disabled = true;
    btn.textContent = '...';

    const t0 = performance.now();

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
        signal: inflight.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
      }

      // 解析 SSE 流
      const reader  = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // 逐帧切分:`event: xxx\ndata: {...}\n\n`
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          handleFrame(frame, t0);
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      showError(err.message || String(err));
    } finally {
      loadEl.style.display = 'none';
      btn.disabled = false;
      btn.textContent = '问';
      inflight = null;
    }
  });

  function handleFrame(frame, t0) {
    let event = 'message';
    let dataStr = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
    }
    if (!dataStr) return;
    let data;
    try { data = JSON.parse(dataStr); } catch { return; }

    switch (event) {
      case 'start':
        appendStep({ kind: 'start', text: `开始 · 模型 ${data.model}` });
        break;

      case 'tool_call': {
        const argStr = formatArgs(data.args);
        appendStep({
          kind: 'call',
          step: data.step,
          name: data.name,
          args: argStr,
          ms: data.model_ms,
        });
        break;
      }

      case 'tool_result':
        attachResult(data.step, data.summary);
        break;

      case 'answer': {
        loadEl.style.display = 'none';
        ansEl.style.display = '';
        const md = data.text || '';
        ansBody.innerHTML = window.marked ? marked.parse(md) : escapeHtml(md);
        const total = ((performance.now() - t0) / 1000).toFixed(2);
        metaTm.textContent = `${total}s`;
        break;
      }

      case 'done':
        if (typeof data.steps === 'number' && data.steps > 0) {
          metaSt.textContent = `${data.steps} STEPS`;
        }
        break;

      case 'error':
        showError(data.message || '未知错误');
        break;
    }
  }

  function appendStep({ kind, step, name, args, ms, text }) {
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

  function attachResult(step, summary) {
    const target = stepsEl.querySelector(`.ask-step[data-step="${step}"] .step-result`);
    if (!target) return;
    if (!summary) return;
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
    loadEl.style.display = 'none';
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
})();
