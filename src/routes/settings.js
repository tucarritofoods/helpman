// Business rules (owner): deposit %, payout hold, cancellation and no-show values.
// Read: any staff member. Change: owner only (and audited).
'use strict';
const express = require('express');
const { ah, authRequired, failIfErrors } = require('../middleware');
const { requireStaff } = require('../services/permissions');
const { auditLog } = require('../services/audit');
const settings = require('../services/settings');

const router = express.Router();
router.use(authRequired);

router.get('/', requireStaff('read'), ah(async (req, res) => {
  res.json({ rules: await settings.all() });
}));

router.put('/', requireStaff('staff'), ah(async (req, res) => {
  const out = await settings.update((req.body || {}).values, req.user.id);
  if (out.errors && failIfErrors(res, out.errors)) return;
  await auditLog(req.user.id, 'settings.updated', 'app_settings', null,
    Object.entries((req.body || {}).values || {}).map(([k, v]) => `${k}=${v}`).join(', ').slice(0, 500));
  res.json({ saved: out.saved, rules: await settings.all() });
}));

module.exports = router;
