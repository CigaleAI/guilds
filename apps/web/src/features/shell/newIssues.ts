import type { IssueNotice } from "../../api/types/issues";
import { useIdentity } from "../../app/identity";
import { reachesSeverity } from "../../app/issues";
import { useIssueDesktopNotification } from "./desktopNotifications";

/**
 * Announces an issue an agent reported when it is at least as severe as the operator asked to be
 * alerted to: `chime` rings, and a desktop notification shows when they turned those on. Feed it
 * the inbox stream's notices.
 */
export function useNewIssueAlerts(chime: () => void): (notice: IssueNotice) => void {
  const { user } = useIdentity();
  const notify = useIssueDesktopNotification();
  return (notice) => {
    if (!reachesSeverity(notice.severity, user.issue_alert_severity)) return;
    chime();
    notify(notice);
  };
}
