import { sha256, parseContentDisposition } from './util.js';

// Decide what a link is and how (if at all) it can be saved.
// fingerprintUrl: a cheap, deterministic export used to detect edits
// (PDF exports embed timestamps, so hashing the PDF would flag every run as changed).
export function classifyLink(url) {
  let u;
  try { u = new URL(url); } catch { return { kind: 'other', label: 'Link' }; }
  const h = u.hostname.replace(/^www\./, '');
  const p = u.pathname;
  let m;

  if (h === 'forms.gle' || (h === 'docs.google.com' && p.includes('/forms/'))) {
    return { kind: 'form', label: 'Google Form (link only; forms can’t be downloaded)' };
  }
  if (h === 'docs.google.com') {
    const id = (re) => { const mm = p.match(re); return mm && mm[1] !== 'e' ? mm[1] : null; };
    let gid;
    if ((gid = id(/\/document\/(?:u\/\d+\/)?d\/([\w-]+)/))) {
      return { kind: 'google', label: 'Google Doc', ext: 'pdf',
        exportUrl: `https://docs.google.com/document/d/${gid}/export?format=pdf`,
        fingerprintUrl: `https://docs.google.com/document/d/${gid}/export?format=txt` };
    }
    if ((gid = id(/\/presentation\/(?:u\/\d+\/)?d\/([\w-]+)/))) {
      return { kind: 'google', label: 'Google Slides', ext: 'pdf',
        exportUrl: `https://docs.google.com/presentation/d/${gid}/export/pdf`,
        fingerprintUrl: `https://docs.google.com/presentation/d/${gid}/export/txt` };
    }
    if ((gid = id(/\/spreadsheets\/(?:u\/\d+\/)?d\/([\w-]+)/))) {
      return { kind: 'google', label: 'Google Sheet', ext: 'xlsx',
        exportUrl: `https://docs.google.com/spreadsheets/d/${gid}/export?format=xlsx`,
        fingerprintUrl: `https://docs.google.com/spreadsheets/d/${gid}/export?format=csv` };
    }
    if ((gid = id(/\/drawings\/(?:u\/\d+\/)?d\/([\w-]+)/))) {
      return { kind: 'google', label: 'Google Drawing', ext: 'pdf',
        exportUrl: `https://docs.google.com/drawings/d/${gid}/export/pdf`,
        fingerprintUrl: `https://docs.google.com/drawings/d/${gid}/export/svg` };
    }
    return { kind: 'other', label: 'Google Docs link' };
  }
  if (h === 'drive.google.com') {
    if (/\/folders\//.test(p)) return { kind: 'folder', label: 'Google Drive folder (link only; open it to see the files)' };
    const gid = (m = p.match(/\/file\/(?:u\/\d+\/)?d\/([\w-]+)/)) ? m[1] : u.searchParams.get('id');
    if (gid) {
      return { kind: 'drivefile', label: 'Google Drive file', ext: '',
        exportUrl: `https://drive.google.com/uc?export=download&id=${gid}` };
    }
  }
  if (h === 'youtube.com' || h === 'youtu.be' || h === 'm.youtube.com') return { kind: 'other', label: 'YouTube video' };
  return { kind: 'other', label: 'Web link' };
}

async function fetchChecked(url, signal) {
  const r = await fetch(url, { credentials: 'include', signal });
  if (!r.ok) throw new Error(`Google returned HTTP ${r.status}`);
  if (/text\/html/i.test(r.headers.get('content-type') || '')) {
    throw new Error('Google showed a page instead of the file (no access, or too large to export)');
  }
  return r;
}

// Returns { fingerprint, getSource, filename } for Saver.save().
export async function prepareGoogle(info, signal) {
  if (info.fingerprintUrl) {
    const text = await (await fetchChecked(info.fingerprintUrl, signal)).text();
    const fingerprint = 'g:' + (await sha256(text));
    return {
      fingerprint,
      getSource: async () => {
        const r = await fetchChecked(info.exportUrl, signal);
        return { blob: await r.blob() };
      },
      filename: '',
    };
  }
  // Plain Drive file: must download it to hash it.
  const r = await fetchChecked(info.exportUrl, signal);
  const buf = await r.arrayBuffer();
  const filename = parseContentDisposition(r.headers.get('content-disposition'));
  return {
    fingerprint: 'g:' + (await sha256(buf)),
    getSource: async () => ({ blob: new Blob([buf], { type: r.headers.get('content-type') || 'application/octet-stream' }) }),
    filename,
  };
}
