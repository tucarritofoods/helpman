// CRM Clients (Corte 4): directory + client profile with 9 tabs, staff only.
//
//   GET  /api/clients                     directory (search, lifecycle, tag, city, sort, page)
//   GET  /api/clients/tags                tags in use (+ 'vip', 'blocked')
//   GET  /api/clients/:id                 1 Summary
//   GET  /api/clients/:id/work            2 Requests & projects
//   GET  /api/clients/:id/money           3 Payments & balance            (finance)
//   GET  /api/clients/:id/messages        4 Messages (through support)
//   GET  /api/clients/:id/notes           5 Internal notes
//   GET  /api/clients/:id/tasks           6 Tasks
//   GET  /api/clients/:id/consents        7 Consents & communications
//   GET  /api/clients/:id/campaigns       8 Campaigns received
//   GET  /api/clients/:id/history         9 History
//   actions (support): tags, notes, tasks, email, request on behalf, resend access, marketing opt-out
//
// Access: every staff role that has 'support' or 'finance'. Money is only for
// 'finance'; actions only for 'support'. Customers and contractors get 403.
'use strict';
const express = require('express');
const { ah, authRequired } = require('../middleware');
const { can, denial, effectiveRole } = require('../services/permissions');
const clients = require('../services/clients');

const router = express.Router();
router.use(authRequired, (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'You do not have permission to do that.' });
  if (!can(req.user, 'support') && !can(req.user, 'finance')) return res.status(403).json(denial(req.user, 'support'));
  next();
});
const need = (area) => (req, res, next) => { const d = denial(req.user, area); if (d) return res.status(403).json(d); next(); };
const withMoney = (req) => !denial(req.user, 'finance');

// Service errors carry statusCode (+ errors for field messages).
const run = (fn) => ah(async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.status(req.method === 'POST' ? 201 : 200).json(out);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json(e.errors ? { errors: e.errors } : { error: e.message, ...(e.code ? { code: e.code } : {}) });
    throw e;
  }
});

router.get('/', run((req) => clients.list({ ...req.query, withMoney: withMoney(req) })));
router.get('/tags', run(() => clients.allTags()));
// Team members a task can be assigned to (names only).
router.get('/team', run(async () => require('../db').prepare(`SELECT id, name FROM users WHERE role = 'admin' AND (staff_role IS NULL OR staff_role <> 'disabled') ORDER BY name`).all()));
router.get('/:id', run((req) => clients.summary(req.params.id, { withMoney: withMoney(req) })));
router.get('/:id/work', run((req) => clients.requestsAndProjects(req.params.id)));
router.get('/:id/money', need('finance'), run((req) => clients.money(req.params.id)));
router.get('/:id/messages', run((req) => clients.messages(req.params.id)));
router.get('/:id/notes', need('support'), run((req) => clients.notes(req.params.id)));
router.get('/:id/tasks', run((req) => clients.tasks(req.params.id)));
router.get('/:id/consents', run((req) => clients.consents(req.params.id)));
router.get('/:id/campaigns', run((req) => clients.campaignsReceived(req.params.id)));
router.get('/:id/history', run((req) => clients.history(req.params.id)));

router.post('/:id/tags', need('support'), run((req) => clients.setTags(req.params.id, req.body || {}, req.user).then((tags) => ({ tags }))));
router.post('/:id/notes', need('support'), run((req) => clients.addNote(req.params.id, req.body || {}, req.user)));
router.patch('/:id/notes/:noteId', need('support'), run((req) => clients.updateNote(req.params.id, req.params.noteId, req.body || {}, req.user)));
router.delete('/:id/notes/:noteId', need('support'), run((req) => clients.deleteNote(req.params.id, req.params.noteId, req.user, effectiveRole(req.user) === 'owner')));
router.post('/:id/tasks', need('support'), run((req) => clients.addTask(req.params.id, req.body || {}, req.user)));
router.patch('/:id/tasks/:taskId', need('support'), run((req) => clients.setTaskStatus(req.params.id, req.params.taskId, (req.body || {}).status, req.user)));
router.post('/:id/email', need('support'), run((req) => clients.emailClient(req.params.id, req.body || {}, req.user)));
router.post('/:id/requests', need('support'), run((req) => clients.createRequest(req.params.id, req.body || {}, req.user)));
router.post('/:id/resend-access', need('support'), run((req) => clients.resendAccess(req.params.id, req.user)));
router.post('/:id/marketing-unsubscribe', need('support'), run((req) => clients.unsubscribeMarketing(req.params.id, req.user)));

module.exports = router;
