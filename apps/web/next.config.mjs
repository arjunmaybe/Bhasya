import nextConstants from 'next/constants.js';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

const { PHASE_DEVELOPMENT_SERVER } = nextConstants;

initOpenNextCloudflareForDev();

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
  // Server Actions retain Next.js same-origin validation defaults.
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next',
});

export default config;
