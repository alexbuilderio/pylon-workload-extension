const PANEL_ID = 'pylon-workload-panel';
const BTN_ID   = 'pylon-workload-btn';
const REFRESH_INTERVAL_MS = 60_000;

const NAV_LABELS = ['Customers', 'Support', 'Product', 'Engagement', 'Analytics', 'Knowledge base', 'Agents'];

let apiKey   = null;
let lastData = null;   // cached so the panel opens instantly on repeat views
let isFetching = false;

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
  const stored = await chrome.storage.sync.get('pylonApiKey');
  apiKey = stored.pylonApiKey ?? null;

  chrome.storage.onChanged.addListener(changes => {
    if (changes.pylonApiKey) {
      apiKey = changes.pylonApiKey.newValue ?? null;
      fetchData();
    }
  });

  await waitForNav();
  injectNavButton();
  injectPanel();
  fetchData();
  setInterval(fetchData, REFRESH_INTERVAL_MS);
}

// ── Nav discovery ─────────────────────────────────────────────────────────────

function waitForNav() {
  return new Promise(resolve => {
    if (findNavContainer()) { resolve(); return; }
    const obs = new MutationObserver(() => {
      if (findNavContainer()) { obs.disconnect(); resolve(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  });
}

function findNavContainer() {
  // Find any element whose trimmed text exactly matches a known nav label
  const navItem = Array.from(
    document.querySelectorAll('a, button, [role="menuitem"], [role="button"], li, div')
  ).find(el =>
    !el.id.startsWith('pylon-workload') &&
    NAV_LABELS.some(label => el.textContent.trim() === label)
  );
  if (!navItem) return null;

  // Walk up to a container that wraps at least 3 nav items
  let parent = navItem.parentElement;
  while (parent && parent !== document.body) {
    const hits = Array.from(parent.children).filter(ch =>
      NAV_LABELS.some(label => ch.textContent.trim().startsWith(label))
    );
    if (hits.length >= 3) return parent;
    parent = parent.parentElement;
  }
  return navItem.parentElement;
}

// ── Nav button ────────────────────────────────────────────────────────────────

function injectNavButton() {
  if (document.getElementById(BTN_ID)) return;

  const container = findNavContainer();
  if (!container) return;

  // Mirror the tag/class of the first real nav item so we inherit Pylon's styles
  const firstItem = Array.from(container.children).find(ch =>
    NAV_LABELS.some(label => ch.textContent.trim().startsWith(label))
  );

  const tagName = firstItem?.tagName.toLowerCase() ?? 'button';
  const btn = document.createElement(tagName);
  btn.id = BTN_ID;
  if (firstItem) btn.className = firstItem.className;

  // Bar-chart SVG icon (same weight as Pylon's Heroicons)
  btn.innerHTML = `
    <span class="pwd-nav-icon" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="1"  y="9" width="3" height="6" rx="1" fill="currentColor"/>
        <rect x="6"  y="5" width="3" height="10" rx="1" fill="currentColor"/>
        <rect x="11" y="2" width="3" height="13" rx="1" fill="currentColor"/>
      </svg>
    </span>
    <span class="pwd-nav-label">Workload</span>
  `;

  if (tagName === 'a') btn.href = '#';
  btn.addEventListener('click', e => { e.preventDefault(); togglePanel(); });
  container.appendChild(btn);
}

// ── Panel ─────────────────────────────────────────────────────────────────────

function injectPanel() {
  if (document.getElementById(PANEL_ID)) return;

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Workload Dashboard');
  panel.innerHTML = `
    <div class="pwd-header">
      <div class="pwd-header-left">
        <span class="pwd-header-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="1"  y="9" width="3" height="6" rx="1" fill="currentColor"/>
            <rect x="6"  y="5" width="3" height="10" rx="1" fill="currentColor"/>
            <rect x="11" y="2" width="3" height="13" rx="1" fill="currentColor"/>
          </svg>
        </span>
        <span class="pwd-title">Workload</span>
      </div>
      <div class="pwd-header-actions">
        <button class="pwd-btn pwd-btn-refresh" title="Refresh">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M13.5 2.5A7 7 0 1 0 14.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M14.5 2.5V6h-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="pwd-btn pwd-btn-close" title="Close">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="pwd-body">
      <div class="pwd-state pwd-state--loading">Loading…</div>
    </div>
  `;

  panel.querySelector('.pwd-btn-refresh').addEventListener('click', () => fetchData(true));
  panel.querySelector('.pwd-btn-close').addEventListener('click', closePanel);

  document.body.appendChild(panel);
}

// ── Panel open / close ────────────────────────────────────────────────────────

function togglePanel() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;

  const isOpen = panel.classList.contains('pwd-open');
  isOpen ? closePanel() : openPanel();
}

function openPanel() {
  const panel = document.getElementById(PANEL_ID);
  const btn   = document.getElementById(BTN_ID);
  if (!panel) return;

  // Position panel just to the right of the nav button's bounding column
  positionPanel(panel, btn);
  panel.classList.add('pwd-open');
  btn?.classList.add('pwd-nav-active');

  // Render whatever we already have (or the loading state if still fetching)
  const body = panel.querySelector('.pwd-body');
  if (lastData) renderAssignees(body, lastData);
}

function closePanel() {
  const panel = document.getElementById(PANEL_ID);
  const btn   = document.getElementById(BTN_ID);
  panel?.classList.remove('pwd-open');
  btn?.classList.remove('pwd-nav-active');
}

function positionPanel(panel, btn) {
  // Find the sidebar's right edge; fall back to the button's right edge
  let leftPx = 220;
  const anchor = btn?.closest('nav, [class*="sidebar"], [class*="Sidebar"]') ?? btn;
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    leftPx = rect.right;
  }
  panel.style.left = `${leftPx}px`;
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchData(forceSpinner = false) {
  if (isFetching) return;

  const panel = document.getElementById(PANEL_ID);
  const isOpen = panel?.classList.contains('pwd-open');
  const body = panel?.querySelector('.pwd-body');

  if (!apiKey) {
    if (isOpen && body) {
      body.innerHTML = `<div class="pwd-state pwd-state--warn">
        No API key set.<br>Click the extension icon to configure.
      </div>`;
    }
    return;
  }

  if (isOpen && body && (forceSpinner || !lastData)) {
    body.innerHTML = '<div class="pwd-state pwd-state--loading">Loading…</div>';
  }

  isFetching = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'FETCH_WORKLOAD', apiKey });

    if (result?.error) {
      lastData = null;
      if (isOpen && body) {
        body.innerHTML = `<div class="pwd-state pwd-state--error">⚠ ${escHtml(result.error)}</div>`;
      }
      return;
    }

    lastData = result ?? [];
    if (isOpen && body) renderAssignees(body, lastData);
  } catch (err) {
    if (isOpen && body) {
      body.innerHTML = `<div class="pwd-state pwd-state--error">⚠ ${escHtml(err.message)}</div>`;
    }
  } finally {
    isFetching = false;
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderAssignees(container, assignees) {
  if (!assignees.length) {
    container.innerHTML = '<div class="pwd-state">No active tickets 🎉</div>';
    return;
  }

  const topScore = assignees[0].score || 1;

  const rows = assignees.map(a => {
    const pct  = Math.round((a.score / topScore) * 100);
    const tier = pct > 66 ? 'high' : pct > 33 ? 'med' : 'low';

    const newBadge = a.newCount
      ? `<span class="pwd-tag pwd-tag--new">${a.newCount} new</span>` : '';
    const waitBadge = a.waitingCount
      ? `<span class="pwd-tag pwd-tag--wait">${a.waitingCount} on you</span>` : '';

    return `
      <div class="pwd-row">
        <div class="pwd-row-top">
          <span class="pwd-name" title="${escHtml(a.email)}">${escHtml(a.name)}</span>
          <span class="pwd-score pwd-score--${tier}">${a.score}pt${a.score !== 1 ? 's' : ''}</span>
        </div>
        <div class="pwd-tags">${newBadge}${waitBadge}</div>
        <div class="pwd-bar-track">
          <div class="pwd-bar pwd-bar--${tier}" style="width:${pct}%"></div>
        </div>
      </div>`;
  }).join('');

  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  container.innerHTML = `
    ${rows}
    <div class="pwd-footer">Updated ${ts} · ${assignees.length} assignee${assignees.length !== 1 ? 's' : ''}</div>
  `;
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

init();
