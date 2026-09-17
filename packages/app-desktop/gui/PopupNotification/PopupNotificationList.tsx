import * as React from 'react';
import { VisibleNotificationsContext } from './PopupNotificationProvider';
import NotificationItem from './NotificationItem';
import { useContext } from 'react';
import { _ } from '@joplin/lib/locale';
import { WindowIdContext } from '../NewWindowOrIFrame';

interface Props {}

// This component displays the popups managed by PopupNotificationContext, which is
// shared by all windows. Popups created with a `windowId` are only shown in that
// window; popups created without one are shown in every window.
const PopupNotificationList: React.FC<Props> = () => {
	const popupSpecs = useContext(VisibleNotificationsContext);
	const windowId = useContext(WindowIdContext);
	const popups = [];
	for (const spec of popupSpecs) {
		if (spec.dismissed) continue;
		if (spec.windowId !== undefined && spec.windowId !== windowId) continue;

		popups.push(
			<NotificationItem
				key={spec.key}
				type={spec.type}
				dismissing={!!spec.dismissAt}
				popup={true}
			>{spec.content()}</NotificationItem>,
		);
	}
	popups.reverse();

	if (popups.length) {
		return <ul
			className='popup-notification-list -overlay'
			role='group'
			aria-label={_('Notifications')}
		>
			{popups}
		</ul>;
	} else {
		return null;
	}
};

export default PopupNotificationList;
