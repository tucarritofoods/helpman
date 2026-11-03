// HELPMAN Phase 2 — customer command center enhancements.
(function () {
  'use strict';

  function money(cents) { return HP.fmtMoney(Number(cents || 0)); }

  // Corte 6.2: the Overview tab is part of customer.html now; this file only fills it.

  async function loadCommandCenter() {
    const box = document.getElementById('hm-command-center');
    if (!box) return;
    try {
      const [jobs, projects] = await Promise.all([
        HP.api('GET','/jobs/mine/list'),
        HP.api('GET','/projects')
      ]);

      const active = projects.filter(p => !['completed','cancelled'].includes(p.stage));
      const completed = projects.filter(p => p.stage === 'completed');
      const svc = (p) => (p.job && p.job.service_type ? p.job.service_type.charAt(0).toUpperCase() + p.job.service_type.slice(1).replace(/_/g, ' ') : 'Project');
      const depositPaid = (p) => (p.payments || []).some(x => x.kind === 'deposit' && ['paid','recorded'].includes(x.status));
      // What the customer sees as the state of each project (plain words, not internal stages).
      const label = (p) => {
        if (p.stage === 'assigned' && !depositPaid(p)) return 'Waiting for your deposit';
        if (p.stage === 'assigned' && (!p.contractor_id || p.contractor_status !== 'accepted')) return 'Finding your pro';
        if (p.stage === 'review' && p.departed_at) return 'Finished — please confirm';
        return HP.PROJECT_STAGE[p.stage] || p.stage;
      };
      // The next steps that are the customer's to take.
      const todo = [];
      jobs.filter(j => j.status === 'quote_sent').forEach(j => todo.push({ title: `Your quote is ready — ${HP.esc(j.service_type || 'request')}`, sub: `Request #${j.id}`, cta: 'Review quote', tab: 'requests' }));
      active.filter(p => p.stage === 'assigned' && !depositPaid(p)).forEach(p => todo.push({ title: `Pay the deposit to book — ${HP.esc(svc(p))}`, sub: `Project #${p.id}`, cta: 'Pay deposit', tab: 'projects' }));
      active.filter(p => p.stage === 'review' && p.departed_at).forEach(p => todo.push({ title: `Your pro finished — ${HP.esc(svc(p))}`, sub: 'Check the photos and confirm the work', cta: 'Confirm', tab: 'projects' }));
      projects.filter(p => ['requires_action','failed','needs_payment'].includes(p.balance_charge_status)).forEach(p => todo.push({ title: `Remaining balance to pay — ${HP.esc(svc(p))}`, sub: `Project #${p.id}`, cta: 'Pay now', tab: 'projects' }));
      active.flatMap(p => (p.milestones || []).filter(m => m.status === 'completed' && m.customer_approval === 'pending').map(m => ({p,m})))
        .forEach(({p,m}) => todo.push({ title: HP.esc(m.title), sub: `Project #${p.id} — approve this step`, cta: 'Review', tab: 'projects' }));

      box.innerHTML = `
        <div class="hm-cc-stats">
          <div class="hm-cc-stat"><span>To do</span><strong>${todo.length}</strong></div>
          <div class="hm-cc-stat"><span>Active projects</span><strong>${active.length}</strong></div>
          <div class="hm-cc-stat"><span>Completed</span><strong>${completed.length}</strong></div>
          <div class="hm-cc-stat"><span>Requests</span><strong>${jobs.length}</strong></div>
        </div>
        <div class="hm-cc-grid">
          <section class="card"><h2>What needs your attention</h2><div id="hm-actions"></div></section>
          <section class="card"><h2>Active projects</h2><div id="hm-active-projects"></div></section>
        </div>`;

      const actions = document.getElementById('hm-actions');
      actions.innerHTML = todo.length ? todo.map(t =>
        `<div class="hm-action-row"><div><strong>${t.title}</strong><div class="small muted">${t.sub}</div></div><button class="btn btn-primary btn-sm" data-go="${t.tab}">${t.cta}</button></div>`
      ).join('') : '<p class="muted">You are all set — nothing to do right now.</p>';

      const list = document.getElementById('hm-active-projects');
      if (!active.length) list.innerHTML = '<p class="muted">No active projects.</p>';
      else list.innerHTML = active.map(p => `
        <button class="hm-project-summary" data-go="projects">
          <span><strong>${HP.esc(svc(p))}</strong><small>${HP.esc(label(p))} · #${p.id}</small></span>
          <span>${money(p.customer_price_cents)} →</span>
        </button>`).join('');

      box.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => {
        document.querySelector(`#portal-tabs .tab[data-tab="${el.dataset.go}"]`).click();
      }));
    } catch (e) {
      box.innerHTML = `<div class="banner banner-warn">${HP.esc(HP.friendlyMessage(e))}</div>`;
    }
  }

  async function enhanceProjectCards() {
    const container = document.getElementById('projects-list');
    if (!container) return;
    const observer = new MutationObserver(() => {
      container.querySelectorAll('.proj-card').forEach(card => {
        if (card.dataset.hm2) return;
        card.dataset.hm2 = '1';
        const btn = card.querySelector('.proj-head button');
        if (!btn) return;
        btn.addEventListener('click', () => setTimeout(() => mountExtras(card), 80));
      });
    });
    observer.observe(container, {childList:true,subtree:true});
  }

  async function mountExtras(card) {
    if (card.querySelector('.hm-phase2-extras')) return;
    const txt = card.textContent || '';
    const m = txt.match(/Project\s*#(\d+)/i) || txt.match(/#(\d+)/);
    if (!m) return;
    const projectId = m[1];
    const body = card.querySelector('.proj-body');
    if (!body) return;

    const wrap = document.createElement('div');
    wrap.className = 'hm-phase2-extras';
    wrap.innerHTML = `
      <hr class="divider">
      <div class="hm-project-tools">
        <button class="btn btn-outline btn-sm" data-hm-schedule>Scheduling preferences</button>
        <button class="btn btn-outline btn-sm" data-hm-changes>Change orders</button>
        <button class="btn btn-outline btn-sm" data-hm-timeline>Project timeline</button>
      </div>
      <div class="hm-project-tool-output"></div>`;
    body.appendChild(wrap);

    wrap.querySelector('[data-hm-schedule]').onclick = () => renderSchedule(projectId, wrap);
    wrap.querySelector('[data-hm-changes]').onclick = () => renderChanges(projectId, wrap);
    wrap.querySelector('[data-hm-timeline]').onclick = () => renderTimeline(projectId, wrap);
  }

  async function renderSchedule(id, wrap) {
    const out = wrap.querySelector('.hm-project-tool-output');
    out.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const s = await HP.api('GET',`/customer-experience/projects/${id}/schedule-preference`);
      out.innerHTML = `
        <form class="hm-schedule-form">
          <h4>Scheduling preferences</h4>
          <div class="form-grid two">
            <div class="field"><label>Preferred date</label><input type="date" name="preferred_date" value="${HP.esc(s.preferred_date || '')}"></div>
            <div class="field"><label>Time window</label><select name="time_window">
              ${['morning','afternoon','evening','anytime'].map(x=>`<option value="${x}" ${s.time_window===x?'selected':''}>${x.replace('_',' ')}</option>`).join('')}
            </select></div>
          </div>
          <div class="field"><label>Flexibility</label><select name="flexibility">
            ${[['exact','Exact date'],['plus_minus_1','± 1 day'],['plus_minus_3','± 3 days'],['flexible','Flexible']].map(([v,l])=>`<option value="${v}" ${s.flexibility===v?'selected':''}>${l}</option>`).join('')}
          </select></div>
          <div class="field"><label>Notes</label><textarea name="notes" maxlength="500">${HP.esc(s.notes || '')}</textarea></div>
          <button class="btn btn-primary btn-sm" type="submit">Save preferences</button>
        </form>`;
      out.querySelector('form').onsubmit = async e => {
        e.preventDefault();
        const f = e.target;
        await HP.api('PUT',`/customer-experience/projects/${id}/schedule-preference`,{
          preferred_date:f.preferred_date.value || null,
          time_window:f.time_window.value,
          flexibility:f.flexibility.value,
          notes:f.notes.value.trim()
        });
        HP.toast('Scheduling preferences saved.','ok');
      };
    } catch(e) { out.innerHTML = `<p class="muted">${HP.esc(HP.friendlyMessage(e))}</p>`; }
  }

  async function renderChanges(id, wrap) {
    const out = wrap.querySelector('.hm-project-tool-output');
    out.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const rows = await HP.api('GET',`/customer-experience/projects/${id}/change-orders`);
      if (!rows.length) { out.innerHTML = '<h4>Change orders</h4><p class="muted">No documented changes for this project.</p>'; return; }
      out.innerHTML = '<h4>Change orders</h4>' + rows.map(c => `
        <div class="hm-change-order">
          <div class="section-head"><strong>${HP.esc(c.title)}</strong>${HP.badge(c.status,c.status==='approved'?'ok':c.status==='sent'?'warn':'muted')}</div>
          <p>${HP.esc(c.description)}</p>
          <div class="small">Price change: <strong>${money(c.price_delta_cents)}</strong> · Schedule: <strong>${Number(c.schedule_delta_days||0)} day(s)</strong></div>
          ${c.status==='sent'?`<div class="btn-row"><button class="btn btn-ok btn-sm" data-co-yes="${c.id}">Approve</button><button class="btn btn-outline btn-sm" data-co-no="${c.id}">Reject</button></div>`:''}
        </div>`).join('');
      out.querySelectorAll('[data-co-yes],[data-co-no]').forEach(b => b.onclick = async () => {
        const cid = b.dataset.coYes || b.dataset.coNo;
        const approved = !!b.dataset.coYes;
        const note = approved ? '' : (prompt('Optional note for the team:') || '');
        await HP.api('POST',`/customer-experience/projects/${id}/change-orders/${cid}/respond`,{approved,note});
        HP.toast(approved?'Change approved.':'Change rejected.','ok');
        renderChanges(id,wrap);
      });
    } catch(e) { out.innerHTML = `<p class="muted">${HP.esc(HP.friendlyMessage(e))}</p>`; }
  }

  async function renderTimeline(id, wrap) {
    const out = wrap.querySelector('.hm-project-tool-output');
    out.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const rows = await HP.api('GET',`/customer-experience/projects/${id}/timeline`);
      out.innerHTML = '<h4>Project timeline</h4>' + (rows.length ? `<div class="hm-timeline">${rows.map(x=>`
        <div class="hm-timeline-row"><span></span><div><strong>${HP.esc(x.title)}</strong><small>${HP.fmtDateTime(x.created_at)}${x.detail?' · '+HP.esc(x.detail):''}</small></div></div>`).join('')}</div>` : '<p class="muted">Project events will appear here.</p>');
    } catch(e) { out.innerHTML = `<p class="muted">${HP.esc(HP.friendlyMessage(e))}</p>`; }
  }

  window.HMCustomer = { loadCommandCenter };
  document.addEventListener('DOMContentLoaded', () => {
    enhanceProjectCards();
  });
})();
