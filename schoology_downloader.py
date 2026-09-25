#!/usr/bin/env python3
"""
Schoology Bulk Downloader
Downloads all materials from a Schoology course, preserving folder structure.
Handles: documents, assignments, assessments, pages, discussions, folders.

Usage:
    1. Fill in the CONFIG section below
    2. Run: python3 schoology_downloader.py
"""

import re
import time
import requests
from pathlib import Path
from urllib.parse import urljoin, urlparse, unquote
from bs4 import BeautifulSoup

# ─────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────
COURSE_ID = "8141837521"
OUTPUT_DIR = "./schoology_files"

COOKIES = {
    "SESS3acdf46cd5ac700bf8c41bf16bd2407e": "654b164ec59547db2b9207068a9a5066",
}

BASE_URL = "https://fuhsd.schoology.com"
REQUEST_DELAY = 0.5
# ─────────────────────────────────────────────

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36",
}

session = requests.Session()
session.cookies.update(COOKIES)
session.headers.update(HEADERS)


def sanitize(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(". ")


def get_soup(url: str) -> BeautifulSoup:
    time.sleep(REQUEST_DELAY)
    resp = session.get(url, allow_redirects=True)
    resp.raise_for_status()
    return BeautifulSoup(resp.text, "html.parser")


def save_html(url: str, dest_dir: Path, filename: str):
    """Save a page as HTML file."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    path = dest_dir / f"{sanitize(filename)}.html"
    if path.exists():
        print(f"  [skip] {path}")
        return
    try:
        time.sleep(REQUEST_DELAY)
        resp = session.get(url, allow_redirects=True)
        path.write_bytes(resp.content)
        print(f"  [html] {path}")
    except Exception as e:
        print(f"  [error] Could not save HTML {url}: {e}")


def download_file(url: str, dest_dir: Path, filename: str = None):
    """Download a binary file."""
    time.sleep(REQUEST_DELAY)
    try:
        resp = session.get(url, stream=True, allow_redirects=True)
        resp.raise_for_status()

        if not filename:
            cd = resp.headers.get("Content-Disposition", "")
            match = re.search(r'filename\*?=["\']?(?:UTF-8\'\')?([^"\';\n]+)', cd, re.IGNORECASE)
            if match:
                filename = unquote(match.group(1).strip())
            else:
                filename = unquote(urlparse(resp.url).path.split("/")[-1]) or "file"

        filename = sanitize(filename)
        if not filename or filename == ".":
            filename = "file"

        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_path = dest_dir / filename

        if dest_path.exists():
            print(f"  [skip] {dest_path}")
            return

        with open(dest_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)
        print(f"  [save] {dest_path}")

    except Exception as e:
        print(f"  [error] Failed to download {url}: {e}")


def scrape_gp_page(url: str, dest_dir: Path, filename_hint: str = None):
    """
    Visit a /materials/gp/XXXXX viewer page and download the real file.
    Attachment links are relative paths like /attachment/ID/source/hash.pdf
    """
    try:
        soup = get_soup(url)

        for sel in [
            "a[href*='/attachment/']",
            "a[href*='asset-cdn.schoology.com']",
            "a[href*='download=1']",
            "a[href*='/file/']",
            "a[download]",
        ]:
            link = soup.select_one(sel)
            if link and link.get("href"):
                fname = filename_hint or link.get_text(strip=True) or None
                download_file(urljoin(BASE_URL, link["href"]), dest_dir, fname)
                return

        # Fallback: any link with a known file extension
        for a in soup.find_all("a", href=True):
            if any(a["href"].lower().endswith(ext) for ext in
                   ['.pdf', '.pptx', '.ppt', '.docx', '.doc', '.xlsx', '.xls', '.png', '.jpg', '.zip']):
                download_file(urljoin(BASE_URL, a["href"]), dest_dir,
                              filename_hint or a.get_text(strip=True) or None)
                return

        # Last resort: save as HTML
        save_html(url, dest_dir, filename_hint or "document")

    except Exception as e:
        print(f"  [error] Could not scrape gp page {url}: {e}")


def extract_google_link(href: str) -> str:
    """Extract real URL from Schoology /link?a=...&path=ENCODED redirect."""
    from urllib.parse import parse_qs, urlparse, unquote
    if "/link?" in href:
        qs = parse_qs(urlparse(href).query)
        if "path" in qs:
            return unquote(qs["path"][0])
    return href


def handle_assignment(url: str, dest_dir: Path, title: str):
    """
    Assignment: always creates a subfolder named after the assignment.
    - instructions.html: saved if description exists
    - attachments/: teacher-attached files or links
    - submissions/: shortcut links to your submitted revisions
    """
    try:
        # Use /assignment/ID/info format which returns full HTML
        if "/assignments/" in url:
            url = url.replace("/assignments/", "/assignment/").replace("/info", "") + "/info"
        elif not url.endswith("/info"):
            # Convert /assignment/ID to /assignment/ID/info
            url = re.sub(r"(/assignment/\d+).*", r"/info", url)

        soup = get_soup(url)
        assign_dir = dest_dir / title
        assign_dir.mkdir(parents=True, exist_ok=True)

        # ── Instructions ─────────────────────────────────────────
        info_body = soup.select_one("div.info-body, div.assignment-body, div.s-rte")
        if info_body and info_body.get_text(strip=True):
            save_html(url, assign_dir, "instructions")
        else:
            print(f"    [no description]")

        # ── Teacher attachments ───────────────────────────────────
        attachments = soup.select("div.attachments a, div.attachments-link a")
        if attachments:
            att_dir = assign_dir / "attachments"
            for a in attachments:
                href = a.get("href", "")
                fname = a.get_text(strip=True) or "attachment"
                if not href:
                    continue

                # Google Doc / Drive link via Schoology redirect
                if "/link?" in href:
                    real_url = extract_google_link(href)
                    link_file = att_dir / f"{sanitize(fname)}.url"
                    att_dir.mkdir(parents=True, exist_ok=True)
                    if not link_file.exists():
                        link_file.write_text("[InternetShortcut]\nURL=" + real_url + "\n")
                        print(f"    [gdoc link] {link_file.name}")

                # Direct file attachment
                elif "/attachment/" in href or "/materials/gp/" in href:
                    att_dir.mkdir(parents=True, exist_ok=True)
                    if "/materials/gp/" in href:
                        scrape_gp_page(urljoin(BASE_URL, href), att_dir, fname)
                    else:
                        download_file(urljoin(BASE_URL, href), att_dir, fname)

                # External link
                elif href.startswith("http"):
                    link_file = att_dir / f"{sanitize(fname)}.url"
                    att_dir.mkdir(parents=True, exist_ok=True)
                    if not link_file.exists():
                        link_file.write_text("[InternetShortcut]\nURL=" + href + "\n")
                        print(f"    [link] {link_file.name}")

        # ── Submissions (save as .url shortcuts) ──────────────────
        # Find dropbox/view links — revision=1, revision=2, etc.
        sub_links = [a for a in soup.find_all("a", href=True)
                     if "/dropbox/view/" in a.get("href", "")]
        if sub_links:
            sub_dir = assign_dir / "submissions"
            sub_dir.mkdir(parents=True, exist_ok=True)
            # Base dropbox URL — try incrementing revisions
            base_href = sub_links[0]["href"]
            # Strip revision param to get base
            base_url = re.sub(r"\?revision=\d+", "", base_href)
            revision = 1
            while True:
                rev_url = f"{BASE_URL}{base_url}?revision={revision}"
                time.sleep(REQUEST_DELAY)
                resp = session.get(rev_url, allow_redirects=True)
                if resp.status_code == 404:
                    break
                # Check if it redirected away (no more revisions)
                if "dropbox/view" not in resp.url:
                    break
                link_file = sub_dir / f"revision_{revision}.url"
                if not link_file.exists():
                    link_file.write_text("[InternetShortcut]\nURL=" + rev_url + "\n")
                    print(f"    [submission rev {revision}] saved shortcut")
                revision += 1
                if revision > 20:  # safety cap
                    break

    except Exception as e:
        print(f"  [error] Could not handle assignment {url}: {e}")


def handle_assessment(url: str, dest_dir: Path, title: str):
    """
    Assessment/quiz: JS-rendered, save a .url shortcut only.
    Content is not accessible without a real browser.
    """
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        link_file = dest_dir / f"{title} (assessment).url"
        if not link_file.exists():
            link_file.write_text("[InternetShortcut]\nURL=" + url + "\n")
            print(f"  [assessment url] {title}")
    except Exception as e:
        print(f"  [error] Could not save assessment shortcut {url}: {e}")


def handle_page(url: str, dest_dir: Path, title: str):
    """Schoology Page: save HTML. Content is in .s-page-summary."""
    save_html(url, dest_dir, title)


def handle_discussion(url: str, dest_dir: Path, title: str):
    """Discussion: save the full thread as HTML."""
    save_html(url, dest_dir, f"{title} (discussion)")


def parse_materials_page(url: str, dest_dir: Path):
    """Recursively parse a materials or folder page, preserving folder structure."""
    print(f"\n[dir] {dest_dir}")
    soup = get_soup(url)

    table = soup.select_one("table#folder-contents-table")
    if not table:
        empty = soup.select_one("div.no-content")
        if empty:
            print(f"  [empty]")
        else:
            print(f"  [warn] No table found at {url}")
        return

    for row in table.select("tr"):
        classes = " ".join(row.get("class", []))

        # ── Folder ───────────────────────────────────────────────
        if "material-row-folder" in classes:
            link = row.select_one("div.folder-title a, a[href*='?f=']")
            if not link:
                continue
            folder_name = sanitize(link.get_text(strip=True))
            sub_url = urljoin(BASE_URL, link["href"])
            parse_materials_page(sub_url, dest_dir / folder_name)

        # ── Document / file ──────────────────────────────────────
        elif "type-document" in classes:
            link = row.select_one("span.attachments-file-name a, div.attachments-file a")
            if not link:
                continue
            filename_hint = link.get_text(strip=True)
            gp_url = urljoin(BASE_URL, link["href"])
            print(f"  [doc] {filename_hint}")
            scrape_gp_page(gp_url, dest_dir, filename_hint)

        # ── Assignment ───────────────────────────────────────────
        elif "type-assignment" in classes:
            link = row.select_one("div.item-title a")
            if not link:
                continue
            title = sanitize(link.get_text(strip=True))
            detail_url = urljoin(BASE_URL, link["href"])
            print(f"  [assignment] {title}")
            handle_assignment(detail_url, dest_dir, title)

        # ── Assessment / quiz ────────────────────────────────────
        elif "type-common-assessment" in classes:
            link = row.select_one("div.item-title a")
            if not link:
                continue
            title = sanitize(link.get_text(strip=True))
            detail_url = urljoin(BASE_URL, link["href"])
            print(f"  [assessment] {title}")
            handle_assessment(detail_url, dest_dir, title)

        # ── Page ─────────────────────────────────────────────────
        elif "type-page" in classes:
            link = row.select_one("div.item-title a")
            if not link:
                continue
            title = sanitize(link.get_text(strip=True))
            detail_url = urljoin(BASE_URL, link["href"])
            print(f"  [page] {title}")
            handle_page(detail_url, dest_dir, title)

        # ── Discussion ───────────────────────────────────────────
        elif "type-discussion" in classes:
            link = row.select_one("div.item-title a")
            if not link:
                continue
            title = sanitize(link.get_text(strip=True))
            detail_url = urljoin(BASE_URL, link["href"])
            print(f"  [discussion] {title}")
            handle_discussion(detail_url, dest_dir, title)

        # ── Unknown type — save as HTML just in case ─────────────
        elif "dr" in classes and "type-" in classes:
            link = row.select_one("div.item-title a, a[href]")
            if not link:
                continue
            title = sanitize(link.get_text(strip=True))
            detail_url = urljoin(BASE_URL, link["href"])
            print(f"  [unknown:{classes}] {title}")
            save_html(detail_url, dest_dir, title)


def main():
    materials_url = f"{BASE_URL}/course/{COURSE_ID}/materials"
    output_path = Path(OUTPUT_DIR)
    output_path.mkdir(parents=True, exist_ok=True)

    print(f"Starting download -> course {COURSE_ID}")
    print(f"Saving to: {output_path.resolve()}\n")

    soup = get_soup(materials_url)
    title = soup.find("title")
    if title:
        title_text = title.get_text()
        print(f"Page title: {title_text}\n")
        if "log in" in title_text.lower():
            print("ERROR: Not logged in - check your cookie.")
            return
        course_name = sanitize(title_text.split(" | ")[0].strip())
    else:
        course_name = COURSE_ID

    course_path = output_path / course_name
    course_path.mkdir(parents=True, exist_ok=True)
    print(f"Course folder: {course_name}\n")

    parse_materials_page(materials_url, course_path)
    print("\nDone!")


if __name__ == "__main__":
    main()