// Builds a small, realistic temp "Schoology Archive" fixture for tests.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { makeMinimalPdf } from "./make-pdf.js";

export async function buildArchive() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "schoology-archive-"));

  const course1 = path.join(root, "Physics 101 - 1111 - TeacherA p1 T1");
  const course2 = path.join(root, "History 9 - 2222 - TeacherB p2 T1");
  await fs.mkdir(course1, { recursive: true });
  await fs.mkdir(course2, { recursive: true });
  await fs.mkdir(path.join(course1, "Unit 1"), { recursive: true });
  await fs.mkdir(path.join(course1, "Unit 1", "HW 1 files"), { recursive: true });
  await fs.mkdir(path.join(course1, "_archive"), { recursive: true });

  await fs.writeFile(
    path.join(course1, "INDEX.md"),
    [
      "# Physics 101 - 1111: TeacherA p1 T1",
      "",
      "Archive of the Schoology course at https://fuhsd.schoology.com/course/1111111111/materials",
      "Last synced: 1/1/2026, 9:00:00 AM",
      "",
      "## How this archive is organized",
      "",
    ].join("\n"),
  );

  await fs.writeFile(
    path.join(course1, "grades.md"),
    [
      "# Grades — Physics 101 - 1111: TeacherA p1 T1",
      "",
      "As of 1/1/2026, 9:00:00 AM.",
      "",
      "| Item | Due | Grade | Comment |",
      "| --- | --- | --- | --- |",
      "| **Course Grade** |  | A (98%) |  |",
      "|     HW 1 | 1/02/26 8:30am | A 10 / 10 |  |",
    ].join("\n"),
  );

  await fs.writeFile(
    path.join(course1, "updates.md"),
    ["# Updates — Physics 101", "", "**TeacherA** — 1/1/2026", "", "Welcome to class!"].join("\n"),
  );

  await fs.writeFile(
    path.join(course1, "Unit 1", "HW 1 (assignment).md"),
    [
      "# HW 1: Kinematics Worksheet",
      "",
      "- **Type:** Assignment",
      "- **Due:** Friday, January 2, 2099 at 8:30 am",
      "",
      "- **Folder:** Unit 1",
      "- **Schoology link:** https://fuhsd.schoology.com/assignment/9991112222",
      "",
      "## Instructions",
      "",
      "Solve problems 1-10 on projectile motion.",
    ].join("\n"),
  );

  await fs.writeFile(
    path.join(course1, "Unit 1", "HW 1 files", "worksheet.pdf"),
    makeMinimalPdf("Projectile Motion Worksheet UniqueMarkerABC"),
  );
  await fs.writeFile(path.join(course1, "Unit 1", "HW 1 files", "notes.txt"), "See chapter 3.");
  await fs.writeFile(
    path.join(course1, "Unit 1", "link.url"),
    "[InternetShortcut]\r\nURL=https://example.com/some-video\r\n",
  );
  await fs.writeFile(path.join(course1, "_archive", "manifest.json"), JSON.stringify({ version: 1 }));
  await fs.writeFile(path.join(course1, ".DS_Store"), "junk");

  // Second course: no grades.md written for one edge case, has an assignment already due (past).
  await fs.writeFile(
    path.join(course2, "INDEX.md"),
    [
      "# History 9 - 2222: TeacherB p2 T1",
      "",
      "Archive of the Schoology course at https://fuhsd.schoology.com/course/2222222222/materials",
      "Last synced: 1/1/2026, 9:00:00 AM",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(course2, "grades.md"),
    ["# Grades — History 9", "", "As of 1/1/2026, 9:00:00 AM.", "", "| Item | Grade |", "| --- | --- |"].join(
      "\n",
    ),
  );
  await fs.mkdir(path.join(course2, "Unit 1"), { recursive: true });
  await fs.writeFile(
    path.join(course2, "Unit 1", "Old HW (assignment).md"),
    [
      "# Old HW",
      "",
      "- **Due:** Monday, January 1, 2001 at 8:30 am",
      "- **Schoology link:** https://fuhsd.schoology.com/assignment/1230000001",
    ].join("\n"),
  );

  return { root, course1, course2 };
}

export async function cleanupArchive(root) {
  await fs.rm(root, { recursive: true, force: true });
}
