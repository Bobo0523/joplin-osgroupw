# Parallel execution plan for MIGRATION_PLAN.md

Time available: about 1 hour (18:36 → 19:40), so the stages are packed into as few waves as the real code dependencies allow.

## Dependency analysis

- Stage 0 (tests) and Stage 1 (infra) only add code. Stage 1 changes no behaviour (database.ts only gains the ability to accept a Kysely query), so the two can be written at the same time.
- Stages 2–8 all need the Stage 1 infra (`kysely.ts`, `kyselyTypes.ts`, `sqlFragments.ts`, Kysely-aware `Database`). The plan orders 3–7 after 2 so they can rely on stable building blocks. But Stage 2 keeps every public option shape and return value of `BaseModel`/`Database`, so stages 3–8 don't depend on Stage 2's internals at the code level. Their file sets are disjoint, so they run in parallel in Wave 2.
- Stage 9 (cleanup and audit) needs everything else finished.

## sqlFragments.ts ownership

The plan wants all `sql` tag uses in `services/database/sqlFragments.ts`. Every helper needs to add fragments, but each file can only have one owner. So:
- `sqlFragments.ts` (lead-owned) re-exports `sqlFragments.<area>.ts` staging files: `stage2`, `models`, `large`, `services`, `search`, `schema`.
- Each Wave 2 helper owns exactly one staging file and imports fragments from `sqlFragments.ts` (never from the staging file directly).
- In Stage 9 the lead merges the staging files into `sqlFragments.ts` and deletes them. Import paths don't change.

## Waves

### Wave 1
| Who | Stage | Files owned |
|---|---|---|
| Lead | Stage 1 – infra | `jest.config.js`, `database.ts`, new `services/database/kysely.ts`, `kyselyTypes.ts`, `sqlFragments.ts` + empty staging files, `services/database/kysely.test.ts`, cSpell dictionary |
| Helper H0 | Stage 0 – safety nets | new `services/database/schema.test.ts`, `services/search/queryBuilder.test.ts`, `models/utils/paginatedFeed.test.ts`, new capture tests `models/Note.previews.test.ts`, `BaseModel.options.test.ts` |

Then the lead runs `yarn tsc` and the **full suite** (foundation), which also writes the schema snapshot from the unchanged schema code.

### Wave 2 (all in parallel)
| Helper | Stage | Files owned |
|---|---|---|
| H2 | Stage 2 – core CRUD | `database.ts` (`insertQuery`, `updateQuery`, `alterColumnQueries`, `wrapQuery`), `BaseModel.ts`, `models/utils/paginationToSql.ts`, `models/utils/paginatedFeed.ts`, `sqlFragments.stage2.ts` |
| H3 | Stages 3 + 4 – small/medium models | `models/Alarm.ts`, `ConflictNoteState.ts`, `ResourceLocalState.ts`, `NoteTag.ts`, `ItemChange.ts`, `Migration.ts`, `Setting.ts`, `services/KvStore.ts`, `models/Tag.ts`, `Revision.ts`, `NoteResource.ts`, `Resource.ts`, `sqlFragments.models.ts` |
| H5 | Stage 5 – large models | `models/BaseItem.ts`, `models/Folder.ts`, `models/Note.ts`, `sqlFragments.large.ts` |
| H6 | Stage 6 – other services | `services/ResourceService.ts`, `RevisionService.ts`, `ReportService.ts`, `services/synchronizer/tools.ts`, `syncInfoUtils.ts`, `debug/DebugService.ts`, `BaseApplication.ts`, `migrations/20.ts`, `testing/test-utils.ts`, `sqlFragments.services.ts` |
| H7 | Stage 7 – search | `services/search/SearchEngine.ts`, `queryBuilder.ts`, `SearchEngineUtils.ts`, `models/NoteEmbedding.ts`, `sqlFragments.search.ts` |
| H8 | Stage 8 – schema/upgrades | `JoplinDatabase.ts`, `services/database/migrations/*.ts`, `services/database/types.ts`, `addMigrationFile.ts`, `sqlStringToLines.ts`, `sqlFragments.schema.ts` |

Then the lead runs `yarn tsc` and the related tests (`--findRelatedTests` on the compiled files) and fixes or reassigns failures.

### Wave 3 (lead)
Stage 9: merge the staging fragment files, remove unused helpers, audit grep, write the `sql` tag inventory into MIGRATION_PLAN.md, `yarn updateIgnored`, **full suite**, root type-check, `linter-ci` and `spellcheck` on all changed files.

## Helper rules
- Only edit owned files. If a change is needed elsewhere, report it back.
- Type-check with `npx tsc --noEmit -p tsconfig.json` in packages/lib only. Never `yarn tsc` or tests.
