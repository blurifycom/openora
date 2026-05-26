import type { UIProvider } from '@oss/ui-provider-contract';

interface NotificationItem {
  id: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

interface NotificationsListProps {
  ui: UIProvider;
  notifications: NotificationItem[];
  onMarkRead: (id: string) => void;
}

export function NotificationsList({ ui, notifications, onMarkRead }: NotificationsListProps) {
  const { Card, Badge, Button } = ui;

  if (notifications.length === 0) {
    return <Card>No notifications.</Card>;
  }

  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {notifications.map((n) => (
        <li key={n.id} style={{ marginBottom: '8px' }}>
          <Card>
            <div
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
            >
              <div>
                <strong>{n.title}</strong>
                {!n.readAt && (
                  <Badge variant="default" className="ml-2">
                    Unread
                  </Badge>
                )}
                <p style={{ margin: '4px 0 0' }}>{n.body}</p>
                <small>{new Date(n.createdAt).toLocaleString()}</small>
              </div>
              {!n.readAt && (
                <Button variant="ghost" size="sm" onClick={() => onMarkRead(n.id)}>
                  Mark read
                </Button>
              )}
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}
