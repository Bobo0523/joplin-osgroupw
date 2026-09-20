import * as React from 'react';
import { _ } from '@joplin/lib/locale';
import { FunctionComponent } from 'react';
import { ConfigScreenStyles } from '../configScreenStyles';
import saveFileToDevice from '../../../../utils/saveFileToDevice';
import ExportTaskButton from './ExportTaskButton';
import makeExportTask from './utils/makeExportTask';

interface Props {
	styles: ConfigScreenStyles;
}

export const exportToDeviceButtonDefaultTitle = () => _('Export all notes as JEX to device');
export const exportToDeviceButtonDescription = () => _('Save a copy of all notes to a folder on this device, in a file format that can be imported by Joplin on a computer.');

const runExportTask = makeExportTask(saveFileToDevice);

const NoteExportToDeviceButton: FunctionComponent<Props> = props => {
	return (
		<ExportTaskButton
			styles={props.styles}
			defaultTitle={exportToDeviceButtonDefaultTitle()}
			description={exportToDeviceButtonDescription()}
			onRunTask={runExportTask}
		/>
	);
};

export default NoteExportToDeviceButton;
