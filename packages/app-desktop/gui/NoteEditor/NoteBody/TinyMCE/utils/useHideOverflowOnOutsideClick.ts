import type { Editor } from 'tinymce';
import { useEffect } from 'react';

// The overflow toggle button ("...") is a standard ARIA disclosure widget: it has
// aria-controls pointing at the id of the panel it shows/hides, and aria-expanded
// reflecting whether that panel is currently open. It's the only button in the
// toolbar with aria-controls, so it can be found directly instead of relying on
// TinyMCE's internal class names or DOM layout.
export const findOverflowToggleButton = (doc: Document): HTMLElement|null => {
	return doc.querySelector<HTMLElement>('.tox-toolbar-overlord button[aria-controls]');
};

// When open, the overflow panel is not a child of the toolbar/editor container: TinyMCE
// renders it into a separate "sink" element (.tox-tinymce-aux) mounted elsewhere in the
// document. Its id is looked up via the toggle button's aria-controls rather than
// searched for structurally.
export const findOpenOverflowToolbar = (doc: Document): HTMLElement|null => {
	const toggleButton = findOverflowToggleButton(doc);
	if (!toggleButton || toggleButton.getAttribute('aria-expanded') !== 'true') return null;

	const overflowId = toggleButton.getAttribute('aria-controls');
	return overflowId ? doc.getElementById(overflowId) : null;
};

// TinyMCE's floating toolbar overflow menu ("...") doesn't close itself when the user
// clicks elsewhere in the editor, unlike most popups/menus.
// See https://discourse.joplinapp.org/t/feature-request-auto-hide-overflow-toolbar/50838
//
// There's no public TinyMCE API for closing it, so this simulates a click on its
// toggle button, found via the ARIA attributes above.
const useHideOverflowOnOutsideClick = (editor: Editor|null) => {
	useEffect(() => {
		if (!editor) return () => {};

		const container = editor.getContainer();
		if (!container) return () => {};

		const ownerDocument = container.ownerDocument;

		const closeOverflow = () => {
			findOverflowToggleButton(ownerDocument)?.click();
		};

		// The toolbar and its overflow menu live in the same document as the container,
		// but the editable note body is in a separate iframe document -- clicks there
		// don't bubble up to the container's document, so they need their own listener.
		// Any click inside that iframe is necessarily outside the overflow menu.
		const onContentMouseDown = () => {
			if (findOpenOverflowToolbar(ownerDocument)) closeOverflow();
		};

		const onContainerMouseDown = (event: MouseEvent) => {
			const openOverflow = findOpenOverflowToolbar(ownerDocument);
			if (!openOverflow) return;

			const target = event.target as Node;
			if (openOverflow.contains(target)) return;
			if (findOverflowToggleButton(ownerDocument)?.contains(target)) return;

			closeOverflow();
		};

		ownerDocument.addEventListener('mousedown', onContainerMouseDown);
		editor.getDoc()?.addEventListener('mousedown', onContentMouseDown);

		return () => {
			ownerDocument.removeEventListener('mousedown', onContainerMouseDown);
			editor.getDoc()?.removeEventListener('mousedown', onContentMouseDown);
		};
	}, [editor]);
};

export default useHideOverflowOnOutsideClick;
