'use strict';

const express = require('express');
const db = require('../db');
const { ah, authRequired, requireRole, isNonEmpty, failIfErrors } = require('../middleware');
const { auditLog } = require('../services/audit');
const ops = require('../services/operations');
const { rankContractors } = require('../services/matching');
const { requireStaff } = require('../services/permissions');

const router = express.Router();
// Corte 6: per-area permissions. Before, ANY team role could use every endpoint here,
// including the money figures in /analytics and offering jobs.
router.use(authRequired, requireRole('admin'), requireStaff('read'));

router.get('/control-center', ah(async (req,res)=>{
  res.json(await ops.controlCenter());
}));

router.post('/generate', ah(async (req,res)=>{
  const generated = await ops.generateOperationalTasks();
  res.json({ generated_count: generated.length, tasks: generated });
}));

router.get('/tasks', ah(async (req,res)=>{
  const status = String(req.query.status || '').trim();
  const priority = String(req.query.priority || '').trim();
  const where=[], args=[];
  if(status){ where.push('t.status = ?'); args.push(status); }
  if(priority){ where.push('t.priority = ?'); args.push(priority); }
  const sql = `SELECT t.*, u.name AS assignee_name
    FROM operations_tasks t LEFT JOIN users u ON u.id=t.assigned_to
    ${where.length?'WHERE '+where.join(' AND '):''}
    ORDER BY
      CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
      t.id DESC LIMIT 300`;
  res.json(await db.prepare(sql).all(...args));
}));

router.post('/tasks', ah(async (req,res)=>{
  const b=req.body||{}, errors={};
  if(!isNonEmpty(b.title,200)) errors.title='Title is required.';
  if(b.priority && !['low','medium','high','critical'].includes(b.priority)) errors.priority='Invalid priority.';
  if(failIfErrors(res,errors)) return;
  const info=await db.prepare(`INSERT INTO operations_tasks
    (title,detail,entity_type,entity_id,priority,status,assigned_to,due_at,source,created_by)
    VALUES(?,?,?,?,?,'open',?,?, 'manual',?)`)
    .run(b.title.trim(),String(b.detail||'').trim().slice(0,3000)||null,
      b.entity_type||null,b.entity_id||null,b.priority||'medium',
      b.assigned_to||null,b.due_at||null,req.user.id);
  auditLog(req.user.id,'operations.task_created','operations_tasks',info.lastInsertRowid,b.title.trim());
  res.status(201).json(await db.prepare('SELECT * FROM operations_tasks WHERE id=?').get(info.lastInsertRowid));
}));

router.patch('/tasks/:id', ah(async (req,res)=>{
  const t=await db.prepare('SELECT * FROM operations_tasks WHERE id=?').get(req.params.id);
  if(!t) return res.status(404).json({error:'Task not found.'});
  const b=req.body||{};
  const patch={};
  if(b.status!==undefined){
    if(!['open','in_progress','blocked','done','dismissed'].includes(b.status)) return res.status(422).json({error:'Invalid status.'});
    patch.status=b.status;
  }
  if(b.priority!==undefined){
    if(!['low','medium','high','critical'].includes(b.priority)) return res.status(422).json({error:'Invalid priority.'});
    patch.priority=b.priority;
  }
  if(b.assigned_to!==undefined) patch.assigned_to=b.assigned_to||null;
  if(b.due_at!==undefined) patch.due_at=b.due_at||null;
  if(b.detail!==undefined) patch.detail=String(b.detail||'').trim().slice(0,3000)||null;
  const sets=Object.keys(patch).map(k=>`${k}=?`);
  if(!sets.length) return res.status(400).json({error:'Nothing to update.'});
  if(patch.status==='done') { sets.push('completed_at=CURRENT_TIMESTAMP'); }
  sets.push('updated_at=CURRENT_TIMESTAMP');
  await db.prepare(`UPDATE operations_tasks SET ${sets.join(',')} WHERE id=?`)
    .run(...Object.values(patch),t.id);
  auditLog(req.user.id,'operations.task_updated','operations_tasks',t.id,JSON.stringify(patch));
  res.json(await db.prepare('SELECT * FROM operations_tasks WHERE id=?').get(t.id));
}));

router.get('/dispatch', requireStaff('dispatch'), ah(async(req,res)=>{
  const rows=await db.prepare(
    `SELECT p.*, j.service_type,j.city,j.state,j.zip,j.urgency,j.description, j.status AS job_status,
            c.legal_name AS contractor_name
     FROM projects p
     JOIN job_requests j ON j.id=p.job_request_id
     LEFT JOIN contractors c ON c.id=p.contractor_id
     WHERE p.stage IN ('assigned','scheduled','in_progress')
     ORDER BY
       CASE WHEN p.contractor_id IS NULL THEN 0 ELSE 1 END,
       CASE j.urgency WHEN 'urgent' THEN 0 ELSE 1 END,
       p.id DESC`
  ).all();
  res.json(rows);
}));

router.get('/projects/:id/recommendations', requireStaff('dispatch'), ah(async(req,res)=>{
  const p=await db.prepare(
    `SELECT p.*,j.service_type,j.city,j.state,j.zip,j.urgency
     FROM projects p JOIN job_requests j ON j.id=p.job_request_id
     WHERE p.id=?`
  ).get(req.params.id);
  if(!p) return res.status(404).json({error:'Project not found.'});

  const contractors=await db.prepare(
    `SELECT c.*,
       (SELECT COUNT(*) FROM projects p2 WHERE p2.contractor_id=c.id AND p2.stage IN ('assigned','scheduled','in_progress','review')) AS current_workload
     FROM contractors c WHERE c.status='active'`
  ).all();

  // Phase 3 availability can improve this data when present.
  try{
    for(const c of contractors){
      const rows=await db.prepare('SELECT * FROM contractor_availability WHERE contractor_id=? AND is_available=1').all(c.id);
      c.is_available=rows.length>0;
    }
  }catch(_){}

  const ranked=rankContractors(p,contractors).slice(0,10);
  res.json(ranked);
}));

// Corte 6: this used to offer the job directly, skipping every gate of the real flow
// (deposit paid, pro photo, offer deadline + email, dispatch role, and it could even
// take a project already in progress away from its pro). Offers now go only through
// POST /api/projects/:id/assign, which enforces all of them.
router.post('/projects/:id/dispatch/:contractorId', (req, res) => {
  res.status(410).json({ error: 'Offer the job from Projects (POST /api/projects/:id/assign); it checks the deposit, the photo and the offer deadline.', code: 'USE_ASSIGN' });
});

router.get('/risks', ah(async(req,res)=>{
  const risks=[];

  const failed=await db.prepare(`SELECT id,project_id,kind,amount_cents FROM payments WHERE status='failed'`).all();
  failed.forEach(x=>risks.push({severity:'critical',type:'payment',entity_id:x.id,title:`Payment failed — project #${x.project_id}`,detail:`${x.kind} · $${(Number(x.amount_cents)/100).toFixed(2)}`}));

  const waiting=await db.prepare(`SELECT id,project_id,title FROM milestones WHERE status='completed' AND customer_approval='pending'`).all();
  waiting.forEach(x=>risks.push({severity:'warning',type:'milestone',entity_id:x.id,title:`Approval pending — project #${x.project_id}`,detail:x.title}));

  const unassigned=await db.prepare(`SELECT p.id,j.service_type FROM projects p JOIN job_requests j ON j.id=p.job_request_id WHERE p.stage='assigned' AND p.contractor_id IS NULL`).all();
  unassigned.forEach(x=>risks.push({severity:'critical',type:'dispatch',entity_id:x.id,title:`Unassigned project #${x.id}`,detail:x.service_type}));

  try{
    const docs=await db.prepare(`SELECT d.id,d.contractor_id,d.doc_type,d.expires_on,c.legal_name
      FROM contractor_documents d JOIN contractors c ON c.id=d.contractor_id
      WHERE d.expires_on IS NOT NULL AND d.status IN ('submitted','verified')`).all();
    for(const d of docs){
      const days=Math.ceil((new Date(d.expires_on).getTime()-Date.now())/86400000);
      if(days<=30) risks.push({severity:days<0?'critical':'warning',type:'compliance',entity_id:d.id,title:`${days<0?'Expired':'Expiring'} ${d.doc_type}`,detail:`${d.legal_name} · ${d.expires_on}`});
    }
  }catch(_){}

  res.json(risks);
}));

router.post('/notes', ah(async(req,res)=>{
  const b=req.body||{};
  if(!isNonEmpty(b.body,3000)) return res.status(422).json({error:'Note is required.'});
  if(!isNonEmpty(b.entity_type,80) || !b.entity_id) return res.status(422).json({error:'Entity is required.'});
  const info=await db.prepare(`INSERT INTO operations_notes(entity_type,entity_id,body,created_by) VALUES(?,?,?,?)`)
    .run(b.entity_type,b.entity_id,b.body.trim(),req.user.id);
  res.status(201).json(await db.prepare('SELECT * FROM operations_notes WHERE id=?').get(info.lastInsertRowid));
}));

router.get('/notes/:entityType/:entityId', ah(async(req,res)=>{
  res.json(await db.prepare(
    `SELECT n.*,u.name AS author_name FROM operations_notes n
     LEFT JOIN users u ON u.id=n.created_by
     WHERE n.entity_type=? AND n.entity_id=? ORDER BY n.id DESC`
  ).all(req.params.entityType,req.params.entityId));
}));

router.get('/analytics', requireStaff('finance'), ah(async(req,res)=>{
  const leads=await db.prepare(`SELECT source,COUNT(*) c,
    SUM(CASE WHEN status IN ('assigned','scheduled','in_progress','review','completed') THEN 1 ELSE 0 END) converted
    FROM job_requests GROUP BY source ORDER BY c DESC`).all();

  const margin=await db.prepare(`SELECT
    COALESCE(SUM(customer_price_cents),0) revenue,
    COALESCE(SUM(contractor_cost_cents),0) cost,
    COUNT(*) projects
    FROM projects WHERE stage='completed'`).get();

  const ageing=await db.prepare(`SELECT status,COUNT(*) c,MIN(created_at) oldest,MAX(created_at) newest
    FROM job_requests WHERE status NOT IN ('completed','lost','cancelled') GROUP BY status`).all();

  res.json({
    acquisition: leads.map(x=>({
      source:x.source||'unknown', leads:Number(x.c||0), converted:Number(x.converted||0),
      conversion_pct:Number(x.c)?Math.round(Number(x.converted||0)/Number(x.c)*100):0
    })),
    economics:{
      revenue_cents:Number(margin.revenue||0),
      cost_cents:Number(margin.cost||0),
      gross_profit_cents:Number(margin.revenue||0)-Number(margin.cost||0),
      gross_margin_pct:Number(margin.revenue)?Math.round((Number(margin.revenue)-Number(margin.cost))/Number(margin.revenue)*100):0,
      completed_projects:Number(margin.projects||0)
    },
    pipeline_ageing:ageing
  });
}));

module.exports=router;
