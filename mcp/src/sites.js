// mcp/sites.json maps courses to their public websites (outside Schoology),
// e.g. AP Comp Sci's lesson site. A missing file just means no sites.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITES_PATH = path.join(__dirname, "..", "sites.json");

export async function loadSites(sitesPath = SITES_PATH) {
  let raw;
  try {
    raw = await fs.readFile(sitesPath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") log(`sites: could not read ${sitesPath}: ${err.message}`);
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      log(`sites: ${sitesPath} is not a JSON array; ignoring`);
      return [];
    }
    return parsed.filter((s) => s && typeof s.course === "string" && typeof s.url === "string");
  } catch (err) {
    log(`sites: could not parse ${sitesPath}: ${err.message}`);
    return [];
  }
}

/** Case-insensitive fragment match, either direction, between a course name and a site's `course`. */
export function siteForCourse(courseName, sites) {
  if (!courseName || !Array.isArray(sites) || sites.length === 0) return null;
  const nameLower = String(courseName).toLowerCase();
  for (const site of sites) {
    const siteLower = site.course.toLowerCase();
    if (nameLower.includes(siteLower) || siteLower.includes(nameLower)) {
      return { course: site.course, url: site.url, note: site.note || null };
    }
  }
  return null;
}
