import type { Meta, StoryObj } from '@storybook/react';
import type { BadgeProps } from '@oss/ui-provider-contract';
import { useUI } from '../.storybook/adapters';

function BadgeDemo(args: BadgeProps) {
  const { Badge } = useUI();
  return <Badge {...args} />;
}

const meta: Meta<typeof BadgeDemo> = {
  title: 'Components/Badge',
  component: BadgeDemo,
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'outline', 'success', 'warning', 'destructive'],
    },
  },
  args: { children: 'Active', variant: 'success' },
};
export default meta;

type Story = StoryObj<typeof BadgeDemo>;

export const Success: Story = {};
export const Warning: Story = { args: { variant: 'warning', children: 'Pending' } };
export const Destructive: Story = { args: { variant: 'destructive', children: 'Suspended' } };
export const Outline: Story = { args: { variant: 'outline', children: 'admin' } };

export const AllVariants: StoryObj = {
  render: () => {
    const { Badge } = useUI();
    return (
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <Badge variant="default">default</Badge>
        <Badge variant="outline">outline</Badge>
        <Badge variant="success">Active</Badge>
        <Badge variant="warning">Pending</Badge>
        <Badge variant="destructive">Suspended</Badge>
      </div>
    );
  },
};
