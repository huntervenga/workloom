# Correct an employment start date

Open **Time off → People & schedules**, choose the person and correct **Employment start**.
Enter an administrator reason, select **Review changes**, inspect the recalculation and choose **Save person settings**.
No additional acknowledgement is required. Existing revision/source checks and confirmed-save draft clearing remain in place.

An existing profile’s reasoned employment-date correction may reveal deficits on past, current or already-booked future dates without blocking the true date.
The accounting date may remain unchanged, or follow the new hire date when it previously followed the old hire date.
Timezone, employment end, actual opening amounts and schedules must otherwise remain unchanged.
Missing zero openings and explicitly stored zero openings mean the same amount; the shared contracts helper supplies this classification to both domain and UI. The save retains the validated input representation, such as an empty zero-opening array, rather than restoring old rows after validation. Immutable earlier profile versions remain intact.

The preview lists affected dates, leave types and signed balance amounts, retaining up to six fractional day digits so a small deficit stays visible.
It explains that these are recalculated balances from existing absences and that the correction can be saved with a reason.
Current balances remain truthful. No credits, adjustments, changed entitlements or extra leave approvals are invented.
Existing requests and their historical charge allocations are not rewritten by the correction.
Ordinary source validity still applies, including dates that would invalidate an existing approved absence.

A mixed edit to schedules, nonzero opening amounts, timezone, employment end or an unrelated accounting boundary follows the normal balance checks.
New or expanded leave requests also retain their ordinary approval and negative-balance rules.
The exception cannot be used to grant additional leave or hide a separate schedule/balance change inside a date correction.

## Verification checkpoint

The frontend candidate passed **27 focused tests in two files**, focused lint, localization validation and the isolated web build including TypeScript checks.
The tests cover dated advisory details, precise amounts, explicit-zero compatibility, required reasons, mixed schedule warnings and confirmed save/draft clearing.
Existing large-chunk build warnings remain; this is not a new full-suite claim.
Independent source review passed. The final helper unit suite passed **5 tests**, and the clean final PostgreSQL suite passed **4 tests in one file** after the post-validation invariant fix. An earlier 25-test/three-file PostgreSQL run belongs to the preceding candidate and is retained as scoped historical evidence, not final regression proof. A read-only check against the actual local profile/source accepted the proposed true date without changing the person.
A compiler run from the wrong working directory exited with code 2 after emitting three main domain artifacts. Root restored the verified backup of all 424 domain files, with zero extras, before the final capture; a clean private build then passed. Earlier failure logs remain preserved.
Controlled local activation passed without DDL: all 107 tables and rows/catalog, all 30 migration-ledger entries and environment files were preserved. PostgreSQL and Vite remained unchanged; only the API restarted and the worker stayed off. HTTP verification passed for **660 assets and both HTML entrypoints**, with old hashed resources retained. This is asset compatibility evidence, not old-tab interaction acceptance.
The target employee’s stored profile was checked read-only and remains at its previous revision/date; the fix does not automatically apply an employment correction.
No main employee date or other main data was changed by implementation or private frontend tests.
Main authenticated browser, real-provider Auth, actual old tabs, native UI and production remain **NOT CHECKED** for this slice.
