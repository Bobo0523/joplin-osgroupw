import { EditorSelection, Line } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

// End of a line-leading Markdown marker ("# " of a heading, "> " of a quote),
// including the space after it. Null when the line has no such marker.
const leadingMarkerEnd = (view: EditorView, line: Line) => {
	let markerEnd: number|null = null;

	syntaxTree(view.state).iterate({
		from: line.from,
		to: line.to,
		enter: node => {
			if (markerEnd !== null) return false;
			const isLeadingMarker = (node.name === 'HeaderMark' || node.name === 'QuoteMark') && node.from === line.from;
			if (!isLeadingMarker) return undefined;

			markerEnd = node.to;
			if (view.state.doc.sliceString(node.to, node.to + 1) === ' ') {
				markerEnd = node.to + 1;
			}
			return false;
		},
	});

	return markerEnd;
};

// Line-leading markers are hidden while the cursor is on another line. The hidden
// run keeps its original text metrics even though only ~1px of it is painted, so
// pressing on what looks like the first visible character actually resolves to a
// position inside the marker. A drag would then start after the "#", and copying
// the heading would silently drop it. Anchor such a drag at the line start.
const selectHiddenLinePrefix = EditorView.mouseSelectionStyle.of((view, startEvent) => {
	const isPlainLeftDrag = startEvent.button === 0 && startEvent.detail === 1 && !startEvent.shiftKey;
	if (!isPlainLeftDrag) return null;

	const pressedAt = view.posAtCoords({ x: startEvent.clientX, y: startEvent.clientY });
	if (pressedAt === null) return null;

	const line = view.state.doc.lineAt(pressedAt);
	const markerEnd = leadingMarkerEnd(view, line);
	if (markerEnd === null || pressedAt > markerEnd) return null;

	// Only when the marker is actually hidden - it is revealed whenever the
	// selection touches its line, and then it can be selected normally.
	const previousSelection = view.state.selection.main;
	const markerRevealed = previousSelection.to >= line.from && previousSelection.from <= line.to;
	if (markerRevealed) return null;

	return {
		get: (event: MouseEvent) => {
			const head = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? pressedAt;
			// A press without a drag should still place a plain cursor.
			if (head === pressedAt) return EditorSelection.single(pressedAt);
			return EditorSelection.single(line.from, head);
		},
		update: () => false,
	};
});

export default selectHiddenLinePrefix;
