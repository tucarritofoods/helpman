// HELPMAN Phase 6 — Growth & Launch dashboard
(function(){
  'use strict';
  // Corte 6: no longer an extra tab; it is Reports › Growth.
  async function loadGrowth(){
    const box=document.getElementById('hm6-growth');if(!box)return;
    try{
      const [g,r]=await Promise.all([
        HP.api('GET','/growth/admin/growth'),
        HP.api('GET','/health/ready').catch(()=>({ok:false,checks:{}}))
      ]);
      box.innerHTML=`
        <p class="small muted">Acquisition, reputation and production readiness.</p>
        <div class="hm6-kpis">
          <div><span>Avg rating</span><strong>${g.reviews.avg_rating.toFixed(1)}</strong></div>
          <div><span>Reviews</span><strong>${g.reviews.total}</strong></div>
          <div><span>Referrals</span><strong>${g.referrals.total}</strong></div>
          <div><span>Referral redemption</span><strong>${g.referrals.redemption_pct}%</strong></div>
          <div><span>Production ready</span><strong>${r.ok?'Yes':'Not yet'}</strong></div>
        </div>
        <div class="hm6-grid">
          <section class="card"><h3>Acquisition by source</h3>
            ${g.acquisition.length?g.acquisition.map(x=>`<div class="hm6-source"><span>${HP.esc(x.source)}</span><div><i style="width:${Math.min(100,x.conversion_pct)}%"></i></div><strong>${x.conversion_pct}%</strong><small>${x.converted}/${x.leads}</small></div>`).join(''):'<p class="muted">No acquisition data yet.</p>'}
          </section>
          <section class="card"><h3>Readiness checks</h3>
            ${Object.entries(r.checks||{}).map(([k,v])=>`<div class="hm6-check"><span>${v.ok?'✓':'×'}</span><div><strong>${HP.esc(k.replaceAll('_',' '))}</strong><small>${HP.esc(v.provider||v.detail||'')}</small></div></div>`).join('')}
          </section>
        </div>`;
    }catch(e){box.innerHTML=`<div class="banner banner-warn">${HP.esc(HP.friendlyMessage(e))}</div>`;}
  }
  window.HMGrowth={loadGrowth};
})();
