// Admin › Clients — client directory and client profile (Corte 4).
// Directory: search, lifecycle filter with counts, tag, city/ZIP, sort, pages.
// Profile (modal): 9 tabs — Summary · Requests & projects · Payments & balance ·
// Messages (through support) · Internal notes · Tasks · Consents & communications ·
// Campaigns received · History — and the actions: new request for the client,
// note, task, message, tags (VIP / blocked), resend access.
// Money tabs and figures only show for team roles with 'finance' (the API enforces it).
(function () {
  'use strict';
  const E = (s) => HP.esc(s);
  const LC = {
    lead: ['Lead', 'muted'], prospect: ['Prospect', 'warn'], active: ['Active', 'info'],
    customer: ['Customer', 'ok'], lost: ['Lost', 'muted'],
  };
  const TABS = [
    ['summary', 'Summary'], ['work', 'Requests & projects'], ['money', 'Payments & balance'], ['messages', 'Messages'],
    ['notes', 'Internal notes'], ['tasks', 'Tasks'], ['consents', 'Consents & comms'], ['campaigns', 'Campaigns'], ['history', 'History'],
  ];
  const state = { q: '', lifecycle: '', tag: '', city: '', sort: 'recent', page: 1 };
  let canMoney = null, trades = null, team = null;

  // Dates come as SQLite text ("2026-11-03 10:00:00", UTC) or ISO; show both the same way.
  function when(v, withTime) {
    if (!v) return '—';
    const s = String(v);
    const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return E(s);
    const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return withTime ? day + ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : day;
  }
  const lcBadge = (l) => HP.badge((LC[l] || [l])[0], (LC[l] || [0, 'muted'])[1]);
  const tagChips = (tags) => (tags || []).map((t) => HP.badge(t === 'vip' ? '★ VIP' : t === 'blocked' ? '⛔ Blocked' : t, t === 'blocked' ? 'err' : t === 'vip' ? 'warn' : 'muted')).join(' ');
  const table = (head, rows) => `<div class="table-scroll"><table><thead><tr>${head.map((h) => `<th>${E(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const empty = (t) => `<p class="small muted">${E(t)}</p>`;
  const errBox = (e) => `<div class="banner banner-warn">${E(HP.friendlyMessage(e))}</div>`;

  // ------------------------------------------------------------------ directory
  async function loadDirectory() {
    const box = document.getElementById('client-directory');
    if (!box) return;
    if (!box.dataset.ready) {
      box.dataset.ready = '1';
      box.innerHTML = `
        <form id="cl-filters" class="filter-grid" role="search">
          <div class="field" style="margin:0"><label for="cl-q" class="small">Search name, email, phone or #id</label><input id="cl-q" type="search" autocomplete="off"></div>
          <div class="field" style="margin:0"><label for="cl-tag" class="small">Tag</label><select id="cl-tag"><option value="">All tags</option></select></div>
          <div class="field" style="margin:0"><label for="cl-city" class="small">City or ZIP</label><input id="cl-city" type="text" autocomplete="off"></div>
          <div class="field" style="margin:0"><label for="cl-sort" class="small">Sort</label><select id="cl-sort">
            <option value="recent">Last activity</option><option value="created">Newest client</option><option value="name">Name</option><option value="spend" data-money>Total spent</option></select></div>
        </form>
        <div id="cl-lc" class="btn-row" style="margin:.75rem 0;flex-wrap:wrap" role="group" aria-label="Lifecycle"></div>
        <div id="cl-list" aria-live="polite"></div>`;
      let timer;
      const go = () => { state.page = 1; refresh(); };
      document.getElementById('cl-q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { state.q = e.target.value; go(); }, 250); });
      document.getElementById('cl-city').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { state.city = e.target.value; go(); }, 300); });
      document.getElementById('cl-tag').addEventListener('change', (e) => { state.tag = e.target.value; go(); });
      document.getElementById('cl-sort').addEventListener('change', (e) => { state.sort = e.target.value; go(); });
      document.getElementById('cl-filters').addEventListener('submit', (e) => e.preventDefault());
      HP.api('GET', '/clients/tags').then((tags) => {
        const sel = document.getElementById('cl-tag');
        tags.forEach((t) => sel.appendChild(HP.el(`<option value="${E(t.tag)}">${E(t.tag)} (${t.count})</option>`)));
      }).catch(() => {});
    }
    await refresh();
  }

  async function refresh() {
    const list = document.getElementById('cl-list');
    list.innerHTML = '<p class="muted">Loading clients…</p>';
    const qs = new URLSearchParams(Object.entries(state).filter(([, v]) => v !== '' && v != null)).toString();
    try {
      const r = await HP.api('GET', '/clients?' + qs);
      if (canMoney === null) canMoney = r.rows.length ? r.rows[0].spend_cents !== undefined : false;
      if (!canMoney) { const o = document.querySelector('#cl-sort option[data-money]'); if (o) o.remove(); }
      const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
      document.getElementById('cl-lc').innerHTML = [['', 'All', total], ...Object.keys(LC).map((k) => [k, LC[k][0], r.counts[k] || 0])]
        .map(([k, label, n]) => `<button type="button" class="btn btn-sm ${state.lifecycle === k ? 'btn-dark' : 'btn-outline'}" data-lc="${k}" aria-pressed="${state.lifecycle === k}">${E(label)} · ${n}</button>`).join('');
      document.querySelectorAll('#cl-lc [data-lc]').forEach((b) => b.addEventListener('click', () => { state.lifecycle = b.dataset.lc; state.page = 1; refresh(); }));
      if (!r.rows.length) { list.innerHTML = HP.emptyState('No clients found', total ? 'Nothing matches these filters.' : 'Clients appear here when they create an account.'); return; }
      const pages = Math.max(1, Math.ceil(r.total / r.per_page));
      list.innerHTML = table(['Client', 'Status', 'City', 'Requests', 'Projects', ...(canMoney ? ['Spent'] : []), 'Last activity'], r.rows.map((c) => `
        <tr>
          <td><button type="button" class="linklike" data-open-client="${c.id}" style="background:none;border:0;padding:0;color:var(--navy);font-weight:700;cursor:pointer;text-align:left">${E(c.name)}</button>
            <div class="small muted">#${c.id} · ${E(c.email)}</div><div>${tagChips(c.tags)}</div></td>
          <td>${lcBadge(c.lifecycle)}</td>
          <td>${E(c.city || '—')} ${c.zip ? `<span class="small muted">${E(c.zip)}</span>` : ''}</td>
          <td>${c.requests}</td><td>${c.projects}${c.completed ? ` <span class="small muted">(${c.completed} done)</span>` : ''}</td>
          ${canMoney ? `<td>${HP.fmtMoney(c.spend_cents)}</td>` : ''}
          <td>${when(c.last_activity)}</td>
        </tr>`)) + `<div class="btn-row" style="justify-content:space-between;align-items:center;margin-top:.6rem">
          <span class="small muted">${r.total} client${r.total === 1 ? '' : 's'} · page ${r.page} of ${pages}</span>
          <span><button type="button" class="btn btn-outline btn-sm" data-pg="-1" ${r.page <= 1 ? 'disabled' : ''}>Previous</button>
          <button type="button" class="btn btn-outline btn-sm" data-pg="1" ${r.page >= pages ? 'disabled' : ''}>Next</button></span></div>`;
      list.querySelectorAll('[data-open-client]').forEach((b) => b.addEventListener('click', () => openClient(Number(b.dataset.openClient))));
      list.querySelectorAll('[data-pg]').forEach((b) => b.addEventListener('click', () => { state.page += Number(b.dataset.pg); refresh(); }));
    } catch (e) { list.innerHTML = errBox(e); }
  }

  // ------------------------------------------------------------------ profile
  let current = null, lastFocus = null;
  function modal() {
    let m = document.getElementById('client-modal');
    if (m) return m;
    m = HP.el(`<div class="modal-backdrop" id="client-modal" hidden>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="cm-title" style="max-width:1000px">
        <div class="modal-head"><h2 id="cm-title">Client</h2><button class="modal-close" type="button" aria-label="Close">×</button></div>
        <div class="modal-body">
          <div id="cm-head"></div>
          <div class="tabs" id="cm-tabs" role="tablist" style="margin-top:.75rem"></div>
          <div id="cm-panel" role="tabpanel"></div>
        </div>
      </div></div>`);
    document.body.appendChild(m);
    const close = () => { m.hidden = true; document.body.style.overflow = ''; if (lastFocus) lastFocus.focus(); if (current && current.dirty) refresh(); current = null; };
    m.querySelector('.modal-close').addEventListener('click', close);
    m.addEventListener('click', (e) => { if (e.target === m) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !m.hidden) close(); });
    return m;
  }

  async function openClient(id, tab) {
    lastFocus = document.activeElement;
    const m = modal();
    m.hidden = false; document.body.style.overflow = 'hidden';
    current = { id, tab: tab || 'summary', dirty: false };
    document.getElementById('cm-title').textContent = `Client #${id}`;
    document.getElementById('cm-head').innerHTML = '<p class="muted">Loading…</p>';
    document.getElementById('cm-panel').innerHTML = '';
    try {
      const s = await HP.api('GET', `/clients/${id}`);
      current.summary = s;
      if (canMoney === null) canMoney = s.spend_cents !== undefined;
      renderHead(s);
      const tabs = TABS.filter(([k]) => k !== 'money' || canMoney);
      document.getElementById('cm-tabs').innerHTML = tabs.map(([k, label]) => `<button class="tab${k === current.tab ? ' active' : ''}" role="tab" type="button" data-cm-tab="${k}" aria-selected="${k === current.tab}">${E(label)}</button>`).join('');
      document.querySelectorAll('[data-cm-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.cmTab)));
      m.querySelector('.modal-close').focus();
      showTab(current.tab);
    } catch (e) { document.getElementById('cm-head').innerHTML = errBox(e); }
  }

  function renderHead(s) {
    document.getElementById('cm-title').textContent = `${s.name} · client #${s.id}`;
    document.getElementById('cm-head').innerHTML = `
      ${s.blocked ? '<div class="banner banner-warn" role="status">⛔ Blocked — this client cannot create requests or accept quotes. Their history stays visible.</div>' : ''}
      <div style="display:flex;gap:.6rem;align-items:center;flex-wrap:wrap">${lcBadge(s.lifecycle)} ${tagChips(s.tags)}</div>
      <div class="btn-row" style="margin-top:.75rem;flex-wrap:wrap">
        <button class="btn btn-dark btn-sm" type="button" data-act="request" ${s.blocked ? 'disabled title="Unblock first"' : ''}>New request for client</button>
        <button class="btn btn-outline btn-sm" type="button" data-act="note">Add note</button>
        <button class="btn btn-outline btn-sm" type="button" data-act="task">Add task</button>
        <button class="btn btn-outline btn-sm" type="button" data-act="message">Message client</button>
        <button class="btn btn-outline btn-sm" type="button" data-act="tags">Tags</button>
        <button class="btn btn-outline btn-sm" type="button" data-act="vip">${s.vip ? 'Remove VIP' : 'Mark VIP'}</button>
        <button class="btn btn-outline btn-sm" type="button" data-act="block">${s.blocked ? 'Unblock' : 'Block'}</button>
        <button class="btn btn-outline btn-sm" type="button" data-act="access">Resend access</button>
      </div>`;
    document.querySelectorAll('#cm-head [data-act]').forEach((b) => b.addEventListener('click', () => ACTIONS[b.dataset.act](b)));
  }

  async function showTab(k) {
    current.tab = k;
    document.querySelectorAll('[data-cm-tab]').forEach((b) => { const on = b.dataset.cmTab === k; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
    const p = document.getElementById('cm-panel');
    p.innerHTML = '<p class="muted">Loading…</p>';
    try { p.innerHTML = await RENDER[k](current.id); WIRE[k] && WIRE[k](p); } catch (e) { p.innerHTML = errBox(e); }
  }
  const reloadTab = () => showTab(current.tab);
  async function reloadHead() { current.dirty = true; const s = await HP.api('GET', `/clients/${current.id}`); current.summary = s; renderHead(s); }

  const RENDER = {
    async summary() {
      const s = current.summary;
      return `<dl class="kv">
        <dt>Email</dt><dd>${E(s.email)} ${s.email_verified ? HP.badge('verified', 'ok') : HP.badge('not verified', 'warn')}</dd>
        <dt>Phone</dt><dd>${E(s.phone || '—')} ${s.sms_opted_in ? HP.badge('texts OK', 'ok') : HP.badge('no texts', 'muted')}</dd>
        <dt>City</dt><dd>${E([s.city, s.zip].filter(Boolean).join(' ') || '—')}</dd>
        <dt>Client since</dt><dd>${when(s.created_at)}</dd>
        <dt>Last activity</dt><dd>${when(s.last_activity, true)}</dd>
        <dt>Services used</dt><dd>${E((s.services || []).join(', ') || '—')}</dd>
        <dt>Requests / projects</dt><dd>${s.requests} / ${s.projects} (${s.completed} completed)</dd>
        ${canMoney ? `<dt>Total spent</dt><dd>${HP.fmtMoney(s.spend_cents)}</dd><dt>Balance due</dt><dd>${HP.fmtMoney(s.balance_due_cents)}</dd>` : ''}
        <dt>Open problems</dt><dd>${s.open_disputes ? HP.badge(s.open_disputes + ' open', 'err') : 'None'}</dd>
        <dt>Open tasks</dt><dd>${s.open_tasks}</dd>
        <dt>Marketing email</dt><dd>${s.marketing_unsubscribed ? HP.badge('unsubscribed', 'muted') : 'Subscribed'}</dd>
      </dl>
      <h4>Pinned notes</h4>${s.pinned_notes.length ? s.pinned_notes.map((n) => `<div class="card" style="padding:.6rem .8rem;margin:.4rem 0"><div>${E(n.body)}</div><div class="small muted">${E(n.author || '')} · ${when(n.created_at)}</div></div>`).join('') : empty('No pinned notes.')}
      <h4>Recent reviews</h4>${s.reviews.length ? s.reviews.map((r) => `<div class="small">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)} project #${r.project_id} — ${E(r.comment || '')}</div>`).join('') : empty('No reviews yet.')}`;
    },
    async work(id) {
      const w = await HP.api('GET', `/clients/${id}/work`);
      return `<h4>Requests</h4>${w.requests.length ? table(['#', 'Service', 'Status', 'Where', 'Quotes', 'Created'], w.requests.map((r) => `<tr>
          <td>#${r.id}${r.guest ? ' <span class="small muted">(guest)</span>' : ''}</td><td>${E(r.service_type)}${r.urgency === 'urgent' ? ' ' + HP.badge('urgent', 'warn') : ''}<div class="small muted">${E(String(r.description || '').slice(0, 90))}</div></td>
          <td>${HP.badge(HP.JOB_STATUS[r.status] || r.status, HP.statusKind(r.status))}</td><td>${E([r.address, r.city, r.zip].filter(Boolean).join(', '))}</td>
          <td>${r.quotes.map((q) => `<div class="small">#${q.id} ${HP.fmtMoney(q.customer_price_cents)} · ${E(q.status)}</div>`).join('') || '—'}</td><td>${when(r.created_at)}</td></tr>`)) : empty('No requests yet.')}
        <h4>Projects</h4>${w.projects.length ? table(['#', 'Service', 'Stage', 'Pro', 'Visit', 'Price'], w.projects.map((p) => `<tr>
          <td>#${p.id}</td><td>${E(p.service_type)}</td><td>${HP.badge(HP.PROJECT_STAGE[p.stage] || p.stage, HP.statusKind(p.stage))}</td>
          <td>${E(p.contractor || '—')}</td><td>${p.scheduled_start ? when(p.scheduled_start) : '—'} ${E(p.arrival_window || '')}</td><td>${HP.fmtMoney(p.customer_price_cents)}</td></tr>`)) : empty('No projects yet.')}`;
    },
    async money(id) {
      const m = await HP.api('GET', `/clients/${id}/money`);
      return `<dl class="kv"><dt>Paid</dt><dd>${HP.fmtMoney(m.totals.paid_cents)}</dd><dt>Refunded</dt><dd>${HP.fmtMoney(m.totals.refunded_cents)}</dd>
          <dt>Net</dt><dd><strong>${HP.fmtMoney(m.totals.net_cents)}</strong></dd><dt>Balance due</dt><dd>${HP.fmtMoney(m.totals.balance_due_cents)}</dd></dl>
        <h4>By project</h4>${m.projects.length ? table(['Project', 'Stage', 'Price', 'Paid', 'Balance', 'Card on file', 'Balance charge'], m.projects.map((p) => `<tr>
          <td>#${p.project_id} ${E(p.service_type)}</td><td>${E(HP.PROJECT_STAGE[p.stage] || p.stage)}</td><td>${HP.fmtMoney(p.price_cents)}</td><td>${HP.fmtMoney(p.paid_cents)}</td>
          <td>${HP.fmtMoney(p.balance_cents)}</td><td>${p.card_on_file ? '✓' : '—'}</td><td>${E(p.balance_charge_status || '—')}</td></tr>`)) : empty('No projects.')}
        <h4>Payments</h4>${m.payments.length ? table(['Date', 'Project', 'Kind', 'Amount', 'Status', 'Method'], m.payments.map((x) => `<tr>
          <td>${when(x.created_at)}</td><td>#${x.project_id}</td><td>${E(x.kind)}</td><td>${x.kind === 'refund' ? '−' : ''}${HP.fmtMoney(x.amount_cents)}</td><td>${E(x.status)}</td><td>${E(x.provider)}</td></tr>`)) : empty('No payments.')}
        ${m.chargebacks.length ? `<h4>Card disputes</h4>${table(['Date', 'Project', 'Amount', 'Reason', 'Status'], m.chargebacks.map((c) => `<tr><td>${when(c.created_at)}</td><td>#${c.project_id}</td><td>${HP.fmtMoney(c.amount_cents)}</td><td>${E(c.reason || '')}</td><td>${E(c.status)}</td></tr>`))}` : ''}
        <p class="small muted">To charge a balance or refund, use Collections or the project. Card numbers are never stored by Helpman.</p>`;
    },
    async messages(id) {
      const m = await HP.api('GET', `/clients/${id}/messages`);
      current.projects = m.projects;
      const threads = m.threads.map((t) => `<div class="card" style="padding:.75rem 1rem;margin:.5rem 0"><strong>Project #${t.project_id} — ${E(t.service_type || '')}</strong>
        ${t.messages.length ? t.messages.map((x) => `<div style="margin:.4rem 0;padding:.4rem .6rem;border-radius:8px;background:${x.sender_role === 'admin' ? '#eef4ff' : '#f6f8fb'}">
          <div class="small muted">${E(x.sender_role === 'admin' ? 'Helpman support' : 'Client')} · ${E(x.sender_name || '')} · ${when(x.created_at, true)} ${x.flagged ? HP.badge('⚠ ' + (x.flag_reason || 'flagged'), 'err') : ''}</div>
          <div>${E(x.body)}</div></div>`).join('') : empty('No messages yet.')}</div>`).join('');
      const emails = m.emails.map((x) => `<div class="card" style="padding:.6rem .8rem;margin:.4rem 0"><div class="small muted">Email from support · ${E(x.author || '')} · ${when(x.created_at, true)}</div><strong>${E(x.subject)}</strong><div style="white-space:pre-wrap">${E(x.body)}</div></div>`).join('');
      return `<p class="small muted">All messages go through Helpman support. The client never gets a pro's contact details, and the pro never gets the client's.</p>
        <button class="btn btn-dark btn-sm" type="button" data-act2="message">Message client</button>
        <h4>Project conversations</h4>${threads || empty('No project conversations yet.')}
        <h4>Emails from support</h4>${emails || empty('No emails sent from the profile yet.')}`;
    },
    async notes(id) {
      const n = await HP.api('GET', `/clients/${id}/notes`);
      return `<p class="small muted">Internal only: the client never sees these notes.</p>
        <form id="cm-note-form" class="card" style="padding:.75rem 1rem" novalidate>
          <div class="field"><label for="cm-note">New note</label><textarea id="cm-note" name="body" rows="3" maxlength="4000"></textarea><span class="field-error" data-error-for="body"></span></div>
          <label class="small"><input type="checkbox" name="pinned"> Pin to the summary</label>
          <div class="btn-row"><button class="btn btn-dark btn-sm" type="submit">Save note</button></div></form>
        ${n.length ? n.map((x) => `<div class="card" style="padding:.6rem .8rem;margin:.4rem 0" data-note="${x.id}">
          <div style="white-space:pre-wrap">${E(x.body)}</div>
          <div class="small muted" style="display:flex;gap:.6rem;align-items:center;flex-wrap:wrap">${x.pinned ? HP.badge('pinned', 'info') : ''} ${E(x.author || '')} · ${when(x.created_at, true)}
            <button type="button" class="btn btn-outline btn-sm" data-pin="${x.pinned ? 0 : 1}">${x.pinned ? 'Unpin' : 'Pin'}</button>
            <button type="button" class="btn btn-outline btn-sm" data-del>Delete</button></div></div>`).join('') : empty('No notes yet.')}`;
    },
    async tasks(id) {
      const t = await HP.api('GET', `/clients/${id}/tasks`);
      return `<button class="btn btn-dark btn-sm" type="button" data-act2="task">Add task</button>
        ${t.length ? table(['Task', 'Due', 'Assigned to', 'Status', ''], t.map((x) => `<tr>
          <td><strong>${E(x.title)}</strong>${x.kind !== 'manual' ? ` <span class="small muted">(automatic: ${E(x.kind)})</span>` : ''}${x.notes ? `<div class="small muted">${E(x.notes)}</div>` : ''}${x.job_request_id ? `<div class="small muted">Request #${x.job_request_id}</div>` : ''}</td>
          <td>${x.due_at ? when(x.due_at) : '—'}</td><td>${E(x.assigned_name || '—')}</td><td>${HP.badge(x.status, x.status === 'done' ? 'ok' : 'warn')}</td>
          <td><button type="button" class="btn btn-outline btn-sm" data-task="${x.id}" data-to="${x.status === 'done' ? 'open' : 'done'}">${x.status === 'done' ? 'Reopen' : 'Mark done'}</button></td></tr>`)) : empty('No tasks for this client.')}`;
    },
    async consents(id) {
      const c = await HP.api('GET', `/clients/${id}/consents`);
      return `<h4>Consents</h4><dl class="kv">
          <dt>Email</dt><dd>${E(c.email.address)} ${c.email.verified ? HP.badge('verified', 'ok') : HP.badge('not verified', 'warn')}</dd>
          <dt>Marketing email</dt><dd>${c.email.marketing.unsubscribed ? `${HP.badge('unsubscribed', 'muted')} <span class="small muted">${E(c.email.marketing.reason || '')} · ${when(c.email.marketing.since)}</span>` : `Subscribed <button type="button" class="btn btn-outline btn-sm" data-unsub>Unsubscribe (client asked)</button>`}</dd>
          ${c.sms.map((s) => `<dt>Texts to ${E(s.phone)}</dt><dd>${s.opted_in ? HP.badge('opted in', 'ok') : HP.badge('no consent', 'muted')} <span class="small muted">${E(s.source || '')} ${s.updated_at ? '· ' + when(s.updated_at) : ''}</span></dd>`).join('')}
        </dl>
        <h4>Terms accepted</h4>${c.terms.length ? table(['When', 'What', 'Version'], c.terms.map((t) => `<tr><td>${when(t.accepted_at, true)}</td><td>${E(t.kind === 'client_quote' ? 'Quote #' + t.reference_id : t.kind)}</td><td>${E(t.terms_version)}</td></tr>`)) : empty('No terms accepted yet.')}
        <h4>Card authorizations (30/70)</h4>${c.card_authorizations.length ? table(['Project', 'Authorized', 'Text version', 'Revoked'], c.card_authorizations.map((a) => `<tr><td>#${a.project_id}</td><td>${when(a.authorized_at, true)}</td><td>${E(a.consent_text_version)}</td><td>${a.revoked_at ? when(a.revoked_at) : '—'}</td></tr>`)) : empty('None.')}
        <h4>Emails sent</h4>${c.communications.emails.length ? table(['When', 'Subject', 'Status'], c.communications.emails.map((m) => `<tr><td>${when(m.created_at, true)}</td><td>${E(m.subject)}</td><td>${E(m.status)}</td></tr>`)) : empty('No emails yet.')}
        <h4>Texts sent</h4>${c.communications.texts.length ? table(['When', 'Kind', 'Text', 'Status'], c.communications.texts.map((m) => `<tr><td>${when(m.created_at, true)}</td><td>${E(m.kind || '')}</td><td class="small">${E(m.body)}</td><td>${E(m.status)}</td></tr>`)) : empty('No texts yet.')}`;
    },
    async campaigns(id) {
      const c = await HP.api('GET', `/clients/${id}/campaigns`);
      return c.length ? table(['When', 'Campaign', 'Subject', 'Status'], c.map((o) => `<tr><td>${when(o.sent_at || o.created_at, true)}</td><td>${E(o.campaign || '—')}</td><td>${E(o.subject)}</td><td>${E(o.status)}${o.error ? `<div class="small muted">${E(o.error)}</div>` : ''}</td></tr>`))
        : empty('This client has not received any campaign.');
    },
    async history(id) {
      const h = await HP.api('GET', `/clients/${id}/history`);
      const ICON = { account: '👤', request: '📝', quote: '💬', project: '🛠', payment: '💳', dispute: '⚠', review: '★', staff: '🗂', campaign: '✉' };
      return h.length ? `<ol style="list-style:none;padding:0;margin:0">${h.map((e) => `<li style="display:flex;gap:.6rem;padding:.45rem 0;border-bottom:1px solid var(--line)">
        <span aria-hidden="true">${ICON[e.kind] || '•'}</span><span style="flex:1">${E(e.text)}</span><span class="small muted" style="white-space:nowrap">${when(e.at, true)}</span></li>`).join('')}</ol>` : empty('Nothing yet.');
    },
  };

  const WIRE = {
    notes(p) {
      p.querySelector('#cm-note-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target, btn = f.querySelector('button[type=submit]');
        HP.busy(btn, true, 'Saving…');
        try { await HP.api('POST', `/clients/${current.id}/notes`, { body: f.body.value, pinned: f.pinned.checked }); HP.toast('Note saved.', 'ok'); await reloadHead(); reloadTab(); }
        catch (err) { HP.handleFormError(f, err); HP.busy(btn, false); }
      });
      p.querySelectorAll('[data-note]').forEach((card) => {
        const nid = card.dataset.note;
        card.querySelector('[data-pin]').addEventListener('click', async (e) => { try { await HP.api('PATCH', `/clients/${current.id}/notes/${nid}`, { pinned: e.target.dataset.pin === '1' }); await reloadHead(); reloadTab(); } catch (err) { HP.toast(HP.friendlyMessage(err), 'error'); } });
        card.querySelector('[data-del]').addEventListener('click', async () => {
          if (!confirm('Delete this note? The deletion is recorded in the audit log.')) return;
          try { await HP.api('DELETE', `/clients/${current.id}/notes/${nid}`); HP.toast('Note deleted.', 'ok'); reloadTab(); } catch (err) { HP.toast(HP.friendlyMessage(err), 'error'); }
        });
      });
    },
    tasks(p) {
      p.querySelector('[data-act2="task"]').addEventListener('click', () => ACTIONS.task());
      p.querySelectorAll('[data-task]').forEach((b) => b.addEventListener('click', async () => {
        try { await HP.api('PATCH', `/clients/${current.id}/tasks/${b.dataset.task}`, { status: b.dataset.to }); current.dirty = true; reloadTab(); } catch (err) { HP.toast(HP.friendlyMessage(err), 'error'); }
      }));
    },
    messages(p) { p.querySelector('[data-act2="message"]').addEventListener('click', () => ACTIONS.message()); },
    consents(p) {
      const b = p.querySelector('[data-unsub]');
      if (b) b.addEventListener('click', async () => {
        if (!confirm('Record that the client asked to stop marketing emails? Only the client can opt in again.')) return;
        try { await HP.api('POST', `/clients/${current.id}/marketing-unsubscribe`, {}); HP.toast('Unsubscribed from marketing.', 'ok'); await reloadHead(); reloadTab(); } catch (err) { HP.toast(HP.friendlyMessage(err), 'error'); }
      });
    },
  };

  // ------------------------------------------------------------------ action forms (inline, inside the profile)
  function formIn(title, html, onSubmit) {
    const p = document.getElementById('cm-panel');
    document.querySelectorAll('[data-cm-tab]').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    p.innerHTML = `<form class="card" style="padding:1rem" novalidate><h3 style="margin-top:0">${E(title)}</h3>${html}
      <div class="btn-row"><button class="btn btn-dark btn-sm" type="submit">Save</button><button class="btn btn-outline btn-sm" type="button" data-cancel>Cancel</button></div></form>`;
    const f = p.querySelector('form');
    f.querySelector('[data-cancel]').addEventListener('click', reloadTab);
    const first = f.querySelector('input,select,textarea'); if (first) first.focus();
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = f.querySelector('button[type=submit]');
      HP.busy(btn, true, 'Saving…');
      try { await onSubmit(f); } catch (err) { HP.handleFormError(f, err); HP.busy(btn, false); }
    });
    return f;
  }
  const fld = (name, label, input, req) => `<div class="field"><label for="cmf-${name}">${E(label)}${req ? ' <span class="req">*</span>' : ''}</label>${input.replace('<INPUT', `<input${/type=/.test(input) ? '' : ' type="text"'} id="cmf-${name}" name="${name}"`).replace('<TEXTAREA', `<textarea id="cmf-${name}" name="${name}"`).replace('<SELECT', `<select id="cmf-${name}" name="${name}"`)}<span class="field-error" data-error-for="${name}"></span></div>`;

  const ACTIONS = {
    async request() {
      if (!trades) trades = await HP.api('GET', '/trades').catch(() => []);
      const s = current.summary;
      formIn('New request for this client', `<p class="small muted">For a phone call or an in-person visit. The client gets an email saying support created it, and it follows the normal quote flow.</p>
        <div class="form-grid two">${fld('service_type', 'Service', `<SELECT>${trades.map((t) => `<option value="${E(t.service_type)}">${E(t.label)}</option>`).join('')}</select>`, true)}
        ${fld('urgency', 'Urgency', '<SELECT><option value="standard">Standard</option><option value="urgent">Urgent</option></select>')}</div>
        ${fld('address', 'Project address', '<INPUT autocomplete="off" maxlength="200">', true)}
        <div class="form-grid two">${fld('city', 'City', `<INPUT value="${E(s.city || '')}">`)}${fld('zip', 'ZIP', `<INPUT value="${E(s.zip || '')}" maxlength="10">`)}</div>
        ${fld('phone', 'Phone for this job', `<INPUT value="${E(s.phone || '')}">`, true)}
        ${fld('description', 'What needs to be done', '<TEXTAREA rows="4" maxlength="2000"></textarea>', true)}`, async (f) => {
        const r = await HP.api('POST', `/clients/${current.id}/requests`, { service_type: f.service_type.value, urgency: f.urgency.value, address: f.address.value, city: f.city.value, zip: f.zip.value, phone: f.phone.value, description: f.description.value });
        HP.toast(`Request #${r.id} created. The client was emailed.`, 'ok'); await reloadHead(); showTab('work');
      });
    },
    note() { showTab('notes'); },
    async task() {
      if (!team) team = await HP.api('GET', '/clients/team').catch(() => []);
      const me = HP.user() || {};
      formIn('New task', `${fld('title', 'Task', '<INPUT maxlength="200">', true)}
        <div class="form-grid two">${fld('due_at', 'Due date', '<INPUT type="date">')}
        ${fld('assigned_to', 'Assign to', `<SELECT><option value="">Nobody</option>${team.map((t) => `<option value="${t.id}" ${t.id === me.id ? 'selected' : ''}>${E(t.name)}</option>`).join('')}</select>`)}</div>
        ${fld('notes', 'Notes', '<TEXTAREA rows="2" maxlength="2000"></textarea>')}`, async (f) => {
        await HP.api('POST', `/clients/${current.id}/tasks`, { title: f.title.value, due_at: f.due_at.value || undefined, assigned_to: f.assigned_to.value || undefined, notes: f.notes.value || undefined });
        HP.toast('Task added.', 'ok'); await reloadHead(); showTab('tasks');
      });
    },
    async message() {
      if (!current.projects) current.projects = (await HP.api('GET', `/clients/${current.id}/messages`)).projects;
      const ps = current.projects || [];
      formIn('Message the client', `<p class="small muted">Goes out as Helpman support. Choose a project to post in its conversation (the client answers from their portal), or send an email when there is no project.</p>
        ${fld('via', 'Where', `<SELECT>${ps.map((p) => `<option value="${p.id}">Project #${p.id} — ${E(p.service_type)} conversation</option>`).join('')}<option value="email">Email from Helpman support</option></select>`)}
        ${fld('subject', 'Subject (email only)', '<INPUT maxlength="150">')}
        ${fld('body', 'Message', '<TEXTAREA rows="5" maxlength="4000"></textarea>', true)}`, async (f) => {
        if (f.via.value === 'email') {
          await HP.api('POST', `/clients/${current.id}/email`, { subject: f.subject.value, body: f.body.value });
        } else {
          if (!f.body.value.trim()) throw Object.assign(new Error('Write the message.'), { status: 422, fields: { body: 'Write the message.' } });
          const t = await HP.api('POST', `/projects/${f.via.value}/threads`, { kind: 'client_support' });
          await HP.api('POST', `/threads/${t.id}/messages`, { body: f.body.value });
        }
        HP.toast('Message sent.', 'ok'); current.dirty = true; showTab('messages');
      });
      const syncSubject = (f) => { f.subject.closest('.field').hidden = f.via.value !== 'email'; };
      const f = document.querySelector('#cm-panel form'); syncSubject(f); f.via.addEventListener('change', () => syncSubject(f));
    },
    async tags() {
      const s = current.summary;
      formIn('Tags', `<p class="small muted">Letters, numbers and dashes. Up to 10 per client. "vip" and "blocked" have their own buttons.</p>
        <div style="margin:.4rem 0">${s.tags.filter((t) => !['vip', 'blocked'].includes(t)).map((t) => `<button type="button" class="btn btn-outline btn-sm" data-rm-tag="${E(t)}" aria-label="Remove tag ${E(t)}">${E(t)} ×</button>`).join(' ') || '<span class="small muted">No other tags.</span>'}</div>
        ${fld('tag', 'Add a tag', '<INPUT maxlength="24" list="cm-tag-list" autocomplete="off">')}<datalist id="cm-tag-list"></datalist>`, async (f) => {
        const r = await HP.api('POST', `/clients/${current.id}/tags`, { add: [f.tag.value] });
        HP.toast('Tags: ' + (r.tags.join(', ') || 'none'), 'ok'); await reloadHead(); ACTIONS.tags();
      });
      HP.api('GET', '/clients/tags').then((tags) => { const dl = document.getElementById('cm-tag-list'); if (dl) dl.innerHTML = tags.map((t) => `<option value="${E(t.tag)}">`).join(''); }).catch(() => {});
      document.querySelectorAll('[data-rm-tag]').forEach((b) => b.addEventListener('click', async () => {
        try { await HP.api('POST', `/clients/${current.id}/tags`, { remove: [b.dataset.rmTag] }); await reloadHead(); ACTIONS.tags(); } catch (err) { HP.toast(HP.friendlyMessage(err), 'error'); }
      }));
    },
    async vip() {
      const on = !current.summary.vip;
      try { await HP.api('POST', `/clients/${current.id}/tags`, on ? { add: ['vip'] } : { remove: ['vip'] }); HP.toast(on ? 'Marked as VIP.' : 'VIP removed.', 'ok'); await reloadHead(); reloadTab(); } catch (err) { HP.toast(HP.friendlyMessage(err), 'error'); }
    },
    async block() {
      const on = !current.summary.blocked;
      if (on && !confirm(`Block ${current.summary.name}? They will not be able to create requests or accept quotes. Open projects continue. This is recorded in the audit log.`)) return;
      try { await HP.api('POST', `/clients/${current.id}/tags`, on ? { add: ['blocked'] } : { remove: ['blocked'] }); HP.toast(on ? 'Client blocked.' : 'Client unblocked.', 'ok'); await reloadHead(); reloadTab(); } catch (err) { HP.toast(HP.friendlyMessage(err), 'error'); }
    },
    async access(btn) {
      if (!confirm(`Email ${current.summary.email} a link to set a new password${current.summary.email_verified ? '' : ' and confirm their email'}?`)) return;
      HP.busy(btn, true, 'Sending…');
      try { const r = await HP.api('POST', `/clients/${current.id}/resend-access`, {}); HP.toast(r.verification_sent ? 'Access and verification links sent.' : 'Access link sent.', 'ok'); current.dirty = true; }
      catch (err) { HP.toast(HP.friendlyMessage(err), 'error'); }
      HP.busy(btn, false);
    },
  };

  window.loadClientDirectory = loadDirectory;
  window.openClientProfile = openClient;
  // If the Clients tab was opened before this file loaded, fill it now.
  document.addEventListener('DOMContentLoaded', () => {
    const box = document.getElementById('client-directory');
    if (box && !box.dataset.ready && box.offsetParent !== null) loadDirectory();
  });
})();
