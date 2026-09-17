import * as React from 'react';
import { useContext, useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import PopupNotificationProvider, { PopupNotificationContext } from './PopupNotificationProvider';
import PopupNotificationList from './PopupNotificationList';
import { WindowIdContext } from '../NewWindowOrIFrame';

interface CreatePopupOnMountProps {
	message: string;
	windowId?: string;
}

const CreatePopupOnMount: React.FC<CreatePopupOnMountProps> = ({ message, windowId }) => {
	const popupManager = useContext(PopupNotificationContext);
	useEffect(() => {
		popupManager.createPopup(() => message, { windowId });
	}, [popupManager, message, windowId]);
	return null;
};

const renderWithWindows = (children: React.ReactNode) => {
	render(
		<PopupNotificationProvider>
			{children}
			<WindowIdContext.Provider value='window-a'>
				<PopupNotificationList/>
			</WindowIdContext.Provider>
			<WindowIdContext.Provider value='window-b'>
				<PopupNotificationList/>
			</WindowIdContext.Provider>
		</PopupNotificationProvider>,
	);
};

describe('PopupNotificationList', () => {
	test('should only show a window-scoped popup in the window it targets', () => {
		renderWithWindows(<CreatePopupOnMount message='Window A message' windowId='window-a'/>);

		expect(screen.getAllByText('Window A message')).toHaveLength(1);
	});

	test('should show a popup with no windowId in every window', () => {
		renderWithWindows(<CreatePopupOnMount message='Broadcast message'/>);

		expect(screen.getAllByText('Broadcast message')).toHaveLength(2);
	});
});
