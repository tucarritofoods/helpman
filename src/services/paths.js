// One place that says where uploaded files live on disk.
//
//   UPLOADS_DIR (optional): absolute path of the uploads folder. Set it when the
//   service runs with a persistent disk (e.g. Render disk mounted at /var/data:
//   UPLOADS_DIR=/var/data/uploads). Default: ./uploads next to server.js, which is
//   EPHEMERAL on hosts without a disk — use object storage (S3_BUCKET) or a disk
//   for real customers.
'use strict';
const path = require('path');
const fs = require('fs');

const UPLOAD_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(__dirname, '..', '..', 'uploads');

const DOC_DIR = path.join(UPLOAD_DIR, 'contractor-docs');

for (const d of [UPLOAD_DIR, DOC_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* reported when a file is written */ }
}

// Absolute path of a stored upload, never outside UPLOAD_DIR.
function uploadPath(filename) {
  return path.join(UPLOAD_DIR, path.basename(String(filename || '')));
}

module.exports = { UPLOAD_DIR, DOC_DIR, uploadPath };
