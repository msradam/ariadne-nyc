import { defineConfig, devices } from '@playwright/test';

/**
 * WebGPU + Cross-Origin-Isolation in Playwright.
 *
 * Headless WebGPU on Apple Silicon: we run in **headed** mode by default
 * (`headless: false`) because:
 *   - Apple Metal isn't accessible from headless Chromium reliably
 *   - SwiftShader software fallback technically works but Granite 4.0 1B
 *     inference under SwiftShader is ~100× slower than Metal. Minutes
 *     per query instead of seconds
 *
 * Set ARIADNE_HEADLESS=1 to force headless (uses --enable-unsafe-swiftshader).
 *
 * The Vite dev server provides COEP/COOP headers (see vite.config.ts), which
 * is what makes self.crossOriginIsolated true. Required for SharedArrayBuffer
 * which WebLLM needs.
 */
const HEADLESS = process.env.ARIADNE_HEADLESS === '1';

export default defineConfig({
  testDir: './tests/e2e',
  // Granite model load + each LLM round-trip eats real seconds.
  timeout: 180_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,        // serialise. Only one Chromium can hold the GPU
  workers: 1,
  reporter: [['list']],

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },

  projects: [
    {
      name: 'chromium-webgpu',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          headless: HEADLESS,
          args: [
            '--enable-features=Vulkan,SharedArrayBuffer,WebGPUDeveloperFeatures',
            '--enable-webgpu-developer-features',
            '--use-vulkan=swiftshader',
            ...(HEADLESS ? ['--enable-unsafe-swiftshader'] : []),
          ],
          // Ignore HTTPS errors so we don't fight self-signed certs in CI.
          ignoreHTTPSErrors: true,
        },
      },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
