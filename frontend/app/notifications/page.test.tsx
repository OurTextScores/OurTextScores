import { jest } from '@jest/globals';

import NotificationsPage from './page';

global.fetch = jest.fn();

function findElement(node: any, predicate: (value: any) => boolean): any {
  if (!node || typeof node !== 'object') return undefined;
  if (predicate(node)) return node;
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children];
  return children.map((child: any) => findElement(child, predicate)).find(Boolean);
}

describe('NotificationsPage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('includes the shared email preference panel with the saved choices', async () => {
    (fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user: { id: 'u1' } })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ notifications: [], unreadCount: 0 })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user: {
            notify: {
              watchPreference: 'weekly',
              emailEnabled: false,
              emailCategories: { comments: false, scanner: true }
            }
          }
        })
      });

    const page: any = await NotificationsPage();
    const panel = findElement(page, (node) => node.props?.id === 'notification-settings');
    const form = findElement(panel, (node) => node.props?.emailCategories);

    expect(panel).toBeDefined();
    expect(form.props.preference).toBe('weekly');
    expect(form.props.emailEnabled).toBe(false);
    expect(form.props.emailCategories).toEqual({
      comments: false,
      revisions: true,
      reviews: true,
      scanner: true,
      approvals: true
    });
  });
});
