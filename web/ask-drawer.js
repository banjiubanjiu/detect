// ════════════════════════════════════════════════════════════════
// Ask Drawer · 全局情报问答抽屉
// 自包含模块:注入 CSS + HTML + 提供 window.openAskDrawer/closeAskDrawer
// 三页面集成:<script src="ask-drawer.js"></script> + 调 openAskDrawer()
// 全局快捷键:⌘K (Cmd/Ctrl+K) 召唤,Esc 关闭
// 永远 dark theme (因为 host 页通常是 dark dashboard)
// ════════════════════════════════════════════════════════════════

(function () {
  if (window.__askDrawerInjected) return;
  window.__askDrawerInjected = true;

  // ─── 内部 dark theme tokens (不依赖 host 页 CSS) ─────
  const DRAWER_CSS = `
    .askd-overlay {
      position: fixed; inset: 0;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(2px);
      opacity: 0; pointer-events: none;
      transition: opacity .25s ease-out;
      z-index: 9998;
    }
    .askd-overlay.is-open { opacity: 1; pointer-events: auto; }

    .askd {
      --d-bg:     #131311;
      --d-paper:  #1a1a18;
      --d-warm:   #222220;
      --d-ink:    #e8e4da;
      --d-ink-90: #d8d4ca;
      --d-ink-60: #a8a49a;
      --d-ink-40: #78746a;
      --d-ink-25: #58544a;
      --d-ink-15: #3a3630;
      --d-ink-08: #2a2620;
      --d-rule:   #3a3630;
      --d-red:    #e84838;
      --d-green:  #48b870;
      --d-blue:   #4890d8;
      --d-amber:  #d8a830;
      --d-serif:  'Playfair Display', Georgia, serif;
      --d-sans:   'Source Sans 3', system-ui, sans-serif;
      --d-mono:   'IBM Plex Mono', monospace;

      position: fixed;
      top: 0; right: 0; bottom: 0;
      width: 540px;
      max-width: 100vw;
      background: var(--d-bg);
      color: var(--d-ink);
      border-left: 1px solid var(--d-ink-15);
      box-shadow: -16px 0 48px rgba(0, 0, 0, 0.6);
      transform: translateX(100%);
      transition: transform .3s cubic-bezier(.16, 1, .3, 1);
      z-index: 9999;
      display: flex;
      flex-direction: column;
      font-family: var(--d-sans);
    }
    .askd.is-open { transform: translateX(0); }

    /* ─── Head ─────────────────────────── */
    .askd-head {
      flex-shrink: 0;
      padding: 14px 22px 12px;
      border-bottom: 1px solid var(--d-ink-15);
      background: var(--d-bg);
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .askd-h-mark {
      color: var(--d-red);
      font-family: var(--d-mono);
      font-size: 14px;
      line-height: 1;
    }
    .askd-h-title {
      font-family: var(--d-mono);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 2px;
      color: var(--d-ink);
      flex: 1;
    }
    .askd-h-title .h-sub {
      color: var(--d-ink-40);
      font-weight: 400;
      letter-spacing: 1.5px;
      padding-left: 8px;
      margin-left: 8px;
      border-left: 1px solid var(--d-ink-25);
    }
    .askd-h-kbd {
      font-family: var(--d-mono);
      font-size: 9px;
      letter-spacing: 1px;
      color: var(--d-ink-40);
      padding: 3px 6px;
      border: 1px solid var(--d-ink-15);
    }
    .askd-h-close {
      background: transparent;
      border: 1px solid var(--d-ink-15);
      color: var(--d-ink-60);
      cursor: pointer;
      width: 28px; height: 28px;
      font-family: var(--d-mono);
      font-size: 14px;
      line-height: 1;
      transition: all .15s;
    }
    .askd-h-close:hover { color: var(--d-red); border-color: var(--d-red); }

    /* ─── Body (滚动区) ─────────────────── */
    .askd-body {
      flex: 1;
      overflow-y: auto;
      padding: 22px 22px 16px;
    }
    .askd-body::-webkit-scrollbar { width: 4px; }
    .askd-body::-webkit-scrollbar-thumb { background: var(--d-ink-15); }
    .askd-body::-webkit-scrollbar-track { background: transparent; }

    /* Empty state */
    .askd-empty {
      padding: 8px 0;
      animation: askdFade .3s ease-out;
    }
    @keyframes askdFade { from { opacity: 0; } to { opacity: 1; } }
    .askd-e-mark {
      font-family: var(--d-mono);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 2px;
      color: var(--d-red);
      margin-bottom: 14px;
    }
    .askd-e-mark::before { content: '▌'; margin-right: 8px; }
    .askd-e-text {
      font-family: var(--d-serif);
      font-size: 19px;
      line-height: 1.45;
      color: var(--d-ink);
      margin-bottom: 12px;
      font-weight: 500;
    }
    .askd-e-hint {
      font-family: var(--d-sans);
      font-size: 13px;
      line-height: 1.55;
      color: var(--d-ink-60);
      margin-bottom: 24px;
    }
    .askd-e-quick {
      font-family: var(--d-mono);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 2px;
      color: var(--d-ink-60);
      margin-bottom: 10px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--d-ink-15);
    }
    .askd-e-list { display: flex; flex-direction: column; gap: 0; }
    .askd-e-item {
      padding: 10px 12px;
      border-bottom: 1px solid var(--d-ink-08);
      cursor: pointer;
      transition: background .15s;
    }
    .askd-e-item:hover { background: var(--d-paper); }
    .askd-e-item:last-child { border-bottom: none; }
    .askd-ei-title {
      font-family: var(--d-serif);
      font-size: 13px;
      line-height: 1.35;
      color: var(--d-ink);
      margin-bottom: 4px;
    }
    .askd-ei-meta {
      font-family: var(--d-mono);
      font-size: 9px;
      letter-spacing: 1px;
      color: var(--d-ink-40);
    }
    .askd-ei-meta .ei-conf { color: var(--d-red); font-weight: 600; }
    .askd-ei-meta .ei-sep { color: var(--d-ink-15); margin: 0 4px; }

    /* ─── Case file ──────────────────────── */
    .askd-case {
      padding: 18px 0 18px;
      border-top: 2px solid var(--d-ink-15);
      animation: askdCaseIn .25s ease-out;
    }
    .askd-case:first-of-type { border-top: none; padding-top: 4px; }
    @keyframes askdCaseIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

    .askd-c-head {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 14px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--d-ink-15);
    }
    .askd-c-num {
      font-family: var(--d-mono);
      font-size: 11px;
      font-weight: 700;
      color: var(--d-red);
      letter-spacing: 1px;
    }
    .askd-c-meta {
      font-family: var(--d-mono);
      font-size: 9px;
      color: var(--d-ink-40);
      letter-spacing: 1.5px;
      flex: 1;
    }
    .askd-c-status {
      font-family: var(--d-mono);
      font-size: 9px;
      color: var(--d-ink-40);
      letter-spacing: 1.5px;
    }
    .askd-c-status.is-active { color: var(--d-green); }
    .askd-c-status.is-active::before { content: '● '; }

    .askd-c-section { margin-bottom: 16px; }
    .askd-c-section:last-child { margin-bottom: 0; }
    .askd-cs-label {
      display: flex;
      align-items: baseline;
      gap: 8px;
      font-family: var(--d-mono);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1.5px;
      color: var(--d-ink);
      margin-bottom: 8px;
      line-height: 1;
    }
    .askd-cs-label::before { content: '▌'; color: var(--d-red); font-size: 12px; }
    .askd-cs-info {
      font-weight: 400;
      letter-spacing: 1px;
      color: var(--d-ink-40);
      font-size: 9px;
    }

    /* REQUEST */
    .askd-cs-req {
      font-family: var(--d-serif);
      font-size: 16px;
      font-style: italic;
      line-height: 1.5;
      color: var(--d-ink);
      padding: 4px 0 0 18px;
      border-left: 2px solid var(--d-ink-15);
      margin-left: 4px;
    }

    /* TRACE */
    details.askd-cs-trace { padding-left: 22px; margin-left: 4px; }
    details.askd-cs-trace > summary {
      list-style: none;
      cursor: pointer;
      user-select: none;
      font-family: var(--d-mono);
      font-size: 10px;
      color: var(--d-ink-60);
      padding: 3px 0;
      transition: color .15s;
    }
    details.askd-cs-trace > summary::-webkit-details-marker { display: none; }
    details.askd-cs-trace > summary::before {
      content: '▸';
      display: inline-block;
      margin-right: 6px;
      color: var(--d-ink-40);
      transition: transform .15s;
    }
    details.askd-cs-trace[open] > summary::before { transform: rotate(90deg); }
    details.askd-cs-trace > summary:hover { color: var(--d-ink); }
    details.askd-cs-trace .trace-body {
      margin-top: 10px;
      padding: 10px 12px;
      background: var(--d-paper);
      border: 1px solid var(--d-ink-15);
      font-family: var(--d-mono);
      font-size: 10px;
    }
    .askd-trace-step {
      margin-bottom: 10px;
      padding-bottom: 10px;
      border-bottom: 1px dashed var(--d-ink-15);
    }
    .askd-trace-step:last-child { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }
    .askd-trace-step .ts-num { color: var(--d-red); font-weight: 700; letter-spacing: 1px; font-size: 9px; }
    .askd-trace-step .ts-tool { color: var(--d-ink); font-weight: 700; margin-left: 6px; }
    .askd-trace-step .ts-time { color: var(--d-ink-40); margin-left: 6px; font-size: 9px; }
    .askd-trace-step .ts-args { color: var(--d-ink-60); margin-top: 4px; word-break: break-all; }
    .askd-trace-step .ts-result { color: var(--d-ink-90); margin-top: 6px; }
    .askd-trace-step .ts-result ul { list-style: none; margin: 4px 0 0; padding: 0; color: var(--d-ink-60); font-size: 9px; }
    .askd-trace-step .ts-result li::before { content: '› '; color: var(--d-ink-40); }
    .askd-trace-step.is-error .ts-tool { color: var(--d-red); }

    /* BRIEF */
    .askd-cs-brief { padding-left: 22px; margin-left: 4px; }
    .askd-cs-brief .brief-rule { width: 36px; height: 0; border-top: 2px solid var(--d-ink); margin-bottom: 12px; }
    .askd-brief-body {
      font-family: var(--d-serif);
      font-size: 15px;
      line-height: 1.7;
      color: var(--d-ink);
    }
    .askd-brief-body > *:first-child { margin-top: 0; }
    .askd-brief-body > *:last-child { margin-bottom: 0; }
    .askd-brief-body p { margin: 0 0 12px; }
    .askd-brief-body strong { font-weight: 700; color: var(--d-ink); }
    .askd-brief-body em { font-style: italic; }
    .askd-brief-body h1, .askd-brief-body h2, .askd-brief-body h3 {
      font-family: var(--d-serif);
      font-weight: 700;
      margin: 18px 0 8px;
      line-height: 1.25;
    }
    .askd-brief-body h1 { font-size: 21px; }
    .askd-brief-body h2 { font-size: 18px; }
    .askd-brief-body h3 { font-size: 16px; }
    .askd-brief-body ul, .askd-brief-body ol { margin: 8px 0 12px; padding-left: 0; list-style: none; }
    .askd-brief-body ul li, .askd-brief-body ol li { position: relative; padding-left: 20px; margin-bottom: 6px; }
    .askd-brief-body ul li::before {
      content: '▸';
      position: absolute;
      left: 4px;
      color: var(--d-red);
      font-size: 11px;
      top: 2px;
    }
    .askd-brief-body ol { counter-reset: brief; }
    .askd-brief-body ol li { counter-increment: brief; }
    .askd-brief-body ol li::before {
      content: counter(brief, decimal-leading-zero) '.';
      position: absolute;
      left: 0;
      color: var(--d-red);
      font-family: var(--d-mono);
      font-size: 10px;
      font-weight: 700;
      top: 4px;
    }
    .askd-brief-body blockquote {
      border-left: 3px solid var(--d-ink-25);
      padding: 4px 0 4px 14px;
      margin: 12px 0;
      color: var(--d-ink-60);
      font-style: italic;
    }
    .askd-brief-body a {
      color: var(--d-blue);
      text-decoration: none;
      border-bottom: 1px solid var(--d-blue);
    }
    .askd-brief-body code {
      font-family: var(--d-mono);
      font-size: 0.86em;
      background: var(--d-paper);
      padding: 1px 6px;
      border: 1px solid var(--d-ink-15);
    }
    .askd-brief-body pre {
      background: var(--d-paper);
      border: 1px solid var(--d-ink-15);
      padding: 12px 14px;
      margin: 12px 0;
      overflow-x: auto;
      font-family: var(--d-mono);
      font-size: 12px;
      line-height: 1.5;
    }
    .askd-brief-body pre code { background: transparent; padding: 0; border: none; }
    .askd-brief-body table {
      border-collapse: collapse;
      width: 100%;
      margin: 12px 0;
      font-family: var(--d-sans);
      font-size: 13px;
    }
    .askd-brief-body th, .askd-brief-body td {
      border: 1px solid var(--d-ink-15);
      padding: 7px 10px;
      text-align: left;
    }
    .askd-brief-body th { background: var(--d-paper); font-weight: 600; }

    .askd-brief-body.is-streaming::after {
      content: '▍';
      display: inline-block;
      color: var(--d-red);
      margin-left: 1px;
      animation: askdBlink 1s steps(1) infinite;
      font-family: var(--d-mono);
    }
    @keyframes askdBlink { 50% { opacity: 0; } }

    /* Case foot · action bar */
    .askd-c-foot {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 16px;
      padding-top: 10px;
      border-top: 1px dotted var(--d-ink-15);
      font-family: var(--d-mono);
      font-size: 9px;
      letter-spacing: 1px;
      color: var(--d-ink-40);
    }
    .askd-cf-conf {
      color: var(--d-green);
      font-weight: 600;
      padding: 2px 6px;
      border: 1px solid var(--d-green);
    }
    .askd-cf-meta { color: var(--d-ink-40); flex: 1; }
    .askd-c-foot button {
      font-family: var(--d-mono);
      font-size: 9px;
      letter-spacing: 1.2px;
      color: var(--d-ink-60);
      background: transparent;
      border: 1px solid var(--d-ink-15);
      padding: 4px 8px;
      cursor: pointer;
      transition: all .15s;
    }
    .askd-c-foot button:hover { color: var(--d-ink); border-color: var(--d-ink); }
    .askd-c-foot button.is-done { color: var(--d-green); border-color: var(--d-green); }

    /* ─── Foot · file new request ────────── */
    .askd-foot {
      flex-shrink: 0;
      padding: 12px 22px 16px;
      border-top: 1px solid var(--d-ink-15);
      background: var(--d-bg);
    }
    .askd-fp {
      font-family: var(--d-mono);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 2px;
      color: var(--d-red);
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .askd-fp .fp-status {
      color: var(--d-ink-40);
      font-weight: 400;
      letter-spacing: 1px;
    }
    .askd-error {
      font-family: var(--d-mono);
      font-size: 10px;
      color: var(--d-red);
      padding: 6px 10px;
      border: 1px solid var(--d-red);
      background: var(--d-paper);
      margin-bottom: 8px;
    }
    .askd-form {
      display: flex;
      gap: 8px;
      align-items: flex-end;
      background: var(--d-paper);
      border: 1px solid var(--d-ink-25);
      padding: 10px 12px;
      transition: border-color .15s;
    }
    .askd-form:focus-within { border-color: var(--d-red); }
    .askd-input {
      flex: 1;
      font-family: var(--d-serif);
      font-size: 15px;
      line-height: 1.4;
      color: var(--d-ink);
      background: transparent;
      border: none;
      outline: none;
      resize: none;
      min-height: 22px;
      max-height: 160px;
      padding: 0;
    }
    .askd-input::placeholder { color: var(--d-ink-40); font-style: italic; }
    .askd-send, .askd-stop {
      font-family: var(--d-mono);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1.5px;
      padding: 7px 16px;
      cursor: pointer;
      flex-shrink: 0;
      align-self: flex-end;
      transition: all .15s;
    }
    .askd-send {
      background: var(--d-ink);
      color: var(--d-bg);
      border: 1px solid var(--d-ink);
    }
    .askd-send:hover { background: var(--d-red); border-color: var(--d-red); color: #fff; }
    .askd-send:disabled { opacity: 0.4; cursor: not-allowed; }
    .askd-stop {
      display: none;
      background: transparent;
      color: var(--d-red);
      border: 1px solid var(--d-red);
    }
    .askd-stop:hover { background: var(--d-red); color: #fff; }

    .askd-foot-meta {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-top: 8px;
      font-family: var(--d-mono);
      font-size: 9px;
      color: var(--d-ink-40);
      letter-spacing: 1px;
    }
    .askd-ctx { color: var(--d-green); }
    .askd-ctx.is-hidden { display: none; }
    .askd-clear {
      font-family: var(--d-mono);
      font-size: 9px;
      letter-spacing: 1px;
      color: var(--d-ink-40);
      background: transparent;
      border: 1px solid var(--d-ink-15);
      padding: 3px 8px;
      cursor: pointer;
      transition: all .15s;
    }
    .askd-clear:hover:not(:disabled) { color: var(--d-red); border-color: var(--d-red); }
    .askd-clear:disabled { opacity: 0.3; cursor: not-allowed; }

    /* mobile */
    @media (max-width: 600px) {
      .askd { width: 100vw; border-left: none; }
    }
  `;

  // 注入 CSS
  const styleEl = document.createElement('style');
  styleEl.id = 'ask-drawer-style';
  styleEl.textContent = DRAWER_CSS;
  document.head.appendChild(styleEl);

  // ─── 注入 HTML (overlay + drawer) ─────────────
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div class="askd-overlay" id="askdOverlay"></div>
    <aside class="askd" id="askd" role="dialog" aria-label="情报问答">
      <div class="askd-head">
        <span class="askd-h-mark">▌</span>
        <span class="askd-h-title">INTELLIGENCE DESK<span class="h-sub">CASE BRIEFING</span></span>
        <span class="askd-h-kbd">⌘K</span>
        <button class="askd-h-close" id="askdClose" type="button" aria-label="关闭">×</button>
      </div>
      <div class="askd-body" id="askdBody">
        <div class="askd-empty" id="askdEmpty">
          <div class="askd-e-mark">AWAITING REQUEST</div>
          <p class="askd-e-text">系统待命。在底部提交一项情报查询,或从下方选取一条 critical 事件作为切入点。</p>
          <p class="askd-e-hint">检索引擎将自主调用 4 个工具,综合 9 个全球冲突的最近 30 天事件作答。</p>
          <div class="askd-e-quick">SUGGESTED QUERIES</div>
          <div class="askd-e-list" id="askdQuickList">
            <div style="font-family:var(--d-mono);font-size:10px;color:var(--d-ink-40);padding:8px 0">加载中…</div>
          </div>
        </div>
        <div id="askdCases"></div>
      </div>
      <div class="askd-foot">
        <div class="askd-fp">
          <span>▸ FILE NEW REQUEST</span>
          <span class="fp-status" id="askdStatus">系统待命</span>
        </div>
        <div class="askd-error" id="askdError" style="display:none"></div>
        <form class="askd-form" id="askdForm">
          <textarea
            class="askd-input"
            id="askdInput"
            rows="1"
            placeholder="提交情报查询… 例如:俄乌最近 critical 军事事件"
            autocomplete="off"
          ></textarea>
          <button class="askd-send" id="askdSend" type="submit">QUERY</button>
          <button class="askd-stop" id="askdStop" type="button">中断</button>
        </form>
        <div class="askd-foot-meta">
          <span class="askd-ctx is-hidden" id="askdCtx">● 上下文 <span id="askdCtxN">0</span> 轮 · <span id="askdTok">0</span> token</span>
          <button class="askd-clear" id="askdClear" type="button" disabled>新对话</button>
        </div>
      </div>
    </aside>
  `;
  while (wrapper.firstChild) document.body.appendChild(wrapper.firstChild);

  // ─── DOM refs ─────────────────────────────────
  const overlay = document.getElementById('askdOverlay');
  const drawer  = document.getElementById('askd');
  const closeBtn = document.getElementById('askdClose');
  const body    = document.getElementById('askdBody');
  const empty   = document.getElementById('askdEmpty');
  const cases   = document.getElementById('askdCases');
  const form    = document.getElementById('askdForm');
  const input   = document.getElementById('askdInput');
  const sendBtn = document.getElementById('askdSend');
  const stopBtn = document.getElementById('askdStop');
  const clearBtn = document.getElementById('askdClear');
  const errEl   = document.getElementById('askdError');
  const status  = document.getElementById('askdStatus');
  const ctxEl   = document.getElementById('askdCtx');
  const ctxN    = document.getElementById('askdCtxN');
  const tokEl   = document.getElementById('askdTok');
  const quickList = document.getElementById('askdQuickList');

  // ─── State ─────────────────────────────────────
  const state = {
    history: [],
    cases: [],
    inflight: null,
    caseCounter: 0,
    totalTokens: 0,
    suggestedLoaded: false,
    atBottom: true,
  };

  // ─── 加载 CDN 依赖 (条件加载,host 页可能已经有 marked) ─────
  function loadScript(src, check) {
    if (check && check()) return Promise.resolve();
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = resolve;
      document.head.appendChild(s);
    });
  }
  Promise.all([
    loadScript('https://cdn.jsdelivr.net/npm/marked/marked.min.js', () => window.marked),
    loadScript('https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js', () => window.DOMPurify),
  ]).then(() => {
    if (window.marked) marked.setOptions({ gfm: true, breaks: true });
  });

  // ─── Markdown / sanitize ──────────────────────
  function renderMarkdown(md) {
    if (!md) return '';
    const html = window.marked ? marked.parse(md) : escapeHtml(md);
    return window.DOMPurify ? DOMPurify.sanitize(html, { ADD_ATTR: ['target'] }) : html;
  }
  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }
  async function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return true; } catch {}
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }

  // ─── 智能 auto-scroll ─────────────────────────
  body.addEventListener('scroll', () => {
    const dist = body.scrollHeight - body.scrollTop - body.clientHeight;
    state.atBottom = dist < 80;
  });
  function scrollToBottom(force = false) {
    if (!force && !state.atBottom) return;
    body.scrollTop = body.scrollHeight;
  }

  // ─── textarea 自动展开 ────────────────────────
  function autoResize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }
  input.addEventListener('input', autoResize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // ─── Open / Close ─────────────────────────────
  function openDrawer() {
    overlay.classList.add('is-open');
    drawer.classList.add('is-open');
    setTimeout(() => input.focus(), 320);
    if (!state.suggestedLoaded) {
      state.suggestedLoaded = true;
      loadSuggested();
    }
  }
  function closeDrawer() {
    overlay.classList.remove('is-open');
    drawer.classList.remove('is-open');
  }
  closeBtn.addEventListener('click', closeDrawer);
  overlay.addEventListener('click', closeDrawer);

  // ─── 加载 SUGGESTED QUERIES (从 latest.json) ──
  async function loadSuggested() {
    try {
      const res = await fetch('/data/latest.json');
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      const all = [];
      for (const [cid, c] of Object.entries(data.conflicts || {})) {
        for (const [catid, cat] of Object.entries(c.categories || {})) {
          for (const item of (cat.items || [])) {
            if (item.criticality === 'critical') {
              all.push({ ...item, conflict_id: cid, conflict_name: c.name, category_label: cat.label });
            }
          }
        }
      }
      all.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      const top = all.slice(0, 5);
      if (top.length === 0) {
        quickList.innerHTML = '<div style="font-family:var(--d-mono);font-size:10px;color:var(--d-ink-40);padding:8px 0">暂无 critical 事件</div>';
        return;
      }
      quickList.innerHTML = '';
      top.forEach(item => {
        const div = document.createElement('div');
        div.className = 'askd-e-item';
        const t = item.title || item.title_en || '';
        div.innerHTML = `
          <div class="askd-ei-title">${escapeHtml(t)}</div>
          <div class="askd-ei-meta">
            <span class="ei-conf">${escapeHtml(item.conflict_name || '')}</span>
            <span class="ei-sep">·</span>${escapeHtml(item.category_label || '')}
            <span class="ei-sep">·</span>${escapeHtml(item.date || '')}
          </div>
        `;
        div.addEventListener('click', () => {
          input.value = `详细说明"${t}"的来龙去脉、各方反应和最新进展。`;
          autoResize();
          input.focus();
        });
        quickList.appendChild(div);
      });
    } catch (e) {
      quickList.innerHTML = '<div style="font-family:var(--d-mono);font-size:10px;color:var(--d-ink-40);padding:8px 0">加载失败</div>';
    }
  }

  // ─── Clear (新对话) ───────────────────────────
  clearBtn.addEventListener('click', () => {
    if (state.inflight) state.inflight.abort();
    state.history = [];
    state.cases = [];
    state.inflight = null;
    state.caseCounter = 0;
    state.totalTokens = 0;
    cases.innerHTML = '';
    empty.style.display = '';
    errEl.style.display = 'none';
    updateMeta();
    clearBtn.disabled = true;
    status.textContent = '系统待命';
    input.focus();
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

  // ─── 核心:运行查询 ───────────────────────────
  async function runQuery(question, { regenerate = false, removeAfter = null } = {}) {
    if (regenerate && removeAfter !== null) {
      state.cases.splice(removeAfter);
      state.history = state.history.slice(0, removeAfter * 2);
      while (cases.children.length > removeAfter) {
        cases.removeChild(cases.lastChild);
      }
    }

    state.inflight = new AbortController();
    errEl.style.display = 'none';
    empty.style.display = 'none';

    state.caseCounter += 1;
    const co = createCase(state.caseCounter, question);
    cases.appendChild(co.root);
    state.cases.push(co);

    input.value = '';
    autoResize();
    sendBtn.style.display = 'none';
    stopBtn.style.display = '';
    clearBtn.disabled = true;
    status.textContent = `处理 CASE #${String(state.caseCounter).padStart(3, '0')} · 检索中`;
    state.atBottom = true;
    requestAnimationFrame(() => co.root.scrollIntoView({ behavior: 'smooth', block: 'start' }));

    const t0 = performance.now();
    let answerMd = '';
    let usage = null;
    let ok = false;

    let pendingRender = false;
    function scheduleRender() {
      if (pendingRender) return;
      pendingRender = true;
      requestAnimationFrame(() => {
        pendingRender = false;
        co.briefBody.innerHTML = renderMarkdown(answerMd);
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
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${txt || res.statusText}`);
      }

      co.briefBody.classList.add('is-streaming');

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
          const got = handleFrame(frame, co, {
            onTextDelta(t) { answerMd += t; scheduleRender(); },
          });
          if (got && got.fullText) answerMd = got.fullText;
          if (got && got.usage) usage = got.usage;
        }
      }
      ok = true;
    } catch (err) {
      if (err.name === 'AbortError') {
        co.briefBody.classList.remove('is-streaming');
        if (!answerMd) co.briefBody.innerHTML = '<p style="color: var(--d-ink-40); font-style: italic;">— CASE ABORTED —</p>';
        co.statusEl.textContent = 'ABORTED';
        co.statusEl.classList.remove('is-active');
      } else {
        showError(err.message || String(err));
        co.briefBody.classList.remove('is-streaming');
        co.statusEl.textContent = 'ERROR';
        co.statusEl.classList.remove('is-active');
      }
    } finally {
      co.briefBody.classList.remove('is-streaming');
      sendBtn.style.display = '';
      stopBtn.style.display = 'none';
      clearBtn.disabled = state.cases.length === 0;
      state.inflight = null;
      input.focus();

      if (ok && answerMd) {
        co.briefBody.innerHTML = renderMarkdown(answerMd);
        state.history.push({ role: 'user', content: question });
        state.history.push({ role: 'assistant', content: answerMd });
        if (state.history.length > 20) state.history = state.history.slice(-20);
        if (usage) state.totalTokens += usage.total_tokens || 0;

        const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
        co.answerMd = answerMd;
        co.statusEl.textContent = 'CLOSED';
        co.statusEl.classList.remove('is-active');
        finalizeTrace(co);
        renderFoot(co, { elapsed, usage });
        updateMeta();
        status.textContent = `就绪 · ${co.toolsCount} 次检索 · ${elapsed}s`;
        scrollToBottom();
      } else if (!ok) {
        status.textContent = '系统待命 · 上一查询已中断';
      }
    }
  }

  function updateMeta() {
    const turns = Math.floor(state.history.length / 2);
    if (turns > 0) {
      ctxEl.classList.remove('is-hidden');
      ctxN.textContent = String(turns);
      tokEl.textContent = state.totalTokens.toLocaleString('en-US');
    } else {
      ctxEl.classList.add('is-hidden');
    }
  }

  // ─── Case factory ───────────────────────────
  function createCase(n, question) {
    const root = document.createElement('article');
    root.className = 'askd-case';

    const numStr = `CASE #${String(n).padStart(3, '0')}`;
    const now = new Date();
    const filed = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

    const head = document.createElement('div');
    head.className = 'askd-c-head';
    head.innerHTML = `
      <span class="askd-c-num">${numStr}</span>
      <span class="askd-c-meta">${filed} · ANALYST</span>
      <span class="askd-c-status is-active">ACTIVE</span>
    `;
    const statusEl = head.querySelector('.askd-c-status');

    // REQUEST
    const reqSec = document.createElement('div');
    reqSec.className = 'askd-c-section';
    reqSec.innerHTML = `<div class="askd-cs-label">REQUEST</div>`;
    const reqBody = document.createElement('div');
    reqBody.className = 'askd-cs-req';
    reqBody.textContent = '"' + question + '"';
    reqSec.appendChild(reqBody);

    // TRACE
    const traceSec = document.createElement('div');
    traceSec.className = 'askd-c-section';
    const traceLabel = document.createElement('div');
    traceLabel.className = 'askd-cs-label';
    traceLabel.innerHTML = `<span>TRACE</span><span class="askd-cs-info">检索中…</span>`;
    traceSec.appendChild(traceLabel);
    const traceDetails = document.createElement('details');
    traceDetails.className = 'askd-cs-trace';
    const summary = document.createElement('summary');
    summary.textContent = '展开检索过程';
    const traceBody = document.createElement('div');
    traceBody.className = 'trace-body';
    traceDetails.appendChild(summary);
    traceDetails.appendChild(traceBody);
    traceSec.appendChild(traceDetails);

    // BRIEF
    const briefSec = document.createElement('div');
    briefSec.className = 'askd-c-section';
    briefSec.innerHTML = `<div class="askd-cs-label">BRIEF</div>`;
    const briefWrap = document.createElement('div');
    briefWrap.className = 'askd-cs-brief';
    briefWrap.innerHTML = `<div class="brief-rule"></div>`;
    const briefBody = document.createElement('div');
    briefBody.className = 'askd-brief-body';
    briefWrap.appendChild(briefBody);
    briefSec.appendChild(briefWrap);

    root.appendChild(head);
    root.appendChild(reqSec);
    root.appendChild(traceSec);
    root.appendChild(briefSec);

    return {
      root, n, question, statusEl,
      traceInfo: traceLabel.querySelector('.askd-cs-info'),
      traceDetails, traceBody,
      briefBody,
      answerMd: '',
      toolsCount: 0,
      stepDurations: [],
    };
  }

  // ─── SSE 帧处理 ───────────────────────────
  function handleFrame(frame, co, { onTextDelta }) {
    let event = 'message', dataStr = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
    }
    if (!dataStr) return null;
    let data;
    try { data = JSON.parse(dataStr); } catch { return null; }

    switch (event) {
      case 'tool_call': {
        co.toolsCount += 1;
        co.stepDurations.push(data.model_ms || 0);
        appendTraceStep(co, data);
        updateTraceInfo(co);
        return null;
      }
      case 'tool_result':
        attachTraceResult(co, data.step, data.summary);
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

  function appendTraceStep(co, data) {
    const div = document.createElement('div');
    div.className = 'askd-trace-step';
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
    co.traceBody.appendChild(div);
  }

  function attachTraceResult(co, step, summary) {
    const target = co.traceBody.querySelector(`.askd-trace-step[data-step="${step}"] .ts-result`);
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

  function updateTraceInfo(co) {
    const ms = co.stepDurations.reduce((a, b) => a + b, 0);
    co.traceInfo.textContent = `${co.toolsCount} 次检索 · ${(ms / 1000).toFixed(1)}s`;
  }

  function finalizeTrace(co) {
    if (co.toolsCount === 0) {
      co.traceInfo.textContent = '无检索 · 直接答复';
      co.traceDetails.style.display = 'none';
    } else {
      updateTraceInfo(co);
    }
  }

  // ─── Action bar ──────────────────────────
  function renderFoot(co, { elapsed, usage }) {
    if (co.footEl) co.footEl.remove();
    const foot = document.createElement('div');
    foot.className = 'askd-c-foot';

    const conf = document.createElement('span');
    conf.className = 'askd-cf-conf';
    conf.textContent = co.toolsCount > 0 ? 'A1' : 'B2';

    const meta = document.createElement('span');
    meta.className = 'askd-cf-meta';
    const tcStr = co.toolsCount > 0 ? `${co.toolsCount} 检索` : '直接答';
    const tokStr = usage ? ` · ${(usage.total_tokens || 0).toLocaleString('en-US')} tok` : '';
    meta.textContent = ` ${tcStr} · ${elapsed}s${tokStr}`;

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = '⎘ 复制';
    copyBtn.addEventListener('click', async () => {
      const ok = await copyToClipboard(co.answerMd);
      copyBtn.textContent = ok ? '✓ 已复制' : '✗ 失败';
      if (ok) copyBtn.classList.add('is-done');
      setTimeout(() => { copyBtn.textContent = '⎘ 复制'; copyBtn.classList.remove('is-done'); }, 1500);
    });

    const regenBtn = document.createElement('button');
    regenBtn.type = 'button';
    regenBtn.textContent = '↻ 重检';
    regenBtn.addEventListener('click', () => {
      if (state.inflight) return;
      const idx = state.cases.indexOf(co);
      if (idx < 0) return;
      runQuery(co.question, { regenerate: true, removeAfter: idx });
    });

    foot.appendChild(conf);
    foot.appendChild(meta);
    foot.appendChild(copyBtn);
    foot.appendChild(regenBtn);
    co.root.appendChild(foot);
    co.footEl = foot;
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

  // ─── 全局快捷键 ⌘K + Esc ─────────────────────
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      if (drawer.classList.contains('is-open')) closeDrawer();
      else openDrawer();
    }
    if (e.key === 'Escape') {
      if (state.inflight) {
        state.inflight.abort();
      } else if (drawer.classList.contains('is-open')) {
        closeDrawer();
      }
    }
  });

  // ─── 暴露 API ─────────────────────────────
  window.openAskDrawer = openDrawer;
  window.closeAskDrawer = closeDrawer;
})();
