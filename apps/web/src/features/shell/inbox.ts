import { useNotifications } from "../../api/queries";

/** Items waiting in the operator's inbox: open issues plus unread tags. */
export function useInboxCount(): number | undefined {
  const { data } = useNotifications();
  return data ? data.issues.length + data.mentions.length : undefined;
}
