import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  // GitHub Pages serves a project site under a sub-path. When that workflow lands,
  // set DOCS_BASE_PATH (e.g. /igaming-oss) so asset URLs resolve correctly.
  basePath: process.env.DOCS_BASE_PATH || undefined,
  images: { unoptimized: true },
};

export default withMDX(config);
