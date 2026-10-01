# MATEVOK — Teacher workspace

MATEVOK is a lightweight, privacy-first teacher workspace designed initially for Philippine teachers, while remaining independent of DepEd and any official system. It brings class and roster management, daily attendance, generic score recording, assessment authoring, lesson planning, classroom tools, student history, and derived reports into one local-first application.

The product principle is **enter once, use everywhere**: a class and roster are created once, then reused—by stable local identifiers—across attendance, scores, assessments, lessons, classroom tools, progress, and reports.

## What is available now

- A responsive, keyboard-accessible teacher workspace with polished first-use, empty, archived, and recovery states.
- Create, open, edit, archive, restore, and deliberately permanently delete classes.
- A class-scoped Today Overview with factual attendance status, incomplete score-entry progress, a lesson dated for the local day (or the most recently edited lesson as fallback), a Classroom Mode launch, and quiet backup-recency status. These summaries are derived from current records.
- Class navigation grouped as Daily (Overview, Attendance, Class Work, Gradebook), Prepare & Teach (Assessment Center, Lesson Workspace, Classroom Mode), and Review (Student Progress, Reports). With no class open, a tool opens directly when there is one active class, asks the teacher to choose when there are multiple, or offers class creation when there are none. Switching classes keeps the current module open and shows each destination's class details and active roster size. Archived classes are excluded as destinations; an archived class may be chosen only as a read-only source when copying an active roster into an empty class.
- Add a student individually or paste a roster with one name per line. Whitespace and blank lines are normalized, possible duplicate names are visibly reviewed, and same-name students can still be intentionally added. In longer rosters, find a student by name to reach that student's existing edit/archive controls without scanning the full list.
- For a new empty class with the same cohort, copy active student names from another active or archived class as fresh independent records. An archived class is a read-only source; archived students, attendance, scores, and class history are not copied, and later roster edits do not sync between classes.
- Archive and restore individual student records.
- Take daily attendance from a class using stable `classId`, `studentId`, and local calendar date values only. Start with **Mark all present**, then mark absent, late, or excused exceptions; reopen a saved date to correct it. Longer rosters include a name lookup that filters only the displayed rows—status totals, **Mark all present**, and explicit Save still apply to the full active class.
- Track factual **Class Work** separately from scores: save a named item with an optional due date and same-class Gradebook assessment link, then record Submitted, Missing, or Excused for active students. Blank remains **Not recorded**, not Missing; a submission can be ungraded, scored zero, or scored independently. Statuses are explicitly saved, searchable/filterable, available as class-scoped Progress history and a printable/CSV status report, and due-today items appear factually in Today. Class Work is not an assignment distribution/LMS and never infers status from a score.
- Review actual status counts, filter by a status, and reopen focused class attendance history. Archived students are omitted from new dates but keep their historical attendance.
- Create, edit, reopen, and deliberately delete assessments, then enter scores in roster order with keyboard-friendly inputs. A blank is distinct from a saved zero.
- Review multiline score paste mapped to the active roster before applying it to the unsaved Gradebook draft. Blank pasted lines never erase existing scores; invalid or excess entries block application, and explicit Save Scores is still required.
- Author original multiple-choice, true/false, short-answer, and essay questions in a Draft. Multiple choice has stable answer-choice IDs and one selected correct answer; short answers keep a teacher reference only and essays can keep optional guidance—neither is auto-graded.
- Mark a complete authored assessment Ready, duplicate it into a new Draft without scores, reorder questions with accessible controls, and print separate A4-oriented student and teacher-key previews. Student copies exclude answers, reference answers, guidance, and internal IDs.
- Keep authored question points and the existing Gradebook maximum visibly separate. A teacher can deliberately synchronize the maximum from a Ready assessment; when scores already exist, raw scores remain intact and a confirmation explains that only generic raw percentages recalculate.
- Open Classroom Mode from a class to randomly pick an active student, avoid repeats during a session-only round, make balanced random groups, use a deadline-based countdown, and open a minimal projector display. A collapsed teacher-side reference can show the same day's saved Lesson without leaving classroom tools.
- Create, reopen, edit, search, duplicate, print, and deliberately delete class-scoped lesson plans. The focused plain-text editor uses Before, During, and After prompts without claiming any official lesson-plan format.
- Save lessons explicitly. The editor shows whether work is unsaved or saved locally and asks before navigating away from unsaved changes.
- Copy teacher-authored lessons and assessments to another active class as independent Drafts. Copies receive fresh IDs (including question and answer-choice IDs), assessment copies have no scores, and no roster, attendance, or historical records are copied. Same-class duplication remains a separate action.
- Save persisted Lessons and authored Assessments as independent templates in My Materials. Search by title or type, then review and add a fresh class-owned Draft to an active class. When opened from a class, **Return to [class]** restores that workspace directly. Templates survive class archive/deletion; changes to a template or class copy never update the other. My Materials is local to this device and is included in encrypted backups.
- Open Student Progress within a class to search active students, optionally view archived students, and inspect one student's recorded attendance, assessment, and Class Work submission history. Zero scores remain distinct from missing scores; submission status remains independently recorded.
- Student Progress uses the same exact generic raw-score percentage arithmetic as Gradebook. Its aggregate, when scores exist, is `sum recorded raw scores / sum corresponding maximum scores`; it is never an official grade, ranking, prediction, or student label.
- Open Reports within a class for a printable Class Roster, date-filtered Attendance Summary, Assessment Results, Class Work Status by work item, or Class Overview. Every report is derived on demand from canonical local records; it is not persisted or added to backups.
- Assessment Results retains zero scores as recorded values, keeps missing scores distinct, and shows only basic descriptive facts: recorded/missing counts, lowest, highest, mean raw score, and generic raw aggregate.
- Export Roster, Attendance, and Assessment Results as local CSV. Fields are CSV-escaped and cells beginning with `=`, `+`, `-`, or `@` are prefixed with an apostrophe to prevent spreadsheet-formula execution.
- Classroom Mode uses only active roster records. It never reads grades, attendance, assessment results, student notes, or profile attributes to choose a student or form groups.
- Display Mode shows only the teacher-selected student, session groups, countdown, and optional temporary message—never administrative controls, grades, percentages, attendance, assessment results, lesson content or notes, archived students, or private IDs.
- See `raw score / maximum score` and a generic raw percentage calculated with exact decimal arithmetic and half-up display rounding to two decimal places.
- Export a compact JSON backup—including attendance, assessments, scores, authored questions, answer choices, and lessons—and restore a validated backup using a clearly labelled **replacement-only** flow. Earlier backups without newer arrays remain importable.
- See a subtle device-local reminder of when a backup download was started, or that no download has been recorded on this device. The browser cannot confirm that the downloaded file was ultimately saved; classroom changes can prompt a dismissible reminder. This metadata contains no class/student information and is not part of the backup.
- A polished mobile navigation pattern, touch-friendly controls, visible focus styles, a skip link, and reduced-motion support.
- A dependency-free, installable PWA foundation with an offline application shell.
- A browser-local IndexedDB storage boundary, migrated additively to schema version 9; version 7 introduced the separate indexed `materials` store, version 8 advanced metadata to prevent older open tabs from writing after single-editor protection became available, and version 9 adds indexed `classWork` and `workSubmissions` stores without replacing existing records.
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
  backup-crypto.js      Passphrase-derived AES-GCM encryption for exported backups
  classroom.js          Pure picker, balanced grouping, and deadline-timer logic
  lesson-reference.js   Class-scoped dated-lesson selection for Today and teacher-side Classroom Mode reference
  storage.js            IndexedDB schema, migrations, normalized local records, backups
  attendance-keyboard.js  Arrow-key status cycling for accessible long-roster attendance entry
  gradebook.js          Explicit generic calculation layer; no official policy constants
  progress.js           Pure individual factual-history derivation
  reports.js            Pure class-scoped report and safe CSV derivations
  sw.js                 Network-first offline application-shell strategy
  manifest.webmanifest  Installable app metadata
  _headers              Static-host security and cache policy
tests/
  storage-foundation.test.mjs  Schema and storage-boundary tests
  classes-roster.test.mjs      Class, roster, deletion, and backup integrity tests
  backup-crypto.test.mjs       Encrypted backup confidentiality and tamper rejection tests
  offline-shell.test.mjs       Offline cache/update strategy tests
```

### Shared data model

`storage.js` uses versioned local stores for workspace data, classes, students, attendance, assessments, scores, questions, question options, lessons, Class Work, per-student submission statuses, and My Materials templates. Today, Student Progress, and Reports are derived views, not persisted report/progress records. Class Work items are class-owned facts; `workSubmissions` links one item and student in that class with a submitted/missing/excused state. Missing status records mean Not recorded. Gradebook scores are independent and never determine submission state. Compound class/due-date and class/student indexes support scoped reads. My Materials stores only teacher-authored Lesson or Assessment template content, never Class Work or student history. A class copy receives fresh class-owned IDs and is an independent Draft snapshot. Student records belong to one class; when a teacher copies a roster into an empty class, MATEVOK creates fresh student IDs from active student names in an active or archived source. The archived source is read-only, and the destination records carry no attendance, scores, or history. My Classes uses `classes` and `students`; Attendance uses normalized records with `classId`, `studentId`, `date` (`YYYY-MM-DD` in the device’s local time), and one stable status: `present`, `absent`, `late`, or `excused`. Attendance never stores a copied student name, and a deterministic record ID keeps each student to one status per class/date.

The gradebook uses `assessments` (`id`, `classId`, title, date, maximum score, optional category/period, authoring status, print metadata, and `policyId`) and `scores` (`assessmentId`, `classId`, `studentId`, and canonical raw-score decimal text). A score identifier is deterministic for the assessment/student pair. A missing score has no score record; a zero score is the explicit raw value `"0"`. Student names are never copied into assessment or score records.

Assessment Center extends that same assessment record; it does not create a second gradebook. `questions` hold a stable opaque question ID, assessment/class links, type, prompt, canonical points, position, and type-specific teacher fields. `questionOptions` hold stable opaque option IDs, question/assessment/class links, text, and position. The multiple-choice question stores one correct option ID. Version 5 adds these stores and indexes additively, so metadata-only Phase 4 assessments remain valid Drafts.

Lesson Workspace uses the existing `lessons` store. Each lesson has an opaque `id`, canonical `classId`, optional local calendar `date`, minimal `draft`/`ready` status, timestamps, and plain-text planning fields for learning goals, preparation, materials, opening, activities, checks for understanding, assessment/evidence, reflection, next steps, and teacher notes. Newlines are preserved. Ready requires only a title and learning goal. Individual students, assessment scores, and Classroom Mode session information are not attached to lessons. Cross-class copies create independent Draft lessons containing only teacher-authored lesson content.

Cross-class assessment copies likewise create a fresh Draft assessment and fresh question/answer-choice IDs without score records. They use the same assessment model as Gradebook and Assessment Center; copying does not copy students, attendance, progress, reports, or classroom session state.

Student Progress is deliberately not stored. It derives a single class-scoped student's attendance statuses, dates, current assessments, and current score records at display time. Missing attendance remains missing; the attendance rate uses `(Present + Late) / all recorded statuses`, with Excused retained as a distinct recorded status. Deleted assessments disappear naturally because their canonical scores are deleted with them. Restored backups regenerate the same summaries from restored canonical records.

Reports are also deliberately not stored. Class Roster includes current and archived students; Attendance Summary lists only recorded statuses within an optional inclusive local-date range; Assessment Results lists each current assessment with recorded raw scores and missing entries; Class Work Status lists one item's Submitted, Missing, Excused, and Not recorded states; and Class Overview provides operational record counts. Reports use the same class-scoped IDs and Gradebook decimal calculation layer as the rest of the workspace, so records from another class cannot appear. Class Work CSV uses the same formula-injection protection as other exports. Reports provide no official grade, ranking, prediction, AI conclusion, or performance label.

Every persisted record has an opaque stable `id`, `createdAt`, and `updatedAt`. Student names are never identifiers. Schema changes use IndexedDB version upgrades and additive migrations; existing stores are never deleted or renamed in a migration. Version 4 adds assessment class/date and score assessment/student lookup indexes without altering existing records.

### Calculation and policy boundary

The only available policy identifier is `generic-raw-v1`, labelled **Generic raw-score view**. It is expressly non-official. Gradebook raw scores and percentages are generic and are **NOT an official school/DepEd grading calculation**. Raw scores and maximum scores accept up to three decimal places, are stored as canonical decimal strings, and are compared using integer decimal arithmetic. Displayed raw percentages are rounded **half up to two decimal places** (for example, `1 / 6 = 16.67%`). They are not a final grade, transmuted grade, grade-period result, category weighting, or DepEd result.

No mode is labelled DepEd, K–12, DO 015, s. 2026, or official/current grading. During Phase 4 research, an authoritative complete source for the claimed issuance and its scope, effective date, component weights, rounding, transmutation, term rules, transition provisions, and strengthened SHS distinctions could not be reliably accessed. Policy-specific calculations are therefore intentionally disabled rather than inferred. Future verified policies must be separately versioned and selected by documented applicability; they must not overwrite raw assessment or score records.

### Local-first privacy model

V1 requires no account and no backend. Classes and student rosters remain in IndexedDB on the teacher's device. The application makes no external API calls, includes no analytics, and never places records in URLs or service-worker cache keys. The service worker caches only public application files, never classroom data.

Teachers should understand that browser storage is tied to their browser and device; clearing browser site data can remove locally stored records. Export an encrypted backup regularly and store it somewhere the teacher controls. The passphrase is never stored by MATEVOK; losing it makes that backup unrecoverable. Older unencrypted backups remain importable and are clearly warned about before restore. Browser storage itself is not encrypted by MATEVOK and still depends on device and browser-profile access controls.

### Classroom Mode session behavior

Classroom Mode reuses the active class roster at the moment a teacher picks or makes groups; archived students are excluded. Picker state stores only student IDs, not copied names. Groups also keep only current student IDs and are discarded if the roster no longer matches. Picker history, avoid-repeat rounds, generated groups, countdown state, and display message survive navigation within the running page but are intentionally discarded on refresh or browser close. They are not placed in IndexedDB, backups, URLs, service-worker caches, or reports.

The picker uses browser cryptographic randomness when available. Grouping uses a local Fisher–Yates shuffle; each active student appears exactly once, and non-empty groups differ in size by at most one. The timer calculates from a monotonic deadline (`performance.now`) rather than decrementing per interval, so delayed/background ticks reconcile to the correct remaining time. Today and the collapsed teacher-side lesson reference prefer a saved lesson whose optional date matches the device's local date, choosing the most recently updated match; if there is no match they use the most recently updated class lesson. The reference is read-only, derived from saved class lessons, and is not rendered in Display Mode.

### Backup, restore, and deletion

Export produces a passphrase-encrypted JSON file containing the currently supported local data: classes, student rosters, attendance records, assessments, scores, questions, question options, lessons, Class Work items, per-student submission statuses, and materials. Backup format v3 adds Class Work arrays; v1 legacy and v2 pre-Class-Work backups remain valid and restore these collections empty. Encryption uses AES-256-GCM with a fresh random salt and nonce per export and PBKDF2-SHA-256 key derivation. The passphrase is not stored; if it is lost, MATEVOK cannot recover the file. Restore authenticates and decrypts encrypted files locally, then validates the backup format, record IDs, shape, relationships, score maximums, question/option ownership, lesson/class ownership, Class Work/submission relationships and same-class assessment links, duplicate relationships, and Ready requirements before review. Earlier plaintext backups remain importable with an explicit warning. Restore is **replacement only**, never a silent merge: it shows incoming totals and requires a checkbox confirmation before replacing current records. Stable IDs are preserved exactly. Valid earlier backups without newer arrays import those collections as empty. Export reads all backed-up stores in one read-only IndexedDB transaction for a coherent snapshot.

Archiving a class or student is reversible. New attendance sessions, score-entry rows, and Class Work edits include only active students; prior normalized attendance, scores, and submission statuses stay available as archived history. Lessons and Class Work remain readable with an archived class and return with it when restored. Permanently deleting a class requires typing its exact name and removes only that class plus records explicitly linked to its `classId`, including attendance, assessments, scores, questions, answer choices, lessons, Class Work, and submission statuses. Deleting an assessment requires typing its title and removes only its linked scores, questions, and answer choices; any linked Class Work item remains and its optional link is cleared.

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

Current product scope covers local class/roster records, attendance, factual Class Work submission status, generic score entry, assessment authoring/printing, lesson planning, session-only Classroom Mode, derived Student Progress and Reports, cross-class copies of teacher-authored lessons/assessments, and local encrypted backup/restore with legacy plaintext import. It does not implement official school/DepEd grading calculations, student accounts, cloud sync, messaging/LMS, or auto-grading. Any future policy-specific calculation would require separate authoritative verification and must not overwrite raw assessment or score records.

## Intentional limitations and risks

The application does not include encrypted-at-rest storage, cross-device sync, conflict-aware backup merge, auto-grading, persistent participation tracking, sound alerts, or official grading-policy calculations. Print layout, physical projector/fullscreen behavior, and browser storage/service-worker behavior should be verified on target browsers and low-cost devices before public release. Attendance intentionally keeps only four daily statuses, and Gradebook intentionally keeps only generic raw-score mathematics.
