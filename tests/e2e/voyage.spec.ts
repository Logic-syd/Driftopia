import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
const password = "OceanVoyage2026";
async function register(page: Page, name: string, email: string) {
  await page.goto("/");
  await page.getByLabel("漂流者昵称").fill(name);
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "出发，去海上生活" }).click();
  await expect(
    page.getByRole("heading", { name: `${name}的漂浮小岛` }),
  ).toBeVisible();
}
async function build(page: Page, kind: string, x: number, y: number) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "建造", exact: true })
    .click();
  await page.getByText("使用坐标选择建造位置").click();
  await page.getByLabel("建筑", { exact: true }).selectOption(kind);
  await page
    .getByRole("button", { name: `在 (${x}, ${y}) 建造`, exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("建好了");
  await page.getByRole("button", { name: "关闭面板" }).click();
}
test("two independent players build, produce, deliver and trade with persistent saves", async ({
  browser,
  page,
}) => {
  const run = randomUUID().slice(0, 8),
    emailA = `voyage-a-${run}@example.test`,
    emailB = `voyage-b-${run}@example.test`;
  const other = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    pageB = await other.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await register(page, "海风旅人", emailA);
  await register(pageB, "远航伙伴", emailB);
  await page.getByRole("button", { name: /快捷打捞/ }).click();
  await expect(page.getByRole("status")).toContainText("打捞成功");
  await build(page, "purifier", 0, 0);
  await page
    .locator(".production-peek")
    .getByRole("button", { name: /净水器/ })
    .click();
  await page.getByRole("button", { name: "开始生产", exact: true }).click();
  await expect(page.getByText("正在生产", { exact: true })).toBeVisible();
  await page.reload();
  await page
    .locator(".production-peek")
    .getByRole("button", { name: /净水器/ })
    .click();
  await expect(page.getByRole("button", { name: /收取产出/ })).toBeEnabled({
    timeout: 20000,
  });
  await page.getByRole("button", { name: /收取产出/ }).click();
  await expect(page.getByRole("status")).toContainText("收获了");
  await page.getByRole("button", { name: "关闭面板" }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "委托", exact: true })
    .click();
  await page.getByRole("button", { name: "交付委托" }).first().click();
  await expect(page.getByRole("status")).toContainText("商船出发了");
  await page.getByRole("button", { name: "关闭面板" }).click();
  // Continue gathering through the actual server-generated salvage records.
  for (let i = 0; i < 4; i++) {
    if (await page.getByRole("button", { name: /快捷打捞/ }).isEnabled()) {
      await page.getByRole("button", { name: /快捷打捞/ }).click();
      await expect(
        page.getByRole("button", { name: /快捷打捞/ }),
      ).toBeEnabled();
    }
  }
  await build(page, "dock", 1, 1);
  await build(pageB, "dock", 1, 1);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "集市", exact: true })
    .click();
  await page.getByRole("button", { name: "我要出售" }).click();
  await page.getByLabel("出售资源").selectOption("water");
  // Produce a fresh batch for the listing.
  await page.getByRole("button", { name: "关闭面板" }).click();
  await page
    .locator(".production-peek")
    .getByRole("button", { name: /净水器/ })
    .click();
  await page.getByRole("button", { name: "开始生产", exact: true }).click();
  await expect(page.getByRole("button", { name: /收取产出/ })).toBeEnabled({
    timeout: 20000,
  });
  await page.getByRole("button", { name: /收取产出/ }).click();
  await expect(page.getByRole("status")).toContainText("收获了");
  await page.getByRole("button", { name: "关闭面板" }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "集市", exact: true })
    .click();
  await page.getByRole("button", { name: "我要出售" }).click();
  await page.getByLabel("出售资源").selectOption("water");
  await page.getByLabel("数量", { exact: true }).fill("2");
  await page.getByLabel("单价（金币）").fill("7");
  await page.getByRole("button", { name: "挂牌出售" }).click();
  await expect(page.getByRole("button", { name: "下架" })).toBeVisible();
  await pageB
    .getByRole("navigation")
    .getByRole("button", { name: "集市", exact: true })
    .click();
  const row = pageB
    .locator(".market-row")
    .filter({ hasText: "海风旅人" })
    .filter({ hasText: "淡水" })
    .first();
  await row.getByLabel("购买淡水数量").fill("2");
  await expect(row.getByText("合计 ◈ 14")).toBeVisible();
  await pageB.setViewportSize({ width: 390, height: 844 });
  await expect(row.getByRole("button", { name: "购买 2 个" })).toBeVisible();
  expect(
    await pageB.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await pageB.screenshot({
    path: "docs/screenshots/market-mobile.png",
    fullPage: true,
  });
  await row.getByRole("button", { name: "购买 2 个" }).click();
  await expect(pageB.getByRole("status")).toContainText("交易完成");
  await pageB.reload();
  await pageB
    .getByRole("navigation")
    .getByRole("button", { name: "仓库", exact: true })
    .click();
  await expect(
    pageB
      .locator(".inventory-item")
      .filter({ hasText: "淡水" })
      .locator("strong"),
  ).toHaveText("2");
  await page.getByRole("button", { name: "交易记录" }).click();
  await expect(page.getByText("卖出 淡水 × 2")).toBeVisible();
  await page.getByRole("button", { name: "关闭面板" }).click();
  await page.mouse.move(0, 0);
  await expect(page.getByRole("status")).toBeHidden({ timeout: 6000 });
  await page.screenshot({
    path: "docs/screenshots/desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "暂别小岛" }).click();
  await page.getByRole("button", { name: "回到我的岛" }).click();
  await page.getByLabel("邮箱", { exact: true }).fill(emailA);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "欢迎回到你的岛" }).click();
  await expect(
    page.locator(".production-peek").getByRole("button", { name: /净水器/ }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.mouse.move(0, 0);
  await expect(page.getByRole("status")).toBeHidden({ timeout: 6000 });
  await page.screenshot({
    path: "docs/screenshots/mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await other.close();
});

test("canvas placement works and panels do not click through into the ocean", async ({
  page,
}) => {
  await register(page, "造岛观察员", `canvas-${randomUUID()}@example.test`);
  const current = await page.request.get("/api/state");
  const before = await current.json();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "建造", exact: true })
    .click();
  await page.getByTestId("build-purifier").click();
  await expect(page.getByText("建造模式", { exact: true })).toBeVisible();
  const canvas = page.locator("canvas");
  await expect(canvas).toHaveAttribute("data-mode", "purifier");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas missing");
  await page.mouse.click(
    bounds.x + bounds.width * 0.53,
    bounds.y + bounds.height * 0.49,
  );
  await expect(page.getByRole("status")).toContainText("净水器建好了");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "仓库", exact: true })
    .click();
  await page.getByRole("heading", { name: "我的仓库", exact: true }).click();
  const after = await (await page.request.get("/api/state")).json();
  expect(after.stats.salvaged).toBe(before.stats.salvaged);
  expect(after.buildings).toHaveLength(1);
  await expect(page.getByRole("dialog", { name: "我的仓库" })).toBeVisible();
});

test("automation survives a return visit and reports real production", async ({
  page,
}) => {
  await register(page, "慢生活岛主", `auto-${randomUUID()}@example.test`);
  await build(page, "purifier", 0, 0);
  const open = () =>
    page
      .locator(".production-peek")
      .getByRole("button", { name: /净水器/ })
      .click();
  await open();
  await page.getByRole("switch", { name: "自动续产" }).click();
  await expect(page.getByText("自动续产已开启", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /查看全部 30 批/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "开始生产", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "关闭面板" }).click();
  await page.reload();
  const report = page.getByLabel("自动生产收成");
  await expect(report).toContainText("最近自动入库 1 批", { timeout: 22000 });
  await open();
  await expect(page.getByRole("switch", { name: "自动续产" })).toBeChecked();
  await page.screenshot({
    path: "docs/screenshots/automation.png",
    animations: "disabled",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "docs/screenshots/automation-mobile.png",
    animations: "disabled",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("switch", { name: "自动续产" }).click();
  await expect(page.getByText("手动安排，按你的节奏来")).toBeVisible();
  await page.getByRole("button", { name: "关闭面板" }).click();
  await page.getByRole("button", { name: "收起生产收成" }).click();
  await page.reload();
  await open();
  await expect(
    page.getByRole("switch", { name: "自动续产" }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: /查看全部 30 批/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭面板" }).click();
  await expect(report).toBeHidden();
});
