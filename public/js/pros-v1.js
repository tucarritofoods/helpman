// Admin › Contractors — the pro's profile (Corte 6.2).
// Tabs: Summary · Jobs · Offers · Compliance · Availability · Payouts (roles that see costs) · Reviews & problems.
// Compliance documents can be verified or rejected by roles with 'dispatch' (the API enforces it).
(function () {
  'use strict';
  const E = (s) => HP.esc(s);
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const LIFECYCLE = { verification: 'In verification', new_active: 'New pro', active: 'Active', top_performer: 'Top performer', suspended: 'Suspended', rejected: 'Not approved', applicant: 'Applicant' };
  const REASON = { quality: 'Quality of the work', incomplete: 'Work incomplete', no_show: 'No-show', damage: 'Damage', billing: 'Billing / price', other: 'Other' };
  const can = (a) => (window.__perms || []).includes(a);
  let data = null, current = null, lastFocus = null;

  function when(v, time) {
    if (!v) return '—';
    const s = String(v);
    const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : (/^\d{4}-\d\d-\d\d$/.test(s) ? s + 'T12:00:00' : s.replace(' ', 'T') + 'Z'));
    if (isNaN(d.getTime())) return E(s);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + (time ? ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '');
  }
  const table = (head, rows) => `<div class="table-scroll"><table><thead><tr>${head.map((h) => `<th>${E(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const empty = (t) => `<p class="small muted">${E(t)}</p>`;
  const specialties = (v) => { try { const a = JSON.parse(v); if (Array.isArray(a)) return a.join(', '); } catch (e) { /* text */ } return String(v || ''); };

  function modal() {
    let m = document.getElementById('pro-modal');
    if (m) return m;
    m = HP.el(`<div class="modal-backdrop" id="pro-modal" hidden>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="pm-title" style="max-width:980px">
        <div class="modal-head"><h2 id="pm-title">Pro</h2><button class="modal-close" type="button" aria-label="Close">×</button></div>
        <div class="modal-body"><div id="pm-head"></div><div class="tabs" id="pm-tabs" role="tablist" style="margin-top:.75rem"></div><div id="pm-panel" role="tabpanel"></div></div>
      </div></div>`);
    document.body.appendChild(m);
    const close = () => { m.hidden = true; document.body.style.overflow = ''; if (lastFocus) lastFocus.focus(); };
    m.querySelector('.modal-close').addEventListener('click', close);
    m.addEventListener('click', (e) => { if (e.target === m) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !m.hidden) close(); });
    return m;
  }

  async function open(id, tab) {
    lastFocus = document.activeElement;
    const m = modal();
    m.hidden = false; document.body.style.overflow = 'hidden';
    current = { id, tab: tab || 'summary' };
    document.getElementById('pm-head').innerHTML = '<p class="muted">Loading…</p>';
    document.getElementById('pm-tabs').innerHTML = ''; document.getElementById('pm-panel').innerHTML = '';
    try { data = await HP.api('GET', `/contractors/${id}/profile`); }
    catch (e) { document.getElementById('pm-head').innerHTML = `<div class="banner banner-warn">${E(HP.friendlyMessage(e))}</div>`; return; }
    const s = data.summary;
    document.getElementById('pm-title').textContent = `${s.legal_name || s.user_name} · pro #${s.id}`;
    const pending = data.documents.filter((d) => d.status === 'submitted').length;
    document.getElementById('pm-head').innerHTML = `<div style="display:flex;gap:.6rem;align-items:center;flex-wrap:wrap">
      ${HP.badge(LIFECYCLE[s.lifecycle] || s.lifecycle || s.status, s.status === 'active' ? 'ok' : 'warn')}
      ${s.provider_type === 'employee' ? HP.badge('company technician', 'info') : ''}
      ${s.retention_at_risk ? HP.badge('retention risk', 'warn') : ''}
      ${pending ? HP.badge(pending + ' document(s) to review', 'warn') : ''}
      ${s.photo_filename ? '' : HP.badge('no profile photo — cannot get offers', 'err')}</div>`;
    const tabs = [['summary', 'Summary'], ['jobs', 'Jobs'], ['offers', 'Offers'], ['documents', 'Compliance'], ['availability', 'Availability'],
      ...(data.can_see_money ? [['payouts', 'Payouts']] : []), ['quality', 'Reviews & problems']];
    document.getElementById('pm-tabs').innerHTML = tabs.map(([k, l]) => `<button class="tab${k === current.tab ? ' active' : ''}" type="button" role="tab" data-pm-tab="${k}" aria-selected="${k === current.tab}">${E(l)}</button>`).join('');
    document.querySelectorAll('[data-pm-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.pmTab)));
    m.querySelector('.modal-close').focus();
    show(current.tab);
  }

  function show(k) {
    current.tab = k;
    document.querySelectorAll('[data-pm-tab]').forEach((b) => { const on = b.dataset.pmTab === k; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
    const p = document.getElementById('pm-panel');
    p.innerHTML = RENDER[k]();
    if (k === 'documents') wireDocs(p);
  }

  const RENDER = {
    summary() {
      const s = data.summary;
      return `<div style="display:flex;gap:1rem;align-items:flex-start;flex-wrap:wrap">
        ${s.photo_url ? `<img src="${E(s.photo_url.replace(/^https?:\/\/[^/]+/, ''))}" alt="" style="width:96px;height:96px;border-radius:50%;object-fit:cover;border:1px solid var(--line)">` : ''}
        <dl class="kv" style="flex:1">
          <dt>Name</dt><dd>${E(s.user_name)}${s.legal_name && s.legal_name !== s.user_name ? ` · ${E(s.legal_name)}` : ''}</dd>
          <dt>Contact</dt><dd>${E(s.email)} · ${E(s.phone || '—')} <span class="small muted">(team only — never shared with customers)</span></dd>
          <dt>Base</dt><dd>${E([s.city, s.service_base].filter(Boolean).join(' · ') || '—')} · ${E(s.service_radius_miles || '—')} miles</dd>
          <dt>Trades</dt><dd>${E(specialties(s.specialties) || '—')}</dd>
          <dt>Experience</dt><dd>${E(s.years_experience || 0)} years</dd>
          <dt>Verification</dt><dd>${s.license_verified ? '✓ license' : '✗ license'} · ${s.insurance_verified ? '✓ insurance' : '✗ insurance'} · background ${E(s.background_check || 'pending')}</dd>
          <dt>Performance</dt><dd>score ${s.score || 0} · ${Number(s.rating_avg || 0).toFixed(1)}★ · ${s.jobs_completed || 0} job(s) completed</dd>
          <dt>Offers</dt><dd>${data.offers.counts.accepted} accepted · ${data.offers.counts.declined} declined · ${data.offers.counts.expired} expired</dd>
          <dt>Payout account</dt><dd>${s.payouts_enabled ? HP.badge('ready', 'ok') : HP.badge('not set up', 'muted')}</dd>
        </dl></div>
        <p class="small muted">To verify or change status, use "Verification" under the pro list.</p>`;
    },
    jobs() {
      return data.jobs.length ? table(['Job', 'Where', 'Stage', 'Visit', ...(data.can_see_money ? ['Budget'] : [])], data.jobs.map((j) => `<tr>
        <td>#${j.id} ${E(j.service_type)}${j.contractor_status === 'offered' ? ' ' + HP.badge('offer pending', 'warn') : ''}</td><td>${E([j.city, j.zip].filter(Boolean).join(' ') || '—')}</td>
        <td>${E(HP.PROJECT_STAGE[j.stage] || j.stage)}</td><td>${j.scheduled_start ? when(String(j.scheduled_start).slice(0, 10)) + ' ' + E(j.arrival_window || '') : '—'}</td>
        ${data.can_see_money ? `<td>${HP.fmtMoney(j.contractor_cost_cents)}</td>` : ''}</tr>`)) : empty('No jobs yet.');
    },
    offers() {
      const c = data.offers.counts;
      const rate = c.offered ? Math.round((c.accepted / c.offered) * 100) : null;
      return `<p>${c.offered} offer(s) · ${c.accepted} accepted · ${c.declined} declined · ${c.expired} expired${rate != null ? ` · <strong>${rate}% accepted</strong>` : ''}</p>
        ${data.offers.events.length ? table(['When', 'Job', 'Event', 'Detail'], data.offers.events.map((o) => `<tr><td>${when(o.created_at, true)}</td><td>#${o.project_id}</td><td>${E(o.event_type)}</td><td class="small">${E(o.detail || '')}</td></tr>`)) : empty('No offers recorded yet.')}`;
    },
    documents() {
      const mayReview = can('dispatch');
      return data.documents.length ? table(['Document', 'Number / issuer', 'Expires', 'Status', ''], data.documents.map((d) => {
        const days = d.expires_on ? Math.ceil((new Date(d.expires_on + 'T12:00:00').getTime() - Date.now()) / 86400000) : null;
        return `<tr data-doc="${d.id}"><td>${E(d.label || d.doc_type)}<div class="small muted">sent ${when(d.created_at)}</div></td>
          <td class="small">${E(d.document_number || '—')}<br>${E(d.issuer || '')}</td>
          <td>${d.expires_on ? when(d.expires_on) : '—'}${days != null && days <= 30 ? ' ' + HP.badge(days < 0 ? 'expired' : `in ${days} d`, days < 0 ? 'err' : 'warn') : ''}</td>
          <td>${HP.badge(d.status, d.status === 'verified' ? 'ok' : d.status === 'submitted' ? 'warn' : 'muted')}${d.rejection_reason ? `<div class="small muted">${E(d.rejection_reason)}</div>` : ''}</td>
          <td>${mayReview && d.status === 'submitted' ? '<button class="btn btn-ok btn-sm" type="button" data-doc-ok>Verify</button> <button class="btn btn-outline btn-sm" type="button" data-doc-no>Reject</button>' : ''}</td></tr>`;
      })) + '<p class="small muted">Verifying a document here does not activate the pro: license, insurance and background are set in "Verification".</p>' : empty('No documents submitted yet.');
    },
    availability() {
      const days = DAYS.map((name, i) => { const a = data.availability.find((x) => Number(x.weekday) === i); return `<tr><td>${name}</td><td>${a && a.is_available ? `${E(a.start_time || '—')} – ${E(a.end_time || '—')}` : '<span class="muted">Not available</span>'}</td></tr>`; });
      return (data.availability.length ? table(['Day', 'Hours'], days) : empty('The pro has not set a weekly schedule yet.'))
        + `<h4>Time off</h4>${data.blackouts.length ? table(['From', 'To', 'Reason'], data.blackouts.map((b) => `<tr><td>${when(b.start_date)}</td><td>${when(b.end_date)}</td><td>${E(b.reason || '')}</td></tr>`)) : empty('No time off recorded.')}`;
    },
    payouts() {
      return data.payouts && data.payouts.length ? table(['Job', 'Amount', 'Status', 'Due', 'Paid'], data.payouts.map((x) => `<tr><td>#${x.project_id}</td><td>${HP.fmtMoney(x.payable_cents)}</td>
        <td>${E(x.status)}${x.via_stripe ? ' <span class="small muted">(Stripe)</span>' : ''}</td><td>${x.due_at ? when(String(x.due_at).slice(0, 10)) : '—'}</td><td>${x.paid_at ? when(x.paid_at) + (x.paid_method ? ' · ' + E(x.paid_method) : '') : '—'}</td></tr>`)) : empty('No payouts yet.');
    },
    quality() {
      return `<h4>Reviews</h4>${data.reviews.length ? data.reviews.map((r) => `<div class="small" style="margin:.3rem 0">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)} job #${r.project_id} — ${E(r.comment || '')} <span class="muted">${when(r.created_at)}</span></div>`).join('') : empty('No reviews yet.')}
        <h4>Problems reported</h4>${data.disputes.length ? table(['Job', 'Opened by', 'Reason', 'Status', 'When'], data.disputes.map((d) => `<tr><td>#${d.project_id}</td><td>${E(d.opened_by_role)}</td><td>${E(REASON[d.reason] || d.reason)}</td><td>${E(d.status)}</td><td>${when(d.created_at)}</td></tr>`)) : empty('No problems reported.')}`;
    },
  };

  function wireDocs(p) {
    p.querySelectorAll('tr[data-doc]').forEach((tr) => {
      const id = tr.dataset.doc;
      const send = async (status, rejection_reason) => {
        try { await HP.api('PATCH', `/contractor-ops/admin/documents/${id}`, { status, rejection_reason }); HP.toast(status === 'verified' ? 'Document verified.' : 'Document rejected.', 'ok'); open(current.id, 'documents'); }
        catch (e) { HP.toast(HP.friendlyMessage(e), 'error'); }
      };
      const ok = tr.querySelector('[data-doc-ok]'); if (ok) ok.addEventListener('click', () => send('verified'));
      const no = tr.querySelector('[data-doc-no]'); if (no) no.addEventListener('click', () => { const r = prompt('Why is it rejected? The pro sees this reason.'); if (r) send('rejected', r); });
    });
  }

  window.openProProfile = open;
})();
