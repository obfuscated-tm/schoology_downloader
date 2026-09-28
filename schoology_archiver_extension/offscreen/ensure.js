// One offscreen document for the whole extension (Chrome allows only one):
// it parses pages for the neo-plan sync (parse.js) and runs the Archiver
// (archive.js), sharing the document and routed by message `target`.

export const OFFSCREEN_URL = 'offscreen/parse.html';

let creating = null;
export async function ensureOffscreen() {
  const have = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)] });
  if (have?.length) return;
  creating ||= chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['DOM_PARSER'],
    justification: 'Read Schoology pages (HTML) for the neo-plan sync and the course archiver',
  }).catch((e) => { if (!/single offscreen|already/i.test(String(e?.message))) throw e; }).finally(() => { creating = null; });
  await creating;
}
