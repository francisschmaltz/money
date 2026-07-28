import { expect, test } from "@playwright/test";

test("mobile navigation exposes its state and dismisses predictably", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const trigger = page.locator("[data-mobile-menu]");
  const nav = page.locator("[data-mobile-nav]");
  const firstLink = nav.locator("a").first();

  await expect(nav).toBeHidden();
  await expect(nav).toHaveAttribute("inert", "");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(
    await firstLink.evaluate((link) => {
      link.focus();
      return document.activeElement === link;
    }),
  ).toBe(false);

  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(nav).toBeVisible();
  await expect(nav).not.toHaveAttribute("inert", "");
  await expect(trigger).toHaveAccessibleName("Close navigation");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");

  await firstLink.focus();
  await page.keyboard.press("Escape");
  await expect(nav).toBeHidden();
  await expect(trigger).toHaveAccessibleName("Open navigation");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.locator(".brand").focus();
  await page.locator("main").click({ position: { x: 8, y: 8 } });
  await expect(nav).toBeHidden();
  await expect(trigger).toHaveAccessibleName("Open navigation");
  await expect(trigger).toBeFocused();
});
