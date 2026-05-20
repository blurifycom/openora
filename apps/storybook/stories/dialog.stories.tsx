import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { useUI } from '../.storybook/adapters';

const meta: Meta = {
  title: 'Components/Dialog',
};
export default meta;

export const EditUser: StoryObj = {
  render: () => {
    const { Dialog, Button } = useUI();
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open dialog</Button>
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title="Edit user"
          description="ada@casino.dev"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input type="checkbox" defaultChecked /> Active
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => setOpen(false)}>Save</Button>
            </div>
          </div>
        </Dialog>
      </>
    );
  },
};
