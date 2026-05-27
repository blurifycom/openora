import type { Preview } from '@storybook/react';
import { adapters, adapterNames, defaultAdapter, AdapterProvider } from './adapters';
import './fonts.css';
import './tailwind.css';
import '@oss/react-sdk/styles.css';

const preview: Preview = {
  globalTypes: {
    adapter: {
      description: 'Active UI provider adapter',
      defaultValue: defaultAdapter,
      toolbar: {
        title: 'Adapter',
        icon: 'component',
        items: adapterNames.map((name) => ({ value: name, title: name })),
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, ctx) => {
      const provider = adapters[ctx.globals.adapter as string] ?? adapters[defaultAdapter];
      return (
        <AdapterProvider value={provider}>
          <div style={{ padding: '2.5rem', minHeight: '100vh', fontFamily: 'var(--bo-font-body)' }}>
            <Story />
          </div>
        </AdapterProvider>
      );
    },
  ],
  parameters: {
    layout: 'fullscreen',
    backgrounds: {
      default: 'paper',
      values: [
        { name: 'paper', value: '#1c1815' },
        { name: 'ink', value: '#262019' },
        { name: 'white', value: '#f7f4ef' },
      ],
    },
  },
};

export default preview;
