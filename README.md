# MATEVOK — Teacher workspace

MATEVOK is a lightweight, privacy-first teacher workspace designed initially for Philippine teachers, while remaining independent of DepEd and any official system. It brings class and roster management, daily attendance, generic score recording, assessment authoring, lesson planning, classroom tools, student history, and derived reports into one local-first application.

The product principle is **enter once, use everywhere**: a class and roster are created once, then reused—by stable local identifiers—across attendance, scores, assessments, lessons, classroom tools, progress, and reports.

## What is available now

- A responsive, keyboard-accessible teacher workspace with polished first-use, empty, archived, and recovery states.
- Create, open, edit, archive, restore, and deliberately permanently delete classes.
- A class-scoped Today Overview with factual attendance status, incomplete score-entry progress, the most recently updated lesson, a Classroom Mode launch, and quiet backup-recency status. These summaries are derived from current records.
- Class navigation grouped as Daily (Overview, Attendance, Gradebook), Prepare & Teach (Assessment Center, Lesson Workspace, Classroom Mode), and Review (Student Progress, Reports). With no class open, a tool opens directly when there is one active class, asks the teacher to choose when there are multiple, or offers class creation when there are none. Archived classes are excluded from class choices.
- Add a student individually or paste a roster with one name per line. Whitespace and blank lines are normalized, possible duplicate names are visibly reviewed, and same-name students can still be intentionally added.
- Archive and restore individual student records.
- Take daily attendance from a class using stable `classId`, `studentId`, and local calendar date values only. Start with **Mark all present**, then mark absent, late, or excused exceptions; reopen a saved date to correct it.
- Review actual status counts, filter by a status, and reopen focused class attendance history. Archived students are omitted from new dates but keep their historical attendance.
- Create, edit, reopen, and deliberately delete assessments, then enter scores in roster order with keyboard-friendly inputs. A blank is distinct from a saved zero.
- Review multiline score paste mapped to the active roster before applying it to the unsaved Gradebook draft. Blank pasted lines never erase existing scores; invalid or excess entries block application, and explicit Save Scores is still required.
- Author original multiple-choice, true/false, short-answer, and essay questions in a Draft. Multiple choice has stable answer-choice IDs and one selected correct answer; short answers keep a teacher reference only and essays can keep optional guidance—neither is auto-graded.
- Mark a complete authored assessment Ready, duplicate it into a new Draft without scores, reorder questions with accessible controls, and print separate A4-oriented student and teacher-key previews. Student copies exclude answers, reference answers, guidance, and internal IDs.
- Keep authored question points and the existing Gradebook maximum visibly separate. A teacher can deliberately synchronize the maximum from a Ready assessment; when scores already exist, raw scores remain intact and a confirmation explains that only generic raw percentages recalculate.
- Open Classroom Mode from a class to randomly pick an active student, avoid repeats during a session-only round, make balanced random groups, use a deadline-based countdown, and open a minimal projector display.
- Create, reopen, edit, search, duplicate, print, and deliberately delete class-scoped lesson plans. The focused plain-text editor uses Before, During, and After prompts without claiming any official lesson-plan format.
- Save lessons explicitly. The editor shows whether work is unsaved or saved locally and asks before navigating away from unsaved changes.
- Copy teacher-authored lessons and assessments to another active class as independent Drafts. Copies receive fresh IDs (including question and answer-choice IDs), assessment copies have no scores, and no roster, attendance, or historical records are copied. Same-class duplication remains a separate action.
- Open Student Progress within a class to search active students, optionally view archived students, and inspect one student's recorded attendance and assessment history. Zero scores remain distinct from missing scores.
- Student Progress uses the same exact generic raw-score percentage arithmetic as Gradebook. Its aggregate, when scores exist, is `sum recorded raw scores / sum corresponding maximum scores`; it is never an official grade, ranking, prediction, or student label.
- Open Reports within a class for a printable Class Roster, date-filtered Attendance Summary, Assessment Results, or Class Overview. Every report is derived on demand from canonical local records; it is not persisted or added to backups.
- Assessment Results retains zero scores as recorded values, keeps missing scores distinct, and shows only basic descriptive facts: recorded/missing counts, lowest, highest, mean raw score, and generic raw aggregate.
- Export Roster, Attendance, and Assessment Results as local CSV. Fields are CSV-escaped and cells beginning with `=`, `+`, `-`, or `@` are prefixed with an apostrophe to prevent spreadsheet-formula execution.
- Classroom Mode uses only active roster records. It never reads grades, attendance, assessment results, student notes, or profile attributes to choose a student or form groups.
- Display Mode shows only the teacher-selected student, session groups, countdown, and optional temporary message—never administrative controls, grades, percentages, attendance, assessment results, notes, archived students, or private IDs.
- See `raw score / maximum score` and a generic raw percentage calculated with exact decimal arithmetic and half-up display rounding to two decimal places.
- Export a compact JSON backup—including attendance, assessments, scores, authored questions, answer choices, and lessons—and restore a validated backup using a clearly labelled **replacement-only** flow. Earlier backups without newer arrays remain importable.
- See a subtle device-local reminder of when a backup was last successfully exported, or that no export has been recorded on this device. Classroom changes can prompt a dismissible reminder; this metadata contains no class/student information and is not part of the backup.
- A polished mobile navigation pattern, touch-friendly controls, visible focus styles, a skip link, and reduced-motion support.
- A dependency-free, installable PWA foundation with an offline application shell.
- A browser-local IndexedDB storage boundary, migrated additively to schema version 6.
- A minimal static security policy that permits no third-party scripts, images, or network connections.

No real classes, students, grades, attendance, or sample student data are bundled with the application.

## Architecture

The project intentionally uses native HTML, CSS, and JavaScript. It avoids a framework, runtime dependencies, remote APIs, web fonts, trackers, and analytics so it stays quick on inexpensive devices and slow connections.

```
dist/
  index.html            Application shell and accessible semantic structure
  styles.css            Design tokens, responsive layout, and interaction states
  app.js                My Classes, Today Overview, navigation, attendance, gradebook, Assessment Center, printing, and backup/restore UX
  class-tool-navigation.js  No-class class-scoped tool routing and accessible class selection
  score-paste.js        Roster-mapped score-paste review and draft application
  backup-status.js      Device-local backup recency/reminder metadata
  classroom.js          Pure picker, balanced grouping, and deadline-timer logic
  storage.js            IndexedDB schema, migrations, normalized local records, backups
  gradebook.js          Explicit generic calculation layer; no official policy constants
  progress.js           Pure individual factual-history derivation
  reports.js            Pure class-scoped report and safe CSV derivations
  sw.js                 Network-first offline application-shell strategy
  manifest.webmanifest  Installable app metadata
  _headers              Static-host security and cache policy
tests/
  storage-foundation.test.mjs  Schema and storage-boundary tests
  classes-roster.test.mjs      Class, roster, deletion, and backup integrity tests
  offline-shell.test.mjs       Offline cache/update strategy tests
```

### Shared data model

`storage.js` uses versioned local stores for workspace data, classes, students, attendance, assessments, scores, questions, question options, and lessons. Today, Student Progress, and Reports are derived views, not persisted report/progress records. My Classes uses `classes` and `students`; Attendance uses normalized records with `classId`, `studentId`, `date` (`YYYY-MM-DD` in the device’s local time), and one stable status: `present`, `absent`, `late`, or `excused`. Attendance never stores a copied student name, and a deterministic record ID keeps each student to one status per class/date.

The gradebook uses `assessments` (`id`, `classId`, title, date, maximum score, optional category/period, authoring status, print metadata, and `policyId`) and `scores` (`assessmentId`, `classId`, `studentId`, and canonical raw-score decimal text). A score identifier is deterministic for the assessment/student pair. A missing score has no score record; a zero score is the explicit raw value `"0"`. Student names are never copied into assessment or score records.

Assessment Center extends that same assessment record; it does not create a second gradebook. `questions` hold a stable opaque question ID, assessment/class links, type, prompt, canonical points, position, and type-specific teacher fields. `questionOptions` hold stable opaque option IDs, question/assessment/class links, text, and position. The multiple-choice question stores one correct option ID. Version 5 adds these stores and indexes additively, so metadata-only Phase 4 assessments remain valid Drafts.

Lesson Workspace uses the existing `lessons` store. Each lesson has an opaque `id`, canonical `classId`, optional local calendar `date`, minimal `draft`/`ready` status, timestamps, and plain-text planning fields for learning goals, preparation, materials, opening, activities, checks for understanding, assessment/evidence, reflection, next steps, and teacher notes. Newlines are preserved. Ready requires only a title and learning goal. Individual students, assessment scores, and Classroom Mode session information are not attached to lessons. Cross-class copies create independent Draft lessons containing only teacher-authored lesson content.

Cross-class assessment copies likewise create a fresh Draft assessment and fresh question/answer-choice IDs without score records. They use the same assessment model as Gradebook and Assessment Center; copying does not copy students, attendance, progress, reports, or classroom session state.

Student Progress is deliberately not stored. It derives a single class-scoped student's attendance statuses, dates, current assessments, and current score records at display time. Missing attendance remains missing; the attendance rate uses `(Present + Late) / all recorded statuses`, with Excused retained as a distinct recorded status. Deleted assessments disappear naturally because their canonical scores are deleted with them. Restored backups regenerate the same summaries from restored canonical records.

Reports are also deliberately not stored. Class Roster includes current and archived students; Attendance Summary lists only recorded statuses within an optional inclusive local-date range; Assessment Results lists each current assessment with recorded raw scores and missing entries; and Class Overview provides operational record counts. Reports use the same class-scoped IDs and Gradebook decimal calculation layer as the rest of the workspace, so records from another class cannot appear. They provide no official grade, ranking, prediction, AI conclusion, or performance label.

Every persisted record has an opaque stable `id`, `createdAt`, and `updatedAt`. Student names are never identifiers. Schema changes use IndexedDB version upgrades and additive migrations; existing stores are never deleted or renamed in a migration. Version 4 adds assessment class/date and score assessment/student lookup indexes without altering existing records.

### Calculation and policy boundary

The only available policy identifier is `generic-raw-v1`, labelled **Generic raw-score view**. It is expressly non-official. Gradebook raw scores and percentages are generic and are **NOT an official school/DepEd grading calculation**. Raw scores and maximum scores accept up to three decimal places, are stored as canonical decimal strings, and are compared using integer decimal arithmetic. Displayed raw percentages are rounded **half up to two decimal places** (for example, `1 / 6 = 16.67%`). They are not a final grade, transmuted grade, grade-period result, category weighting, or DepEd result.

No mode is labelled DepEd, K–12, DO 015, s. 2026, or official/current grading. During Phase 4 research, an authoritative complete source for the claimed issuance and its scope, effective date, component weights, rounding, transmutation, term rules, transition provisions, and strengthened SHS distinctions could not be reliably accessed. Policy-specific calculations are therefore intentionally disabled rather than inferred. Future verified policies must be separately versioned and selected by documented applicability; they must not overwrite raw assessment or score records.

### Local-first privacy model

V1 requires no account and no backend. Classes and student rosters remain in IndexedDB on the teacher's device. The application makes no external API calls, includes no analytics, and never places records in URLs or service-worker cache keys. The service worker caches only public application files, never classroom data.

Teachers should understand that browser storage is tied to their browser and device; clearing browser site data can remove locally stored records. Export a backup regularly and store it somewhere the teacher controls. Backup files are not encrypted and may contain student names, so they should be protected like any other private class list.

### Classroom Mode session behavior

Classroom Mode reuses the active class roster at the moment a teacher picks or makes groups; archived students are excluded. Picker state stores only student IDs, not copied names. Groups also keep only current student IDs and are discarded if the roster no longer matches. Picker history, avoid-repeat rounds, generated groups, countdown state, and display message survive navigation within the running page but are intentionally discarded on refresh or browser close. They are not placed in IndexedDB, backups, URLs, service-worker caches, or reports.

The picker uses browser cryptographic randomness when available. Grouping uses a local Fisher–Yates shuffle; each active student appears exactly once, and non-empty groups differ in size by at most one. The timer calculates from a monotonic deadline (`performance.now`) rather than decrementing per interval, so delayed/background ticks reconcile to the correct remaining time.

### Backup, restore, and deletion

Export produces a machine-readable JSON file containing the currently supported local data: classes, student rosters, attendance records, assessments, scores, questions, question options, and lessons. Restore validates the file format, backup version, record IDs, record shape, class and assessment relationships, score maximums, question/option ownership, lesson/class ownership, option positions, duplicate score relationships, and Ready requirements before it can proceed. Restore is **replacement only**, never a silent merge: it shows incoming totals and requires a checkbox confirmation before replacing current records. Stable IDs are preserved exactly. Valid earlier backups without newer arrays import those collections as empty.

Archiving a class or student is reversible. New attendance sessions and score-entry rows include only active students; prior normalized attendance and scores stay available when a student or class is archived. Lessons remain readable with an archived class and return with it when restored. Permanently deleting a class requires typing its exact name and removes only that class plus records explicitly linked to its `classId`, including attendance, assessments, scores, questions, answer choices, and lessons. Deleting an assessment requires typing its title and removes only its linked scores, questions, and answer choices.

### Offline and update behavior

Once the service worker has installed while online, the app shell can open offline. Requests use a network-first strategy: when online, the current files refresh the cache; when offline, cached shell files are used. New service workers activate promptly and clear obsolete shell caches, while `index.html` and `sw.js` are instructed not to remain stale in supporting static hosts. The shell remains usable if service-worker registration is unavailable.

## Development

The app is plain static files. Serve `dist/` with any local static server that respects relative paths, then open its root URL. A secure origin (`https` or `localhost`) is required for service workers and the install prompt.

Run the complete automated test suite with a current Node.js runtime:

```powershell
node --test tests/*.test.mjs
```

For a manual browser check, serve `dist/` on `localhost` or HTTPS. Exercise class routing and the Today Overview; create a class and roster; take attendance; create an assessment, enter scores directly and through reviewed score paste, author questions, and print; create/save a lesson and copy lessons or assessments to another class; use Classroom Mode, Progress, and Reports; then export and restore a backup. Confirm unsaved-work guards and that copied assessments have no scores. Wait for service-worker installation, simulate offline mode, and refresh; the cached app shell should return. Use a 390px viewport and keyboard-only navigation to verify responsive navigation, focus handling, dialogs, skip link, visible focus, validation, and Escape behavior.

## Scope and boundaries

Current product scope covers local class/roster records, attendance, generic score entry, assessment authoring/printing, lesson planning, session-only Classroom Mode, derived Student Progress and Reports, cross-class copies of teacher-authored lessons/assessments, and local backup/restore. It does not implement official school/DepEd grading calculations, student accounts, cloud sync, messaging/LMS, auto-grading, or encrypted backups. Any future policy-specific calculation would require separate authoritative verification and must not overwrite raw assessment or score records.

## Intentional limitations and risks

The application does not include encrypted-at-rest storage, cross-device sync, conflict-aware backup merge, auto-grading, persistent participation tracking, sound alerts, or official grading-policy calculations. Print layout, physical projector/fullscreen behavior, and browser storage/service-worker behavior should be verified on target browsers and low-cost devices before public release. Attendance intentionally keeps only four daily statuses, and Gradebook intentionally keeps only generic raw-score mathematics.
