import { findOpenOverflowToolbar, findOverflowToggleButton } from './useHideOverflowOnOutsideClick';

// Mirrors TinyMCE's actual markup: the toggle button lives inside .tox-toolbar-overlord
// (nested in .tox-toolbar__primary), while the panel it controls is mounted separately,
// elsewhere in the document (TinyMCE's "sink"), linked only via aria-controls/id.
const buildDocumentBody = (overflowOpen: boolean) => {
	document.body.innerHTML = `
		<div class="tox-toolbar-overlord">
			<div class="tox-toolbar__primary">
				<div class="tox-toolbar__group">
					<button class="tox-tbtn" id="bold-button"></button>
				</div>
				<div class="tox-toolbar__group">
					<button
						class="tox-tbtn ${overflowOpen ? 'tox-tbtn--enabled' : ''}"
						aria-haspopup="true"
						aria-expanded="${overflowOpen}"
						aria-controls="overflow-panel-id"
						id="toggle-button"
					></button>
				</div>
			</div>
		</div>
		<div class="tox tox-silver-sink tox-tinymce-aux">
			<div class="tox-toolbar__overflow" id="overflow-panel-id">
				<button class="tox-tbtn" id="overflow-item-button"></button>
			</div>
		</div>
	`;
};

describe('useHideOverflowOnOutsideClick', () => {

	afterEach(() => {
		document.body.innerHTML = '';
	});

	test('findOverflowToggleButton should find the button by its aria-controls attribute', () => {
		buildDocumentBody(false);
		const toggleButton = findOverflowToggleButton(document);
		expect(toggleButton?.id).toBe('toggle-button');
	});

	test('findOverflowToggleButton should return null when there is no overlord', () => {
		document.body.innerHTML = '';
		expect(findOverflowToggleButton(document)).toBeNull();
	});

	test.each([
		[false, null],
		[true, 'overflow-panel-id'],
	])('findOpenOverflowToolbar should find the panel via aria-controls only when open (open: %s)', (overflowOpen, expectedId) => {
		buildDocumentBody(overflowOpen);
		const found = findOpenOverflowToolbar(document);
		if (expectedId === null) {
			expect(found).toBeNull();
		} else {
			expect(found?.id).toBe(expectedId);
		}
	});

});
