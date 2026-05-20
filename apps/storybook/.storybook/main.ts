import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../stories/**/*.stories.@(ts|tsx)'],
  // Storybook 10 ships the former addon-essentials features in core.
  addons: [],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
};

export default config;
