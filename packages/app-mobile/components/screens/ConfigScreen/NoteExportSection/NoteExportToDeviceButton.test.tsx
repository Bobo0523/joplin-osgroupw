import * as React from 'react';

import { _ } from '@joplin/lib/locale';
import { act, fireEvent, render, waitFor } from '../../../../utils/testing/testingLibrary';
import { expect, describe, beforeEach, test, jest } from '@jest/globals';
import { createNTestNotes, setupDatabaseAndSynchronizer, switchClient } from '@joplin/lib/testing/test-utils';
import Folder from '@joplin/lib/models/Folder';
import configScreenStyles from '../configScreenStyles';
import Setting from '@joplin/lib/models/Setting';
import { copyFile, openDocumentTree } from '@joplin/react-native-saf-x';
import NoteExportToDeviceButton from './NoteExportToDeviceButton';

jest.mock('@joplin/react-native-saf-x', () => ({
	openDocumentTree: jest.fn(),
	copyFile: jest.fn(),
}));

const exportToDevice = async () => {
	const styles = configScreenStyles(Setting.THEME_DARK);
	const view = render(<NoteExportToDeviceButton
		styles={styles}
	/>);

	const exportButton = view.getByText(_('Export all notes as JEX to device'));
	await act(() => fireEvent.press(exportButton));

	await waitFor(() =>
		expect(view.queryByText(_('Exported successfully!'))).not.toBeNull(),
	);

	return view;
};

describe('NoteExportToDeviceButton', () => {
	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);

		jest.mocked(copyFile).mockReset();

		const folder = await Folder.save({ title: 'folder1' });
		await createNTestNotes(10, folder);
	});

	test('should copy the exported file to the directory chosen by the user', async () => {
		jest.mocked(openDocumentTree).mockResolvedValue({ uri: 'content://test/tree' } as never);

		const view = await exportToDevice();

		await waitFor(() => expect(copyFile).toHaveBeenCalledTimes(1));
		const [source, destination] = jest.mocked(copyFile).mock.calls[0];
		expect(source).toMatch(/jex-export\.jex$/);
		expect(destination).toBe('content://test/tree/jex-export.jex');

		view.unmount();
	});

	test('should not copy anything if the user cancels the directory picker', async () => {
		jest.mocked(openDocumentTree).mockResolvedValue(null as never);

		const view = await exportToDevice();

		expect(copyFile).not.toHaveBeenCalled();

		view.unmount();
	});
});
