import { sleep, throwIfStopped } from '../util.js';

const REQUEST_GAP_MS = 400; // be polite: one Schoology page every ~0.4s

export class LoginError extends Error {
  constructor() { super('Not logged in to Schoology in this browser'); }
}

// Fetches Schoology pages using your normal browser login.
// "direct" mode fetches from the extension page; if Schoology doesn't see the
// login cookie that way, it falls back to fetching from inside an open
// Schoology tab (same-origin, always has your session).
export class SchoologyClient {
  constructor({ host, tabId, log, signal }) {
    this.signal = signal;
    this.host = host;
    this.origin = `https://${host}`;
    this.tabId = tabId ? Number(tabId) : null;
    this.log = log;
    this.mode = 'direct';
    this.lastRequest = 0;
  }

  abs(u) { return new URL(u, this.origin).href; }

  async init(courseId) {
    const url = `${this.origin}/course/${courseId}/materials`;
    try {
      const res = await this.getDoc(url);
      this.verified = true;
      return res;
    } catch (e) {
      if (!(e instanceof LoginError) && !(e instanceof TypeError)) throw e;
    }
    const tabId = await this.findSchoologyTab();
    if (!tabId) throw new LoginError();
    this.mode = 'tab';
    this.tabId = tabId;
    this.log('Using your open Schoology tab to read pages (tab mode).');
    const res = await this.getDoc(url);
    this.verified = true;
    return res;
  }

  async findSchoologyTab() {
    if (this.tabId) {
      try {
        const t = await chrome.tabs.get(this.tabId);
        if (t.url && new URL(t.url).host === this.host) return t.id;
      } catch { /* tab closed */ }
    }
    const tabs = await chrome.tabs.query({ url: `${this.origin}/*` });
    return tabs[0]?.id ?? null;
  }

  // noRedirect: a redirect is reported ({ redirected: true }) and never
  // followed, so the page it points at is not requested at all.
  async raw(url, noRedirect = false) {
    const redirect = noRedirect ? 'manual' : 'follow';
    if (this.mode === 'direct') {
      const r = await fetch(url, { credentials: 'include', signal: this.signal, redirect });
      if (r.type === 'opaqueredirect') return { status: 0, url, text: '', redirected: true };
      return { status: r.status, url: r.url, text: await r.text() };
    }
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: async (u, redir) => {
        const r = await fetch(u, { credentials: 'include', redirect: redir });
        if (r.type === 'opaqueredirect') return { status: 0, url: u, text: '', redirected: true };
        return { status: r.status, url: r.url, text: await r.text() };
      },
      args: [url, redirect],
    });
    if (!res || !res.result) throw new Error('Could not read page through the Schoology tab (was it closed?)');
    return res.result;
  }

  async throttle() {
    const wait = this.lastRequest + REQUEST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait, this.signal);
    this.lastRequest = Date.now();
  }

  // Returns { doc, url }. Throws LoginError / Error('HTTP ...').
  async getDoc(url) {
    const r = await this.getText(url);
    const doc = new DOMParser().parseFromString(r.text, 'text/html');
    if (doc.querySelector('form#s-user-login-form, #login-container')) throw new LoginError();
    return { doc, url: r.url };
  }

  async getText(url, { noRedirect = false } = {}) {
    url = this.abs(url);
    if (isQuizTakingUrl(url)) throw new Error(`refused to open a quiz-taking page (${new URL(url).pathname})`);
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      throwIfStopped(this.signal);
      await this.throttle();
      let r;
      try {
        r = await this.raw(url, noRedirect);
      } catch (e) {
        throwIfStopped(this.signal);
        // A redirect to Google sign-in shows up as a CORS TypeError.
        lastErr = e;
        if (e instanceof TypeError && !this.verified) throw e;
        await sleep(1500 * (attempt + 1), this.signal);
        continue;
      }
      if (r.redirected) return { text: '', url, redirected: true };
      if (r.status === 429 || r.status >= 500) {
        lastErr = new Error(`HTTP ${r.status}`);
        await sleep(3000 * (attempt + 1), this.signal);
        continue;
      }
      const final = new URL(r.url || url);
      if (final.host !== this.host || final.pathname.startsWith('/login')) throw new LoginError();
      if (r.status >= 400) throw new Error(`HTTP ${r.status} for ${final.pathname}`);
      return { text: r.text, url: r.url || url };
    }
    throw lastErr || new Error('request failed');
  }
}

// VIEW ONLY safety net: pages that take/start/resume a quiz are never requested.
// /assignment/ID/assessment is the Test/Quiz "take" tab (/assessment_view is the read-only history).
export function isQuizTakingUrl(url) {
  const p = new URL(url).pathname;
  return /\/assessment\/?$/.test(p) || /\/assessment\/(start|take|resume|attempt|submit)/.test(p)
    || /\/(start|take|resume)[_-]?(attempt|assessment|quiz)/i.test(p)
    // /assessment/5/start, /course/1/assessments/2/take, …/assessments/2/resume/
    || /\/assessments?\/(\d+\/)*(start|take|resume|submit|begin)(\/|$)/i.test(p)
    // the dropbox submit form: opening it submits nothing, but nothing here needs it
    || /\/dropbox\/submit(\/|$)/i.test(p);
}
