import * as React from 'react';
import { _ } from '@joplin/lib/locale';
import { FunctionComponent } from 'react';
import { ConfigScreenStyles } from '../configScreenStyles';
import shareFile from '../../../../utils/shareFile';
import ExportTaskButton from './ExportTaskButton';
import makeExportTask from './utils/makeExportTask';

interface Props {
	styles: ConfigScreenStyles;
}

export const exportButtonDefaultTitle = () => _('Export all notes as JEX');
export const exportButtonDescription = () => _('Share a copy of all notes in a file format that can be imported by Joplin on a computer.');

const runExportTask = makeExportTask(path => shareFile(path, 'application/jex'));

const NoteExportButton: FunctionComponent<Props> = props => {
	return (
		<ExportTaskButton
			styles={props.styles}
			defaultTitle={exportButtonDefaultTitle()}
			description={exportButtonDescription()}
			onRunTask={runExportTask}
		/>
	);
};

export default NoteExportButton;
