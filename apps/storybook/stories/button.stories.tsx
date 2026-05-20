import type { Meta, StoryObj } from '@storybook/react';
import type { ButtonProps } from '@oss/ui-provider-contract';
import { useUI } from '../.storybook/adapters';

function ButtonDemo(args: ButtonProps) {
  const { Button } = useUI();
  return <Button {...args} />;
}

const meta: Meta<typeof ButtonDemo> = {
  title: 'Components/Button',
  component: ButtonDemo,
  argTypes: {
    variant: {
      control: 'select',
      options: ['primary', 'secondary', 'outline', 'ghost', 'destructive'],
    },
    size: { control: 'select', options: ['sm', 'md', 'lg'] },
    loading: { control: 'boolean' },
    disabled: { control: 'boolean' },
  },
  args: { children: 'Continue', variant: 'primary', size: 'md' },
};
export default meta;

type Story = StoryObj<typeof ButtonDemo>;

export const Primary: Story = {};
export const Secondary: Story = { args: { variant: 'secondary' } };
export const Outline: Story = { args: { variant: 'outline' } };
export const Ghost: Story = { args: { variant: 'ghost' } };
export const Destructive: Story = { args: { variant: 'destructive', children: 'Suspend account' } };
export const Loading: Story = { args: { loading: true } };

export const AllVariants: StoryObj = {
  render: () => {
    const { Button } = useUI();
    return (
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
      </div>
    );
  },
};

export const Sizes: StoryObj = {
  render: () => {
    const { Button } = useUI();
    return (
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <Button size="sm">Small</Button>
        <Button size="md">Medium</Button>
        <Button size="lg">Large</Button>
      </div>
    );
  },
};
