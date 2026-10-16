# Asana-style weekly planning demo

`scripts/bootstrap-asana-demo.mjs` sets up a separate synthetic workspace, **Team planning demo**, with one project, **Weekly team planning**. It is loosely modelled on a team board: five people, about four tasks each, mixed statuses and priorities, tags, one Work type category per task, a shared one-hour call, and a pinned weekly plan/fact report.

**Status:** accepted on aggregate checks. The root operator ran `--execute` locally and reported 270 oracle checks passed, 0 failed, original-row preservation passed, and 10 offline tests passed. Only those aggregates were shared; no runtime rows or database content were. The tables below come from the fixture literals, and the run's checks matched them. Browser and visual acceptance of this workspace had not been recorded when this status was written; it was added later (below).

**Compiled browser check, `5ca0487` (root, read-only).** The offline tests passed 12/12, and setup passed 270 checks with 0 failed and original-row preservation, as before. The five synthetic identities were not renamed, and the fixture facts below remain exact. At 1440 and 390, the actual demo table had these properties:

- 23 task rows, each 41px including the border;
- the title column about 456px on desktop and 280px on mobile;
- no page overflow, no page errors and no HTTP mutations;
- a footer showing the current 123h.

The actual pinned report UI showed a 94h plan, 84h 45m of original fact and 88h of total fact, marked Incomplete. With an explicitly selected week, root opened and closed the weekly plan and actual dialogs at both widths. In all four states, the rows stayed 41px and the table width was unchanged, with no overflow, errors or mutations. Root also confirmed that a visible Priority value persists after reload. The interaction contract is in [68](68-asana-table-editing.md), and the exact gates and paths are in [25](25-ux-verification.md).

```sh
node scripts/bootstrap-asana-demo.mjs            # dry-run (default): no network, database or .env access
node scripts/bootstrap-asana-demo.mjs --execute  # additive setup, then verification
node scripts/bootstrap-asana-demo.mjs --verify   # read-only GET re-check of the pinned reports
node --test tests/scripts/asana-demo.test.mjs    # offline fixture/oracle/comparator tests
```

## People and identity

The named personas (Mark, Andrei, Anna, Michael, Pavel) are **section labels only**. Each one maps to an existing allowlisted Synthetic actor, and no identity was renamed or created. Reports, assignee chips and memberships still show the fixture display names below.

| Section | Existing actor | Role |
|---|---|---|
| Mark (Synthetic Owner) | Synthetic Owner | owner |
| Andrei (Synthetic Admin) | Synthetic Admin | admin |
| Anna (Synthetic Member A) | Synthetic Member A | member |
| Michael (Synthetic Member B) | Synthetic Member B | member |
| Pavel (Synthetic Member C) | Synthetic Member C | member |

A sixth section, **Team rituals**, holds the meeting. The local API runs as Synthetic Owner, so **My tasks** shows Mark's work only. To see other people, group the project by section or assignee.

## Three different quantities

| Quantity | What it is | Expected total |
|---|---|---|
| Team package estimate, **pinned baseline** | Whole-package estimates captured by the freeze, counted once per package (task + detail subtasks; meeting = 60 min × 5) | 121h 00m (7,260 min) known |
| Team package estimate, **current** | The same packages plus the 2h `Hotfix: merge issue regression after release` package created after the freeze. This is what a loaded task-table budget footer shows | 123h 00m (7,380 min) known |
| Personal weekly plan | Per person and package commitment for the week of 12 Oct, frozen before any fact | 94h 00m (5,640 min) |
| Weekly fact | Manual period facts and meeting attendance, all recorded after the freeze | 84h 45m original, 88h 00m in total |

In both budgets, one package (`Stabilise flaky CI checks`) has an unknown estimate, not a zero. A **123h** table footer and the **121h** report baseline do not disagree: the extra 2h is post-freeze added scope, which the pinned baseline never includes. The weekly plan (94h) and fact (88h) are unaffected.

Summing a package estimate once per personal commitment gives false totals: 153h 00m against the baseline, or 155h 00m with the late commitment. They are inflated because the shared Persistent views package is counted twice and the meeting package five times.

## Per person (weekly plan/fact report)

| Person | Plan | Original fact | Added scope | Unplanned | Total fact | Fact coverage | Variance |
|---|---|---|---|---|---|---|---|
| Mark | 13h 00m | 9h 00m | – | – | 9h 00m | 4/5 | unavailable |
| Andrei | 25h 00m | 24h 30m | 2h 30m | – | 27h 00m | 6/6 | −30m (−2%) |
| Anna | 19h 00m | 16h 30m | – | – | 16h 30m | 4/5 | unavailable |
| Michael | 20h 00m | 19h 00m | – | – | 19h 00m | 5/5 | −60m (−5%) |
| Pavel | 17h 00m | 15h 45m | – | 45m | 16h 30m | 5/5 | −75m (−7.35%) |
| **Team** | **94h 00m** | **84h 45m** | **2h 30m** | **45m** | **88h 00m** | **24/26** | **unavailable** |

Variance is shown only when every original item has a known plan and a recorded fact. The report has 28 rows: 26 original, one unplanned and one added-scope.

## Per work type (work-type report)

| Person | Bug | Core feature | Side feature | Client support | Management | Uncategorized | Total |
|---|---|---|---|---|---|---|---|
| Mark | – | – | – | 0m | 9h 00m | – | 9h 00m |
| Andrei | 10h 00m | 12h 00m | 4h 00m | – | 1h 00m | – | 27h 00m |
| Anna | – | 7h 00m | 6h 30m | 2h 00m | 1h 00m | – | 16h 30m |
| Michael | 3h 00m | 13h 00m | 2h 30m | – | 30m | – | 19h 00m |
| Pavel | 45m | – | 2h 30m | 12h 30m | 0m | 45m | 16h 30m |
| **Team** | **13h 45m** | **32h 00m** | **15h 30m** | **14h 30m** | **11h 30m** | **45m** | **88h 00m** |

There are 27 active sources (22 manual facts and 5 attendance postings). A **0m** cell is a recorded zero source, not a missing one. `Triage leftover inbox requests` deliberately has no Work type. Its 45m stays in the denominator: categorized minutes are 87h 15m out of 88h 00m in total.

## Meeting accounting

**Weekly team planning call** is scheduled for Wed 14 Oct, 10:00–11:00 Asia/Nicosia, with Mark as organizer and five attendees. The meeting is one task and one package with a 5h 00m estimate. Each person's personal plan of 60m is applied through preview/apply. After the freeze, the actual duration is saved as 60m, then attendance is confirmed:

- Mark, Andrei and Anna were present: 60m each.
- Michael attended partially: 30m.
- Pavel was absent: an active 0m source, so he is recorded rather than missing.

That gives 3h 30m in total, not the 5h 00m invited. Meeting time is counted once per attendee posting. It is never multiplied by participants or tasks.

## Deliberate edge cases

- **Freeze before facts:** the script runs plans, the meeting plan, a preview and an explicit manual project freeze, which also creates five personal freezes. Only then does it record facts. The cutoff is set to 00:00 Mon 26 Oct Asia/Nicosia. The script refuses to start within one hour of the cutoff unless the freeze is already acknowledged, so an automatic cutoff freeze cannot stand in for the manual one.
- **Late work:** `Hotfix: merge issue regression after release` is created after the freeze with a 2h plan and a 2h 30m fact. The server classifies it as added scope.
- **Unplanned help:** Pavel spends 45m on Michael's frozen `Fix Android crash on image upload` package without a commitment. The report shows it as unplanned.
- **Shared subtask:** `Persistent views: save view settings on the server` is a detail subtask, so it shares the parent's 12h package. Anna's plan is 7h on the parent, and her facts are 6h on the parent plus 1h on the subtask, which makes one row of 7h. Andrei's plan is 3h on the subtask, with 3h 30m recorded. The package estimate is counted once.
- **Unknown versus zero:** `Draft the Q4 roadmap update` (Mark) and `Fix keyboard focus on the board view` (Anna) have no fact. `Answer the client escalation backlog` (Mark) has a recorded 0m. Pavel's absence is also a recorded 0m.

## Safety and reruns

- The workspace and the five membership rows are written additively through the existing database seed seam, as in [27](27-synthetic-demo.md). Every other write goes through a typed API/domain command.
- Before the first addition, the script snapshots every original public row. At the end, it checks that none of those rows changed. Execution needs the loopback app/database, local identity mode and English status templates.
- `.local/demo/asana-v1.json` is private (0600 in a 0700 directory). It stores the deterministic operation keys and the exact parsed body of each command before the request is sent. A rerun replays the stored bodies and keys. It never invents fresh keys and never drops or resets data.
- The manifest also stores a fixture digest. A changed fixture, a lost manifest, an existing workspace without a manifest, or fixture drift all cause a refusal. The setup lock is shared with the daily demo.
- Output contains links, check counts and expected-versus-actual numbers only. Errors show the phase plus an API status/code or an error class, never connection strings.

## Verification

`--verify`, which also runs at the end of `--execute`, reads the pinned baseline, the weekly run, every page of its rows, and the work-type run. It then compares them with the oracle by stable ID (membership, package and option). It checks:

- the baseline is project scope and manual mode;
- the team and per-person summary fields;
- each row's scope, plan, fact, recorded flag and package estimate, with no unexpected rows;
- the distinct package-estimate total and the shared package's single baseline;
- that every fact is later than the freeze;
- meeting plan, fact and attendance-source counts;
- work-type team and per-person buckets, including zero and uncategorized buckets;
- that the weekly total equals the work-type total.

Any failed check exits non-zero and leaves product data unchanged. The current 123h budget is a source-derived offline value, asserted in `tests/scripts/asana-demo.test.mjs` and shown in the dry-run. It is not one of the 270 runtime checks; those compare only the pinned reports.

## Where to look after the root run

The root operator links the project. Inside it, group by section or assignee and show the Work type column. A loaded table's budget footer is expected to show the current 123h, not the 121h baseline. In the week view, open the saved report (121h baseline) and the work-type view, and compare them with the tables above.
