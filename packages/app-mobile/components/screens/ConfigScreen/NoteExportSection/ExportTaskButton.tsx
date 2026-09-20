import * as React from 'react';
import { _ } from '@joplin/lib/locale';
import { FunctionComponent, useCallback } from 'react';
import { ConfigScreenStyles } from '../configScreenStyles';
import TaskButton, { OnRunTaskCallback, TaskStatus } from './TaskButton';

interface Props {
	styles: ConfigScreenStyles;
	defaultTitle: string;
	description: string;
	onRunTask: OnRunTaskCallback;
}

const ExportTaskButton: FunctionComponent<Props> = props => {
	const getTitle = useCallback((taskStatus: TaskStatus) => {
		if (taskStatus === TaskStatus.InProgress) {
			return _('Exporting...');
		} else {
			return props.defaultTitle;
		}
	}, [props.defaultTitle]);

	return (
		<TaskButton
			taskName={props.defaultTitle}
			buttonLabel={getTitle}
			finishedLabel={_('Exported successfully!')}
			description={props.description}
			styles={props.styles}
			onRunTask={props.onRunTask}
		/>
	);
};

export default ExportTaskButton;
