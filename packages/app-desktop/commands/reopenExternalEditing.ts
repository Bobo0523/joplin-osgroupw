import CommandService, { CommandRuntime, CommandDeclaration, CommandContext } from '@joplin/lib/services/CommandService';
import { _ } from '@joplin/lib/locale';
import { stateUtils } from '@joplin/lib/reducer';

export const declaration: CommandDeclaration = {
	name: 'reopenExternalEditing',
	label: () => _('Reopen in external editor'),
	iconName: 'icon-share',
};

export const runtime = (): CommandRuntime => {
	return {
		execute: async (context: CommandContext, noteId: string = null) => {
			noteId = noteId || stateUtils.selectedNoteId(context.state);
			void CommandService.instance().execute('startExternalEditing', noteId);
		},
		enabledCondition: 'oneNoteSelected && !noteIsReadOnly && !noteIsLocked',
	};
};
