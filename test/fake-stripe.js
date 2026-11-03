// Fake Stripe client for the money and visit tests (no network).
// Shared by test/money.test.js and test/visit.test.js.
'use strict';
let SEQ = 0;
function makeFake() {
  const intents = new Map(), refunds = [], transferLog = [], reversals = [], accountMap = new Map(), customerLog = [];
  const state = { offSession: 'succeed' }; // 'succeed' | 'auth' | 'decline'
  const refunded = (id) => refunds.filter(r => r.payment_intent === id).reduce((a, r) => a + r.amount, 0);
  const cardError = (code, pi) => Object.assign(new Error(code === 'authentication_required' ? 'This payment requires authentication.' : 'Your card was declined.'), { type: 'StripeCardError', code, raw: { payment_intent: pi } });
  const fake = {
    state, intents, refundLog: refunds, transferLog, reversals, accountMap, customerLog,
    customers: { create: async (p, o) => { const c = { id: `cus_${++SEQ}`, email: p.email, idem: o && o.idempotencyKey }; customerLog.push(c); return c; } },
    paymentIntents: {
      create: async (p, o) => {
        const id = `pi_${++SEQ}`;
        const pi = { id, client_secret: `${id}_secret`, amount: p.amount, amount_received: 0, metadata: p.metadata, customer: p.customer || null,
          payment_method: p.payment_method || null, setup_future_usage: p.setup_future_usage || null, off_session: !!p.off_session,
          status: 'requires_payment_method', idem: o && o.idempotencyKey, latest_charge: null };
        intents.set(id, pi);
        if (p.off_session && p.confirm) {
          if (state.offSession === 'succeed') { pi.status = 'succeeded'; pi.amount_received = p.amount; pi.latest_charge = `ch_${++SEQ}`; }
          else if (state.offSession === 'auth') { pi.status = 'requires_payment_method'; throw cardError('authentication_required', { ...pi }); }
          else { pi.status = 'requires_payment_method'; throw cardError('card_declined', { ...pi }); }
        }
        return { ...pi };
      },
      cancel: async (id) => { intents.get(id).status = 'canceled'; return intents.get(id); },
      retrieve: async (id) => { const pi = intents.get(id); return { ...pi, latest_charge: { id: pi.latest_charge || `ch_for_${id}`, amount: pi.amount_received, amount_refunded: refunded(id) } }; },
    },
    refunds: { create: async ({ payment_intent, amount }) => {
      const pi = intents.get(payment_intent);
      if (amount > pi.amount_received - refunded(payment_intent)) throw new Error('over-refund');
      const r = { id: `re_${++SEQ}`, payment_intent, amount }; refunds.push(r); return r;
    } },
    accounts: {
      create: async (p, o) => { const a = { id: `acct_${++SEQ}`, email: p.email, payouts_enabled: false, details_submitted: false, requirements: { currently_due: ['external_account'] }, idem: o && o.idempotencyKey }; accountMap.set(a.id, a); return a; },
      retrieve: async (id) => ({ ...accountMap.get(id) }),
    },
    accountLinks: { create: async (p) => ({ url: `https://connect.stripe.test/setup/${p.account}`, expires_at: 1 }) },
    transfers: {
      create: async (p, o) => { const t = { id: `tr_${++SEQ}`, ...p, idem: o && o.idempotencyKey }; transferLog.push(t); return t; },
      createReversal: async (id, p) => { const r = { id: `trr_${++SEQ}`, transfer: id, amount: p.amount }; reversals.push(r); return r; },
    },
    balance: { retrieve: async () => ({ livemode: false }) },
    webhooks: { constructEvent: (raw, sig, secret) => { if (sig !== `valid-${secret}`) throw new Error('bad signature'); return JSON.parse(Buffer.from(raw).toString('utf8')); } },
    // helper: the customer pays an intent in the browser
    pay(id, pm = 'pm_card_visa') { const pi = intents.get(id); pi.amount_received = pi.amount; pi.status = 'succeeded'; pi.payment_method = pm; pi.latest_charge = `ch_${++SEQ}`; return pi; },
  };
  return fake;
}
module.exports = { makeFake };
