// One place that persists an uploaded photo: validate, optimize (re-encode), then
// keep it on local disk or (when S3_BUCKET is set) in object storage. Used by the
// request-photo, project-photo and profile-photo routes so none can drift.
//
// Security (Corte 1):
//  - The browser's Content-Type is NOT trusted: every file must decode as a real
//    image (sharp reads it) or the whole upload is refused with 400.
//  - Re-encoding drops EXIF/GPS metadata, so a photo can never carry the
//    uploader's location to the other side of the marketplace.
//  - In production sharp is mandatory: without it photos would be stored as-is.
'use strict';
const fs = require('fs');
const photoSvc = require('./photos');
const storage = require('./storage');
const { redactContacts } = require('./views');

let sharp = null;
try { sharp = require('sharp'); } catch (e) { sharp = null; }

const MAX_PIXELS = 50 * 1000 * 1000; // decompression-bomb guard (50 MP)

function invalid(message) {
  // The global error handler maps "Only image files…" to a 400 with this text.
  return new Error(message || 'Only image files are allowed (JPG, PNG, WebP or HEIC, max 5 MB each).');
}

function discard(files) {
  for (const f of files || []) { try { fs.unlinkSync(f.path); } catch (e) { /* already gone */ } }
}

// Refuses the batch unless EVERY file is a decodable image. Cleans up on refusal.
async function assertImages(files) {
  if (!sharp) {
    if (process.env.NODE_ENV === 'production') {
      discard(files);
      throw invalid('Only image files are allowed — photo processing is unavailable on this server, so uploads are paused.');
    }
    return; // development without sharp: tolerated (documented in README)
  }
  for (const f of files || []) {
    try {
      const meta = await sharp(f.path, { limitInputPixels: MAX_PIXELS }).metadata();
      if (!meta || !meta.width || !meta.height || !meta.format) throw new Error('not an image');
    } catch (e) {
      discard(files);
      throw invalid('Only image files are allowed — one of the files is not a valid photo.');
    }
  }
}

// The original file name is free text chosen by the uploader and shown to the
// other side: keep it short and without contact details.
function safeOriginalName(name) {
  const base = String(name || 'photo').split(/[\\/]/).pop().replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  const clean = redactContacts(base);
  return clean.includes('[contact removed') ? 'photo.jpg' : (clean || 'photo.jpg');
}

async function persist(file, kind) {
  const opt = await photoSvc.optimize(file.path, file.mimetype);
  if (!opt.optimized && sharp) {
    // Validated but could not be re-encoded: never store the raw file (it would keep its metadata).
    discard([file]);
    throw invalid('Only image files are allowed — this photo could not be processed. Try a JPG or PNG.');
  }
  if (!storage.isConfigured()) {
    return { opt, filename: file.filename, storageKey: null, storageProvider: 'local' };
  }
  const ext = (String(file.originalname || '').split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'jpg';
  const key = storage.objectKey({ kind, extension: ext });
  await storage.putObject({ key, filePath: opt.path || file.path, contentType: file.mimetype });
  try { fs.unlinkSync(file.path); } catch (e) { /* best effort */ }
  // photos.filename doubles as the lookup key for S3 rows (see server.js photo route).
  return { opt, filename: key, storageKey: key, storageProvider: 's3' };
}

module.exports = { persist, assertImages, safeOriginalName };
