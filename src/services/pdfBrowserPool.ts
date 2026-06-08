import puppeteer, { type Browser } from 'puppeteer';

let sharedBrowser: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

export async function getSharedPdfBrowser(): Promise<Browser> {
  if (sharedBrowser?.connected) {
    return sharedBrowser;
  }

  if (!browserLaunchPromise) {
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    const extraArgs = process.env.PUPPETEER_ARGS
      ? process.env.PUPPETEER_ARGS.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    browserLaunchPromise = puppeteer
      .launch({
        headless: 'new',
        executablePath: executablePath || undefined,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--font-render-hinting=medium',
          ...extraArgs,
        ],
      })
      .then((browser) => {
        sharedBrowser = browser;
        browser.on('disconnected', () => {
          sharedBrowser = null;
          browserLaunchPromise = null;
        });
        return browser;
      })
      .catch((err) => {
        browserLaunchPromise = null;
        throw err;
      });
  }

  return browserLaunchPromise;
}

export async function closeSharedPdfBrowser(): Promise<void> {
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => undefined);
    sharedBrowser = null;
    browserLaunchPromise = null;
  }
}
