// fetch_page against a local http server. The server is on loopback, which
// the real address guard refuses (see netguard.test.js), so these tests
// inject a permissive guard — that's the point of making it injectable.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { htmlToText } from "../src/htmltext.js";

let server;
let baseUrl;
let mcpHome;
let fetchPage;

const noopGuard = async () => {};

before(async () => {
  mcpHome = await fs.mkdtemp(path.join(os.tmpdir(), "schoology-mcp-fetchpage-"));
  process.env.SCHOOLOGY_MCP_HOME = mcpHome;
  ({ fetchPage } = await import("../src/fetchpage.js"));

  server = http.createServer((req, res) => {
    if (req.url === "/page.html" || req.url === "/page2.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<html><head><style>.x{}</style></head><body><nav>skip me</nav><h1>Title</h1><p>Hello <b>world</b>.</p><ul><li>one</li><li>two</li></ul><a href=\"/other\">Other page</a></body></html>",
      );
      return;
    }
    if (req.url === "/lesson.md") {
      // apcs.tinocs.com: a rendered HTML page at a .md URL, menus before the <h1>
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html><head><title>Java Setup</title></head><body><ul>${"<li>menu item</li>".repeat(50)}</ul><h1>JAVA Setup</h1><p>${"Lesson text. ".repeat(30)}</p><a href="/lesson/next.md">Next</a></body></html>`);
      return;
    }
    if (req.url === "/note.md") {
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end("# A note\n\nplain markdown");
      return;
    }
    if (req.url === "/redirected") {
      res.writeHead(302, { location: "/page.html" });
      res.end();
      return;
    }
    if (req.url === "/loop1") {
      res.writeHead(302, { location: "/loop2" });
      res.end();
      return;
    }
    if (req.url === "/loop2") {
      res.writeHead(302, { location: "/loop1" });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(mcpHome, { recursive: true, force: true });
});

test("fetch_page turns HTML into readable text plus a link list", async () => {
  const result = await fetchPage(`${baseUrl}/page.html`, { guard: noopGuard });
  assert.equal(result.kind, "html");
  assert.match(result.text, /Title/);
  assert.match(result.text, /Hello world/);
  assert.ok(!/skip me/.test(result.text), "nav content should be stripped");
  assert.ok(result.links.some((l) => l.url === `${baseUrl}/other`));
  assert.equal(result.cached, false);
});

test("fetch_page returns .md content as is", async () => {
  const result = await fetchPage(`${baseUrl}/note.md`, { guard: noopGuard });
  assert.equal(result.kind, "markdown");
  assert.equal(result.text, "# A note\n\nplain markdown");
});

test("fetch_page follows a redirect, re-checking the guard on each hop", async () => {
  let calls = 0;
  const guard = async () => {
    calls++;
  };
  const result = await fetchPage(`${baseUrl}/redirected`, { guard });
  assert.equal(result.kind, "html");
  assert.equal(result.final_url, `${baseUrl}/page.html`);
  assert.ok(calls >= 2, "guard should be called for both the original and redirected host");
});

test("fetch_page gives up after too many redirects", async () => {
  await assert.rejects(() => fetchPage(`${baseUrl}/loop1`, { guard: noopGuard }), /too many redirects/);
});

test("fetch_page caches responses for repeat requests", async () => {
  let requests = 0;
  const countingFetch = (...args) => {
    requests++;
    return fetch(...args);
  };
  const url = `${baseUrl}/page2.html`;
  const first = await fetchPage(url, { guard: noopGuard, fetchImpl: countingFetch });
  assert.equal(first.cached, false);
  assert.equal(requests, 1);
  const second = await fetchPage(url, { guard: noopGuard, fetchImpl: countingFetch });
  assert.equal(second.cached, true);
  assert.equal(requests, 1, "second call should be served from cache, not hit the network");
  assert.equal(second.text, first.text);
});

test("fetch_page rejects a non-public host via the real (uninjected) guard", async () => {
  await assert.rejects(() => fetchPage("http://127.0.0.1:1/whatever"), /non-public address|refusing to fetch/);
});

test("htmlToText strips script/style/nav and keeps headings, lists, and links", () => {
  const { text, links } = htmlToText(
    '<html><body><script>evil()</script><nav>nav junk</nav><h1>Heading</h1><ul><li>Item A</li><li>Item B</li></ul><a href="https://example.com/foo">Foo</a></body></html>',
    "https://example.com/",
  );
  assert.match(text, /Heading/);
  assert.match(text, /Item A/);
  assert.ok(!/evil\(\)/.test(text));
  assert.ok(!/nav junk/.test(text));
  assert.deepEqual(links, [{ text: "Foo", url: "https://example.com/foo" }]);
});

test("fetch_page: HTML served at a .md URL is read as HTML, from the first <h1>", async () => {
  const r = await fetchPage(`${baseUrl}/lesson.md`, { guard: noopGuard });
  assert.equal(r.kind, "html");
  assert.equal(r.title, "Java Setup");
  assert.match(r.text, /^## JAVA Setup/);
  assert.doesNotMatch(r.text, /menu item/);
  assert.ok(r.links.some((l) => (l.url || l.href || l).toString().endsWith("/lesson/next.md")));
});
