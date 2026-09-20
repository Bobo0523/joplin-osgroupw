import Logger from '@joplin/utils/Logger';
import shim from '@joplin/lib/shim';
import { join } from 'path';
import exportAllFolders from './exportAllFolders';
import { ExportProgressState } from '@joplin/lib/services/interop/types';
import makeImportExportCacheDirectory from './makeImportExportCacheDirectory';
import { OnProgressCallback, OnRunTaskCallback, SetAfterCompleteListenerCallback } from '../TaskButton';

const logger = Logger.create('NoteExport');

type SaveExportedFileCallback = (path: string)=> Promise<void>;

// Exports all notes to a temporary file, then hands that file to saveExportedFile,
// which decides where it ends up (shared with another app, saved to the device, ...).
const makeExportTask = (saveExportedFile: SaveExportedFileCallback): OnRunTaskCallback => {
	return async (
		onProgress: OnProgressCallback,
		setAfterCompleteListener: SetAfterCompleteListenerCallback,
	) => {
		const exportTargetPath = join(await makeImportExportCacheDirectory(), 'jex-export.jex');
		logger.info(`Exporting all folders to path ${exportTargetPath}`);

		setAfterCompleteListener(async (success: boolean) => {
			if (success) {
				await saveExportedFile(exportTargetPath);
			}
			await shim.fsDriver().remove(exportTargetPath);
		});

		// Initially, undetermined progress
		onProgress(undefined);

		const status = await exportAllFolders(exportTargetPath, (status, progress) => {
			if (progress !== null) {
				onProgress(progress);
			} else if (status === ExportProgressState.Closing || status === ExportProgressState.QueuingItems) {
				// We don't have a numeric progress value and the closing/queuing state may take a while.
				// Set a special progress value:
				onProgress(undefined);
			}
		});

		onProgress(1);

		logger.info('Export complete');

		return { warnings: status.warnings, success: true };
	};
};

export default makeExportTask;
