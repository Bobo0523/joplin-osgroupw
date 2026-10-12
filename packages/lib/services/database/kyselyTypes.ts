import { Generated } from 'kysely';
import { AlarmEntity, ConflictNoteStateEntity, DeletedItemEntity, FolderEntity, ItemChangeEntity, ItemsNormalizedEntity, KeyValueEntity, MigrationEntity, NoteEmbeddingsMetaEntity, NoteEntity, NoteResourceEntity, NoteTagEntity, NotesNormalizedEntity, ResourceEntity, ResourceLocalStateEntity, ResourcesToDownloadEntity, RevisionEntity, SettingEntity, SyncItemEntity, TableFieldEntity, TagEntity, TagsWithNoteCountEntity, VersionEntity } from './types';

// Every column is marked as generated (optional on insert) because the models
// insert partial rows and rely on the column defaults for the rest.
type Table<Entity> = {
	[Column in keyof Omit<Entity, 'type_'>]-?: Generated<Entity[Column]>;
};

interface MasterKeyTable {
	id: Generated<string>;
	created_time: Generated<number>;
	updated_time: Generated<number>;
	source_application: Generated<string>;
	encryption_method: Generated<number>;
	checksum: Generated<string>;
	content: Generated<string>;
}

interface NotesFtsTable extends Table<NotesNormalizedEntity> {
	docid: Generated<number>;
	rowid: Generated<number>;
}

interface ItemsFtsTable extends Table<ItemsNormalizedEntity> {
	docid: Generated<number>;
	rowid: Generated<number>;
}

interface NoteEmbeddingsVecTable {
	rowid: Generated<number>;
	embedding: Generated<Buffer | string>;
	distance: Generated<number>;
	k: Generated<number>;
}

interface SqliteMasterTable {
	type: string;
	name: string;
	tbl_name: string;
	rootpage: number;
	sql: string | null;
}

interface SqliteSequenceTable {
	name: string;
	seq: number;
}

export interface DatabaseSchema {
	alarms: Table<AlarmEntity>;
	conflict_note_states: Table<ConflictNoteStateEntity>;
	deleted_items: Table<DeletedItemEntity>;
	folders: Table<FolderEntity>;
	item_changes: Table<ItemChangeEntity>;
	items_fts: ItemsFtsTable;
	items_normalized: Table<ItemsNormalizedEntity>;
	key_values: Table<KeyValueEntity>;
	master_keys: MasterKeyTable;
	migrations: Table<MigrationEntity>;
	note_embeddings_meta: Table<NoteEmbeddingsMetaEntity>;
	note_embeddings_vec: NoteEmbeddingsVecTable;
	note_resources: Table<NoteResourceEntity>;
	note_tags: Table<NoteTagEntity>;
	notes: Table<NoteEntity>;
	notes_fts: NotesFtsTable;
	notes_normalized: Table<NotesNormalizedEntity>;
	resource_local_states: Table<ResourceLocalStateEntity>;
	resources: Table<ResourceEntity>;
	resources_to_download: Table<ResourcesToDownloadEntity>;
	revisions: Table<RevisionEntity>;
	settings: Table<SettingEntity>;
	sqlite_master: SqliteMasterTable;
	sqlite_sequence: SqliteSequenceTable;
	sync_items: Table<SyncItemEntity>;
	table_fields: Table<TableFieldEntity>;
	tags: Table<TagEntity>;
	tags_with_note_count: Table<TagsWithNoteCountEntity>;
	version: Table<VersionEntity>;
}

// Used where the table name is only known at runtime, for example in
// BaseModel, which serves every model table.
export type DynamicDatabaseSchema = Record<string, Record<string, unknown>>;
