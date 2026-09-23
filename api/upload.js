const Busboy = require('busboy');
const { Readable } = require('stream');
const { google } = require('googleapis');

const {
  API_KEY,
  GOOGLE_DRIVE_FOLDER_ID,
  // Option A: service account key JSON (whole file contents, or base64 of it)
  GOOGLE_SERVICE_ACCOUNT_KEY,
  // Option B: OAuth user credentials (use for a normal "My Drive" folder)
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
} = process.env;

// Vercel rejects request bodies over 4.5MB before they reach the function.
const MAX_BODY_BYTES = 4.5 * 1024 * 1024;

let driveClient;
function getDrive() {
  if (driveClient) return driveClient;

  let auth;
  if (GOOGLE_REFRESH_TOKEN) {
    auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  } else if (GOOGLE_SERVICE_ACCOUNT_KEY) {
    const raw = GOOGLE_SERVICE_ACCOUNT_KEY.trim().startsWith('{')
      ? GOOGLE_SERVICE_ACCOUNT_KEY
      : Buffer.from(GOOGLE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf8');
    auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(raw),
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
  } else {
    throw new Error('Missing Google credentials: set GOOGLE_REFRESH_TOKEN or GOOGLE_SERVICE_ACCOUNT_KEY');
  }

  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

async function uploadToDrive({ name, mimeType, buffer, folderId }) {
  const res = await getDrive().files.create({
    requestBody: { name, parents: [folderId] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id, name, mimeType, size, webViewLink',
    supportsAllDrives: true,
  });
  return res.data;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const files = [];
    const fields = {};
    const bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_BODY_BYTES } });

    bb.on('file', (_field, stream, info) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () =>
        files.push({
          name: info.filename,
          mimeType: info.mimeType || 'application/octet-stream',
          buffer: Buffer.concat(chunks),
        })
      );
    });
    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('close', () => resolve({ files, fields }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

/**
 * POST /api/upload
 *  - multipart/form-data: each file is uploaded as-is (other form fields -> saved as JSON if no files)
 *  - application/json:    { filename, base64, mimeType? } -> decoded file; any other body saved as a .json file
 *  - anything else:       raw body saved as-is
 * Optional query params: ?filename=name.ext&folderId=<override>
 * Auth header: x-api-key: <API_KEY>
 */
async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!API_KEY || req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!GOOGLE_DRIVE_FOLDER_ID) {
    return res.status(500).json({ error: 'GOOGLE_DRIVE_FOLDER_ID is not configured' });
  }

  // Accept a bare ID or a pasted folder URL (drops "/folders/" prefix and "?hl=..." suffix).
  const folderId = String(req.query.folderId || GOOGLE_DRIVE_FOLDER_ID)
    .trim()
    .replace(/^.*\/folders\//, '')
    .split(/[?#/]/)[0];
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  try {
    let items;

    if (contentType.startsWith('multipart/form-data')) {
      const { files, fields } = await parseMultipart(req);
      items = files.length
        ? files.map((f) => ({ ...f, name: f.name || `upload-${timestamp}` }))
        : Object.keys(fields).length
          ? [{
              name: req.query.filename || `data-${timestamp}.json`,
              mimeType: 'application/json',
              buffer: Buffer.from(JSON.stringify(fields, null, 2)),
            }]
          : [];
    } else {
      const body = await readRawBody(req);
      const isJson = contentType.includes('application/json');
      let json;
      if (isJson) {
        try { json = JSON.parse(body.toString('utf8')); } catch { json = null; }
      }

      if (json && typeof json.base64 === 'string' && json.filename) {
        // { filename, base64, mimeType? } -> decoded file (data: URL prefix allowed)
        const b64 = json.base64.replace(/^data:[^,]*,/, '');
        items = [{
          name: json.filename,
          mimeType: json.mimeType || (/\.pdf$/i.test(json.filename) ? 'application/pdf' : 'application/octet-stream'),
          buffer: Buffer.from(b64, 'base64'),
        }];
      } else if (body.length) {
        items = [{
          name: req.query.filename || `data-${timestamp}.${isJson ? 'json' : contentType.startsWith('text/') ? 'txt' : 'bin'}`,
          mimeType: contentType.split(';')[0] || 'application/octet-stream',
          buffer: body,
        }];
      } else {
        items = [];
      }
    }

    if (!items.length) {
      return res.status(400).json({ error: 'No data received' });
    }

    const uploaded = [];
    for (const item of items) {
      uploaded.push(await uploadToDrive({ ...item, folderId }));
    }
    return res.status(201).json({ success: true, files: uploaded });
  } catch (err) {
    console.error('Upload failed:', err.errors || err.message);
    const status = Number.isInteger(err.code) && err.code >= 400 && err.code < 600 ? err.code : 500;
    return res.status(status).json({ error: 'Upload to Google Drive failed', details: err.errors || err.message });
  }
}

module.exports = handler;
// Let us read the raw stream ourselves (needed for multipart and binary bodies).
module.exports.config = { api: { bodyParser: false } };
