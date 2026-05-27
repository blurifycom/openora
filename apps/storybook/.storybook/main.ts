import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';

const config: StorybookConfig = {
  stories: ['../stories/**/*.stories.@(ts|tsx)'],
  // Storybook 10 ships the former addon-essentials features in core.
  addons: [],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  // DaisyUI is the single shipped adapter; its btn/card/modal classes need Tailwind
  // v4 + the daisyUI plugin in the build, otherwise stories render unstyled.
  viteFinal: async (cfg) => {
    cfg.plugins = [...(cfg.plugins ?? []), tailwindcss()];
    return cfg;
  },
};

export default config;
