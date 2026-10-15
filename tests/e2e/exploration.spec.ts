import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { PlayerState } from "../../packages/shared/src/index";
import type { ExplorationState } from "../../packages/shared/src/exploration";

const password = "RealVoyage2026";

async function readState(page: Page): Promise<PlayerState> {
  const response = await page.request.get("/api/state");
  expect(response.ok()).toBe(true);
  return response.json();
}

async function readExploration(page: Page): Promise<ExplorationState> {
  const response = await page.request.get("/api/exploration");
  expect(response.ok()).toBe(true);
  return response.json();
}

async function perform(page: Page, path: string, click: () => Promise<void>) {
  const response = page.waitForResponse(
    (result) =>
      new URL(result.url()).pathname === path &&
      result.request().method() === "POST",
  );
  await click();
  const completed = await response;
  expect(completed.ok(), await completed.text()).toBe(true);
  return completed.json();
}

async function openExploration(page: Page) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "探索", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "航向未知的海" }),
  ).toBeVisible();
}

async function build(page: Page, kind: string, x: number, y: number) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "建造", exact: true })
    .click();
  await page.getByText("使用坐标选择建造位置").click();
  await page.getByLabel("建筑", { exact: true }).selectOption(kind);
  await perform(page, "/api/game/build", () =>
    page
      .getByRole("button", { name: `在 (${x}, ${y}) 建造`, exact: true })
      .click(),
  );
  await expect(page.getByRole("status")).toContainText("建好了");
  await page.getByRole("button", { name: "关闭面板" }).click();
}

test("a real voyage survives logout and a lost claim response without duplicate rewards", async ({
  page,
}) => {
  const email = `exploration-${randomUUID()}@example.test`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("漂流者昵称").fill("海图记录员");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "出发，去海上生活" }).click();
  await expect(
    page.getByRole("heading", { name: "海图记录员的漂浮小岛" }),
  ).toBeVisible();

  // Gather actual server-generated salvage through the normal player controls.
  // No seed/admin writes, changed deadlines or fabricated successful API responses.
  const initial = await readState(page);
  for (let i = 0; i < initial.salvage.length; i++) {
    await perform(page, "/api/game/salvage", () =>
      page.getByRole("button", { name: /快捷打捞/ }).click(),
    );
    await expect(page.getByRole("status")).toContainText("打捞成功");
    if (i + 1 < initial.salvage.length)
      await expect(
        page.getByRole("button", { name: /快捷打捞/ }),
      ).toBeEnabled();
  }
  await build(page, "purifier", 0, 0);
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
  await build(page, "dock", 1, 1);

  await openExploration(page);
  const available = await readExploration(page);
  expect(available.hasDock).toBe(true);
  const skiff = available.shipyard.find((ship) => ship.kind === "skiff");
  const bay = available.regions.find((region) => region.id === "bay");
  if (!skiff || !bay)
    throw new Error("Starter ship and bay must be configured");
  expect(bay.unlocked).toBe(true);
  await page.getByRole("button", { name: /^我的船队/ }).click();
  const beforeBuild = await readState(page);
  await page
    .getByTestId("shipyard-skiff")
    .getByRole("button", { name: `建造${skiff.name}`, exact: true })
    .click();
  await perform(page, "/api/exploration/build", () =>
    page
      .getByRole("alertdialog", { name: "确认建造船只" })
      .getByRole("button", { name: "确认建造", exact: true })
      .click(),
  );
  const afterBuild = await readState(page);
  expect(afterBuild.coins).toBe(beforeBuild.coins - skiff.coins);
  for (const [resource, quantity] of Object.entries(skiff.cost)) {
    const key = resource as keyof PlayerState["inventory"];
    expect(afterBuild.inventory[key] ?? 0).toBe(
      (beforeBuild.inventory[key] ?? 0) - quantity,
    );
  }
  const fleet = await readExploration(page);
  expect(fleet.ships).toHaveLength(1);
  const ship = fleet.ships[0];
  await expect(page.getByTestId(`ship-${ship.id}`)).toBeVisible();
  await expect(
    page.getByRole("alertdialog", { name: "确认建造船只" }),
  ).toBeHidden();
  await page.getByTestId(`ship-${ship.id}`).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "docs/screenshots/exploration-fleet.png",
    fullPage: true,
    animations: "disabled",
  });

  await page.getByRole("button", { name: "海域航图", exact: true }).click();
  await page
    .getByRole("button", { name: `探索${bay.name}`, exact: true })
    .click();
  await page.getByLabel("派遣船只", { exact: true }).selectOption(ship.id);
  const chart = page.getByLabel("可交互探索海图", { exact: true });
  await chart.scrollIntoViewIfNeeded();
  await expect(chart).toBeVisible();
  await page.screenshot({
    path: "docs/screenshots/exploration-map.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await chart.scrollIntoViewIfNeeded();
  await expect(chart).toBeVisible();
  await expect(chart).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "docs/screenshots/exploration-map-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "准备出航", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", { name: "确认探索出航" });
  await expect(confirmation).toBeVisible();
  const beforeDispatch = await readState(page);
  await perform(page, "/api/exploration/dispatch", () =>
    confirmation.getByRole("button", { name: "确认派遣", exact: true }).click(),
  );
  const departed = await readExploration(page);
  expect(departed.voyages).toHaveLength(1);
  const voyage = departed.voyages[0];
  expect(voyage.phase).toBe("sailing");
  expect(voyage.shipId).toBe(ship.id);
  expect(voyage.regionId).toBe("bay");
  expect(departed.ships[0].durability).toBe(ship.durability - bay.baseWear);
  const afterDispatch = await readState(page);
  expect(afterDispatch.coins).toBe(beforeDispatch.coins - bay.coins);
  for (const [resource, quantity] of Object.entries(bay.supplies)) {
    const key = resource as keyof PlayerState["inventory"];
    expect(afterDispatch.inventory[key] ?? 0).toBe(
      (beforeDispatch.inventory[key] ?? 0) - quantity,
    );
  }

  await page.getByRole("button", { name: "关闭面板" }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "暂别小岛" }).click();
  await expect(page.getByRole("button", { name: "回到我的岛" })).toBeVisible();
  expect((await page.request.get("/api/exploration")).status()).toBe(401);
  // The real server-issued travel deadline elapses while this session is revoked.
  await page.waitForTimeout(
    Math.max(0, Date.parse(voyage.arrivesAt) - Date.now() + 500),
  );
  await page.getByRole("button", { name: "回到我的岛" }).click();
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "欢迎回到你的岛" }).click();
  await expect(
    page.getByRole("heading", { name: "海图记录员的漂浮小岛" }),
  ).toBeVisible();
  await openExploration(page);
  const resumed = await readExploration(page);
  const pending = resumed.voyages.find((current) => current.id === voyage.id);
  expect(pending?.phase).toBe("choice");
  const safeReturn = pending?.event?.choices.find(
    (choice) => choice.id === "return",
  );
  if (!safeReturn) throw new Error("Every encounter must offer safe return");
  const voyageCard = page.getByTestId(`voyage-${voyage.id}`);
  await expect(
    voyageCard.getByRole("button", { name: safeReturn.label }),
  ).toBeVisible();

  await page.screenshot({
    path: "docs/screenshots/exploration.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("dialog", { name: "航向未知的海" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "docs/screenshots/exploration-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await voyageCard.getByRole("button", { name: safeReturn.label }).click();
  const choiceConfirmation = page.getByRole("alertdialog", {
    name: "确认航海选择",
  });
  await perform(page, "/api/exploration/choose", () =>
    choiceConfirmation
      .getByRole("button", { name: "确认选择", exact: true })
      .click(),
  );
  const returning = (await readExploration(page)).voyages.find(
    (current) => current.id === voyage.id,
  );
  expect(returning?.choiceId).toBe("return");
  expect(returning?.phase).toBe("returning");
  const claim = voyageCard.getByRole("button", {
    name: "领取返航收获",
    exact: true,
  });
  await expect(claim).toBeEnabled({ timeout: 20000 });
  const ready = (await readExploration(page)).voyages.find(
    (current) => current.id === voyage.id,
  );
  expect(ready?.phase).toBe("ready");
  const reward = ready?.result;
  if (!reward)
    throw new Error("Returned voyage must expose its persisted result");
  const beforeClaim = await readState(page);

  // Commit the real player request, then drop its response. The app must retry
  // with the same key; forwarding the request never fabricates a game result.
  const claimKeys: string[] = [];
  await page.route("**/api/exploration/claim", async (route) => {
    claimKeys.push(route.request().headers()["idempotency-key"]);
    if (claimKeys.length === 1) {
      const committed = await route.fetch();
      if (!committed.ok()) {
        await route.fulfill({ response: committed });
        return;
      }
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await perform(page, "/api/exploration/claim", () => claim.click());
  expect(claimKeys).toHaveLength(2);
  expect(claimKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  expect(claimKeys[1]).toBe(claimKeys[0]);
  await page.unroute("**/api/exploration/claim");
  const afterClaim = await readState(page);
  expect(afterClaim.coins).toBe(beforeClaim.coins + reward.coins);
  expect(afterClaim.xp).toBe(beforeClaim.xp + reward.xp);
  for (const resource of new Set([
    ...Object.keys(beforeClaim.inventory),
    ...Object.keys(reward.resources),
    ...Object.keys(afterClaim.inventory),
  ])) {
    const key = resource as keyof PlayerState["inventory"];
    expect(afterClaim.inventory[key] ?? 0).toBe(
      (beforeClaim.inventory[key] ?? 0) + (reward.resources[key] ?? 0),
    );
  }
  const completed = await readExploration(page);
  expect(completed.voyages).toHaveLength(0);
  expect(completed.progress.claimed).toBe(1);
  expect(completed.progress.regions.bay).toBe(1);
  expect(completed.ships[0].activeVoyageId).toBeNull();
  expect(completed.ships[0].durability).toBe(
    ship.durability - bay.baseWear - reward.damage,
  );
  expect(
    completed.history.find((current) => current.id === voyage.id)?.phase,
  ).toBe("claimed");
  await page.getByRole("button", { name: "航海日志", exact: true }).click();
  await expect(page.getByTestId(`voyage-${voyage.id}`)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "领取返航收获", exact: true }),
  ).toBeHidden();

  await page.reload();
  await openExploration(page);
  await page.getByRole("button", { name: "航海日志", exact: true }).click();
  await expect(page.getByTestId(`voyage-${voyage.id}`)).toBeVisible();
  const persistedPlayer = await readState(page);
  const persistedExploration = await readExploration(page);
  expect(persistedPlayer.inventory).toEqual(afterClaim.inventory);
  expect(persistedPlayer.coins).toBe(afterClaim.coins);
  expect(persistedPlayer.xp).toBe(afterClaim.xp);
  expect(persistedExploration.history).toEqual(completed.history);
  expect(persistedExploration.ships).toEqual(completed.ships);
  expect(errors).toEqual([]);
});
