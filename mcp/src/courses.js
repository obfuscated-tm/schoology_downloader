// Course resolution: a course argument can be a section_id or a case-insensitive
// name fragment. Resolves against the union of what we know: cached live/snapshot
// course lists (if any) and the archive on disk.
import { listArchivedCourses, AmbiguousCourseError, CourseNotFoundError } from "./archive.js";

/** Build a unified course list: archive courses plus any live/snapshot-only courses. */
export async function mergedCourses(ctx) {
  const archiveCourses = await listArchivedCourses();
  const bySection = new Map();
  for (const c of archiveCourses) {
    bySection.set(c.section_id || `dir:${c.dir_name}`, {
      section_id: c.section_id,
      name: c.name,
      dir_name: c.dir_name,
      dir: c.dir,
      has_archive: true,
      last_synced: c.last_synced,
    });
  }

  const liveCourses =
    ctx?.cache?.getLive("courses", {})?.data ||
    ctx?.cache?.getSnapshot()?.snapshot?.courses ||
    null;
  if (Array.isArray(liveCourses)) {
    for (const lc of liveCourses) {
      const sectionId = lc.section_id != null ? String(lc.section_id) : null;
      const key = sectionId || `title:${lc.title}`;
      const existing = bySection.get(key);
      if (existing) {
        existing.section_id = existing.section_id || sectionId;
        existing.title = lc.title || lc.section_title;
      } else {
        bySection.set(key, {
          section_id: sectionId,
          name: lc.title || lc.section_title || sectionId,
          title: lc.title,
          has_archive: false,
        });
      }
    }
  }

  return [...bySection.values()];
}

function matchesQuery(course, qLower) {
  const fields = [course.name, course.title, course.dir_name].filter(Boolean);
  return fields.some((f) => f.toLowerCase().includes(qLower));
}

/**
 * Resolve a course argument to a unified course record.
 * Throws AmbiguousCourseError / CourseNotFoundError (from archive.js).
 */
export async function resolveCourseRef(ctx, query) {
  const courses = await mergedCourses(ctx);
  if (!query) {
    if (courses.length === 1) return courses[0];
    throw new AmbiguousCourseError(courses);
  }
  const q = String(query).trim();
  const bySectionId = courses.filter((c) => c.section_id === q);
  if (bySectionId.length === 1) return bySectionId[0];
  if (bySectionId.length > 1) throw new AmbiguousCourseError(bySectionId);

  const qLower = q.toLowerCase();
  const byName = courses.filter((c) => matchesQuery(c, qLower));
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new AmbiguousCourseError(byName);

  throw new CourseNotFoundError(query);
}
