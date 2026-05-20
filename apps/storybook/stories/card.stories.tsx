import type { Meta, StoryObj } from '@storybook/react';
import { useUI } from '../.storybook/adapters';

const meta: Meta = {
  title: 'Components/Card',
};
export default meta;

export const Basic: StoryObj = {
  render: () => {
    const { Card } = useUI();
    return (
      <Card className="stat-card">
        <div className="stat-card__label">Total deposits</div>
        <div className="stat-card__value">$1,284,500</div>
        <div className="stat-card__hint">+12% vs last week</div>
      </Card>
    );
  },
};

export const Grid: StoryObj = {
  render: () => {
    const { Card } = useUI();
    const tiles = [
      { label: 'Total users', value: '48,210' },
      { label: 'Active users', value: '12,004' },
      { label: 'Deposits', value: '$1.2M' },
      { label: 'Withdrawals', value: '$840K' },
    ];
    return (
      <div className="stat-grid">
        {tiles.map((t) => (
          <Card key={t.label} className="stat-card">
            <div className="stat-card__label">{t.label}</div>
            <div className="stat-card__value">{t.value}</div>
          </Card>
        ))}
      </div>
    );
  },
};
