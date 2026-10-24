# Empty-title Backspace deletion

Clearing a saved task title and pressing Backspace again archives the task through the existing command and offers Undo. An invalid empty title is never saved.

## Cause and correction

The table had two row sources: its task-list query and the insertion chain's confirmed-create fallback. The latter reused an old creation payload whenever any list fetch started. Deleting a recently created task removed the query row, but the archive-triggered refresh made the fallback display the original title again.

A separate previous fix also patched every cache under the task-list prefix as if it contained `pages.tasks`. The real placement reader shares that prefix but contains `pages.rows`. The resulting exception after a successful archive replaced its valid Undo entry with an unsupported boundary. Archive cache pruning now selects only canonical task-list keys and validates their page shape; placement caches stay untouched.

A creation fallback now retires permanently once the raw task list observes it. Its anchor history stays available for further Enter-created siblings. A genuinely acknowledged creation still waits visibly for its first list read.

Deletion also retains the known subtree and accepted archive revision. A late older list cannot undo that archive. A newer unarchived head releases the subtree; an explicitly included, current archived head is visible in the archived view. Existing error recovery is preserved. Project state is already remounted by actor/workspace/project identity.

Undo publishes only its validated restore revision under an actor/workspace/task cache key. This releases restored children even when a search excludes their parent. An old restore acknowledgement cannot release a later archive. No task DTO or descendant revision is fabricated.

## Verification

- The unchanged implementation failed the integrated regression after archive acknowledgement: the old full-title row returned while the next GET was held.
- Private compiled Chrome baseline also reproduced the same ghost in all 20 sampled post-acknowledgement frames.
- Final focused frontend tests: **36 tests / 7 files passed**, including creation visibility, delayed archive/read, stale read, Undo, repeated deletion, rejected deletion, nested descendants, archived view, filtered-parent Undo and restore-ack identity isolation.
- Scoped ESLint, localization validation, TypeScript and isolated web build passed. Existing large-chunk build warnings remain.
- A real-shaped placement reader reproduced the missing Undo and `MUTATION_CONFIRMED_OBSERVER_FAILED` in a separate integrated RED test before the cache-scope fix.
- Final private compiled Chrome verification passed the same full journey in light (1/1) and dark (1/1): all 59/57 continuous deletion frames and 20/19 explicit stale-read frames stayed absent; Undo twice and definite-422 single-row recovery passed. Earlier baseline/diagnostic failures are preserved. The owned private API stopped and its child database was dropped.
- Main authenticated browser, real Auth provider, actual old tabs and production were not checked by this task.

## Local activation

The frontend was activated at `http://127.0.0.1:4310/app` on **24 October 2026 at 08:28:08 UTC**. The served index matches `b1d0e7aac674cee9d544e2d5777d2587f6230fc2fd4561da034b798bbf5f959f`; all **102 candidate files** were fetched through port 4310 and their hashes and MIME types verified. **88 old assets** were retained. No restart, backend, environment or database change was made.

Browser acceptance used the isolated compiled application and synthetic data. The authenticated main workflow, real Auth provider, interaction with an already-open old tab and production remain **NOT CHECKED**. Served-file verification does not claim those workflows passed.

Only frontend source and tests changed; builds ran privately, with no API/schema or real task mutation. Source/build, private browser and local activation evidence is in the private `workloom-backspace-native-2d008530-b79b-414c-87c6-922ca4d144e4` QA directory, including `native-final-proof.json` and `web-activation-receipt.json`.
