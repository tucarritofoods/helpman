// Admin "Setup" tab — the owner's plug-in panel (Corte 1).
// Shows, for every owner plug (E1..E6), whether it is in place, which
// environment variables are set (never their values) and a live test button.
(function () {
  'use strict';
  const STATUS = {
    ok: ['Ready', 'ok'],
    missing: ['Missing', 'err'],
    warning: ['Check', 'warn'],
    manual: ['Confirm manually', 'info'],
    optional: ['Optional', 'muted'],
  };
  const GROUPS = {
    E1: 'E1 · Stripe payments',
    E2: 'E2 · Hosting and database',
    E3: 'E3 · Photo storage',
    E4: 'E4 · Email',
    E5: 'E5 · Access and security',
    E6: 'E6 · Optional services',
  };

  function envChips(env) {
    if (!env || !env.length) return '';
    return '<div class="small" style="margin-top:.35rem;display:flex;flex-wrap:wrap;gap:.35rem">' +
      env.map((e) => `<code style="padding:.1rem .4rem;border-radius:6px;background:${e.set ? '#e5f4e4' : '#fbebeb'}" title="${e.set ? 'set' : 'not set'}">${e.set ? '✓' : '✗'} ${HP.esc(e.name)}</code>`).join('') +
      '</div>';
  }

  function row(it) {
    const [label, kind] = STATUS[it.status] || [it.status, 'muted'];
    return `<div class="card" style="padding:.85rem 1rem;margin:.5rem 0" data-plug="${HP.esc(it.id)}">
      <div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap">
        <strong style="flex:1;min-width:12rem">${HP.esc(it.label)}</strong>
        ${HP.badge(label, kind)}
        ${it.testable ? `<button class="btn btn-outline btn-sm" type="button" data-plug-test="${HP.esc(it.id)}">Run test</button>` : ''}
      </div>
      <p class="small muted" style="margin:.35rem 0 0">${HP.esc(it.detail)}</p>
      ${envChips(it.env)}
      <p class="small" data-plug-result="${HP.esc(it.id)}" style="margin:.35rem 0 0" aria-live="polite"></p>
    </div>`;
  }

  async function render() {
    const box = document.getElementById('plugs-body');
    if (!box) return;
    box.innerHTML = '<p class="muted">Checking every plug…</p>';
    let r;
    try {
      r = await HP.api('GET', '/admin/plugs');
    } catch (e) {
      box.innerHTML = `<div class="banner banner-warn">Could not load the setup checklist: ${HP.esc(HP.friendlyMessage(e))}</div>`;
      return;
    }
    const s = r.summary || {};
    const head = r.ready
      ? '<div class="banner banner-ok" role="status"><strong>Everything required is plugged in.</strong> Helpman is ready to operate.</div>'
      : `<div class="banner banner-warn" role="status"><strong>${s.missing || 0} missing · ${s.warning || 0} to check · ${s.manual || 0} to confirm.</strong> Plug in the red items before launch.</div>`;
    const byGroup = {};
    (r.items || []).forEach((it) => { (byGroup[it.code] = byGroup[it.code] || []).push(it); });
    box.innerHTML = head + Object.keys(GROUPS).filter((g) => byGroup[g]).map((g) =>
      `<h3 style="margin:1.1rem 0 .25rem">${HP.esc(GROUPS[g])}</h3>` + byGroup[g].map(row).join('')
    ).join('') + `<p class="small muted" style="margin-top:1rem">Checked ${HP.esc(HP.fmtDateTime ? HP.fmtDateTime(r.checked_at) : r.checked_at)}. Secret values are never shown here — only whether each one is set.</p>`;
    box.querySelectorAll('[data-plug-test]').forEach((b) => b.addEventListener('click', () => test(b)));
  }

  async function test(btn) {
    const id = btn.dataset.plugTest;
    const out = document.querySelector(`[data-plug-result="${id}"]`);
    btn.disabled = true;
    if (out) out.textContent = 'Testing…';
    try {
      const r = await HP.api('POST', `/admin/plugs/${encodeURIComponent(id)}/test`, {});
      if (out) { out.textContent = (r.ok ? '✓ ' : '✗ ') + (r.detail || ''); out.style.color = r.ok ? 'var(--ok)' : 'var(--err)'; }
    } catch (e) {
      if (out) { out.textContent = '✗ ' + HP.friendlyMessage(e); out.style.color = 'var(--err)'; }
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Business rules (deposit %, payout hold, cancellation / no-show) ----
  async function renderRules() {
    const box = document.getElementById('rules-body');
    if (!box) return;
    let r;
    try { r = await HP.api('GET', '/admin/settings'); }
    catch (e) { box.innerHTML = `<div class="banner banner-warn">Could not load the rules: ${HP.esc(HP.friendlyMessage(e))}</div>`; return; }
    const GROUPS = { money: 'Money', timing: 'Reminders and timeframes', dispatch: 'Automatic offers' };
    // A 0/1 rule is an on/off switch, not a number to type.
    const input = (x) => (x.min === 0 && x.max === 1)
      ? `<select id="rule-${HP.esc(x.key)}" name="${HP.esc(x.key)}" style="max-width:9rem">
          <option value="1"${Number(x.value) === 1 ? ' selected' : ''}>On</option>
          <option value="0"${Number(x.value) === 0 ? ' selected' : ''}>Off</option></select>`
      : `<input type="number" id="rule-${HP.esc(x.key)}" name="${HP.esc(x.key)}" min="${x.min}" max="${x.max}" step="1" value="${Number(x.value)}" style="max-width:9rem">`;
    const field = (x) => `
      <div class="field" style="max-width:640px">
        <label for="rule-${HP.esc(x.key)}">${HP.esc(x.label)} ${x.pending_owner ? HP.badge('Owner decision', 'warn') : ''}</label>
        ${input(x)}
        <p class="small muted" style="margin:.2rem 0 0">${HP.esc(x.help || '')}</p>
      </div>`;
    box.innerHTML = `<form id="rules-form" novalidate>${Object.keys(GROUPS).map((g) => {
      const rows = r.rules.filter((x) => (x.group || 'money') === g);
      return rows.length ? `<h3 style="margin:1rem 0 .5rem">${GROUPS[g]}</h3>${rows.map(field).join('')}` : '';
    }).join('')}
      <button class="btn btn-primary btn-sm" type="submit" id="rules-save">Save rules</button>
      <p class="small" id="rules-msg" role="status"></p></form>`;
    document.getElementById('rules-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = {};
      r.rules.forEach((x) => { const v = e.target.elements[x.key].value; if (String(v) !== String(x.value) || x.pending_owner) values[x.key] = Number(v); });
      const btn = document.getElementById('rules-save');
      HP.busy(btn, true, 'Saving…');
      try { await HP.api('PUT', '/admin/settings', { values }); HP.toast('Rules saved.', 'ok'); renderRules(); }
      catch (err) { document.getElementById('rules-msg').textContent = HP.friendlyMessage(err); HP.busy(btn, false); }
    });
  }

  window.loadPlugsTab = function () {
    const refresh = document.getElementById('plugs-refresh');
    if (refresh && !refresh.dataset.bound) { refresh.dataset.bound = '1'; refresh.addEventListener('click', render); }
    render();
    renderRules();
  };
})();
