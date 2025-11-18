import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DeleteSourceButton from './delete-source-button';
import { deleteSourceAction } from './admin-actions';

// Mock the server action
jest.mock('./admin-actions', () => ({
  deleteSourceAction: jest.fn(),
}));

describe('DeleteSourceButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders delete button', () => {
    render(<DeleteSourceButton workId="123" sourceId="src-1" />);
    expect(screen.getByText('Delete source')).toBeInTheDocument();
  });

  it('shows error message when deletion fails', async () => {
    const user = userEvent.setup();
    const mockError = new Error('Only admin can delete a source with revisions from multiple users');
    (deleteSourceAction as jest.Mock).mockRejectedValue(mockError);

    render(<DeleteSourceButton workId="123" sourceId="src-1" />);

    const button = screen.getByText('Delete source');
    await user.click(button);

    await waitFor(() => {
      expect(screen.getByText('Only admin can delete a source with revisions from multiple users')).toBeInTheDocument();
    });
  });

  it('shows generic error message when deletion fails without specific message', async () => {
    const user = userEvent.setup();
    (deleteSourceAction as jest.Mock).mockRejectedValue(new Error());

    render(<DeleteSourceButton workId="123" sourceId="src-1" />);

    const button = screen.getByText('Delete source');
    await user.click(button);

    await waitFor(() => {
      expect(screen.getByText('Failed to delete source')).toBeInTheDocument();
    });
  });

  it('clears previous errors when deleting again', async () => {
    const user = userEvent.setup();
    const mockError = new Error('First error');
    (deleteSourceAction as jest.Mock).mockRejectedValueOnce(mockError);

    render(<DeleteSourceButton workId="123" sourceId="src-1" />);

    const button = screen.getByText('Delete source');

    // First attempt - should show error
    await user.click(button);

    await waitFor(() => {
      expect(screen.getByText('First error')).toBeInTheDocument();
    });

    // Second attempt - error should clear and deletion should succeed
    (deleteSourceAction as jest.Mock).mockResolvedValueOnce(undefined);
    await user.click(button);

    await waitFor(() => {
      expect(screen.queryByText('First error')).not.toBeInTheDocument();
    });
  });
});
