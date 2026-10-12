# Kysely migration plan for packages/lib

**Status (2026-10-09): all stages done.** The final run of `yarn tsc && yarn test` in `packages/lib` gives **1652 passed / 0 failed / 3 skipped**: the original 1637 tests plus 15 new safety-net tests. The results, the places where the work differed from this plan, and the full list of `sql` tag uses are at the end of this document.

## Context

`packages/lib` talks to SQLite with hand-written SQL strings spread across about 40 files. Some values are pasted straight into the SQL text instead of being passed as separate parameters, for example `id IN ('a','b')` built with an escape helper. You want to move this to the Kysely query builder (0.29.6, already in `package.json`). App behaviour must not change and the test suite must stay at **1637 passed / 0 failed / 3 skipped**. That count will go up only by the new safety-net tests this plan adds.

### How it works today (plain language)
- **One gateway.** Every query goes through `Database` (`packages/lib/database.ts`): `selectOne`, `selectAll`, `exec` and `transactionExecBatch`.
- **That gateway sits on top of four drivers:** node-sqlite3 (desktop, CLI, tests), better-sqlite3, React Native, and web (sqlite-wasm).
- **The gateway also adds:** automatic retry when the database is busy, query logging and profiling, and a lock so only one transaction runs at a time.
- **Schema setup:** `JoplinDatabase.ts` creates and upgrades the schema in 53 numbered steps. Steps 1–41 are written inline. Steps 42–53 are files in `services/database/migrations/`. A brand-new profile runs **all 53 steps**, so the old steps still define today's schema.
- **Search** uses SQLite's full-text-search extension (FTS4), kept in sync by database triggers. `services/search/queryBuilder.ts` builds search queries by gluing strings together. Results are ranked in JavaScript from FTS4's raw match statistics.
- **AI semantic search** (`models/NoteEmbedding.ts`) uses the `sqlite-vec` extension.

### Key design decision (recommended): Kysely builds the SQL, Joplin runs it
Kysely normally runs queries itself through its own driver. Joplin can't simply switch to that: it has four platform drivers plus its own retry and transaction logic. So we use Kysely only to **build** each query, which gives SQL text plus a parameter list. That result goes through the existing `Database` gateway unchanged.
- **Already proven:** I ran Kysely this way in a scratch test, outside the repo.
- **Why it's safest:** drivers, retries, logging, transactions and the mobile and web apps keep working exactly as now. Only the way the SQL text is produced changes.

### Findings that shape the plan
1. **Kysely 0.29.6 does not load in the test runner as-is.** It ships only as a modern ES module. lib's tests run on compiled CommonJS under Jest 29, which fails with `Unexpected token 'export'`.
   - **Fix, tested in a scratch Jest run:** tell Jest to convert just the kysely package with Babel (`transformIgnorePatterns` plus a `babel-jest` transform). `babel-jest` and `@babel/core` are already installed.
   - **Also checked:** `yarn tsc` type-checks kysely imports fine with lib's current settings, and plain Node 22+ and Electron 42 load it natively.
   - **Wider impact:** Jest in app-desktop, app-cli and app-mobile also loads lib code, so their tests would need the same setting (decision Q1).
2. **Some things have no Kysely builder method.** FTS4 virtual tables, triggers, `PRAGMA`, the sqlite-vec `MATCH … AND k = N` syntax, `matchinfo()` and `offsets()`. Kysely provides an escape hatch for this: the `sql` template tag. It is part of Kysely, keeps values as safe parameters, and lets us write any SQLite syntax. This is how they will be handled (decision Q3).
3. **Changing schema text can silently change behaviour.**
   - **How defaults work:** at startup Joplin reads every column's default value back from the database (`refreshTableFields`). It uses those defaults to fill new records.
   - **Defaults:** today they are written `DEFAULT ""`. Kysely writes `DEFAULT ''`, and the read-back code only strips double quotes. New notes would then get a literal `''` as their default text.
   - **Column types:** Kysely has no `INT` type, and Joplin's type mapping only accepts INT, INTEGER, TEXT and NUMERIC.
   - **Handling:** a "schema fingerprint" test (Stage 0) catches any difference like this.
4. **Kysely quotes names with `"…"`; Joplin uses backticks.** Both are valid. But in SQLite a `"misspelt_column"` silently becomes a text value instead of raising an error. We guard against that with typed table definitions, so the compiler catches misspellings, and with the tests.
5. **Other parts of the monorepo pass raw SQL snippets into lib methods.** Examples: `Resource.all({ where: 'id LIKE ? OR title LIKE ?' })` in the desktop app, `conditions: [...]` in search, `{ sql: 'deleted_time = 0' }` in the REST API. To keep those callers unchanged, these options stay accepted and are turned into Kysely fragments inside lib.
6. **Existing quirks found** (decision Q4):
   - **Search parameter order:** the search query builder probably puts parameters in the wrong order when `id:` is combined with `notebook:`, `tag:` or `resource:` filters.
   - **REST sort direction:** `order_dir` from the REST API is pasted unchecked into SQL.
   - **Case-insensitive lookup:** `loadByFields` applies case-insensitivity only to the last field.
7. **Upgrade testing gap.** Tests always build a fresh database, so they never upgrade a real old database. Stage 0 adds that check.

## Decisions (answered)
- **Q1 – Jest transform, lib only.** Only `packages/lib/jest.config.js` changes.
  - **Accepted risk:** Jest in app-desktop, app-cli and app-mobile will fail to load lib files that import kysely, until their configs get the same setting. That would be a follow-up outside this migration.
  - The real apps (Node and Electron, which load it natively, plus bundlers) are not affected by this.
- **Q2 – Rewrite the historic steps with Kysely's schema builder.** The schema fingerprint must show the output is identical. Kysely's `sql` tag is used only where the builder can't produce identical output (e.g. `INT` columns, `DEFAULT ""` text, FTS, triggers).
- **Q3 – Use Kysely's `sql` template tag** for FTS4, triggers, PRAGMA, sqlite-vec, `matchinfo/offsets`.
  - **All `sql` tag uses live in one file:** `packages/lib/services/database/sqlFragments.ts`. No other file imports `sql` from kysely; other files call named functions exported from that file.
  - When the migration is finished, every use is listed in the "`sql` tag inventory" section at the end of this document.
- **Q4 – Preserve the existing quirks exactly.**
  - **What that means:** the search parameter order, the unchecked REST `order_dir` and the `loadByFields` case-insensitivity behaviour all stay as they are.
  - **How:** Stage 0 capture tests lock them in. Kysely fragments are combined in the same order as today's strings.
  - **Afterwards:** they're listed under "Follow-ups" for you to decide on later.

## Stages

All stages: run `yarn tsc` then `yarn test` in `packages/lib`. "Done when" always includes **tsc passes and tests are 1637 + new passed / 0 failed / 3 skipped**. Run `yarn updateIgnored` after adding TS files, and add "kysely" to the cSpell dictionary per `readme/dev/spellcheck.md`.

### Stage 0 – Safety nets (no production code changes)
- **Goal:** lock down current behaviour before touching anything.
- **Files:** a new `services/database/schema.test.ts` (a schema fingerprint). It records, for every table, index, trigger and view, the column names, types, default values read back by Joplin (`table_fields` / `createDefaultRow`), primary keys and the `sqlite_master` SQL. It saves this to a snapshot, generated from the current code. It also includes an upgrade test: build the version-N database from the current steps, then upgrade it to 53 and compare against a fresh 53. A new `services/search/queryBuilder.test.ts` captures behaviour for combined filters. Small capture tests cover `Note.previews` ordering and conditions, `paginatedFeed`, and `BaseModel.search/all/byIds` options, where existing tests are thin.
- **Depends on:** nothing.
- **Done when:** new tests pass on unchanged code; baseline count recorded.

### Stage 1 – Kysely infrastructure
- **Goal:** let lib code build Kysely queries and run them through the existing gateway.
- **Files:**
  - `packages/lib/jest.config.js` only (per Q1).
  - New `services/database/kysely.ts`: a compile-only Kysely instance (SQLite adapter and query compiler, `DummyDriver`) and the `toSqlQuery(compiled)` helper, which turns Kysely's `{sql, parameters}` into Joplin's `{sql, params}`.
  - A `rawFragment(sql, params)` helper that turns legacy `where` strings with `?` into Kysely fragments.
  - New `services/database/kyselyTypes.ts`: the typed table map, derived from the generated `*Entity` types in `services/database/types.ts` (required columns, minus `type_`), plus tables and views those lack (`sync_items`, `deleted_items`, `tags_with_note_count`, `sqlite_master`, `sqlite_sequence`, …).
  - `database.ts`: `selectOne/selectAll/exec/transactionExecBatch` also accept a Kysely query, with the same retry, logging and mutex.
- **Depends on:** Stage 0, Q1.
- **Done when:** a small unit test compiles and runs a Kysely select, insert and update against a test DB; full suite green.

### Stage 2 – Core CRUD helpers
- **Goal:** move the shared building blocks every model uses.
- **Files:**
  - `database.ts`: `insertQuery`, `updateQuery`.
  - `BaseModel.ts`: `count`, `load*`, `all`, `allIds`, `byIds`, `search`, `applySqlOptions`, `saveQuery`, `save`, `delete`, `batchDelete`.
  - `models/utils/paginationToSql.ts` and `models/utils/paginatedFeed.ts`.
- **What stays the same:** the public option shapes (`where`, `whereParams`, `conditions`, `fields`, `order`, `limit`, `caseInsensitive`, `nextQueries`) and return values, including `.id` and `.modObject` on save queries. `escapeIdsForSql` is kept for outside callers but no longer used inside lib.
- **Depends on:** Stage 1.
- **Done when:** suite green; no hand-written SQL left in these files.

### Stage 3 – Small models and KvStore
- **Files:** `models/Alarm.ts`, `ConflictNoteState.ts` (`INSERT OR REPLACE` becomes Kysely's `insertInto().orReplace()`), `ResourceLocalState.ts`, `NoteTag.ts`, `ItemChange.ts`, `Migration.ts`, `Setting.ts`, `services/KvStore.ts`.
- **Depends on:** Stage 2.
- **Done when:** suite green; a grep of these files finds no SQL keywords in plain strings.

### Stage 4 – Medium models
- **Files:** `models/Tag.ts` (view), `Revision.ts` (self-join), `NoteResource.ts` (GROUP BY/HAVING, subqueries), `Resource.ts`.
- **Notes:** `Resource.ts` has a row-value comparison with an old-Android fallback, which is kept as-is, and an unescaped `mime IN (...)`, which becomes parameters.
- **Depends on:** Stage 2.
- **Done when:** suite green; grep clean.

### Stage 5 – Large models
- **Files:** `models/BaseItem.ts` (sync queries, `NOT IN` subqueries, `sprintf`-built SQL), `models/Folder.ts` (recursive CTE, joins, GROUP BY), `models/Note.ts` (`previews` with its conditions, patterns and to-do ordering).
- **Depends on:** Stages 2–4.
- **Done when:** suite green; Stage 0 capture tests for previews and pagination unchanged; grep clean.

### Stage 6 – Other services
- **Files:** `services/ResourceService.ts`, `RevisionService.ts`, `ReportService.ts`, `services/synchronizer/tools.ts`, `syncInfoUtils.ts`, `debug/DebugService.ts`, `BaseApplication.ts`, `migrations/20.ts`, `testing/test-utils.ts`.
- **Why the last two matter:** `migrations/20.ts` is a data migration, and `test-utils.ts` clears the DB between tests.
- **Depends on:** Stage 5.
- **Done when:** suite green; grep clean.

### Stage 7 – Search
- **Goal:** move search-index syncing and search queries.
- **Files:**
  - `services/search/SearchEngine.ts`: the batch `notes_normalized` / `items_normalized` sync and the resource FTS query.
  - `services/search/queryBuilder.ts`: rebuilt as composed Kysely fragments, so parameters stay attached to their fragment. It keeps the current output, quirks included, for every case in the Stage 0 tests (per Q4).
  - `services/search/SearchEngineUtils.ts`.
  - `models/NoteEmbedding.ts`, using sqlite-vec via the `sql` tag.
- **Depends on:** Stages 2–5, Q3, Q4.
- **Done when:** all `SearchEngine*.test`, `queryBuilder.test` and `SqliteVec.test` pass; suite green.

### Stage 8 – Schema setup and upgrade steps
- **Goal:** move all 53 upgrade steps and the schema helpers.
- **Files:**
  - `JoplinDatabase.ts`: steps 1–41, `refreshTableFields`, `createDefaultRow`, `clearForTesting`, version reads and writes, FTS detection.
  - `services/database/migrations/42–53.ts`.
  - `services/database/types.ts`: the `Migration` type.
  - `database.ts`: `alterColumnQueries`.
  - `services/database/addMigrationFile.ts` and `sqlStringToLines.ts` (removed if no longer used).
- **How:** tables, columns, indexes and views use Kysely's schema builder where it gives an identical fingerprint. FTS tables, triggers, PRAGMA and `INT`/quoted-default columns use the `sql` tag (per Q2/Q3). `refreshTableFields` default-value parsing is made to handle both quote styles, so it is safe either way.
- **Step behaviour stays the same:** each step still runs as one transaction, and the "tolerated failure" steps (15, 18, 33, 34: FTS and spellfix) behave as now.
- **Depends on:** Stage 1, Q2, Q3. It's placed late because it is the riskiest. A schema bug affects every new profile.
- **Done when:** the Stage 0 schema fingerprint and upgrade tests are **identical** to the snapshot, and the suite is green.

### Stage 9 – Cleanup and audit
- **Goal:** remove helpers no longer used in lib (`escapeValues`, the string-building parts of `wrapQuery`). Keep anything still called by other packages.
- **Audit:** grep all of `packages/lib` (excluding tests and `.js`) for `SELECT|INSERT|UPDATE|DELETE|CREATE|PRAGMA` in plain strings. Each remaining hit must be in `services/database/sqlFragments.ts`. Also check that `sql` is imported from kysely in that file only, then write the inventory section.
- **Done when:** audit clean, `yarn tsc` and `yarn test` green in packages/lib, and the other packages still type-check (`yarn tsc --noEmit`) against lib's unchanged public API.

## Main risks and how they're handled
| Risk | Handling |
|---|---|
| Kysely won't load in Jest | Babel transform for the kysely package in lib's Jest config (tested). Other packages' Jest runs will break on lib files that import kysely; you accepted this (Q1), and it's listed as a follow-up. |
| Schema drift: a different default-value text or column type changes how new records are filled | Stage 0 schema fingerprint snapshot must match exactly; default parsing hardened. |
| Existing users' databases upgrade differently from fresh ones | Stage 0 upgrade test (old version → 53 vs fresh 53). |
| Misspelt column silently becomes a string under `"…"` quoting | Typed table map catches it at compile time; tests. |
| Search ranking breaks: ranking depends on column order and `matchinfo` layout | Column lists unchanged; FTS table definitions written with the `sql` tag; search tests. |
| Parameter order bugs when combining fragments | Kysely keeps parameters with their fragment; queryBuilder characterization tests. |
| Booleans: Kysely passes `true`/`false` instead of `1`/`0`, and some drivers may bind them differently | Values are passed to the drivers exactly as the callers give them, as before (see "Changes to the plan"). |
| Mobile (Metro/Hermes) or desktop bundle can't handle Kysely's modern JS | Not covered by lib tests. Flagged for you to check with a mobile and desktop build. Kysely is plain JS and both bundlers transpile it, but this should be confirmed on a real build. |
| Other packages rely on raw-SQL options | Options kept and converted internally; root `yarn tsc` in Stage 9. |
| Performance: building queries adds overhead | Kysely compile is microseconds; hot paths (search sync batches) build once per batch. |
| Behaviour change through accidentally "fixing" quirks | Quirks preserved (Q4) and locked by Stage 0 capture tests. |

## Follow-ups (not part of this migration)
- **Other packages' Jest configs:** add the same kysely transform to app-desktop, app-cli and app-mobile.
- **Search parameter order (confirmed bug):** searches that combine `id:` with `notebook:`, `tag:` or `resource:` bind the values to the wrong conditions, so they return no results even when a note matches. The capture test shows it, for example `id:<note> notebook:Work`. The original behaviour is reproduced on purpose at the end of `queryBuilder()` in `services/search/queryBuilder.ts`. The fix is to delete that reordering and update the affected entries of the `queryBuilder.test.ts` snapshot.
- **REST `order_dir`:** validate it before it goes into SQL.
- **`loadByFields`:** apply case-insensitivity to every field, not just the last.
- **Real-build check:** confirm a mobile (Metro/Hermes) build and a desktop build with Kysely bundled.

## Verification (every stage)
```
cd packages/lib && yarn tsc && yarn test
```
Expected: 1637 + (new safety-net tests) passed, 0 failed, 3 skipped. Plus the stage's grep check, and in Stages 8–9 an exact match with the schema fingerprint snapshot.

## Results

| Stage | Result |
|---|---|
| 0 – Safety nets | Done. New tests: schema fingerprint at every version 1–53 plus fresh database, upgrade of a database seeded with data, search results for 50 filter combinations in FTS and non-FTS mode, and the shared model query options. All snapshots were generated from the original code. |
| 1 – Infrastructure | Done. `services/database/kysely.ts`, `kyselyTypes.ts`, `sqlFragments.ts`; Jest transform for kysely. |
| 2 – Core CRUD helpers | Done. |
| 3 – Small models and KvStore | Done. |
| 4 – Medium models | Done. |
| 5 – Large models | Done. |
| 6 – Other services | Done, including the REST routes and `testing/test-utils.ts`. |
| 7 – Search | Done. All search tests and the capture snapshot pass unchanged. |
| 8 – Schema and upgrade steps | Done. The schema fingerprint is identical to the original at every version, for a fresh database and for the seeded upgrade. |
| 9 – Cleanup and audit | Done. The audit below is clean, and app-cli, app-desktop, app-mobile and server all type-check (`tsc --noEmit`). |

### Test results

- **Baseline before any change:** 1637 passed / 0 failed / 3 skipped.
- **After each stage:** every stage ended with all tests passing.
- **Final, run twice:** 1652 passed / 0 failed / 3 skipped both times, and all 6 snapshots matched.

### Intermittent test-runner crash

In two of the roughly fourteen full runs, two or three test files were reported as "failed to run". The cause was a test worker process that crashed with a segmentation fault (SIGSEGV), not a failed assertion.

- **Where it crashes:** the macOS crash reports show it inside V8's garbage collector (`ClearStaleLeftTrimmedPointerVisitor`, Node 24.14). That is the Node runtime itself, not JavaScript or SQLite code.
- **Not tied to particular tests:** the affected files pass when run on their own, and the next full run was clean each time.
- **Not proven pre-existing:** it did not happen in the two runs made before the migration started. So I can't prove it already existed. If you see it, rerun the suite. If it keeps happening, try another Node version, or compare with a few runs of the original code.

### Changes to the plan made during the work

1. **Jest transform:**
   - **What the plan said:** use Babel.
   - **What was done:** the transform uses the TypeScript compiler that lib already has (`packages/lib/jest.esmTransform.js`).
   - **Why:** the Babel plugin needed is not a dependency of lib, so this avoids adding one.
2. **Inserts are written with a small `insertInto(table, values)` helper** in `kysely.ts`.
   - **Why:** lib is compiled without `strictNullChecks`, and in that mode Kysely's insert types treat every column as required.
   - **What it still checks:** column names, at compile time.
3. **Booleans are not converted to 0/1:**
   - **What the plan said:** convert them.
   - **What was done:** values are passed to the drivers exactly as before, which keeps the behaviour the same.
4. **Lists of IDs are still written into the SQL as escaped literals** (`literalList`), not as `?` parameters.
   - **Why:** older SQLite versions limit a query to 999 parameters, so a long list of IDs bound as parameters would fail.
5. **Options that take SQL snippets still accept strings.** `where`, `conditions` and the `paginatedFeed` where-query also accept Kysely expressions now.
   - **Inside lib:** all of lib uses expressions.
   - **Outside lib:** strings from other packages keep working, for example the desktop app's `Resource.all({ where: ... })`.
6. **Helpers that existed only to build SQL strings were removed**, because nothing in the monorepo used them any more:
   - `Database.escapeField`, `escapeFields`, `escapeFieldsToString`, `escapeValues`, `alterColumnQueries` and `wrapQueries`
   - `BaseModel.escapeIdsForSql` and `selectFields`
   - `Note.previewFieldsSql`
   - `models/utils/paginationToSql.ts` and `services/database/sqlStringToLines.ts`
7. **Schema setup now lives in four places:**
   - **Column definitions:** `services/database/schemaUtils.ts`, using Kysely's schema builder.
   - **The tag-count view:** `services/database/tagsWithNoteCountView.ts`.
   - **Raw SQL:** FTS tables, triggers, PRAGMA and the `INT` type are in `sqlFragments.ts`.
   - **Reading defaults back:** `refreshTableFields` handles default values written with both quote styles (`unquoteDefaultValue` in `JoplinDatabase.ts`). Databases created before the migration use `""`, and new ones use `''`.
8. **The schema fingerprint treats `note_tags nt` and `note_tags as nt` in view definitions as equal.**
   - **Why:** both mean the same in SQL.
   - **Snapshot unaffected:** this change did not alter the original-code snapshot.
9. **`SearchEngine.relevantFields`** is now an array of column names instead of an SQL string.
10. **Spell-check word list:** five technical words were added to `packages/tools/cspell/dictionary4.txt`: Kysely, Introspector, xinfo, notnull, rootpage.

### What is not covered by the lib tests

- **Other packages' Jest tests:** as decided in Q1, their Jest configs were not changed. Tests in app-desktop, app-cli and app-mobile that load lib database code will fail to load kysely until the same transform is added to their configs.
- **Real app builds:** the mobile (Metro/Hermes), desktop (Electron/esbuild) and web builds were not run. They should be checked once with Kysely bundled.

## `sql` tag inventory

Kysely's `sql` template tag is imported in exactly one file, `packages/lib/services/database/sqlFragments.ts`. No other file in lib imports it, which the final audit checked. Each use is a named function, listed below with why the query builder can't be used and where it is called from.

| Function | What it writes | Why the builder isn't used | Used in |
|---|---|---|---|
| `legacyFragment` | A string SQL snippet with `?` placeholders, as passed through the `where` and `conditions` options | Other packages pass these snippets as plain strings | `BaseModel.ts`, `database.ts`, `models/utils/paginatedFeed.ts` |
| `legacyConditions` | Conditions joined with `AND` without brackets, exactly as before | Mixes string snippets with Kysely expressions while keeping the original text | `BaseModel.ts` |
| `boundValue` | A bound parameter for an `undefined` value | Kysely drops `undefined` columns, but they used to be bound as NULL | `database.ts` |
| `literalList` | `('a', 'b', …)` with escaped literals | Avoids the 999-parameter limit of older SQLite (see change 4) | 14 files: models and services |
| `equalsCollateNocase` | `` `field` = ? COLLATE NOCASE `` | The builder has no collation for a comparison | `BaseModel.ts`, `models/Tag.ts` |
| `rawOrderItem` | An ORDER BY item with a direction other than ASC/DESC, or a dotted field name taken as one identifier | Keeps the original behaviour for unusual REST `order_by`/`order_dir` values (Q4) | `services/database/kysely.ts` (`orderBy`) |
| `ftsOffsets`, `ftsMatchInfo` | `offsets(...)`, `matchinfo(..., 'pcnalx')` | FTS4 auxiliary functions | `services/search/SearchEngine.ts`, `queryBuilder.ts` |
| `ftsMatch` | `<table or column> MATCH ?` | The builder has no FTS `MATCH` operator | `SearchEngine.ts`, `queryBuilder.ts` |
| `connectiveChain` | A flat `a AND b OR c` chain without brackets | Keeps the search builder's original operator precedence | `services/search/queryBuilder.ts` |
| `createVecTableQuery` | `CREATE VIRTUAL TABLE … USING vec0(embedding FLOAT[n])` | sqlite-vec virtual table | `models/NoteEmbedding.ts` |
| `vecKnnMatch` | `… MATCH ? AND k = n` | sqlite-vec needs `k` as a literal | `models/NoteEmbedding.ts` |
| `vecToJson` | `vec_to_json(...)` | sqlite-vec function | `models/NoteEmbedding.ts` |
| `literalNumber` | A number written into the query (used for `LIMIT`) | sqlite-vec's planner needs a literal LIMIT after a join | `models/NoteEmbedding.ts` |
| `intColumnType` | The column type `INT` | The schema builder only has `integer`, and existing profiles use `INT` | `services/database/schemaUtils.ts` |
| `createFtsTableQuery` | `CREATE VIRTUAL TABLE … USING fts4(...)` | No builder for virtual tables | `JoplinDatabase.ts` (v15, v18, v33), `migrations/45.ts` |
| `createVirtualTableQuery` | `CREATE VIRTUAL TABLE … USING fts4aux/spellfix1` | No builder for virtual tables | `JoplinDatabase.ts` (v34) |
| `createFtsTriggerQueries` | The four triggers that keep an FTS table in sync | No builder for triggers | `JoplinDatabase.ts` (v15, v18, v33), `migrations/45.ts` |
| `dropTriggerQuery` | `DROP TRIGGER [IF EXISTS] …` | No builder for triggers | `JoplinDatabase.ts` (v18, v33) |
| `ftsInitialIndexQuery` | `INSERT INTO fts(docid, …) SELECT rowid, …` | Uses the hidden `rowid`/`docid` columns | `JoplinDatabase.ts` (v15) |
| `tableInfoQuery` | `PRAGMA table_info(...)` | No builder for PRAGMA | `JoplinDatabase.ts` |

The audit searched every non-test `.ts` file in `packages/lib` for SQL statements in plain strings (SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, PRAGMA). The only match outside `sqlFragments.ts` is `setLogExcludedQueryTypes(['SELECT'])` in `BaseApplication.ts`. That is the word the query logger uses to skip SELECT statements, not a query.

