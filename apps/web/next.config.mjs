import nextConstants from 'next/constants.js';

const { PHASE_DEVELOPMENT_SERVER } = nextConstants;

/**
 * Separate dev/prod build output so `next dev` (dev webpack layout:
 * flat `server/*.js`, eval-source-map runtime) never reuses or overwrites
 * `next build` artifacts (prod layout: `server/chunks/*.js`, manifests).
 *
 * @param {string} phase
 * @param {{ defaultConfig: import('next').NextConfig }} _options
 * @returns {import('next').NextConfig}
 */
const config = (phase, _options) => ({
  reactStrictMode: true,
  experimental: { serverActions: { allowedOrigins: ['*'] } },
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next',
});

export default config;
