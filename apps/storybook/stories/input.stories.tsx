import type { Meta, StoryObj } from '@storybook/react';
import type { InputProps } from '@oss/ui-provider-contract';
import { useUI } from '../.storybook/adapters';

function InputDemo(args: InputProps) {
  const { Input } = useUI();
  return (
    <div style={{ maxWidth: 360 }}>
      <Input {...args} />
    </div>
  );
}

const meta: Meta<typeof InputDemo> = {
  title: 'Components/Input',
  component: InputDemo,
  argTypes: {
    label: { control: 'text' },
    placeholder: { control: 'text' },
    error: { control: 'text' },
    type: { control: 'select', options: ['text', 'email', 'password', 'search', 'number'] },
    disabled: { control: 'boolean' },
  },
  args: { label: 'Email', placeholder: 'you@igaming.dev', type: 'email' },
};
export default meta;

type Story = StoryObj<typeof InputDemo>;

export const Default: Story = {};
export const WithError: Story = {
  args: { label: 'Password', type: 'password', error: 'Must be at least 8 characters' },
};
export const NoLabel: Story = {
  render: () => {
    const { Input } = useUI();
    return (
      <div style={{ maxWidth: 360 }}>
        <Input placeholder="Search users..." />
      </div>
    );
  },
};
export const Disabled: Story = { args: { disabled: true, placeholder: 'Locked' } };
