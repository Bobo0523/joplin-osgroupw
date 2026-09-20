import { basename } from '@joplin/utils/path';
import { copyFile, openDocumentTree } from '@joplin/react-native-saf-x';

// Asks the user for a destination folder, then copies the file there. Unlike sharing,
// this can write to the device's own storage. Android only -- it relies on the Storage
// Access Framework. Does nothing if the user cancels the folder picker.
const saveFileToDevice = async (path: string) => {
	// The permission is only needed for this copy, so it isn't persisted.
	const targetDirectory = await openDocumentTree(false);
	if (!targetDirectory?.uri) return;

	await copyFile(path, `${targetDirectory.uri}/${basename(path)}`, { replaceIfDestinationExists: true });
};

export default saveFileToDevice;
