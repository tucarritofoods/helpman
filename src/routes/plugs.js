// Plug-in panel API (owner only). Reports which owner plugs (E1..E6) are in
// place and runs harmless live tests. Never returns a secret value: only
// whether each environment variable is set.
'use strict';
const express = require('express');
const { ah, authRequired } = require('../middleware');
const { requireStaff } = require('../services/permissions');
const { auditLog } = require('../services/audit');
const plugs = require('../services/plugs');

const router = express.Router();
router.use(authRequired, requireStaff('staff'));

router.get('/', ah(async (req, res) => {
  res.json(await plugs.report());
}));

const TESTABLE = ['database', 'stripe', 'storage', 'email'];
router.post('/:id/test', ah(async (req, res) => {
  const id = String(req.params.id || '');
  if (!TESTABLE.includes(id)) return res.status(404).json({ error: 'There is no live test for this item.' });
  let out;
  try {
    out = await plugs.runTest(id, req.user);
  } catch (e) {
    // The provider's message can name the account; keep it short and generic.
    out = { ok: false, detail: 'The test failed: ' + String(e && e.message ? e.message : e).replace(/(sk|pk|rk|whsec|SG)[._-][A-Za-z0-9._-]+/g, '[key]').slice(0, 160) };
  }
  await auditLog(req.user.id, 'plugs.test', 'plugs', null, `${id}: ${out.ok ? 'ok' : 'failed'}`);
  res.json({ id, ...out });
}));

module.exports = router;
