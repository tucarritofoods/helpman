// Admin › Campaigns (Corte 5): segment builder → message → preview / test → send now or schedule → results.
// Every email goes out from the platform's business sender with the unsubscribe link and postal address.
(function () {
  'use strict';
  const E = (s) => HP.esc(s);
  const LIFECYCLE = [['lead', 'Lead'], ['prospect', 'Prospect'], ['active', 'Active'], ['customer', 'Customer'], ['lost', 'Lost']];
  const PRO_STATUS = [['pending', 'Pending'], ['active', 'Active'], ['suspended', 'Suspended'], ['rejected', 'Rejected']];
  const STATUS = { draft: ['Draft', 'muted'], scheduled: ['Scheduled', 'info'], queued: ['Queued', 'info'], sending: ['Sending', 'warn'], done: ['Sent', 'ok'], cancelled: ['Cancelled', 'muted'] };
  const VARS = [['first_name', 'First name'], ['city', 'City'], ['last_service', 'Last service']];
  let root, trades = null, tags = null, segments = [], templates = [];

  function when(v) {
    if (!v) return '—';
    const s = String(v);
    const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? E(s) : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  const badge = (st) => HP.badge((STATUS[st] || [st])[0], (STATUS[st] || [0, 'muted'])[1]);
  const errBox = (e) => `<div class="banner banner-warn">${E(HP.friendlyMessage(e))}</div>`;
  const toastErr = (e) => HP.toast(HP.friendlyMessage(e), 'error');

  async function load() {
    root = document.getElementById('campaign-builder');
    if (!root) return;
    if (!trades) [trades, tags] = await Promise.all([HP.api('GET', '/trades').catch(() => []), HP.api('GET', '/clients/tags').catch(() => [])]);
    home();
  }

  // ------------------------------------------------------------------ home: campaigns + segments
  async function home() {
    root.innerHTML = `<div class="section-head"><h2>Campaigns</h2><button class="btn btn-dark btn-sm" type="button" id="cp-new">New campaign</button></div>
      <p class="small muted">Emails go out from Helpman's business address, with the unsubscribe link and postal address required by law. Unsubscribed and blocked people are never included.</p>
      <div id="cp-list"><p class="muted">Loading…</p></div>
      <div class="section-head" style="margin-top:1.5rem"><h2>Saved segments</h2><button class="btn btn-outline btn-sm" type="button" id="sg-new">New segment</button></div>
      <div id="sg-list"><p class="muted">Loading…</p></div>`;
    root.querySelector('#cp-new').addEventListener('click', () => editor(null));
    root.querySelector('#sg-new').addEventListener('click', () => segmentEditor(null));
    try {
      const list = await HP.api('GET', '/campaigns');
      const box = root.querySelector('#cp-list');
      box.innerHTML = list.length ? `<div class="table-scroll"><table><thead><tr><th>Campaign</th><th>Audience</th><th>Status</th><th>Recipients</th><th>When</th><th></th></tr></thead><tbody>
        ${list.map((c) => `<tr><td><strong>${E(c.name)}</strong>${c.subject ? `<div class="small muted">${E(c.subject)}</div>` : ''}</td>
          <td class="small">${c.builder ? E(c.segment_name || 'Custom filters') : E(String(c.segment).replace(/_/g, ' ')) + ' <span class="muted">(older)</span>'}</td>
          <td>${badge(c.status)}</td><td>${c.recipients ? `${c.sent} / ${c.recipients}` : (c.audience_count || '—')}</td>
          <td class="small">${c.status === 'scheduled' ? 'Scheduled ' + when(c.scheduled_at) : c.started_at ? when(c.started_at) : when(c.created_at)}</td>
          <td><button class="btn btn-outline btn-sm" type="button" data-open="${c.id}" data-status="${c.status}" data-builder="${c.builder ? 1 : 0}">${c.builder && ['draft', 'scheduled'].includes(c.status) ? 'Open' : 'Results'}</button></td></tr>`).join('')}
        </tbody></table></div>` : HP.emptyState('No campaigns yet', 'Create one to reach a group of your clients.');
      box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => (b.dataset.builder === '1' && ['draft', 'scheduled'].includes(b.dataset.status) ? editor(Number(b.dataset.open)) : resultsView(Number(b.dataset.open)))));
    } catch (e) { root.querySelector('#cp-list').innerHTML = errBox(e); }
    try {
      segments = await HP.api('GET', '/campaigns/segments');
      const box = root.querySelector('#sg-list');
      box.innerHTML = segments.length ? `<div class="table-scroll"><table><thead><tr><th>Segment</th><th>People now</th><th>Filters</th><th></th></tr></thead><tbody>
        ${segments.map((s) => `<tr><td><strong>${E(s.name)}</strong></td><td>${s.count}</td><td class="small muted">${E(describe(s.filters))}</td>
          <td><button class="btn btn-outline btn-sm" type="button" data-sg-edit="${s.id}">Edit</button> <button class="btn btn-outline btn-sm" type="button" data-sg-del="${s.id}">Delete</button></td></tr>`).join('')}
        </tbody></table></div>` : '<p class="small muted">No saved segments. Build an audience once and save it to reuse it.</p>';
      box.querySelectorAll('[data-sg-edit]').forEach((b) => b.addEventListener('click', () => segmentEditor(segments.find((s) => s.id === Number(b.dataset.sgEdit)))));
      box.querySelectorAll('[data-sg-del]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this segment? Campaigns already sent keep their results.')) return;
        try { await HP.api('DELETE', `/campaigns/segments/${b.dataset.sgDel}`); HP.toast('Segment deleted.', 'ok'); home(); } catch (e) { toastErr(e); }
      }));
    } catch (e) { root.querySelector('#sg-list').innerHTML = errBox(e); }
  }

  function describe(f) {
    if (!f) return '';
    const p = [];
    if (f.audience === 'contractors') p.push('Pros');
    if (f.lifecycle) p.push(f.lifecycle.join('/'));
    if (f.contractor_status) p.push(f.contractor_status.join('/'));
    if (f.places) p.push('in ' + f.places.join(', '));
    if (f.services) p.push('used ' + f.services.join(', '));
    if (f.tags_any) p.push('tag ' + f.tags_any.join(' or '));
    if (f.tags_none) p.push('not ' + f.tags_none.join(', '));
    if (f.inactive_days_min != null) p.push(`idle ≥ ${f.inactive_days_min} d`);
    if (f.active_within_days != null) p.push(`active ≤ ${f.active_within_days} d`);
    if (f.jobs_min != null || f.jobs_max != null) p.push(`jobs ${f.jobs_min ?? 0}–${f.jobs_max ?? '∞'}`);
    if (f.spend_min_cents != null || f.spend_max_cents != null) p.push(`spent $${(f.spend_min_cents || 0) / 100}–${f.spend_max_cents != null ? '$' + f.spend_max_cents / 100 : '∞'}`);
    if (f.include_guests === false) p.push('accounts only');
    return p.join(' · ') || 'Everyone';
  }

  // ------------------------------------------------------------------ the filter form (shared by campaigns and segments)
  const checks = (name, opts, sel) => `<div class="btn-row" style="flex-wrap:wrap;gap:.35rem .9rem;margin:.2rem 0 .6rem">${opts.map(([v, l]) =>
    `<label class="small" style="display:inline-flex;gap:.3rem;align-items:center"><input type="checkbox" name="${name}" value="${E(v)}" ${sel && sel.includes(v) ? 'checked' : ''}> ${E(l)}</label>`).join('')}</div>`;
  const num = (name, label, val, step) => `<div class="field" style="margin:0"><label class="small" for="f-${name}">${E(label)}</label><input type="number" min="0" ${step ? `step="${step}"` : ''} id="f-${name}" name="${name}" value="${val == null ? '' : E(val)}"><span class="field-error" data-error-for="${name}"></span></div>`;

  function filterForm(f) {
    f = f || {};
    const pros = f.audience === 'contractors';
    const tagOpts = (tags || []).map((t) => [t.tag, t.tag]);
    return `<fieldset class="card" style="padding:1rem" data-filters>
      <legend style="font-weight:700;padding:0 .3rem">Who gets it</legend>
      <div class="btn-row" style="gap:1rem;margin:0 0 .6rem">
        <label><input type="radio" name="audience" value="clients" ${pros ? '' : 'checked'}> Clients</label>
        <label><input type="radio" name="audience" value="contractors" ${pros ? 'checked' : ''}> Pros</label></div>
      <div data-for="clients" ${pros ? 'hidden' : ''}>
        <div class="small" style="font-weight:600">Status</div>${checks('lifecycle', LIFECYCLE, f.lifecycle)}
        <div class="small" style="font-weight:600">Services used</div>${checks('services', (trades || []).map((t) => [t.service_type, t.label]), f.services)}
        ${tagOpts.length ? `<div class="small" style="font-weight:600">With any of these tags</div>${checks('tags_any', tagOpts, f.tags_any)}<div class="small" style="font-weight:600">Without these tags</div>${checks('tags_none', tagOpts, f.tags_none)}` : ''}
        <div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.6rem">
          ${num('inactive_days_min', 'No activity for at least (days)', f.inactive_days_min)}${num('active_within_days', 'Active in the last (days)', f.active_within_days)}
          ${num('jobs_min', 'Completed jobs, min', f.jobs_min)}${num('jobs_max', 'Completed jobs, max', f.jobs_max)}
          ${num('spend_min', 'Total spent, min ($)', f.spend_min_cents != null ? f.spend_min_cents / 100 : null, '0.01')}${num('spend_max', 'Total spent, max ($)', f.spend_max_cents != null ? f.spend_max_cents / 100 : null, '0.01')}
        </div>
        <label class="small" style="display:block;margin-top:.6rem"><input type="checkbox" name="include_guests" ${f.include_guests === false ? '' : 'checked'}> Include people who asked for a quote without an account</label>
      </div>
      <div data-for="contractors" ${pros ? '' : 'hidden'}>
        <div class="small" style="font-weight:600">Pro status</div>${checks('contractor_status', PRO_STATUS, f.contractor_status)}
        <div class="form-grid two">${num('contractor_min_rating', 'Rating at least (0–5)', f.contractor_min_rating, '0.1')}${num('pro_jobs_min', 'Completed jobs, min', pros ? f.jobs_min : null)}</div>
      </div>
      <div class="field" style="margin:.6rem 0 0"><label class="small" for="f-places">Cities or ZIP codes (comma separated)</label><input type="text" id="f-places" name="places" value="${E((f.places || []).join(', '))}" placeholder="Vallejo, 94590"></div>
      <div data-count class="banner" style="margin-top:.8rem" aria-live="polite"><span class="muted">Counting…</span></div>
    </fieldset>`;
  }

  function readFilters(box) {
    const v = (n) => [...box.querySelectorAll(`input[name="${n}"]:checked`)].map((i) => i.value);
    const n = (name) => { const el = box.querySelector(`[name="${name}"]`); return el && el.value !== '' ? Number(el.value) : undefined; };
    const pros = box.querySelector('input[name="audience"]:checked').value === 'contractors';
    const places = box.querySelector('[name="places"]').value.split(',').map((s) => s.trim()).filter(Boolean);
    const f = { audience: pros ? 'contractors' : 'clients', places };
    if (pros) Object.assign(f, { contractor_status: v('contractor_status'), contractor_min_rating: n('contractor_min_rating'), jobs_min: n('pro_jobs_min') });
    else {
      const money = (name) => { const x = n(name); return x === undefined ? undefined : Math.round(x * 100); };
      Object.assign(f, { lifecycle: v('lifecycle'), services: v('services'), tags_any: v('tags_any'), tags_none: v('tags_none'),
        inactive_days_min: n('inactive_days_min'), active_within_days: n('active_within_days'), jobs_min: n('jobs_min'), jobs_max: n('jobs_max'),
        spend_min_cents: money('spend_min'), spend_max_cents: money('spend_max'), include_guests: box.querySelector('[name="include_guests"]').checked });
    }
    Object.keys(f).forEach((k) => { if (f[k] === undefined || (Array.isArray(f[k]) && !f[k].length)) delete f[k]; });
    return f;
  }

  // Live count, debounced. Returns a function giving the last count.
  function wireCount(box) {
    let timer, last = null;
    const count = box.querySelector('[data-count]');
    const refresh = async () => {
      count.innerHTML = '<span class="muted">Counting…</span>';
      try {
        const r = await HP.api('POST', '/campaigns/audience', { filters: readFilters(box) });
        last = r.count;
        const ex = r.excluded;
        count.innerHTML = `<strong>${r.count}</strong> ${r.count === 1 ? 'person' : 'people'} will get it.
          <span class="small muted">Left out automatically: ${ex.unsubscribed} unsubscribed, ${ex.blocked} blocked, ${ex.no_email} without email.</span>
          ${r.sample.length ? `<div class="small muted" style="margin-top:.3rem">For example: ${r.sample.slice(0, 5).map((m) => E(m.name || m.email) + (m.city ? ` (${E(m.city)})` : '')).join(', ')}${r.count > 5 ? '…' : ''}</div>` : ''}`;
      } catch (e) {
        last = null;
        HP.applyFieldErrors(box, e.fields);
        count.innerHTML = `<span class="small">${E(HP.friendlyMessage(e))}</span>`;
      }
    };
    box.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 300); });
    box.addEventListener('change', (e) => {
      if (e.target.name === 'audience') box.querySelectorAll('[data-for]').forEach((d) => { d.hidden = d.dataset.for !== e.target.value; });
      clearTimeout(timer); timer = setTimeout(refresh, 150);
    });
    refresh();
    return { get: () => last, refresh };
  }

  // ------------------------------------------------------------------ segment editor
  function segmentEditor(seg) {
    root.innerHTML = `<div class="section-head"><h2>${seg ? 'Edit segment' : 'New segment'}</h2><button class="btn btn-outline btn-sm" type="button" data-back>Back</button></div>
      <form id="sg-form" novalidate>
        <div class="field"><label for="sg-name">Segment name <span class="req">*</span></label><input type="text" id="sg-name" name="name" maxlength="80" value="${E(seg ? seg.name : '')}"><span class="field-error" data-error-for="name"></span></div>
        ${filterForm(seg && seg.filters)}
        <div class="btn-row"><button class="btn btn-dark btn-sm" type="submit">Save segment</button></div></form>`;
    root.querySelector('[data-back]').addEventListener('click', home);
    const f = root.querySelector('#sg-form');
    wireCount(f.querySelector('[data-filters]'));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const body = { name: f.name.value, filters: readFilters(f.querySelector('[data-filters]')) };
        await HP.api(seg ? 'PUT' : 'POST', `/campaigns/segments${seg ? '/' + seg.id : ''}`, body);
        HP.toast('Segment saved.', 'ok'); home();
      } catch (err) { HP.handleFormError(f, err); }
    });
  }

  // ------------------------------------------------------------------ campaign editor
  async function editor(id) {
    root.innerHTML = '<p class="muted">Loading…</p>';
    let c = null;
    try {
      [segments, templates] = await Promise.all([HP.api('GET', '/campaigns/segments'), HP.api('GET', '/campaigns/templates')]);
      if (id) c = await HP.api('GET', `/campaigns/${id}`);
    } catch (e) { root.innerHTML = errBox(e); return; }
    const scheduled = c && c.status === 'scheduled';
    const usingSeg = c && c.segment_id;
    root.innerHTML = `<div class="section-head"><h2>${c ? E(c.name) : 'New campaign'}</h2><button class="btn btn-outline btn-sm" type="button" data-back>Back to campaigns</button></div>
      ${scheduled ? `<div class="banner" role="status">Scheduled for <strong>${when(c.scheduled_at)}</strong>. <button class="btn btn-outline btn-sm" type="button" data-unschedule>Unschedule to edit</button></div>` : ''}
      <form id="cp-form" novalidate ${scheduled ? 'inert' : ''}>
        <h3>1 · Audience</h3>
        <div class="field"><label for="cp-seg">Use a saved segment</label><select id="cp-seg" name="segment_id"><option value="">No — build the audience here</option>
          ${segments.map((s) => `<option value="${s.id}" ${c && c.segment_id === s.id ? 'selected' : ''}>${E(s.name)} (${s.count} now)</option>`).join('')}</select></div>
        <div data-builder ${usingSeg ? 'hidden' : ''}>${filterForm(c && !usingSeg ? c.filters : null)}
          <button class="btn btn-outline btn-sm" type="button" data-save-seg style="margin-top:.5rem">Save these filters as a segment</button></div>
        <h3 style="margin-top:1.5rem">2 · Message</h3>
        <div class="form-grid two">
          <div class="field"><label for="cp-name">Campaign name (internal) <span class="req">*</span></label><input type="text" id="cp-name" name="name" maxlength="160" value="${E(c ? c.name : '')}"><span class="field-error" data-error-for="name"></span></div>
          <div class="field"><label for="cp-tpl">Start from a template</label><select id="cp-tpl"><option value="">—</option>${templates.map((t) => `<option value="${t.id}">${E(t.name)}</option>`).join('')}</select></div></div>
        <div class="field"><label for="cp-subject">Subject <span class="req">*</span></label><input type="text" id="cp-subject" name="subject" maxlength="150" value="${E(c ? c.subject : '')}"><span class="field-error" data-error-for="subject"></span></div>
        <div class="field"><label for="cp-body">Message <span class="req">*</span></label>
          <div class="btn-row" style="margin:0 0 .35rem;gap:.35rem">${VARS.map(([v, l]) => `<button class="btn btn-outline btn-sm" type="button" data-var="${v}" title="Insert {{${v}}}">+ ${E(l)}</button>`).join('')}</div>
          <textarea id="cp-body" name="body_text" rows="9" maxlength="10000">${E(c ? c.body_text : '')}</textarea>
          <div class="hint">A blank line starts a new paragraph. **Bold** and https:// links work. Variables are filled in for each person.</div><span class="field-error" data-error-for="body_text"></span></div>
        <div class="form-grid two">
          <div class="field"><label for="cp-blabel">Button text (optional)</label><input type="text" id="cp-blabel" name="button_label" maxlength="40" value="${E(c && c.button_label || '')}"><span class="field-error" data-error-for="button_label"></span></div>
          <div class="field"><label for="cp-burl">Button link</label><input type="text" id="cp-burl" name="button_url" value="${E(c && c.button_url || '')}" placeholder="/ or https://…"><span class="field-error" data-error-for="button_url"></span></div></div>
        <div class="btn-row"><button class="btn btn-dark btn-sm" type="submit">Save draft</button><button class="btn btn-outline btn-sm" type="button" data-save-tpl>Save message as template</button></div>
      </form>
      <div id="cp-review" style="margin-top:1.5rem"></div>`;
    root.querySelector('[data-back]').addEventListener('click', home);
    const f = root.querySelector('#cp-form');
    const fbox = f.querySelector('[data-filters]');
    const counter = wireCount(fbox);
    const ub = root.querySelector('[data-unschedule]');
    if (ub) ub.addEventListener('click', async () => { try { await HP.api('POST', `/campaigns/${c.id}/unschedule`, {}); HP.toast('Unscheduled. You can edit it now.', 'ok'); editor(c.id); } catch (e) { toastErr(e); } });
    f.segment_id.addEventListener('change', () => { f.querySelector('[data-builder]').hidden = !!f.segment_id.value; });
    f.querySelectorAll('[data-var]').forEach((b) => b.addEventListener('click', () => {
      const ta = f.body_text, tok = `{{${b.dataset.var}}}`, at = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, at) + tok + ta.value.slice(ta.selectionEnd ?? at); ta.focus(); ta.selectionStart = ta.selectionEnd = at + tok.length;
    }));
    f.querySelector('#cp-tpl').addEventListener('change', (e) => {
      const t = templates.find((x) => x.id === Number(e.target.value)); if (!t) return;
      if ((f.subject.value || f.body_text.value) && !confirm('Replace the subject and message with this template?')) { e.target.value = ''; return; }
      f.subject.value = t.subject; f.body_text.value = t.body_text || String(t.body_html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').trim();
      f.button_label.value = t.button_label || ''; f.button_url.value = t.button_url || '';
    });
    f.querySelector('[data-save-seg]').addEventListener('click', async () => {
      const name = prompt('Name for this segment:'); if (!name) return;
      try { await HP.api('POST', '/campaigns/segments', { name, filters: readFilters(fbox) }); HP.toast('Segment saved.', 'ok'); } catch (e) { toastErr(e); }
    });
    f.querySelector('[data-save-tpl]').addEventListener('click', async () => {
      const name = prompt('Name for this template:', f.name.value); if (!name) return;
      try { await HP.api('POST', '/campaigns/builder/templates', { name, subject: f.subject.value, body_text: f.body_text.value, button_label: f.button_label.value, button_url: f.button_url.value }); HP.toast('Template saved.', 'ok'); }
      catch (e) { HP.handleFormError(f, e); }
    });
    const payload = () => ({ name: f.name.value, subject: f.subject.value, body_text: f.body_text.value, button_label: f.button_label.value, button_url: f.button_url.value,
      ...(f.segment_id.value ? { segment_id: Number(f.segment_id.value) } : { filters: readFilters(fbox) }) });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = f.querySelector('button[type=submit]'); HP.busy(btn, true, 'Saving…');
      try {
        c = await HP.api(c ? 'PUT' : 'POST', `/campaigns${c ? '/' + c.id : ''}`, payload());
        HP.clearFieldErrors(f); HP.toast('Draft saved.', 'ok'); review(c);
      } catch (err) { HP.handleFormError(f, err); }
      HP.busy(btn, false);
    });
    if (c) review(c);
    void counter;
  }

  // ------------------------------------------------------------------ review: preview, test, send, schedule
  async function review(c) {
    const box = document.getElementById('cp-review');
    box.innerHTML = '<p class="muted">Preparing preview…</p>';
    let p;
    try { p = await HP.api('POST', `/campaigns/${c.id}/preview`, {}); } catch (e) { box.innerHTML = errBox(e); return; }
    const draft = c.status === 'draft';
    box.innerHTML = `<h3>3 · Check and send</h3>
      <p>Preview for <strong>${E(p.recipient.name || p.recipient.email)}</strong>${p.recipient.city ? ` (${E(p.recipient.city)})` : ''}. Subject: <strong>${E(p.subject)}</strong></p>
      <iframe title="Email preview" sandbox="" style="width:100%;height:520px;border:1px solid var(--line);border-radius:.75rem;background:#f6f8fb" data-preview></iframe>
      <div class="card" style="padding:1rem;margin-top:1rem">
        <p style="margin-top:0"><strong>${p.audience_count}</strong> ${p.audience_count === 1 ? 'person' : 'people'} will get this email${c.test_sent_at ? ` · test sent ${when(c.test_sent_at)}` : ''}.</p>
        <div class="btn-row" style="flex-wrap:wrap">
          <button class="btn btn-outline btn-sm" type="button" data-test>Send me a test</button>
          ${draft ? `<button class="btn btn-primary btn-sm" type="button" data-send ${p.audience_count ? '' : 'disabled'}>Send now to ${p.audience_count}</button>
          <label class="small" for="cp-at" style="margin-left:.5rem">or schedule</label><input type="datetime-local" id="cp-at" style="max-width:240px;padding:.45rem .6rem;border:1px solid var(--line);border-radius:.6rem;font:inherit">
          <button class="btn btn-outline btn-sm" type="button" data-schedule>Schedule</button>` : ''}
          <button class="btn btn-outline btn-sm" type="button" data-cancel>Cancel campaign</button>
        </div></div>`;
    box.querySelector('[data-preview]').srcdoc = p.html;
    box.querySelector('[data-test]').addEventListener('click', async (e) => {
      HP.busy(e.target, true, 'Sending…');
      try { const r = await HP.api('POST', `/campaigns/${c.id}/test`, {}); HP.toast(`Test sent to ${r.to}.`, 'ok'); } catch (err) { toastErr(err); }
      HP.busy(e.target, false);
    });
    const send = box.querySelector('[data-send]');
    if (send) send.addEventListener('click', async () => {
      if (!confirm(`Send "${c.name}" now to ${p.audience_count} ${p.audience_count === 1 ? 'person' : 'people'}? This cannot be undone.`)) return;
      HP.busy(send, true, 'Sending…');
      try { await HP.api('POST', `/campaigns/${c.id}/send-now`, { expected_count: p.audience_count }); HP.toast('Campaign is going out.', 'ok'); resultsView(c.id); }
      catch (err) { HP.busy(send, false); toastErr(err); if (err.body && err.body.code === 'AUDIENCE_CHANGED') review(c); }
    });
    const sch = box.querySelector('[data-schedule]');
    if (sch) sch.addEventListener('click', async () => {
      const v = box.querySelector('#cp-at').value;
      if (!v) { HP.toast('Choose the date and time first.', 'error'); return; }
      try { await HP.api('POST', `/campaigns/${c.id}/schedule`, { at: new Date(v).toISOString() }); HP.toast('Scheduled. The audience is counted again when it goes out.', 'ok'); home(); } catch (err) { toastErr(err); }
    });
    box.querySelector('[data-cancel]').addEventListener('click', async () => {
      if (!confirm('Cancel this campaign? It will not be sent.')) return;
      try { await HP.api('POST', `/campaigns/${c.id}/cancel`, {}); HP.toast('Campaign cancelled.', 'ok'); home(); } catch (err) { toastErr(err); }
    });
  }

  // ------------------------------------------------------------------ results
  async function resultsView(id, filter, page) {
    root.innerHTML = '<p class="muted">Loading results…</p>';
    let r;
    try { r = await HP.api('GET', `/campaigns/${id}/results?page=${page || 1}${filter ? '&status=' + filter : ''}`); } catch (e) { root.innerHTML = errBox(e); return; }
    const t = r.totals, c = r.campaign;
    const tile = (n, label, key, off) => `<button type="button" class="stage-card" data-filter="${key || ''}" style="text-align:left;cursor:pointer;${filter === key ? 'outline:2px solid var(--navy)' : ''}${off ? ';opacity:.55' : ''}"><div class="c">${off ? '—' : n}</div><div class="n">${E(label)}</div></button>`;
    root.innerHTML = `<div class="section-head"><h2>${E(c.name)}</h2><button class="btn btn-outline btn-sm" type="button" data-back>Back to campaigns</button></div>
      <p>${badge(c.status)} ${c.started_at ? 'Started ' + when(c.started_at) : ''} ${c.completed_at ? '· finished ' + when(c.completed_at) : ''}</p>
      <div class="pipeline">${tile(t.recipients, 'Recipients', '')}${tile(t.sent, 'Sent', 'sent')}${tile(t.queued, 'Waiting', 'queued')}${tile(t.failed, 'Errors', 'failed')}
        ${tile(t.delivered, 'Delivered', 'delivered', !r.tracking)}${tile(t.bounced, 'Bounced', 'bounced', !r.tracking)}${tile(t.opened, 'Opened', 'opened', !r.tracking)}${tile(t.clicked, 'Clicked', 'clicked', !r.tracking)}
        ${tile(t.unsubscribed, 'Unsubscribed', 'unsubscribed')}</div>
      ${t.skipped_unsubscribed || t.cancelled ? `<p class="small muted">${t.skipped_unsubscribed} skipped because they unsubscribed before it went out · ${t.cancelled} stopped by cancelling.</p>` : ''}
      ${r.tracking ? '' : `<p class="small muted">Delivered, bounced, opened and clicked appear when real email is plugged in (Setup › E4: SendGrid and its event webhook). Now: ${E(r.provider)} mode.</p>`}
      <div class="btn-row">${['sending', 'queued'].includes(c.status) ? '<button class="btn btn-outline btn-sm" type="button" data-stop>Stop sending</button>' : ''}
        <button class="btn btn-outline btn-sm" type="button" data-dup>Duplicate as new draft</button> <button class="btn btn-outline btn-sm" type="button" data-reload>Refresh</button></div>
      ${r.rows.length ? `<div class="table-scroll"><table><thead><tr><th>Recipient</th><th>Status</th><th>Sent</th><th>Delivered</th><th>Opened</th><th>Clicked</th><th>Unsubscribed</th></tr></thead><tbody>
        ${r.rows.map((x) => `<tr><td>${E(x.to_name || '')}<div class="small muted">${E(x.to_email)}</div></td>
          <td>${HP.badge(x.status === 'failed' ? (x.error === 'unsubscribed' ? 'skipped' : x.error === 'cancelled' ? 'stopped' : 'error') : x.status, x.status === 'sent' ? 'ok' : x.status === 'failed' ? 'err' : 'info')}${x.bounced_at ? ' ' + HP.badge('bounced', 'err') : ''}</td>
          <td class="small">${when(x.sent_at)}</td><td class="small">${when(x.delivered_at)}</td><td class="small">${x.opened_at ? when(x.opened_at) + (x.open_count > 1 ? ` (${x.open_count}×)` : '') : '—'}</td>
          <td class="small">${x.clicked_at ? when(x.clicked_at) : '—'}</td><td class="small">${when(x.unsubscribed_at)}</td></tr>`).join('')}</tbody></table></div>
        <div class="btn-row"><button class="btn btn-outline btn-sm" type="button" data-pg="-1" ${r.page <= 1 ? 'disabled' : ''}>Previous</button><button class="btn btn-outline btn-sm" type="button" data-pg="1" ${r.rows.length < r.per_page ? 'disabled' : ''}>Next</button></div>`
        : '<p class="small muted">No recipients in this view.</p>'}`;
    root.querySelector('[data-back]').addEventListener('click', home);
    root.querySelector('[data-reload]').addEventListener('click', () => resultsView(id, filter, page));
    root.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => resultsView(id, b.dataset.filter || undefined, 1)));
    root.querySelectorAll('[data-pg]').forEach((b) => b.addEventListener('click', () => resultsView(id, filter, (page || 1) + Number(b.dataset.pg))));
    const stop = root.querySelector('[data-stop]');
    if (stop) stop.addEventListener('click', async () => {
      if (!confirm('Stop sending? Emails already sent cannot be recalled.')) return;
      try { const x = await HP.api('POST', `/campaigns/${id}/cancel`, {}); HP.toast(`${x.stopped} email(s) stopped.`, 'ok'); resultsView(id); } catch (e) { toastErr(e); }
    });
    root.querySelector('[data-dup]').addEventListener('click', async () => {
      try { const d = await HP.api('POST', `/campaigns/${id}/duplicate`, {}); HP.toast('Copy created as a draft.', 'ok'); editor(d.id); } catch (e) { toastErr(e); }
    });
  }

  window.loadCampaignBuilder = load;
  document.addEventListener('DOMContentLoaded', () => {
    const box = document.getElementById('campaign-builder');
    if (box && box.offsetParent !== null) load();
  });
})();
