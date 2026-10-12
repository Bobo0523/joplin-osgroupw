import { AlarmEntity, ConflictNoteStateEntity, DeletedItemEntity, FolderEntity, ItemChangeEntity, ItemsFtEntity, ItemsNormalizedEntity, KeyValueEntity, MigrationEntity, NoteEmbeddingsMetaEntity, NoteEntity, NoteResourceEntity, NotesNormalizedEntity, NoteTagEntity, ResourceEntity, ResourceLocalStateEntity, ResourcesToDownloadEntity, RevisionEntity, SettingEntity, SyncItemEntity, TableFieldEntity, TagEntity, TagsWithNoteCountEntity, VersionEntity } from './types';

type Table<T> = { [K in keyof Omit<T, 'type_'>]-?: T[K] };

export interface SqliteMasterTable {
	type: string;
	name: string;
	tbl_name: string;
	rootpage: number;
	sql: string | null;
}

export interface SqliteSequenceTable {
	name: string;
	seq: number;
}

export interface MasterKeyTable {
	id: string;
	created_time: number;
	updated_time: number;
	source_application: string;
	encryption_method: number;
	checksum: string;
	content: string;
}

export interface NoteEmbeddingsVecTable {
	rowid: number;
	embedding: unknown;
	distance: number;
}

export interface SearchAuxTable {
	term: string;
	col: string;
	documents: number;
	occurrences: number;
}

export interface NotesSpellfixTable {
	word: string;
	rank: number;
	distance: number;
	score: number;
	matchlen: number;
	top: number;
	scope: number;
	srchcnt: number;
	soundslike: string;
	langid: number;
}

export interface KyselyDatabase {
	alarms: Table<AlarmEntity>;
	conflict_note_states: Table<ConflictNoteStateEntity>;
	deleted_items: Table<DeletedItemEntity>;
	folders: Table<FolderEntity>;
	item_changes: Table<ItemChangeEntity>;
	items_fts: Table<ItemsFtEntity>;
	items_normalized: Table<ItemsNormalizedEntity>;
	key_values: Omit<Table<KeyValueEntity>, 'value'> & { value: string | number };
	master_keys: MasterKeyTable;
	migrations: Table<MigrationEntity>;
	note_embeddings_meta: Table<NoteEmbeddingsMetaEntity>;
	note_embeddings_vec: NoteEmbeddingsVecTable;
	note_resources: Table<NoteResourceEntity>;
	note_tags: Table<NoteTagEntity>;
	notes: Table<NoteEntity>;
	notes_fts: Table<NotesNormalizedEntity>;
	notes_normalized: Table<NotesNormalizedEntity>;
	notes_spellfix: NotesSpellfixTable;
	resource_local_states: Table<ResourceLocalStateEntity>;
	resources: Table<ResourceEntity>;
	resources_to_download: Table<ResourcesToDownloadEntity>;
	revisions: Table<RevisionEntity>;
	search_aux: SearchAuxTable;
	settings: Table<SettingEntity>;
	sqlite_master: SqliteMasterTable;
	sqlite_sequence: SqliteSequenceTable;
	sync_items: Table<SyncItemEntity>;
	table_fields: Table<TableFieldEntity>;
	tags: Table<TagEntity>;
	tags_with_note_count: Table<TagsWithNoteCountEntity>;
	version: Table<VersionEntity>;
}

export type KyselyTableName = keyof KyselyDatabase;
