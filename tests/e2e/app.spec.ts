import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { MockGitHub } from './github.mock';

async function start(page: Page) {
  await page.setViewportSize({ width: 1194, height: 834 });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '编辑笔记' })).toBeVisible();
}
async function createNote(page: Page, path: string) {
  await page.getByRole('button', { name: '新建笔记', exact: true }).click();
  await page.getByRole('textbox', { name: '笔记路径', exact: true }).fill(path);
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(
    page
      .getByRole('heading', { name: path.split('/').pop()!.replace('.md', ''), exact: true })
      .first(),
  ).toBeVisible();
}
async function edit(page: Page, text: string) {
  const editor = page.getByRole('textbox', { name: '编辑笔记' });
  await editor.click();
  await editor.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
  await expect(page.locator('.saved-status')).toHaveText('本地已保存');
  await expect(editor).toHaveText(text.trim(), { useInnerText: true });
}
async function connect(page: Page) {
  await page.getByRole('button', { name: '连接其他仓库' }).click();
  await page.getByLabel('仓库所有者', { exact: true }).fill('test');
  await page.getByLabel('仓库名称', { exact: true }).fill('notes');
  await page.getByLabel('GitHub Token', { exact: true }).fill('github_pat_simulated_only');
  await page.getByRole('button', { name: '校验并读取分支' }).click();
  await page.getByRole('button', { name: '连接并同步' }).click();
  await expect(page.getByRole('dialog', { name: '连接 GitHub 仓库' })).toBeHidden();
  await expect(page.getByRole('button', { name: '开始', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '编辑笔记' })).toContainText('原始内容');
}

test('note sorting reverses files at every level without reordering or expanding folders', async ({
  page,
}) => {
  await start(page);
  for (const path of [
    'A-folder/Z-note.md',
    'A-folder/A-note.md',
    'A-folder/B-sub/Z-note.md',
    'A-folder/B-sub/A-note.md',
    'A-folder/A-sub/M-note.md',
    'B-folder/M-note.md',
    'Z-note.md',
    'A-note.md',
  ])
    await createNote(page, path);
  await edit(page, '当前笔记的内容与选中状态应保持不变。');
  const tree = page.getByRole('navigation', { name: '笔记文件树' });
  const aFolder = tree.locator(':scope > details').first();
  const nested = aFolder.locator(':scope > .folder-children > details').nth(1);
  const order = page.getByRole('combobox', { name: '笔记排序' });
  await expect(order).toHaveValue('asc');
  await expect(tree.locator(':scope > details > summary > span')).toHaveText([
    'A-folder',
    'B-folder',
  ]);
  await expect(aFolder.locator(':scope > .folder-children > .file-row > span')).toHaveText([
    'A-note',
    'Z-note',
  ]);
  await expect(nested.locator(':scope > .folder-children > .file-row > span')).toHaveText([
    'A-note',
    'Z-note',
  ]);
  await aFolder.locator(':scope > summary').click();
  await order.selectOption('desc');
  await expect(aFolder).not.toHaveAttribute('open');
  await expect(tree.locator(':scope > details > summary > span')).toHaveText([
    'A-folder',
    'B-folder',
  ]);
  await expect(aFolder.locator(':scope > .folder-children > details > summary > span')).toHaveText([
    'A-sub',
    'B-sub',
  ]);
  await expect(aFolder.locator(':scope > .folder-children > .file-row > span')).toHaveText([
    'Z-note',
    'A-note',
  ]);
  await expect(nested.locator(':scope > .folder-children > .file-row > span')).toHaveText([
    'Z-note',
    'A-note',
  ]);
  const rootPaths = () =>
    tree
      .locator(':scope > .file-row')
      .evaluateAll((elements) =>
        elements.map((el) => el.getAttribute('title')).filter((path) => path?.endsWith('-note.md')),
      );
  expect(await rootPaths()).toEqual(['Z-note.md', 'A-note.md']);
  await expect(tree.locator('.file-row.selected')).toHaveAttribute('title', 'A-note.md');
  await expect(page.getByRole('textbox', { name: '编辑笔记' })).toHaveText(
    '当前笔记的内容与选中状态应保持不变。',
  );
  await page.reload();
  await expect(order).toHaveValue('desc');
  await expect.poll(rootPaths).toEqual(['Z-note.md', 'A-note.md']);
  await page.getByRole('textbox', { name: '搜索笔记' }).fill('note');
  await expect(tree.locator('.file-row > span')).toHaveCount(8);
  await expect
    .poll(() =>
      tree
        .locator('.file-row > span')
        .evaluateAll((elements) => elements.map((el) => el.firstChild?.textContent)),
    )
    .toEqual(['Z-note', 'Z-note', 'Z-note', 'M-note', 'M-note', 'A-note', 'A-note', 'A-note']);
  await page.getByRole('button', { name: '清除搜索' }).click();
  await order.selectOption('asc');
  expect(await rootPaths()).toEqual(['A-note.md', 'Z-note.md']);
  await page.setViewportSize({ width: 834, height: 1194 });
  await page.getByRole('button', { name: '打开文件导航', exact: true }).click();
  await expect(order).toBeVisible();
  const bounds = await order.boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(280);
  await page.screenshot({ path: 'artifacts/inkbridge-note-sort.png', fullPage: true });
});

test('sidebar width supports drag, keyboard, touch and viewport-safe persistence', async ({
  page,
  context,
}) => {
  await start(page);
  await edit(page, '调整侧栏时保留正在编辑的笔记。');
  const handle = page.getByRole('separator', { name: '调整侧栏宽度' });
  const sidebar = page.locator('.sidebar');
  const width = () => sidebar.evaluate((el) => Math.round(el.getBoundingClientRect().width));
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 140, box.y + 300, { steps: 8 });
  await page.mouse.up();
  await expect.poll(width).toBe(420);
  await handle.focus();
  await handle.press('ArrowRight');
  await expect.poll(width).toBe(436);
  await page.reload();
  await expect.poll(width).toBe(436);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开文件导航', exact: true }).click();
  await expect.poll(width).toBe(326);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '关闭文件导航' }).click({ position: { x: 380, y: 300 } });
  await page.setViewportSize({ width: 1194, height: 834 });
  await expect.poll(width).toBe(436);
  await handle.dblclick();
  await expect.poll(width).toBe(280);
  await page.setViewportSize({ width: 834, height: 1194 });
  await page.getByRole('button', { name: '打开文件导航', exact: true }).click();
  await expect
    .poll(() => sidebar.evaluate((el) => Math.round(el.getBoundingClientRect().x)))
    .toBe(0);
  const touchBox = (await handle.boundingBox())!;
  const client = await context.newCDPSession(page);
  const x = touchBox.x + touchBox.width / 2;
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y: 400 }],
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: x + 80, y: 400 }],
  });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await client.detach();
  await expect.poll(width).toBe(360);
  await page.screenshot({ path: 'artifacts/inkbridge-sidebar-resize.png', fullPage: true });
  await page.getByRole('button', { name: '关闭文件导航' }).click({ position: { x: 800, y: 300 } });
  await expect(page.getByRole('textbox', { name: '编辑笔记' })).toHaveText(
    '调整侧栏时保留正在编辑的笔记。',
  );
});

test('writing modes agree with visible panes and survive rotation and reload', async ({ page }) => {
  await start(page);
  const mode = (name: string) => page.getByRole('button', { name, exact: true });
  const editor = page.getByRole('textbox', { name: '编辑笔记' });
  const preview = page.getByRole('article', { name: 'Markdown 预览' });
  await expect(mode('分栏')).toHaveAttribute('aria-pressed', 'true');
  await expect(editor).toBeVisible();
  await expect(preview).toBeVisible();
  await mode('阅读').click();
  await expect(editor).toBeHidden();
  await expect(preview).toBeVisible();
  await mode('编辑').click();
  await expect(editor).toBeVisible();
  await expect(preview).toBeHidden();
  await page.setViewportSize({ width: 834, height: 1194 });
  await expect(editor).toBeVisible();
  await expect(mode('分栏')).toHaveCount(0);
  await mode('阅读').click();
  await expect(preview).toBeVisible();
  await page.reload();
  await expect(mode('阅读')).toHaveAttribute('aria-pressed', 'true');
  await expect(preview).toBeVisible();
  await expect(editor).toBeHidden();
  await page.setViewportSize({ width: 1194, height: 834 });
  await expect(mode('阅读')).toHaveAttribute('aria-pressed', 'true');
  await mode('分栏').click();
  await preview.click({ position: { x: 10, y: 10 } });
  await page.setViewportSize({ width: 834, height: 1194 });
  await expect(mode('阅读')).toHaveAttribute('aria-pressed', 'true');
  await expect(preview).toBeVisible();
  await expect(editor).toBeHidden();
  await mode('编辑').click();
  await expect(editor).toBeVisible();
  await page.setViewportSize({ width: 1194, height: 834 });
  await expect(mode('分栏')).toHaveAttribute('aria-pressed', 'true');
  await expect(editor).toBeVisible();
  await expect(preview).toBeVisible();
});

test('long-note scroll positions survive repeated view switches', async ({ page }) => {
  await start(page);
  const editor = page.getByRole('textbox', { name: '编辑笔记' });
  await editor.click();
  await editor.press('ControlOrMeta+a');
  await page.keyboard.insertText(
    Array.from({ length: 100 }, (_, i) => `## 段落 ${i}\n\n用于验证长文滚动位置。`).join('\n\n'),
  );
  await expect(page.locator('.saved-status')).toHaveText('本地已保存');
  // CodeMirror virtualizes long documents; check the rendered preview, not editor DOM text.
  await expect(page.locator('.markdown-body h2')).toHaveCount(100);
  const editorScroll = page.locator('.cm-scroller');
  const previewScroll = page.locator('.preview-pane');
  await editorScroll.evaluate((element) => {
    element.scrollTop = 900;
  });
  await previewScroll.evaluate((element) => {
    element.scrollTop = 1200;
  });
  const original = await editorScroll.evaluate((element) => element.scrollTop);
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByRole('button', { name: '阅读', exact: true }).click();
    await expect.poll(() => previewScroll.evaluate((element) => element.scrollTop)).toBe(1200);
    await page.getByRole('button', { name: '分栏', exact: true }).click();
    await expect.poll(() => editorScroll.evaluate((element) => element.scrollTop)).toBe(original);
  }
  await page.screenshot({ path: 'artifacts/inkbridge-writing-split.png', fullPage: true });
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await page.screenshot({ path: 'artifacts/inkbridge-writing-read.png', fullPage: true });
});

test('keyboard mode switching restores selection and immediate edits persist', async ({ page }) => {
  await start(page);
  await edit(page, 'abcd保留的内容');
  const editor = page.getByRole('textbox', { name: '编辑笔记' });
  await editor.press('ControlOrMeta+Home');
  for (let i = 0; i < 4; i++) await editor.press('Shift+ArrowRight');
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  const editButton = page.getByRole('button', { name: '编辑', exact: true });
  await page.getByRole('button', { name: '阅读', exact: true }).press('Home');
  await expect(editButton).toBeFocused();
  await editButton.press('Enter');
  await expect(editor).toBeFocused();
  await page.keyboard.insertText('替换');
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Markdown 预览' })).toHaveText('替换保留的内容');
  await expect(page.locator('.saved-status')).toHaveText('本地已保存');
  await page.reload();
  await expect(page.getByRole('article', { name: 'Markdown 预览' })).toHaveText('替换保留的内容');
});

test('touch mode switches preserve the draft without focusing the hidden editor', async ({
  page,
}) => {
  await start(page);
  await page.setViewportSize({ width: 834, height: 1194 });
  await edit(page, '触屏切换的草稿');
  await page.getByRole('button', { name: '阅读', exact: true }).tap();
  await expect(page.getByRole('textbox', { name: '编辑笔记' })).toBeHidden();
  await page.getByRole('button', { name: '编辑', exact: true }).tap();
  const editor = page.getByRole('textbox', { name: '编辑笔记' });
  await expect(editor).toBeVisible();
  await expect(editor).not.toBeFocused();
  await expect(editor).toHaveText('触屏切换的草稿');
  const buttons = page.getByRole('toolbar', { name: '笔记视图' }).getByRole('button');
  for (const button of await buttons.all()) {
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: 'artifacts/inkbridge-writing-narrow.png', fullPage: true });
});

test('iPad typography stays readable across widths and remembers the chosen text size', async ({
  page,
}) => {
  await start(page);
  await createNote(page, '工作记录/一份包含较长标题的阅读与简单编辑排版检查笔记.md');
  await edit(
    page,
    '# 阅读测试\n\n正文应当在横屏、竖屏和分屏中保持相同大小。\n\n## 第二部分\n\n| 项目 | 内容 |\n| --- | --- |\n| 表格 | 阅读内容 |\n\n```text\n' +
      'long-code-'.repeat(24) +
      '\n```',
  );
  const textSize = (selector: string) =>
    page.locator(selector).evaluate((el) => getComputedStyle(el).fontSize);
  expect(await textSize('.cm-editor')).toBe('18px');
  expect(await textSize('.markdown-body')).toBe('18px');
  await page.getByRole('button', { name: '设置与本地数据', exact: true }).click();
  await page.getByLabel('正文大小', { exact: true }).selectOption('20');
  expect(await textSize('.markdown-body')).toBe('20px');
  await page.getByLabel('正文大小', { exact: true }).selectOption('22');
  await page.getByLabel('外观主题').selectOption('dark');
  await page.getByRole('button', { name: '关闭设置' }).click();
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await page.getByRole('button', { name: '收起文件导航', exact: true }).click();
  await expect(page.locator('.sidebar')).toBeHidden();
  for (const width of [1194, 834, 600]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await textSize('.markdown-body')).toBe('22px');
    expect(await textSize('.markdown-body table')).toBe('22px');
    expect(await textSize('.cm-editor')).toBe('22px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const heading = await page.locator('.note-heading h1').boundingBox();
    expect(heading!.x).toBeGreaterThanOrEqual(0);
    expect(heading!.x + heading!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `artifacts/inkbridge-readable-${width}.png`, fullPage: true });
  }
  expect(
    await page.locator('.markdown-body pre').evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true);
  await page.reload();
  await expect(page.getByRole('article', { name: 'Markdown 预览' })).toBeVisible();
  expect(await textSize('.markdown-body')).toBe('22px');
  await page.getByRole('button', { name: '编辑', exact: true }).tap();
  await expect(page.getByRole('textbox', { name: '编辑笔记' })).toBeVisible();
});

test('note actions and optional information are accessible without persistent clutter', async ({
  page,
}) => {
  await start(page);
  await expect(page.locator('.eyebrow, .toolbar-tip, .editor-footer, .preview-label')).toHaveCount(
    0,
  );
  const more = page.getByRole('button', { name: '更多笔记操作', exact: true });
  await expect(page.getByRole('button', { name: '删除笔记', exact: true })).toBeHidden();
  await more.focus();
  await more.press('Enter');
  await expect(page.getByRole('button', { name: '重命名笔记', exact: true })).toBeVisible();
  await page.locator('.note-information > summary').click();
  await expect(page.locator('.note-information')).toContainText('UTF-8');
  await page.locator('.note-information > summary').press('Escape');
  await expect(more).toBeFocused();
  await expect(page.getByRole('button', { name: '重命名笔记', exact: true })).toBeHidden();
  await more.click();
  await page.locator('.note-heading h1').click();
  await expect(page.getByRole('button', { name: '删除笔记', exact: true })).toBeHidden();
  await more.click();
  await page.getByRole('button', { name: '删除笔记', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '编辑笔记' })).toBeVisible();
});

test('local autosave survives refresh; PWA opens offline and creates/searches/exports notes', async ({
  page,
  context,
}) => {
  await start(page);
  await createNote(page, '随记/中文 空格.md');
  await edit(page, '# 离线测试\n\n保存后刷新也在。unique-offline');
  await page.reload();
  await expect(page.getByRole('textbox', { name: '编辑笔记' })).toContainText('unique-offline');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect(page.locator('.local-ready')).toContainText('应用已准备好离线使用');
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('textbox', { name: '编辑笔记' })).toContainText('unique-offline');
  await createNote(page, '断网创建.md');
  await edit(page, '# 断网写作\n\noffline-created');
  await page.getByRole('textbox', { name: '搜索笔记' }).fill('unique-offline');
  await expect(page.getByRole('navigation', { name: '笔记文件树' })).toContainText('中文 空格');
  await expect(page.getByRole('navigation', { name: '笔记文件树' })).not.toContainText('断网创建');
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: '更多笔记操作', exact: true }).click();
  await page.getByRole('button', { name: '导出 ZIP', exact: true }).click();
  const file = await event,
    bytes = await readFile((await file.path())!);
  const archive = unzipSync(bytes);
  expect(strFromU8(archive['随记/中文 空格.md'])).toContain('unique-offline');
  expect(strFromU8(archive['断网创建.md'])).toContain('offline-created');
  await page.screenshot({ path: 'artifacts/inkbridge-offline.png', fullPage: true });
});

test('GitHub snapshot, atomic rename, persistent conflict draft and merge converge through real UI', async ({
  page,
  context,
}) => {
  const remote = new MockGitHub();
  await remote.install(context);
  await start(page);
  await connect(page);
  await edit(page, '# 我的笔记\n\niPad 本地修改');
  remote.advance({ '日记/开始.md': '# 我的笔记\n\n电脑远端修改' });
  await page.getByRole('button', { name: '同步', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '处理同步冲突' });
  await expect(dialog).toBeVisible();
  await page
    .getByRole('textbox', { name: '手动合并结果' })
    .fill('# 我的笔记\n\n保留双方想法的草稿');
  await expect(dialog.getByRole('status')).toContainText('草稿已保存在本机');
  await page.screenshot({ path: 'artifacts/inkbridge-conflict.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: /查看并处理/ }).click();
  await expect(page.getByRole('textbox', { name: '手动合并结果' })).toContainText(
    '保留双方想法的草稿',
  );
  await page.getByRole('button', { name: '采用手动合并结果' }).click();
  await page.getByRole('button', { name: '稍后处理' }).click();
  // Refresh erased the token. Re-enter only in the local connection form.
  await page.getByRole('button', { name: '连接其他仓库' }).click();
  await expect(page.getByLabel('GitHub Token', { exact: true })).toHaveValue('');
  await page.getByLabel('GitHub Token', { exact: true }).fill('github_pat_simulated_only');
  await page.getByRole('button', { name: '校验并读取分支' }).click();
  await page.getByRole('button', { name: '连接并同步' }).click();
  await expect.poll(() => remote.text('日记/开始.md')).toContain('保留双方想法的草稿');
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.getByRole('button', { name: '更多笔记操作', exact: true }).click();
  await page.getByRole('button', { name: '重命名笔记', exact: true }).click();
  await page.getByRole('textbox', { name: '笔记路径' }).fill('日记/新的 名字.md');
  await page.getByRole('button', { name: '确认重命名' }).click();
  const before = remote.pushes.length;
  await page.getByRole('button', { name: '同步', exact: true }).click();
  await expect.poll(() => remote.text('日记/新的 名字.md')).toContain('保留双方想法的草稿');
  expect(remote.text('日记/开始.md')).toBeUndefined();
  expect(remote.pushes.length).toBe(before + 1);
  expect(remote.text('.obsidian/workspace.json')).toBe('{"preserve":true}');
  expect(remote.text('画布.canvas')).toBe('{"nodes":[]}');
  expect(remote.pushes.every((push) => push.force === false)).toBe(true);
  expect(remote.unexpected).toEqual([]);
  const exportEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '更多笔记操作', exact: true }).click();
  await page.getByRole('button', { name: '导出 ZIP', exact: true }).click();
  const exported = await exportEvent;
  const zip = unzipSync(await readFile((await exported.path())!));
  expect(Object.keys(zip)).not.toContain('.obsidian/workspace.json');
  const report = JSON.parse(strFromU8(zip['_InkBridge-export-report.json']));
  expect(report.missingAttachments).toEqual(['附件/test.pdf']);
  expect(
    Object.values(zip)
      .map((bytes) => strFromU8(bytes))
      .join(''),
  ).not.toContain('github_pat_simulated_only');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    'github_pat_simulated_only',
  );
  await page.screenshot({ path: 'artifacts/inkbridge-connected.png', fullPage: true });
});

test('Markdown cannot execute scripts or fetch images without permission; wiki ambiguity is explicit', async ({
  page,
  context,
}) => {
  const outbound: string[] = [];
  await context.route('https://untrusted.invalid/**', async (route) => {
    outbound.push(route.request().url());
    await route.abort();
  });
  await start(page);
  await createNote(page, '甲/同名.md');
  await createNote(page, '乙/同名.md');
  await createNote(page, '安全测试.md');
  await edit(
    page,
    '# 安全测试\n\n[[同名|选择笔记]]\n\n<script>window.pwned=1</script>\n<img src="https://untrusted.invalid/pixel" onerror="window.pwned=2">\n[危险](javascript:window.pwned=3)\n<iframe srcdoc="<script>parent.pwned=4</script>"></iframe>',
  );
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  const preview = page.getByRole('article', { name: 'Markdown 预览' });
  await expect(preview.locator('script,iframe,[onerror],[onclick]')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { pwned?: number }).pwned),
  ).toBeUndefined();
  expect(outbound).toEqual([]);
  await preview.getByRole('link', { name: '选择笔记' }).click();
  const choices = page.getByRole('dialog', { name: '选择链接目标' });
  await expect(choices.getByRole('button', { name: '甲/同名.md' })).toBeVisible();
  await expect(choices.getByRole('button', { name: '乙/同名.md' })).toBeVisible();
  await choices.getByRole('button', { name: '取消' }).click();
  await page.setViewportSize({ width: 834, height: 1194 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: '打开文件导航' })).toBeVisible();
  await expect
    .poll(() =>
      page.locator('.sidebar').evaluate((el) => Math.round(el.getBoundingClientRect().right)),
    )
    .toBeLessThanOrEqual(0);
  await expect
    .poll(() =>
      page.locator('.main-panel').evaluate((el) => Math.round(el.getBoundingClientRect().left)),
    )
    .toBe(0);
  await page.screenshot({
    path: 'artifacts/inkbridge-portrait.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('portrait touch navigation, dark theme and edit/preview use the full page width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 834, height: 1194 });
  await page.goto('/');
  const menu = page.getByRole('button', { name: '打开文件导航' });
  await expect(menu).toBeVisible();
  await menu.click();
  await createNote(page, '竖屏书写.md');
  await edit(page, '# 随身的书写空间\n\n一段在 iPad 竖屏写下的文字。\n\n- 离线保存\n- 手动同步');
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '编辑笔记' })).toBeHidden();
  await expect(page.getByRole('article', { name: 'Markdown 预览' })).toContainText(
    '一段在 iPad 竖屏写下的文字。',
  );
  await menu.click();
  await page.getByRole('button', { name: '设置与本地数据', exact: true }).click();
  await page.getByLabel('外观主题').selectOption('dark');
  await page.getByRole('button', { name: '关闭设置' }).click();
  await page.getByRole('button', { name: '关闭文件导航' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect
    .poll(() =>
      page.locator('.sidebar').evaluate((el) => Math.round(el.getBoundingClientRect().right)),
    )
    .toBeLessThanOrEqual(0);
  await expect
    .poll(() =>
      page.locator('.main-panel').evaluate((el) => Math.round(el.getBoundingClientRect().left)),
    )
    .toBe(0);
  await page.screenshot({
    path: 'artifacts/inkbridge-portrait-dark.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('attachments report omissions, download on demand, and stay available offline; API errors keep notes', async ({
  page,
  context,
}) => {
  const remote = new MockGitHub();
  await remote.install(context);
  await start(page);
  await connect(page);
  await page.getByRole('button', { name: /^附件/ }).click();
  await expect(page.getByText('尚未下载 · 离线不可用')).toBeVisible();
  await page.getByRole('button', { name: '下载到本机' }).click();
  await expect(page.getByRole('button', { name: '导出附件' })).toBeVisible();
  await context.setOffline(true);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出附件' }).click();
  expect((await readFile((await (await download).path())!)).toString()).toBe(
    '%PDF-1.7\nmock-binary\n',
  );
  await context.setOffline(false);
  await page.getByRole('button', { name: /^全部笔记/ }).click();
  await expect(page.getByRole('textbox', { name: '编辑笔记' })).toContainText('原始内容');
  await edit(page, '# 我的笔记\n\n网络失败仍在本地');
  remote.failStatus = 401;
  await page.getByRole('button', { name: '同步', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('凭据无效');
  await page.reload();
  await expect(page.getByRole('textbox', { name: '编辑笔记' })).toContainText('网络失败仍在本地');
});

test('real Web Locks exclude a second tab and later typing survives an in-flight commit', async ({
  page,
  context,
}) => {
  const remote = new MockGitHub();
  await remote.install(context);
  await start(page);
  await connect(page);
  const second = await context.newPage();
  await start(second);
  await connect(second);
  await expect(second.getByRole('button', { name: '同步', exact: true })).toBeEnabled();
  await page.bringToFront();
  await expect(page.getByRole('button', { name: '同步', exact: true })).toBeEnabled();
  await edit(page, '# 我的笔记\n\n第一个快照');
  let release!: () => void,
    entered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  remote.beforeRef = async () => {
    entered = true;
    await gate;
  };
  await page.getByRole('button', { name: '同步', exact: true }).click();
  await expect.poll(() => entered).toBe(true);
  await edit(page, '# 我的笔记\n\n第一个快照\n\n同步期间继续输入');
  // Click does not require focus: both documents share the browser's actual Web Locks manager.
  await second.getByRole('button', { name: '同步', exact: true }).click();
  await expect(second.getByRole('alert')).toContainText(/同步|标签/);
  release();
  await expect(page.getByRole('button', { name: '同步', exact: true })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: '编辑笔记' })).toContainText('同步期间继续输入');
  expect(remote.text('日记/开始.md')).toBe('# 我的笔记\n\n第一个快照');
  await page.getByRole('button', { name: '同步', exact: true }).click();
  await expect.poll(() => remote.text('日记/开始.md')).toContain('同步期间继续输入');
  await second.close();
});
