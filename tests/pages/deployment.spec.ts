import { test, expect } from '@playwright/test';

test('Pages subpath loads resources, scopes its PWA and opens the saved note offline', async ({
  page,
  context,
}) => {
  const failed: string[] = [];
  const csp: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failed.push(response.url());
  });
  page.on('console', (message) => {
    if (message.type() === 'error') csp.push(message.text());
  });
  await page.goto('./');
  const editor = page.getByRole('textbox', { name: '编辑笔记' });
  await expect(editor).toBeVisible();
  const manifestUrl = await page.locator('link[rel=manifest]').getAttribute('href');
  expect(manifestUrl).toBe('/InkBridge/manifest.webmanifest');
  const response = await page.request.get(manifestUrl!);
  const manifest = await response.json();
  expect(manifest.start_url).toBe('/InkBridge/');
  expect(manifest.scope).toBe('/InkBridge/');
  for (const icon of manifest.icons) {
    expect(icon.src).toMatch(/^\/InkBridge\//);
    expect((await page.request.get(icon.src)).ok()).toBe(true);
  }
  await editor.click();
  await editor.press('ControlOrMeta+a');
  await page.keyboard.insertText('# Pages 路径测试\n\n离线修改也能保留。');
  await expect(page.locator('.saved-status')).toHaveText('本地已保存');
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(new URL(scope).pathname).toBe('/InkBridge/');
  await page.reload();
  await expect(editor).toContainText('离线修改也能保留。');
  expect(
    await page.evaluate(() => new URL(navigator.serviceWorker.controller!.scriptURL).pathname),
  ).toBe('/InkBridge/sw.js');
  await context.setOffline(true);
  await page.reload();
  await expect(editor).toContainText('离线修改也能保留。');
  expect(failed).toEqual([]);
  expect(csp).toEqual([]);
});

test('HTML carries a CSP even without host-specific response headers', async ({ page }) => {
  await page.goto('./');
  const policy = page.locator('meta[http-equiv="Content-Security-Policy"]');
  await expect(policy).toHaveAttribute('content', /script-src 'self'/);
  // Exercise the policy in the browser, not just the presence of a meta element.
  const blocked = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 1000);
        document.addEventListener(
          'securitypolicyviolation',
          (event) => {
            if (event.blockedURI === 'inline') {
              clearTimeout(timer);
              resolve(true);
            }
          },
          { once: true },
        );
        const script = document.createElement('script');
        script.textContent = 'window.inlineScriptExecuted = true';
        document.body.append(script);
      }),
  );
  expect(blocked).toBe(true);
  expect(await page.evaluate(() => Reflect.get(window, 'inlineScriptExecuted'))).toBeUndefined();
});
