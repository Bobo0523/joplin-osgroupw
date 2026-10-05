import BaseItem from './BaseItem';
import BaseModel from '../BaseModel';
import { literalList, qb } from '../services/database/kysely';

export default class NoteTag extends BaseItem {
	public static tableName() {
		return 'note_tags';
	}

	public static modelType() {
		return BaseModel.TYPE_NOTE_TAG;
	}

	public static async byNoteIds(noteIds: string[]) {
		if (!noteIds.length) return [];
		return this.modelSelectAll(qb.selectFrom('note_tags').selectAll().where('note_id', 'in', literalList(noteIds)));
	}

	public static async tagIdsByNoteId(noteId: string) {
		const rows = await this.db().selectAll(qb.selectFrom('note_tags').select('tag_id').where('note_id', '=', noteId));
		const output = [];
		for (let i = 0; i < rows.length; i++) {
			output.push(rows[i].tag_id);
		}
		return output;
	}
}
