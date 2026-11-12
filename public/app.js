const STORAGE_KEY = 'difflens.form.v1';

const state = {
  result: null,
  tab: 'visual',
  visualMode: 'side',
  changesOnly: false,
  comparing: false,
  startedAt: 0,
  timer: null,
  demo: null,
  live: null,
  liveWheel: { dx: 0, dy: 0, x: 0, y: 0, timer: null },
  liveDelayMs: 0,
};

const $ = (id) => document.getElementById(id);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

init();

async function init() {
  wireEvents();
  restoreForm();
  await loadDemoTargets();
  loadHealth();
  if (new URLSearchParams(location.search).get('demo') === '1') runCompare();
}

function wireEvents() {
  $('compareForm').addEventListener('submit', (event) => {
    event.preventDefault();
    runCompare();
  });

  $('swapBtn').addEventListener('click', () => {
    const local = $('localUrl').value;
    $('localUrl').value = $('stagingUrl').value;
    $('stagingUrl').value = local;
    saveForm();
  });

  $('demoBtn').addEventListener('click', async () => {
    await loadDemoTargets();
    if (!state.demo) return;
    $('localUrl').value = state.demo.local;
    $('stagingUrl').value = state.demo.staging;
    saveForm();
    runCompare();
  });

  $('optionsBtn').addEventListener('click', () => {
    const panel = $('optionsPanel');
    const open = panel.hidden;
    panel.hidden = !open;
    $('optionsBtn').setAttribute('aria-expanded', String(open));
    $('optionsBtn').textContent = open ? 'Hide options' : 'Options';
  });

  $('liveDelaySlider').addEventListener('input', (e) => {
    const delay = Number(e.target.value);
    state.liveDelayMs = delay;
    $('liveDelayValue').textContent = delay;
  });

  for (const id of [
    'localUrl',
    'stagingUrl',
    'settleMs',
    'pixelThreshold',
    'ignoreSelectors',
    'fullPage',
    'ignoreWhitespace',
    'compareAttributes',
    'normalizeOrigins',
    'standardUserAgent',
    'scrollPage',
    'localAuthUsername',
    'stagingAuthUsername',
  ]) {
    $(id).addEventListener('change', saveForm);
    if ($(id).tagName === 'INPUT' && $(id).type === 'text') {
      $(id).addEventListener('input', debounce(saveForm, 400));
    }
  }

  $('liveBtn').addEventListener('click', startLive);
  $('liveCloseBtn').addEventListener('click', () => {
    if (state.live?.status === 'ended') closeLivePanel();
    else endLive();
  });
  $('liveReloadBtn').addEventListener('click', () => {
    if (state.live?.status === 'live') sendLive({ type: 'reload' });
  });
  $('liveScreen').addEventListener('pointerdown', onLivePointerDown);
  $('liveScreen').addEventListener('wheel', onLiveWheel, { passive: false });

  window.addEventListener('pagehide', () => {
    const live = state.live;
    if (!live?.id) return;
    fetch(`/api/session/${encodeURIComponent(live.id)}`, { method: 'DELETE', keepalive: true }).catch(
      () => {},
    );
  });

  $('retryBtn').addEventListener('click', runCompare);
  $('rerunBtn').addEventListener('click', runCompare);
  $('jumpBtn').addEventListener('click', jumpToFirstChange);
  $('changesOnly').addEventListener('change', (event) => {
    state.changesOnly = event.target.checked;
    $('contentDiff').classList.toggle('changes-only', state.changesOnly);
  });
  $('markupSearch').addEventListener('input', filterMarkup);

  $$('.tab').forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));
  $$('.seg').forEach((button) =>
    button.addEventListener('click', () => setVisualMode(button.dataset.visualMode)),
  );

  $('overlayRange').addEventListener('input', (event) => {
    $('overlayFrame').style.setProperty('--overlay-pos', `${event.target.value}%`);
  });

  bindSync($('localScroll'), $('stagingScroll'));

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      runCompare();
    }
    if (event.target.closest('.tabs') && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      const tabs = $$('.tab');
      const current = tabs.findIndex((tab) => tab.classList.contains('active'));
      const next = (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus();
      activateTab(tabs[next].dataset.tab);
    }
  });
}

async function loadDemoTargets() {
  if (state.demo) return;
  try {
    const response = await fetch('/api/demo-targets');
    if (!response.ok) return;
    state.demo = await response.json();
    if (!$('localUrl').value) $('localUrl').value = state.demo.local;
    if (!$('stagingUrl').value) $('stagingUrl').value = state.demo.staging;
    saveForm();
  } catch {
    /* demo is optional */
  }
}

async function loadHealth() {
  try {
    const response = await fetch('/api/health');
    const health = await response.json();
    if (health.engine?.installed) {
      const major = health.engine.version ? ` ${String(health.engine.version).split('.')[0]}` : '';
      $('engineText').textContent = `Chromium${major} · ${health.engine.viewport.width}×${health.engine.viewport.height}`;
    } else {
      $('engineText').textContent = 'Chromium not installed';
      document.querySelector('.engine-pill i').style.background = '#fb7185';
    }
  } catch {
    $('engineText').textContent = 'Server offline';
  }
}

async function runCompare() {
  if (state.comparing) return;
  const localUrl = $('localUrl').value.trim();
  const stagingUrl = $('stagingUrl').value.trim();
  if (!localUrl || !stagingUrl) {
    showError('Both URLs are required', 'Add a local URL and a staging URL, then compare again.');
    $('localUrl').focus();
    return;
  }

  state.comparing = true;
  setBusy(true);
  hideError();
  $('results').hidden = true;
  $('statusPanel').hidden = false;
  startTimer();

  const payload = buildPayload();

  try {
    const response = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new RequestError(data, response.status);
    stopTimer();
    $('statusPanel').hidden = true;
    renderResult(data);
  } catch (error) {
    stopTimer();
    $('statusPanel').hidden = true;
    const details = [];
    if (error.details?.sides) {
      for (const [side, info] of Object.entries(error.details.sides)) {
        details.push(`${capitalize(side)}: ${info.ok ? 'loaded successfully' : info.message}`);
      }
    }
    if (error.field) details.push(`Check the "${error.field}" field.`);
    const title =
      error.status === 429
        ? 'A comparison is already running'
        : error.status === 503
          ? 'Chromium is not available'
          : 'Comparison failed';
    showError(title, error.message, details);
  } finally {
    state.comparing = false;
    setBusy(false);
  }
}

function buildPayload() {
  return {
    localUrl: $('localUrl').value.trim(),
    stagingUrl: $('stagingUrl').value.trim(),
    settleMs: $('settleMs').value,
    pixelThreshold: $('pixelThreshold').value,
    ignoreSelectors: $('ignoreSelectors').value,
    localHeaders: $('localHeaders').value,
    stagingHeaders: $('stagingHeaders').value,
    localCookies: $('localCookies').value,
    stagingCookies: $('stagingCookies').value,
    localAuth: readAuth('local'),
    stagingAuth: readAuth('staging'),
    fullPage: $('fullPage').checked,
    ignoreWhitespace: $('ignoreWhitespace').checked,
    compareAttributes: $('compareAttributes').checked,
    normalizeOrigins: $('normalizeOrigins').checked,
    standardUserAgent: $('standardUserAgent').checked,
    scrollPage: $('scrollPage').checked,
  };
}

function readAuth(prefix) {
  const username = $(`${prefix}AuthUsername`).value.trim();
  const password = $(`${prefix}AuthPassword`).value;
  if (!username && !password) return null;
  return { username, password };
}

/* ---------------------------------------------------------------- live mode */

async function startLive() {
  if (state.live?.status === 'starting' || state.live?.status === 'live') return;
  const localUrl = $('localUrl').value.trim();
  const stagingUrl = $('stagingUrl').value.trim();
  if (!localUrl || !stagingUrl) {
    showError('Both URLs are required', 'Add a local URL and a staging URL, then start the live session.');
    $('localUrl').focus();
    return;
  }

  if (state.live) closeLivePanel();
  hideError();

  const live = {
    status: 'starting',
    id: null,
    socket: null,
    layout: null,
    actions: [],
    prevResultsHidden: $('results').hidden,
    prevEmptyHidden: $('emptyState').hidden,
  };
  state.live = live;

  $('livePanel').hidden = false;
  $('livePanel').dataset.state = 'starting';
  $('liveMeta').textContent = 'Starting Chromium…';
  $('liveEngine').textContent = '';
  $('liveLocalUrl').textContent = localUrl;
  $('liveStagingUrl').textContent = stagingUrl;
  $('livePlaceholderTitle').textContent = 'Starting Chromium…';
  $('livePlaceholderText').textContent = 'Opening local and staging in one split-view tab';
  $('livePlaceholder').classList.remove('hidden');
  $('liveFrame').removeAttribute('src');
  $('livePulses').innerHTML = '';
  $('liveLog').innerHTML =
    '<li class="live-log-empty">No actions yet. Click a link, button or form field in either half.</li>';
  $('liveSystem').innerHTML = '';
  $('liveCount').textContent = '0';

  $('liveBtn').disabled = true;
  $('liveCloseBtn').disabled = true;
  $('liveReloadBtn').disabled = true;
  $('liveCloseBtn').textContent = 'End session';

  $('results').hidden = true;
  $('emptyState').hidden = true;
  $('livePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const response = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload()),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new RequestError(data, response.status);
    if (state.live !== live) return;

    live.id = data.id;
    live.layout = data.layout || null;
    connectLive(live, data.wsPath);
  } catch (error) {
    if (state.live !== live) return;
    const details = [];
    if (error.details?.sides) {
      for (const [side, info] of Object.entries(error.details.sides)) {
        details.push(`${capitalize(side)}: ${info.ok ? 'loaded successfully' : info.message}`);
      }
    }
    if (error.field) details.push(`Check the "${error.field}" field.`);
    closeLivePanel();
    const title =
      error.status === 429
        ? 'Two live sessions are already running'
        : error.status === 503
          ? 'Chromium is not available'
          : 'Live session failed';
    showError(title, error.message, details);
  }
}

function connectLive(live, wsPath) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket;
  try {
    socket = new WebSocket(`${protocol}//${location.host}${wsPath}`);
  } catch (error) {
    failLiveConnection(live, error.message);
    return;
  }
  live.socket = socket;

  socket.addEventListener('open', () => {
    if (state.live !== live) return;
    live.status = 'live';
    applyLiveState('live');
    $('liveMeta').textContent = 'Connected · mirroring clicks and scrolling';
  });

  socket.addEventListener('message', (event) => {
    if (state.live !== live) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleLiveMessage(live, message);
  });

  socket.addEventListener('close', () => {
    live.socket = null;
    if (state.live !== live || live.status === 'ended') return;
    live.status = 'ended';
    applyLiveState('ended');
    $('liveMeta').textContent = 'Session closed';
    $('livePlaceholderTitle').textContent = 'Live session ended';
    $('livePlaceholderText').textContent =
      'The browser session was closed. Start a new live session to keep interacting.';
  });

  socket.addEventListener('error', () => {
    if (state.live !== live || live.status === 'ended') return;
    appendLiveSystem('The live connection reported an error.');
  });
}

function failLiveConnection(live, message) {
  live.status = 'ended';
  applyLiveState('ended');
  $('liveMeta').textContent = 'Could not connect';
  $('livePlaceholderTitle').textContent = 'Live session ended';
  $('livePlaceholderText').textContent = message || 'The live connection could not be opened.';
  appendLiveSystem(message || 'The live connection could not be opened.');
}

function handleLiveMessage(live, message) {
  if (message.type === 'ready') {
    live.layout = message.layout || live.layout;
    live.status = 'live';
    applyLiveState('live');
    $('liveLocalUrl').textContent = message.urls?.local || $('liveLocalUrl').textContent;
    $('liveStagingUrl').textContent = message.urls?.staging || $('liveStagingUrl').textContent;
    const version = message.engine?.version ? ` ${String(message.engine.version).split('.')[0]}` : '';
    $('liveEngine').textContent = `${message.engine?.name || 'Chromium'}${version} · one 1920×1080 tab · 960 px per page`;
    $('liveMeta').textContent = 'Connected · mirroring clicks and scrolling';
    live.actions = Array.isArray(message.actions) ? message.actions.slice(0, 12) : [];
    renderLiveActions(live);
    if (live.actions[0]) pulseLiveAction(live.actions[0]);
  } else if (message.type === 'frame') {
    if (message.data) {
      $('liveFrame').src = `data:image/jpeg;base64,${message.data}`;
      if (live.status === 'live') $('livePlaceholder').classList.add('hidden');
    }
  } else if (message.type === 'navigated') {
    if (message.side === 'local') $('liveLocalUrl').textContent = message.url;
    if (message.side === 'staging') $('liveStagingUrl').textContent = message.url;
  } else if (message.type === 'action') {
    if (!message.action) return;
    live.actions.unshift(message.action);
    if (live.actions.length > 12) live.actions.pop();
    renderLiveActions(live);
    pulseLiveAction(message.action);
    if (!message.action.mirrored && message.action.error) {
      appendLiveSystem(`${message.action.side || 'page'}: ${message.action.error}`);
    }
  } else if (message.type === 'system') {
    appendLiveSystem(message.message);
  } else if (message.type === 'auth') {
    const detail = message.hasCredentials
      ? 'The credentials were rejected. Update them in Options and start a new session.'
      : 'Add a username and password under Options → Basic auth, then start a new session.';
    appendLiveSystem(`${capitalize(message.side)} returned HTTP ${message.status}. ${detail}`);
  } else if (message.type === 'error') {
    appendLiveSystem(message.message || 'The live session reported an error.');
  } else if (message.type === 'closed') {
    live.status = 'ended';
    applyLiveState('ended');
    $('liveMeta').textContent = 'Session closed';
    $('livePlaceholderTitle').textContent = 'Live session ended';
    $('livePlaceholderText').textContent = closedReason(message.reason);
  }
}

function closedReason(reason) {
  if (reason === 'idle') return 'Closed after 5 minutes without interaction. Start a new session to continue.';
  if (reason === 'disconnected') return 'The browser window lost its connection. Start a new session to continue.';
  if (reason === 'requested') return 'You ended the session. Start a new one whenever you like.';
  if (reason === 'failed') return 'The session could not keep both pages open.';
  if (reason === 'shutdown') return 'DiffLens shut down and closed the session.';
  return 'The live session ended. Start a new session to continue.';
}

function applyLiveState(status) {
  $('livePanel').dataset.state = status;
  $('liveBtn').disabled = status === 'starting' || status === 'live';
  $('liveReloadBtn').disabled = status !== 'live';
  $('liveCloseBtn').disabled = status === 'starting';
  $('liveCloseBtn').textContent = status === 'ended' ? 'Close' : 'End session';
  $('livePlaceholder').classList.toggle('hidden', status === 'live');
}

function sendLive(message) {
  const socket = state.live?.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function onLivePointerDown(event) {
  if (state.live?.status !== 'live' || event.button !== 0) return;
  const point = livePoint(event);
  if (!point) return;
  event.preventDefault();
  addLivePulse({ x: point.x, y: point.y, width: 0, height: 0 }, 'source', false);
  const delay = state.liveDelayMs || 0;
  if (delay > 0) {
    setTimeout(() => sendLive({ type: 'click', x: point.x, y: point.y }), delay);
  } else {
    sendLive({ type: 'click', x: point.x, y: point.y });
  }
}

function onLiveWheel(event) {
  if (state.live?.status !== 'live') return;
  const point = livePoint(event);
  if (!point) return;
  event.preventDefault();

  const rect = $('liveScreen').getBoundingClientRect();
  const scale = rect.width ? 1920 / rect.width : 1;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 1080 : 1;
  const wheel = state.liveWheel;
  wheel.dx += event.deltaX * unit * scale;
  wheel.dy += event.deltaY * unit * scale;
  wheel.x = point.x;
  wheel.y = point.y;

  if (wheel.timer) return;
  wheel.timer = setTimeout(() => {
    wheel.timer = null;
    const dx = Math.round(wheel.dx);
    const dy = Math.round(wheel.dy);
    wheel.dx = 0;
    wheel.dy = 0;
    if (!dx && !dy) return;
    const delay = state.liveDelayMs || 0;
    if (delay > 0) {
      wheel.delayTimer = setTimeout(() => {
        sendLive({ type: 'wheel', x: wheel.x, y: wheel.y, deltaX: dx, deltaY: dy });
        wheel.delayTimer = null;
      }, delay);
    } else {
      sendLive({ type: 'wheel', x: wheel.x, y: wheel.y, deltaX: dx, deltaY: dy });
    }
  }, 35);
}

function livePoint(event) {
  const rect = $('liveScreen').getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = ((event.clientX - rect.left) / rect.width) * 1920;
  const y = ((event.clientY - rect.top) / rect.height) * 1080;
  if (x < 0 || y < 0 || x > 1920 || y > 1080) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

function renderLiveActions(live) {
  $('liveCount').textContent = String(live.actions.length);
  if (!live.actions.length) {
    $('liveLog').innerHTML =
      '<li class="live-log-empty">No actions yet. Click a link, button or form field in either half.</li>';
    return;
  }
  $('liveLog').innerHTML = live.actions
    .map((action, index) => {
      const side = action.side === 'staging' ? 'staging' : 'local';
      const target = action.targetSide === 'staging' ? 'staging' : 'local';
      const matched = action.mirrored
        ? `matched by ${matchedByLabel(action.matchedBy)}${action.error ? ` · ${action.error}` : ''}`
        : action.error || 'not mirrored';
      return `<li class="live-entry ${action.mirrored ? '' : 'warn'}" data-action-index="${index}" tabindex="0" role="button" aria-label="${escapeAttr(`Show ${action.label || 'element'} on both pages`)}">
  <span class="live-entry-side ${side}">${side === 'local' ? 'L' : 'S'}</span>
  <span class="live-entry-main">
    <span class="live-entry-label">${escapeHtml(action.label || 'element')}</span>
    <span class="live-entry-meta">${escapeHtml(`${side} → ${target} · ${matched}`)}</span>
  </span>
</li>`;
    })
    .join('');

  $$('.live-entry', $('liveLog')).forEach((entry) => {
    const action = live.actions[Number(entry.dataset.actionIndex)];
    const show = () => {
      if (action) pulseLiveAction(action);
    };
    entry.addEventListener('click', show);
    entry.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        show();
      }
    });
  });
}

function matchedByLabel(value) {
  if (value === 'css') return 'selector';
  if (value === 'role+name') return 'role + text';
  if (value === 'text') return 'text';
  if (value === 'css-path') return 'CSS path';
  return 'element';
}

function pulseLiveAction(action) {
  if (action.bboxPage) addLivePulse(action.bboxPage, 'source', true);
  if (action.targetBboxPage) addLivePulse(action.targetBboxPage, 'target', true);
}

function addLivePulse(rect, tone, box) {
  const layer = $('livePulses');
  if (!layer || !rect) return;
  const pulse = document.createElement('span');
  pulse.className = `live-pulse ${tone}${box ? ' box' : ''}`;
  pulse.style.left = `${(rect.x / 1920) * 100}%`;
  pulse.style.top = `${(rect.y / 1080) * 100}%`;
  if (box) {
    pulse.style.width = `${(rect.width / 1920) * 100}%`;
    pulse.style.height = `${(rect.height / 1080) * 100}%`;
  }
  layer.appendChild(pulse);
  setTimeout(() => pulse.remove(), 780);
}

function appendLiveSystem(message) {
  if (!message) return;
  const box = $('liveSystem');
  const line = document.createElement('span');
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  line.textContent = `${time} · ${message}`;
  box.prepend(line);
  while (box.children.length > 8) box.lastElementChild.remove();
}

function endLive() {
  const live = state.live;
  if (!live) return;
  if (live.socket?.readyState === WebSocket.OPEN) {
    try {
      live.socket.send(JSON.stringify({ type: 'end' }));
    } catch {
      /* ignore */
    }
  }
  closeLivePanel();
}

function closeLivePanel() {
  const live = state.live;
  state.live = null;
  if (live?.socket) {
    try {
      live.socket.close();
    } catch {
      /* ignore */
    }
  }
  if (live?.id) {
    fetch(`/api/session/${encodeURIComponent(live.id)}`, { method: 'DELETE', keepalive: true }).catch(
      () => {},
    );
  }
  $('livePanel').hidden = true;
  $('liveFrame').removeAttribute('src');
  $('livePulses').innerHTML = '';
  $('liveBtn').disabled = false;
  $('results').hidden = live?.prevResultsHidden ?? true;
  $('emptyState').hidden = live?.prevEmptyHidden ?? $('results').hidden;
}

function setBusy(busy) {
  $('compareBtn').disabled = busy;
  $('compareBtn').querySelector('.btn-label').textContent = busy ? 'Comparing…' : 'Compare pages';
  $('demoBtn').disabled = busy;
}

function startTimer() {
  state.startedAt = performance.now();
  const phases = [
    [0, 'Launching Chromium · 1920×1080'],
    [1200, 'Loading local and staging in isolated contexts'],
    [4200, 'Settling fonts, images and lazy content'],
    [7500, 'Computing pixel, content and markup diffs'],
    [12000, 'Still working — tall pages can take a little longer'],
  ];
  const tick = () => {
    const seconds = (performance.now() - state.startedAt) / 1000;
    $('elapsed').textContent = `${seconds.toFixed(1)}s`;
    let detail = phases[0][1];
    for (const [after, label] of phases) if (seconds >= after / 1000) detail = label;
    $('statusDetail').textContent = detail;
  };
  tick();
  state.timer = setInterval(tick, 120);
}

function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

function renderResult(result) {
  state.result = result;
  state.changesOnly = false;
  $('changesOnly').checked = false;
  $('contentDiff').classList.remove('changes-only');

  const { summary, content, markup, visual, local, staging } = result;
  const totalContent = content.stats.added + content.stats.removed + content.stats.changed;
  const totalMarkup = markup.stats.added + markup.stats.removed + markup.stats.changed;

  const badge = $('verdictBadge');
  badge.className = `verdict-badge ${summary.identical ? 'identical' : 'changed'}`;
  badge.textContent = summary.identical ? 'No differences' : 'Differences found';

  $('resultTitle').textContent = `${local.title || hostOf(local.finalUrl) || 'Local'} vs ${staging.title || hostOf(staging.finalUrl) || 'Staging'}`;
  $('resultSub').textContent = `${formatDate(result.createdAt)} · ${formatMs(result.timings.totalMs)} · ${result.engine.viewport.width}×${result.engine.viewport.height} · ${result.engine.screenshotMode}`;

  $('jsonLink').href = `/api/result/${encodeURIComponent(result.id)}?download=1`;
  $('reportLink').href = `/api/report/${encodeURIComponent(result.id)}`;

  $('statChips').innerHTML = [
    chip(visual.available ? formatPercent(visual.ratio) : 'n/a', 'Visual difference', 'pink'),
    chip(formatNumber(content.stats.added), 'New lines in local', 'add'),
    chip(formatNumber(content.stats.removed), 'Removed lines', 'del'),
    chip(formatNumber(content.stats.changed), 'Edited lines', 'mod'),
  ].join('');

  const warnings = result.warnings || [];
  $('warnings').hidden = warnings.length === 0;
  $('warningsList').innerHTML = warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');

  $('tabVisualCount').textContent = visual.available ? formatPercent(visual.ratio) : 'n/a';
  $('tabContentCount').textContent = totalContent ? formatNumber(totalContent) : '0';
  $('tabMarkupCount').textContent = totalMarkup ? formatNumber(totalMarkup) : '0';

  renderVisual(result);
  renderContent(result);
  renderMarkup(result);
  renderDiagnostics(result);

  $('emptyState').hidden = true;
  $('results').hidden = false;
  setVisualMode('side');
  activateTab(visual.available || totalContent || totalMarkup ? 'visual' : 'content');

  requestAnimationFrame(() => {
    const top = $('results').getBoundingClientRect().top + window.scrollY - 82;
    window.scrollTo({ top, behavior: 'smooth' });
  });
}

function chip(value, label, tone) {
  return `<div class="stat-chip ${tone}"><span class="value">${escapeHtml(value)}</span><span class="label">${escapeHtml(label)}</span></div>`;
}

function renderVisual(result) {
  const { visual, local, staging } = result;
  const note = $('visualNote');
  const stage = $('visualStage');

  if (!visual.available) {
    stage.classList.add('hidden');
    note.hidden = false;
    note.textContent = visual.warning || visual.reason || 'Pixel comparison is unavailable for this run.';
    $('diffStats').innerHTML = '';
    $('jumpBtn').hidden = true;
    return;
  }

  stage.classList.remove('hidden');
  note.hidden = !visual.warning;
  if (visual.warning) note.textContent = visual.warning;

  const localUrl = local.screenshot?.url;
  const stagingUrl = staging.screenshot?.url;
  const diffUrl = visual.diffUrl;

  setImage($('localShot'), localUrl);
  setImage($('stagingShot'), stagingUrl);
  setImage($('overlayLocal'), localUrl);
  setImage($('overlayStaging'), stagingUrl);
  setImage($('diffShot'), diffUrl);

  $('localShotLink').href = localUrl || '#';
  $('stagingShotLink').href = stagingUrl || '#';
  $('diffShotLink').href = diffUrl || '#';

  $('localShotMeta').textContent = local.screenshot
    ? `${visual.width}×${visual.local.height}`
    : 'unavailable';
  $('stagingShotMeta').textContent = staging.screenshot
    ? `${visual.width}×${visual.staging.height}`
    : 'unavailable';
  $('diffShotMeta').textContent = `${visual.width}×${visual.height}`;

  const bboxText = visual.bbox ? `first at y ${formatNumber(visual.bbox.y)}` : 'no changed region';
  $('diffStats').innerHTML = [
    `<span class="diff-stat"><b>${formatPercent(visual.ratio)}</b> pixels changed</span>`,
    `<span class="diff-stat"><b>${formatNumber(visual.mismatchPixels)}</b> of ${formatNumber(visual.totalPixels)} px</span>`,
    `<span class="diff-stat"><b>${visual.regions?.length || 0}</b> changed regions · ${escapeHtml(bboxText)}</span>`,
    `<span class="diff-stat"><b>${escapeHtml(result.engine.name)}</b> ${escapeHtml(result.engine.version || '')}</span>`,
  ].join('');

  $('jumpBtn').hidden = !visual.bbox;
  $('overlayFrame').style.setProperty('--overlay-pos', `${$('overlayRange').value}%`);
}

function setImage(element, url) {
  if (url) {
    element.src = url;
    element.classList.remove('hidden');
  } else {
    element.removeAttribute('src');
    element.classList.add('hidden');
  }
}

function setVisualMode(mode) {
  state.visualMode = mode;
  $('visualStage').dataset.mode = mode;
  $$('.seg').forEach((button) => button.classList.toggle('active', button.dataset.visualMode === mode));
  if (mode === 'overlay') {
    $('overlayScroll').scrollTop = $('localScroll').scrollTop;
  }
}

function jumpToFirstChange() {
  const bbox = state.result?.visual?.bbox;
  const img = $('localShot');
  if (!bbox || !img?.naturalHeight) return;
  const scale = img.clientHeight / img.naturalHeight;
  const y = Math.max(0, bbox.y * scale - 42);
  $('localScroll').scrollTop = y;
  $('stagingScroll').scrollTop = y;
  $('overlayScroll').scrollTop = y;
  const diffScroll = $('diffShot').closest('.shot-scroll');
  if (diffScroll) diffScroll.scrollTop = y;
}

function bindSync(first, second) {
  let syncing = false;
  const sync = (from, to) => {
    if (syncing) return;
    syncing = true;
    const fromMax = from.scrollHeight - from.clientHeight;
    const toMax = to.scrollHeight - to.clientHeight;
    if (fromMax > 0 && toMax > 0) to.scrollTop = (from.scrollTop / fromMax) * toMax;
    requestAnimationFrame(() => {
      syncing = false;
    });
  };
  first.addEventListener('scroll', () => sync(first, second), { passive: true });
  second.addEventListener('scroll', () => sync(second, first), { passive: true });
}

function renderContent(result) {
  const { content } = result;
  const stats = content.stats;
  $('contentStats').innerHTML = [
    `<span><b>${stats.similarity}%</b> similar</span>`,
    `<span class="add">+${formatNumber(stats.added)}</span>`,
    `<span class="del">−${formatNumber(stats.removed)}</span>`,
    `<span class="mod">~${formatNumber(stats.changed)}</span>`,
    `<span>${formatNumber(stats.totalOldLines)} → ${formatNumber(stats.totalNewLines)} lines</span>`,
  ].join('');

  if (!content.hunks.length) {
    $('contentDiff').innerHTML = `<div class="empty-note"><b>No visible text changes</b>The rendered text is identical on both pages. Try the Markup tab for attribute-only changes.</div>`;
    return;
  }

  $('contentDiff').innerHTML = content.hunks
    .map((hunk) => {
      const rows = hunk.rows.map(renderContentRow).join('');
      const truncated = hunk.truncated ? '<span class="count"> · truncated</span>' : '';
      return `<div class="hunk">
  <div class="hunk-head"><span>@@ staging ${hunk.oldStart} · local ${hunk.newStart} @@</span><span class="count">${hunk.changes} change${hunk.changes === 1 ? '' : 's'}${truncated}</span></div>
  ${rows}
</div>`;
    })
    .join('');
  $('contentDiff').classList.toggle('changes-only', state.changesOnly);
}

function renderContentRow(row) {
  if (row.kind === 'mod') {
    return `<div class="diff-row mod">
  <div class="ln">${row.oldLine}</div><div class="ln">${row.newLine}</div><div class="marker">~</div>
  <div class="code"><span class="line del">${segmentsHtml(row.oldSegments, 'old')}</span><span class="line add">${segmentsHtml(row.newSegments, 'new')}</span></div>
</div>`;
  }
  if (row.kind === 'add') {
    return `<div class="diff-row add"><div class="ln"></div><div class="ln">${row.newLine}</div><div class="marker">+</div><div class="code">${textOrNbsp(row.newText)}</div></div>`;
  }
  if (row.kind === 'del') {
    return `<div class="diff-row del"><div class="ln">${row.oldLine}</div><div class="ln"></div><div class="marker">−</div><div class="code">${textOrNbsp(row.oldText)}</div></div>`;
  }
  return `<div class="diff-row same"><div class="ln">${row.oldLine}</div><div class="ln">${row.newLine}</div><div class="marker"></div><div class="code">${textOrNbsp(row.oldText)}</div></div>`;
}

function segmentsHtml(segments, mode) {
  if (!segments?.length) return '&nbsp;';
  return segments
    .map((segment) => {
      const text = escapeHtml(segment.t);
      if (segment.k === 'same') return text;
      return `<span class="seg ${segment.k}">${text}</span>`;
    })
    .join('');
}

function textOrNbsp(value) {
  const text = String(value ?? '');
  return text.length ? escapeHtml(text) : '&nbsp;';
}

function renderMarkup(result) {
  const { markup } = result;
  const stats = markup.stats;
  $('markupStats').innerHTML = [
    `<span class="add">+${formatNumber(stats.added)} new</span>`,
    `<span class="del">−${formatNumber(stats.removed)} removed</span>`,
    `<span class="mod">~${formatNumber(stats.changed)} changed</span>`,
    stats.moved ? `<span>${formatNumber(stats.moved)} moved</span>` : '',
    `<span>${formatNumber(stats.compared)} matched nodes</span>`,
  ].join('');

  const groups = [];
  if (markup.changed.length) groups.push(renderMarkupGroup('changed', 'Changed elements', markup.changed, markup.stats.changed, markup.truncated.changed));
  if (markup.added.length) groups.push(renderMarkupGroup('added', 'New in local', markup.added, markup.stats.added, markup.truncated.added));
  if (markup.removed.length) groups.push(renderMarkupGroup('removed', 'Missing from local', markup.removed, markup.stats.removed, markup.truncated.removed));

  $('markupSections').innerHTML = groups.length
    ? groups.join('')
    : `<div class="empty-note"><b>No markup changes</b>Text, links, images and tracked attributes match on both pages.</div>`;

  $$('.el-row').forEach((row) => {
    row.addEventListener('toggle', () => {
      if (!row.open) return;
      const copy = row.querySelector('[data-copy]');
      if (copy) copy.dataset.ready = '1';
    });
  });
  $$('[data-copy]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const value = button.dataset.copy;
      try {
        await navigator.clipboard.writeText(value);
        button.textContent = 'Copied';
        setTimeout(() => {
          button.textContent = 'Copy selector';
        }, 1200);
      } catch {
        button.textContent = 'Copy failed';
      }
    });
  });
  filterMarkup();
}

function renderMarkupGroup(tone, title, items, total, truncated) {
  const rows = items.map((item) => renderMarkupRow(item, tone)).join('');
  const more = truncated ? `<span class="count">· showing ${items.length} of ${formatNumber(total)}</span>` : '';
  return `<section class="change-group" data-group="${tone}">
  <div class="group-head ${tone === 'added' ? 'add' : tone === 'removed' ? 'del' : 'mod'}">
    <h3>${escapeHtml(title)}</h3>
    <span class="count">${formatNumber(total)}</span>
    ${more}
  </div>
  ${rows}
</section>`;
}

function renderMarkupRow(item, tone) {
  const attrSearch = Array.isArray(item.attrs)
    ? item.attrs.map((attr) => `${attr.name} ${attr.from} ${attr.to}`)
    : Object.entries(item.attrs || {}).map(([name, value]) => `${name} ${value}`);
  const search = [
    item.path,
    item.tag,
    item.text?.from,
    item.text?.to,
    item.text,
    ...attrSearch,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const preview =
    tone === 'changed'
      ? `${clip(item.text?.from || '')} → ${clip(item.text?.to || '')}`
      : clip(item.text || (item.attrs ? Object.entries(item.attrs).map(([k, v]) => `${k}=${v}`).join(' ') : ''));

  const body = [];
  if (item.text?.from !== undefined || item.text?.to !== undefined) {
    body.push(`<div class="el-text"><span class="from">${escapeHtml(item.text?.from || '(empty)')}</span><span class="arrow">→</span><span class="to">${escapeHtml(item.text?.to || '(empty)')}</span></div>`);
  } else if (item.text) {
    body.push(`<div class="el-text">${escapeHtml(item.text)}</div>`);
  }
  if (item.attrs?.length) {
    body.push(`<div class="attr-list">${item.attrs
      .map(
        (attr) =>
          `<div class="attr-row"><span class="attr-name">${escapeHtml(attr.name)}</span><span class="attr-val from">${escapeHtml(attr.from || '∅')}</span><span>→</span><span class="attr-val to">${escapeHtml(attr.to || '∅')}</span></div>`,
      )
      .join('')}</div>`);
  } else if (tone !== 'changed' && item.attrs && Object.keys(item.attrs).length) {
    body.push(`<div class="attr-list">${Object.entries(item.attrs)
      .map(
        ([name, value]) =>
          `<div class="attr-row"><span class="attr-name">${escapeHtml(name)}</span><span class="attr-val">${escapeHtml(value)}</span></div>`,
      )
      .join('')}</div>`);
  }
  body.push(`<div class="el-actions"><button type="button" class="mini-btn" data-copy="${escapeAttr(item.path)}">Copy selector</button></div>`);

  return `<details class="el-row" data-search="${escapeAttr(search)}">
  <summary>
    <span class="el-path" title="${escapeAttr(item.path)}">${escapeHtml(item.path)}</span>
    <span class="tag">${escapeHtml(item.tag)}</span>
    <span class="el-preview">${escapeHtml(preview || '(no text)')}</span>
  </summary>
  <div class="el-body">${body.join('')}</div>
</details>`;
}

function filterMarkup() {
  const query = $('markupSearch').value.trim().toLowerCase();
  let visible = 0;
  $$('.change-group').forEach((group) => {
    let groupVisible = 0;
    $$('.el-row', group).forEach((row) => {
      const match = !query || (row.dataset.search || '').includes(query);
      row.classList.toggle('hidden', !match);
      if (match) groupVisible += 1;
    });
    group.classList.toggle('hidden', groupVisible === 0);
    visible += groupVisible;
  });
  let note = document.getElementById('markupFilterEmpty');
  if (!visible && query) {
    if (!note) {
      note = document.createElement('div');
      note.id = 'markupFilterEmpty';
      note.className = 'empty-note';
      note.innerHTML = '<b>No matches</b>Try a shorter selector, tag or text fragment.';
      $('markupSections').appendChild(note);
    }
  } else if (note) {
    note.remove();
  }
}

function renderDiagnostics(result) {
  const cards = [renderDiagCard(result.local, 'Local', 'local'), renderDiagCard(result.staging, 'Staging', 'staging')];
  cards.push(renderRunDetails(result));
  $('diagnostics').innerHTML = cards.join('');
}

function renderDiagCard(side, label, tone) {
  const diag = side.diagnostics || {};
  const issues = [
    ...(diag.pageErrors || []).map((error) => `Page error: ${error}`),
    ...(diag.consoleErrors || []).map((error) => `Console: ${error}`),
    ...(diag.failedRequests || []).map((request) => `Failed: ${request.method} ${request.url} (${request.error})`),
    ...(diag.httpErrors || []).map((error) => `HTTP ${error.status}: ${error.url}`),
  ];
  const warnings = diag.consoleWarnings || [];
  const healthy = issues.length === 0 && (side.httpStatus === null || side.httpStatus < 400);

  const issueBlock = issues.length
    ? `<div class="issue-block"><h4>${issues.length} issue${issues.length === 1 ? '' : 's'}</h4><ul class="issue-list">${issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join('')}</ul></div>`
    : `<p class="ok-line">✓ No console errors, page errors or failed requests</p>`;

  const warningBlock = warnings.length
    ? `<div class="issue-block"><h4>${warnings.length} console warning${warnings.length === 1 ? '' : 's'}</h4><ul class="issue-list">${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></div>`
    : '';

  return `<div class="diag-card">
  <div class="diag-head">
    <span class="shot-dot ${tone}" aria-hidden="true"></span>
    <h3>${escapeHtml(label)}</h3>
    <span class="status-pill ${healthy ? 'good' : 'bad'}">${side.httpStatus ? `HTTP ${side.httpStatus}` : 'no status'}</span>
  </div>
  <div class="diag-body">
    <div class="diag-url">${escapeHtml(side.finalUrl)}</div>
    <div class="kv"><span>Title</span><b>${escapeHtml(side.title || '—')}</b></div>
    <div class="kv"><span>Viewport</span><b>${side.viewport?.width || '?'}×${side.viewport?.height || '?'} @${side.viewport?.dpr || 1}×</b></div>
    <div class="kv"><span>Page height</span><b>${formatNumber(side.documentHeight)} px</b></div>
    <div class="kv"><span>Visible text</span><b>${formatNumber(side.textChars)} chars</b></div>
    <div class="kv"><span>Elements scanned</span><b>${formatNumber(side.elements)}${side.elementsTruncated ? '+' : ''}</b></div>
    <div class="kv"><span>Links / buttons / images</span><b>${side.counts?.links || 0} / ${side.counts?.buttons || 0} / ${side.counts?.images || 0}</b></div>
    <div class="kv"><span>Capture time</span><b>${formatMs(side.timings?.totalMs)}</b></div>
    ${issueBlock}
    ${warningBlock}
  </div>
</div>`;
}

function renderRunDetails(result) {
  const options = result.options || {};
  return `<div class="diag-card" style="grid-column:1/-1">
  <div class="diag-head">
    <span class="shot-dot diff" aria-hidden="true"></span>
    <h3>Run details</h3>
    <span class="status-pill good">completed</span>
  </div>
  <div class="diag-body">
    <div class="kv"><span>Engine</span><b>${escapeHtml(result.engine.name)} ${escapeHtml(result.engine.version || '')}</b></div>
    <div class="kv"><span>Viewport / mode</span><b>${result.engine.viewport.width}×${result.engine.viewport.height} · ${escapeHtml(result.engine.screenshotMode)}</b></div>
    <div class="kv"><span>Wait after load</span><b>${formatNumber(options.settleMs)} ms</b></div>
    <div class="kv"><span>Pixel threshold</span><b>${escapeHtml(String(options.pixelThreshold ?? '—'))}</b></div>
    <div class="kv"><span>Ignore selectors</span><b>${escapeHtml(options.ignoreSelectors?.join(', ') || 'none')}</b></div>
    <div class="kv"><span>Total time</span><b>${formatMs(result.timings.totalMs)}</b></div>
    <div class="kv"><span>Comparison ID</span><b>${escapeHtml(result.id)}</b></div>
  </div>
</div>`;
}

function activateTab(name) {
  state.tab = name;
  $$('.tab').forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  $$('.tab-panel').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
}

function showError(title, message, details = []) {
  $('errorTitle').textContent = title;
  $('errorMessage').textContent = message || 'Something went wrong.';
  $('errorDetails').innerHTML = details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join('');
  $('errorDetails').classList.toggle('hidden', details.length === 0);
  $('errorPanel').hidden = false;
  $('errorPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function hideError() {
  $('errorPanel').hidden = true;
}

function saveForm() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        localUrl: $('localUrl').value,
        stagingUrl: $('stagingUrl').value,
        settleMs: $('settleMs').value,
        pixelThreshold: $('pixelThreshold').value,
        ignoreSelectors: $('ignoreSelectors').value,
        fullPage: $('fullPage').checked,
        ignoreWhitespace: $('ignoreWhitespace').checked,
        compareAttributes: $('compareAttributes').checked,
        normalizeOrigins: $('normalizeOrigins').checked,
        standardUserAgent: $('standardUserAgent').checked,
        scrollPage: $('scrollPage').checked,
        localAuthUsername: $('localAuthUsername').value.trim(),
        stagingAuthUsername: $('stagingAuthUsername').value.trim(),
      }),
    );
  } catch {
    /* storage can be disabled */
  }
}

function restoreForm() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    saved = null;
  }
  if (!saved) return;
  if (saved.localUrl) $('localUrl').value = saved.localUrl;
  if (saved.stagingUrl) $('stagingUrl').value = saved.stagingUrl;
  if (saved.settleMs) $('settleMs').value = saved.settleMs;
  if (saved.pixelThreshold) $('pixelThreshold').value = saved.pixelThreshold;
  if (saved.ignoreSelectors) $('ignoreSelectors').value = saved.ignoreSelectors;
  if (saved.localAuthUsername) $('localAuthUsername').value = saved.localAuthUsername;
  if (saved.stagingAuthUsername) $('stagingAuthUsername').value = saved.stagingAuthUsername;
  for (const id of ['fullPage', 'ignoreWhitespace', 'compareAttributes', 'normalizeOrigins', 'standardUserAgent', 'scrollPage']) {
    if (typeof saved[id] === 'boolean') $(id).checked = saved[id];
  }
}

class RequestError extends Error {
  constructor(data, status) {
    super(data?.message || `Request failed with HTTP ${status}`);
    this.name = 'RequestError';
    this.status = status;
    this.details = data?.details;
    this.field = data?.field;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}

function clip(value, max = 90) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString() : '—';
}

function formatPercent(ratio) {
  if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) return 'n/a';
  const value = Number(ratio) * 100;
  if (value === 0) return '0%';
  if (value < 0.01) return '<0.01%';
  return `${value.toFixed(2)}%`;
}

function formatMs(ms) {
  if (!Number.isFinite(Number(ms))) return '—';
  return Number(ms) < 1000 ? `${Math.round(ms)} ms` : `${(Number(ms) / 1000).toFixed(1)} s`;
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function capitalize(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
