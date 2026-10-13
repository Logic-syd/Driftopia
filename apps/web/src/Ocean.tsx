import { useEffect, useLayoutEffect, useRef } from "react";
import Phaser from "phaser";
import { useGame, type Placement } from "./store";
import {
  BUILDINGS,
  ECONOMY,
  RESOURCES,
  type Resource,
  type BuildingKind,
} from "../../../packages/game-config/src/index";
import { reducedMotion } from "./feedback";
import type { PlayerState } from "../../../packages/shared/src/index";
const TILE_W = 104,
  TILE_H = 52;
type SceneData = {
  blocked: boolean;
  state: PlayerState | null;
  placement: Placement;
  onTile: (x: number, y: number) => void;
  onBuilding: (id: string) => void;
  onSalvage: (id: string) => Promise<boolean>;
};
const points = (values: number[][]) =>
  values.map(([x, y]) => new Phaser.Geom.Point(x, y));
export class OceanScene extends Phaser.Scene {
  dataRef!: { current: SceneData };
  world!: Phaser.GameObjects.Container;
  sea!: Phaser.GameObjects.Graphics;
  foam!: Phaser.GameObjects.Graphics;
  worldObjects: Phaser.GameObjects.GameObject[] = [];
  lastState: PlayerState | null = null;
  lastPlacement: Placement = null;
  floating: {
    object: Phaser.GameObjects.Container;
    y: number;
    phase: number;
  }[] = [];
  zoom = 1;
  targetZoom = 1;
  displayPanX = 0;
  displayPanY = 0;
  ghost: Phaser.GameObjects.Container | null = null;
  productionBubbles: {
    object: Phaser.GameObjects.Graphics;
    y: number;
    phase: number;
  }[] = [];
  salvageOrigin: { x: number; y: number } | null = null;
  panX = 0;
  panY = 0;
  dragStart: { x: number; y: number; px: number; py: number } | null = null;
  moved = false;
  lastPinch = 0;
  reduced = reducedMotion();
  constructor(dataRef: { current: SceneData }) {
    super("ocean");
    this.dataRef = dataRef;
  }
  create() {
    this.sea = this.add.graphics();
    this.foam = this.add.graphics();
    this.world = this.add.container(0, 0);
    this.input.addPointer(1);
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      this.dragStart = { x: p.x, y: p.y, px: this.panX, py: this.panY };
      this.moved = false;
    });
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (this.dataRef.current.placement) this.previewPlacement(p);
      const p1 = this.input.pointer1,
        p2 = this.input.pointer2;
      if (p1.isDown && p2.isDown) {
        const distance = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
        if (this.lastPinch)
          this.setZoom((this.targetZoom * distance) / this.lastPinch);
        this.lastPinch = distance;
        this.moved = true;
        return;
      }
      if (
        p.isDown &&
        this.dragStart &&
        Phaser.Math.Distance.Between(
          p.x,
          p.y,
          this.dragStart.x,
          this.dragStart.y,
        ) > 8
      ) {
        this.moved = true;
        this.panX = this.dragStart.px + p.x - this.dragStart.x;
        this.panY = this.dragStart.py + p.y - this.dragStart.y;
        this.positionWorld();
      }
    });
    this.input.on("pointerup", () => {
      this.dragStart = null;
      this.lastPinch = 0;
    });
    this.input.on(
      "wheel",
      (_p: unknown, _o: unknown, _dx: number, dy: number) =>
        this.setZoom(this.targetZoom * (dy > 0 ? 0.94 : 1.06)),
    );
    this.scale.on("resize", () => this.redraw());
    this.redraw();
    this.game.events.on("zoom", (delta: number) =>
      this.setZoom(this.targetZoom + delta),
    );
    this.game.events.on("reset", () => {
      this.targetZoom = 1;
      this.panX = 0;
      this.panY = 0;
      this.positionWorld();
    });
  }
  setZoom(value: number) {
    this.targetZoom = Phaser.Math.Clamp(value, 0.5, 1.8);
    if (this.reduced) this.zoom = this.targetZoom;
    this.positionWorld();
  }
  positionWorld() {
    const w = this.scale.width,
      h = this.scale.height;
    const base = w < 700 ? 0.76 : 1.17;
    this.world
      .setPosition(
        w * (w < 1000 ? 0.5 : 0.53) + this.displayPanX,
        h * 0.49 + this.displayPanY,
      )
      .setScale(base * this.zoom);
  }
  drawSea() {
    const w = this.scale.width,
      h = this.scale.height;
    this.sea.clear();
    const night =
      Math.floor((Date.now() + useGame.getState().offset) / 240000) % 2 === 1;
    for (let i = 0; i < 40; i++) {
      const t = i / 40;
      const color = Phaser.Display.Color.Interpolate.ColorWithColor(
        night
          ? new Phaser.Display.Color(58, 111, 144)
          : new Phaser.Display.Color(98, 185, 192),
        night
          ? new Phaser.Display.Color(36, 93, 122)
          : new Phaser.Display.Color(41, 145, 164),
        40,
        i,
      );
      this.sea.fillStyle(
        Phaser.Display.Color.GetColor(color.r, color.g, color.b),
      );
      this.sea.fillRect(0, t * h, w, h / 40 + 1);
    }
    if (night) {
      this.sea.fillStyle(0xe9efcd, 0.8);
      this.sea.fillCircle(w * 0.78, h * 0.18, 16);
      this.sea.fillStyle(0x50788d);
      this.sea.fillCircle(w * 0.785, h * 0.174, 14);
      this.sea.fillStyle(0xe9efcd, 0.45);
      for (let i = 0; i < 22; i++)
        this.sea.fillCircle(
          (i * 197 + 80) % w,
          70 + ((i * 31) % (h * 0.2)),
          i % 3 === 0 ? 1.5 : 0.8,
        );
    }
    this.sea.fillStyle(0xb2e4d7, 0.15);
    this.sea.fillEllipse(w * 0.23, h * 0.43, w * 0.82, h * 0.8);
    this.sea.fillStyle(0xa5dac8, 0.1);
    this.sea.fillEllipse(w * 0.9, h * 0.75, w * 0.8, h * 0.7);
    // Faraway islands and a quiet sailboat, all original procedural artwork.
    this.sea.fillStyle(0x377f80, 0.3);
    this.sea.fillEllipse(w * 0.87, h * 0.25, 135, 30);
    this.sea.fillStyle(0xadd2b0, 0.5);
    this.sea.fillEllipse(w * 0.87, h * 0.24, 102, 23);
    this.sea.fillStyle(0x508f7b, 0.7);
    this.sea.fillTriangle(
      w * 0.87 - 30,
      h * 0.24,
      w * 0.87,
      h * 0.24 - 33,
      w * 0.87 + 30,
      h * 0.24,
    );
    const sx = w * 0.14,
      sy = h * 0.57;
    this.sea.fillStyle(0x246f7a, 0.25);
    this.sea.fillEllipse(sx, sy + 15, 66, 14);
    this.sea.fillStyle(0xe9bd81);
    this.sea.fillTriangle(sx - 25, sy, sx + 26, sy, sx + 13, sy + 10);
    this.sea.lineStyle(2, 0x876e53);
    this.sea.lineBetween(sx, sy, sx, sy - 56);
    this.sea.fillStyle(0xf7edce);
    this.sea.fillTriangle(sx - 3, sy - 52, sx - 3, sy - 5, sx - 32, sy - 7);
    this.sea.fillStyle(0xd3e6d4);
    this.sea.fillTriangle(sx + 3, sy - 46, sx + 3, sy - 5, sx + 24, sy - 6);
  }
  iso(x: number, y: number) {
    return { x: ((x - y) * TILE_W) / 2, y: ((x + y) * TILE_H) / 2 };
  }
  canPlace(x: number, y: number) {
    const { state, placement } = this.dataRef.current;
    if (!state || !placement || Math.abs(x) > 8 || Math.abs(y) > 8)
      return false;
    const exists = state.tiles.some((t) => t.x === x && t.y === y);
    const occupied = state.buildings.some(
      (b) => b.x === x && b.y === y && b.id !== placement.movingId,
    );
    const validTile =
      placement.kind === "floor"
        ? !exists &&
          state.tiles.some((t) => Math.abs(t.x - x) + Math.abs(t.y - y) === 1)
        : exists && !occupied;
    if (!validTile) return false;
    if (placement.movingId) return true;
    const cost =
      placement.kind === "floor"
        ? ECONOMY.floorCost
        : BUILDINGS[placement.kind].cost;
    return (
      Object.entries(cost).every(
        ([r, n]) => (state.inventory[r as Resource] ?? 0) >= n,
      ) &&
      (placement.kind === "floor" ||
        state.coins >= BUILDINGS[placement.kind].coins)
    );
  }
  previewPlacement(pointer: Phaser.Input.Pointer) {
    this.ghost?.destroy();
    this.ghost = null;
    const { placement, blocked } = this.dataRef.current;
    if (!placement || blocked || this.moved) return;
    const localX = (pointer.x - this.world.x) / this.world.scaleX;
    const localY = (pointer.y - this.world.y) / this.world.scaleY;
    const x = Math.round(localX / TILE_W + localY / TILE_H);
    const y = Math.round(localY / TILE_H - localX / TILE_W);
    const position = this.iso(x, y),
      valid = this.canPlace(x, y);
    const ghost = this.add.container(position.x, position.y);
    const g = this.add.graphics();
    g.fillStyle(valid ? 0xc9f4bd : 0xf5a29b, 0.65);
    g.fillPoints(
      points([
        [0, -26],
        [51, 0],
        [0, 26],
        [-51, 0],
      ]),
      true,
    );
    g.lineStyle(2, valid ? 0xf4ffe9 : 0xb85149, 0.9);
    g.strokePoints(
      points([
        [0, -26],
        [51, 0],
        [0, 26],
        [-51, 0],
      ]),
      true,
    );
    ghost.add(g);
    ghost.add(
      this.add
        .text(
          0,
          -34,
          placement.kind === "floor" ? "＋" : BUILDINGS[placement.kind].icon,
          { fontSize: "36px" },
        )
        .setOrigin(0.5)
        .setAlpha(0.72),
    );
    ghost.add(
      this.add
        .text(0, 38, valid ? "✓ 可以放置" : "× 位置或材料不足", {
          fontSize: "11px",
          color: valid ? "#244d35" : "#852f29",
          backgroundColor: valid ? "#e5f9d5" : "#ffe7df",
          padding: { x: 5, y: 4 },
        })
        .setOrigin(0.5),
    );
    this.world.add(ghost);
    this.ghost = ghost;
  }
  resourceFeedback(before: PlayerState | null, after: PlayerState | null) {
    if (!before || !after || before.id !== after.id) return;
    const gains = Object.entries(after.inventory).filter(
      ([id, n]) => n > (before.inventory[id as Resource] ?? 0),
    );
    gains.slice(0, 4).forEach(([id, n], index) => {
      const resource = RESOURCES[id as Resource];
      const origin = this.salvageOrigin ?? {
        x: this.world.x,
        y: this.world.y - 70,
      };
      const target = document
        .querySelector<HTMLElement>(
          `.resource-bar button[title="${resource.name}"]`,
        )
        ?.getBoundingClientRect();
      const label = this.add
        .text(
          origin.x + index * 30,
          origin.y,
          `${resource.icon} +${n - (before.inventory[id as Resource] ?? 0)}`,
          {
            fontFamily: "sans-serif",
            fontSize: "19px",
            color: "#fffde8",
            backgroundColor: "#356e62",
            padding: { x: 8, y: 5 },
          },
        )
        .setOrigin(0.5)
        .setDepth(100);
      if (this.reduced) {
        this.time.delayedCall(500, () => label.destroy());
        return;
      }
      this.tweens.add({
        targets: label,
        x: target ? target.x + target.width / 2 : this.scale.width / 2,
        y: target ? target.y + target.height / 2 : 90,
        alpha: 0.15,
        scale: 0.7,
        delay: index * 70,
        duration: 850,
        ease: "Cubic.easeInOut",
        onComplete: () => label.destroy(),
      });
    });
    if (gains.length) this.salvageOrigin = null;
  }
  redraw() {
    this.resourceFeedback(this.lastState, this.dataRef.current.state);
    this.drawSea();
    this.world.removeAll(true);
    this.floating = [];
    this.productionBubbles = [];
    this.ghost = null;
    this.positionWorld();
    const { state, placement } = this.dataRef.current;
    this.lastState = state;
    this.lastPlacement = placement;
    this.game.canvas.dataset.mode = placement?.kind ?? "idle";
    const tiles =
      state?.tiles ??
      Array.from({ length: 9 }, (_, i) => ({
        x: (i % 3) - 1,
        y: Math.floor(i / 3) - 1,
      }));
    const shadow = this.add.graphics();
    shadow.fillStyle(0x175668, 0.25);
    shadow.fillEllipse(0, 44, 360, 178);
    shadow.lineStyle(3, 0xa6dfd6, 0.4);
    shadow.strokeEllipse(0, 35, 395, 192);
    this.world.add(shadow);
    const targets = [...tiles];
    if (placement?.kind === "floor")
      for (const t of tiles)
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const x = t.x + dx,
            y = t.y + dy;
          if (
            !targets.some((p) => p.x === x && p.y === y) &&
            Math.abs(x) <= 8 &&
            Math.abs(y) <= 8
          )
            targets.push({ x, y });
        }
    for (const t of targets.sort((a, b) => a.x + a.y - (b.x + b.y))) {
      const pos = this.iso(t.x, t.y);
      const exists = tiles.some((p) => p.x === t.x && p.y === t.y);
      const valid = this.canPlace(t.x, t.y);
      const g = this.add.graphics({ x: pos.x, y: pos.y });
      if (exists) {
        g.fillStyle(0x8c5e3c);
        g.fillPoints(
          points([
            [-51, 0],
            [0, 26],
            [0, 39],
            [-51, 13],
          ]),
          true,
        );
        g.fillStyle(0x785037);
        g.fillPoints(
          points([
            [0, 26],
            [51, 0],
            [51, 13],
            [0, 39],
          ]),
          true,
        );
        g.fillStyle((t.x + t.y) % 2 === 0 ? 0xdab078 : 0xe6be85);
        g.fillPoints(
          points([
            [0, -26],
            [51, 0],
            [0, 26],
            [-51, 0],
          ]),
          true,
        );
        g.lineStyle(1.5, 0x9f774e, 0.8);
        g.strokePoints(
          points([
            [0, -26],
            [51, 0],
            [0, 26],
            [-51, 0],
          ]),
          true,
        );
        for (let k = -2; k <= 2; k++) {
          const a = k * 8;
          g.lineStyle(1, 0xb78955, 0.65);
          g.lineBetween(
            -44 + Math.abs(k) * 7,
            a,
            0 + a * 2,
            22 - Math.abs(k) * 5,
          );
        }
        g.fillStyle(0x775a43, 0.6);
        g.fillCircle(-37, 0, 1.8);
        g.fillCircle(37, 0, 1.8);
      }
      if (valid) {
        g.fillStyle(0xc9f4bd, 0.55);
        g.fillPoints(
          points([
            [0, -24],
            [49, 0],
            [0, 24],
            [-49, 0],
          ]),
          true,
        );
        g.lineStyle(2, 0xf7ffe4, 0.8);
        g.strokePoints(
          points([
            [0, -24],
            [49, 0],
            [0, 24],
            [-49, 0],
          ]),
          true,
        );
        const label = this.add
          .text(pos.x, pos.y - 9, "+", {
            fontFamily: "sans-serif",
            fontSize: "22px",
            color: "#efffea",
          })
          .setOrigin(0.5);
        this.world.add(label);
      }
      this.world.add(g);
      const zone = this.add.zone(pos.x, pos.y, 100, 50).setInteractive(
        new Phaser.Geom.Polygon(
          points([
            [0, -25],
            [50, 0],
            [0, 25],
            [-50, 0],
          ]),
        ),
        (shape: Phaser.Geom.Polygon, x: number, y: number) =>
          Phaser.Geom.Polygon.Contains(shape, x - 50, y - 25),
      );
      zone.on("pointerover", () => {
        if (valid) g.setAlpha(0.7);
      });
      zone.on("pointerout", () => g.setAlpha(1));
      zone.on("pointerup", (pointer: Phaser.Input.Pointer) => {
        if (!(pointer.event.target instanceof HTMLCanvasElement)) return;
        if (!this.moved && valid) this.dataRef.current.onTile(t.x, t.y);
        else if (!this.moved && this.dataRef.current.placement)
          useGame
            .getState()
            .notify("这格无法放置，请检查空位、相邻地板和建造材料", "error");
      });
      this.world.add(zone);
    }
    // Small mooring posts along the edge.
    for (const [x, y] of [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ]) {
      const pos = this.iso(x, y);
      const g = this.add.graphics();
      g.fillStyle(0x946540);
      g.fillRoundedRect(pos.x - 48, pos.y - 14, 7, 24, 2);
      g.fillStyle(0xf2dab1);
      g.fillEllipse(pos.x - 44.5, pos.y - 14, 8, 5);
      g.lineStyle(2, 0xdcc695);
      g.lineBetween(pos.x - 48, pos.y - 7, pos.x - 41, pos.y - 5);
      this.world.add(g);
    }
    const buildings = state?.buildings ?? [];
    for (const b of [...buildings].sort((a, b) => a.x + a.y - (b.x + b.y))) {
      const pos = this.iso(b.x, b.y);
      const container = this.drawBuilding(b.kind, pos.x, pos.y);
      const zone = this.add
        .zone(0, -26, 85, 80)
        .setInteractive({ useHandCursor: true });
      zone.on("pointerup", (pointer: Phaser.Input.Pointer) => {
        if (!(pointer.event.target instanceof HTMLCanvasElement)) return;
        if (!this.moved && !this.dataRef.current.placement)
          this.dataRef.current.onBuilding(b.id);
      });
      container.add(zone);
      const ready = b.jobs.some(
        (j) =>
          Date.parse(j.finishesAt) <= Date.now() + useGame.getState().offset,
      );
      if (b.jobs.length) {
        const badge = this.add
          .text(0, -80, ready ? "✓ 可收获" : "◷ 生产中", {
            fontFamily: "sans-serif",
            fontSize: "12px",
            color: ready ? "#275349" : "#51645a",
            backgroundColor: ready ? "#dcf4bf" : "#fff4d8",
            padding: { x: 9, y: 5 },
          })
          .setOrigin(0.5);
        container.add(badge);
        for (let i = 0; i < 3; i++) {
          const bubble = this.add.graphics({ x: -15 + i * 15, y: -58 - i * 4 });
          bubble.fillStyle(ready ? 0xe8f9b1 : 0xbcece1, 0.75);
          bubble.fillCircle(0, 0, 2.5);
          container.add(bubble);
          this.productionBubbles.push({
            object: bubble,
            y: bubble.y,
            phase: i * 2 + b.x,
          });
        }
      }
    }
    if (!buildings.some((b) => b.x === 0 && b.y === 0)) {
      this.drawCamper(0, 0);
    }
    const flag = this.add.graphics();
    flag.lineStyle(3, 0x725d42);
    flag.lineBetween(0, -72, 0, -148);
    flag.fillStyle(0xf4e9ce);
    flag.fillTriangle(2, -147, 31, -140, 2, -127);
    flag.fillStyle(0x54836a);
    flag.fillCircle(12, -139, 3);
    this.world.add(flag);
    for (const s of state?.salvage ?? []) {
      const w = this.scale.width,
        h = this.scale.height;
      const c = this.add.container((w * s.x) / 100, (h * s.y) / 100);
      const g = this.add.graphics();
      g.fillStyle(0x226b7b, 0.22);
      g.fillEllipse(0, 12, 54, 17);
      g.lineStyle(1, 0xc7f5df, 0.7);
      g.strokeEllipse(0, 10, 65, 22);
      if (s.kind === "wood") {
        g.fillStyle(0x9c704b);
        g.fillRoundedRect(-22, -8, 44, 15, 4);
        g.fillStyle(0xd0a371);
        g.fillEllipse(-20, -1, 9, 15);
        g.lineStyle(2, 0xb88a5d);
        g.lineBetween(-13, -4, 16, -4);
        g.lineBetween(-8, 2, 20, 2);
      } else if (s.kind === "plastic") {
        g.fillStyle(0xb9e3ce);
        g.fillRoundedRect(-10, -18, 20, 34, 6);
        g.fillStyle(0xefefce);
        g.fillRect(-9, -5, 18, 12);
        g.fillStyle(0x4b9186);
        g.fillRoundedRect(-6, -23, 12, 7, 2);
      } else if (s.kind === "rare") {
        g.fillStyle(0xaa7044);
        g.fillRoundedRect(-20, -14, 40, 30, 5);
        g.lineStyle(4, 0xe7c36d);
        g.strokeRoundedRect(-19, -13, 38, 28, 4);
        g.lineBetween(-19, 0, 19, 0);
        g.fillStyle(0xf9e5a8);
        g.fillRect(-4, -4, 8, 10);
        const glint = this.add.graphics({ x: 25, y: -19 });
        glint.fillStyle(0xffefb4);
        glint.fillPoints(
          points([
            [0, -10],
            [3, -3],
            [10, 0],
            [3, 3],
            [0, 10],
            [-3, 3],
            [-10, 0],
            [-3, -3],
          ]),
          true,
        );
        c.add(glint);
      } else {
        g.fillStyle(0x879fa5);
        g.fillPoints(
          points([
            [-18, -7],
            [2, -17],
            [20, -3],
            [11, 15],
            [-15, 10],
          ]),
          true,
        );
        g.lineStyle(3, 0xb9c8c3);
        g.lineBetween(-10, -5, 9, 6);
      }
      c.add(g);
      const hit = this.add
        .zone(0, 0, 74, 74)
        .setInteractive({ useHandCursor: true });
      hit.on("pointerover", () => c.setScale(1.12));
      hit.on("pointerout", () => c.setScale(1));
      hit.on("pointerup", (pointer: Phaser.Input.Pointer) => {
        if (!(pointer.event.target instanceof HTMLCanvasElement)) return;
        if (!this.moved) {
          if (useGame.getState().busy) return;
          this.salvageOrigin = { x: c.x, y: c.y };
          void this.dataRef.current.onSalvage(s.id).then((ok) => {
            if (!ok) {
              this.salvageOrigin = null;
              return;
            }
            // Only animate a confirmed catch; failed actions leave the item visible.
            const ripple = this.add.graphics({
              x: (this.scale.width * s.x) / 100,
              y: (this.scale.height * s.y) / 100,
            });
            ripple.lineStyle(2, 0xe9f8ce, 0.8);
            ripple.strokeEllipse(0, 0, 42, 20);
            if (this.reduced) {
              ripple.destroy();
              return;
            }
            this.tweens.add({
              targets: ripple,
              scale: 2,
              alpha: 0,
              duration: 450,
              onComplete: () => ripple.destroy(),
            });
          });
        }
      });
      c.add(hit);
      this.floating.push({ object: c, y: c.y, phase: s.x });
    }
    // Clean floating items from previous state snapshots.
    for (const obj of this.worldObjects) obj.destroy();
    this.worldObjects = this.floating.map((f) => f.object);
  }
  drawCamper(x: number, y: number) {
    const c = this.add.container(x, y);
    const g = this.add.graphics();
    g.fillStyle(0x8e754f, 0.2);
    g.fillEllipse(0, 6, 34, 16);
    g.fillStyle(0x426675);
    g.fillRoundedRect(-9, -7, 7, 18, 3);
    g.fillRoundedRect(3, -7, 7, 18, 3);
    g.fillStyle(0xf1dfb2);
    g.fillRoundedRect(-13, -30, 26, 26, 8);
    g.fillStyle(0xd6a675);
    g.fillCircle(0, -39, 11);
    g.fillStyle(0xe9c98e);
    g.fillEllipse(0, -45, 35, 12);
    g.fillStyle(0xc6a369);
    g.fillRoundedRect(-10, -57, 20, 14, 5);
    g.fillStyle(0x596c51);
    g.fillRect(-10, -47, 20, 4);
    g.fillStyle(0x4d6154);
    g.fillRoundedRect(-13, -26, 7, 19, 3);
    c.add(g);
    this.world.add(c);
    return c;
  }
  drawBuilding(kind: BuildingKind, x: number, y: number) {
    const c = this.add.container(x, y),
      g = this.add.graphics();
    g.fillStyle(0x765637, 0.19);
    g.fillEllipse(0, 8, 74, 29);
    if (kind === "purifier") {
      g.fillStyle(0x728c7a);
      g.fillRoundedRect(-25, -38, 50, 43, 5);
      g.fillStyle(0x9fd6c5);
      g.fillEllipse(0, -38, 50, 20);
      g.fillStyle(0xd8e9c5);
      g.fillEllipse(0, -41, 42, 14);
      g.fillStyle(0x64b5c3);
      g.fillRoundedRect(-16, -26, 32, 25, 5);
      g.fillStyle(0xc4efe1, 0.7);
      g.fillRect(-11, -24, 6, 16);
      g.lineStyle(5, 0xdbc990);
      g.lineBetween(25, -22, 34, -22);
      g.lineBetween(34, -22, 34, -9);
      g.fillStyle(0x94ddd7);
      g.fillCircle(34, -4, 3);
      g.lineStyle(4, 0x9b7950);
      g.lineBetween(-22, -45, -22, -70);
      g.lineBetween(22, -45, 22, -70);
      g.fillStyle(0xf0deb0);
      g.fillPoints(
        points([
          [-32, -66],
          [0, -81],
          [32, -66],
          [0, -52],
        ]),
        true,
      );
      g.lineStyle(2, 0xcbb581);
      g.lineBetween(-32, -66, 0, -52);
    } else if (kind === "fishnet") {
      g.lineStyle(5, 0x866848);
      g.lineBetween(-27, 4, -27, -53);
      g.lineBetween(29, 7, 29, -46);
      g.lineStyle(2, 0xe2dab6);
      for (let i = 0; i < 6; i++) {
        g.lineBetween(-27 + i * 11, -43, -18 + i * 8, 3);
        g.lineBetween(-27, -43 + i * 8, 29, -37 + i * 8);
      }
      g.fillStyle(0x91d3cc, 0.8);
      g.fillEllipse(0, -14, 25, 9);
      g.fillTriangle(-9, -14, -18, -22, -18, -7);
      g.fillStyle(0xf4ba7b);
      g.fillEllipse(9, -3, 18, 7);
    } else if (kind === "garden") {
      g.fillStyle(0x996741);
      g.fillRoundedRect(-35, -14, 70, 29, 3);
      g.fillStyle(0x695a40);
      g.fillEllipse(0, -13, 69, 23);
      for (let i = 0; i < 5; i++) {
        const px = (i - 2) * 12,
          py = -20 + (i % 2) * 6;
        g.lineStyle(3, 0x6e9b5a);
        g.lineBetween(px, 0, px, py - 15);
        g.fillStyle(i % 2 ? 0x83b968 : 0xa5cd79);
        g.fillEllipse(px - 5, py - 9, 15, 8);
        g.fillEllipse(px + 5, py - 16, 15, 8);
      }
    } else if (kind === "dock") {
      g.fillStyle(0xa16d44);
      g.fillPoints(
        points([
          [-36, -6],
          [10, -24],
          [40, -5],
          [-6, 16],
        ]),
        true,
      );
      g.lineStyle(4, 0x735d40);
      g.lineBetween(-22, -7, -22, -68);
      g.lineBetween(27, -8, 27, -51);
      g.fillStyle(0xf2e7c9);
      g.fillTriangle(-20, -67, -20, -17, 17, -23);
      g.fillStyle(0x528e80);
      g.fillTriangle(-19, -67, -19, -49, -6, -52);
      g.lineStyle(2, 0xf0dca9);
      g.strokeCircle(28, -4, 9);
    } else {
      const color =
        kind === "warehouse"
          ? 0xcc995f
          : kind === "workshop"
            ? 0xdab982
            : kind === "recycler"
              ? 0x91a5a1
              : 0xe4cca0;
      g.fillStyle(color);
      g.fillPoints(
        points([
          [-30, -34],
          [0, -20],
          [0, 14],
          [-30, -1],
        ]),
        true,
      );
      g.fillStyle(0xb78d60);
      g.fillPoints(
        points([
          [0, -20],
          [32, -36],
          [32, -2],
          [0, 14],
        ]),
        true,
      );
      g.fillStyle(
        kind === "cabin" ? 0xb57861 : kind === "recycler" ? 0x718b88 : 0x729880,
      );
      g.fillPoints(
        points([
          [-40, -34],
          [-5, -69],
          [39, -47],
          [0, -13],
        ]),
        true,
      );
      g.fillStyle(kind === "cabin" ? 0xcc9876 : 0x9eba91);
      g.fillPoints(
        points([
          [-40, -34],
          [-5, -69],
          [-4, -43],
        ]),
        true,
      );
      g.lineStyle(2, 0xd8c69a);
      for (let i = 0; i < 4; i++)
        g.lineBetween(-29 + i * 12, -34 - i * 6, -2 + i * 11, -21 - i * 6);
      g.fillStyle(0x695b48);
      g.fillPoints(
        points([
          [10, -15],
          [23, -22],
          [23, 3],
          [10, 9],
        ]),
        true,
      );
      g.fillStyle(0xf8dc8f);
      g.fillRect(-22, -20, 11, 10);
      g.lineStyle(1, 0x6d654a);
      g.lineBetween(-17, -20, -17, -10);
    }
    c.add(g);
    this.world.add(c);
    return c;
  }
  update(time: number) {
    this.reduced = reducedMotion();
    const smooth = this.reduced ? 1 : 0.28;
    this.zoom = Phaser.Math.Linear(this.zoom, this.targetZoom, smooth);
    this.displayPanX = Phaser.Math.Linear(this.displayPanX, this.panX, smooth);
    this.displayPanY = Phaser.Math.Linear(this.displayPanY, this.panY, smooth);
    this.positionWorld();
    this.input.enabled = !this.dataRef.current.blocked;
    if (
      this.dataRef.current.state !== this.lastState ||
      this.dataRef.current.placement !== this.lastPlacement
    )
      this.redraw();
    const w = this.scale.width,
      h = this.scale.height;
    this.foam.clear();
    this.foam.lineStyle(1.4, 0xc8f1e5, 0.32);
    for (let i = 0; i < 65; i++) {
      const x =
          ((i * 173 + (!this.reduced ? time * 0.004 : 0)) % (w + 60)) - 30,
        y = (i * 137) % h;
      const wave = this.reduced ? 0 : Math.sin(time * 0.0007 + i) * 2;
      this.foam.beginPath();
      this.foam.moveTo(x, y);
      this.foam.lineTo(x + 9, y + wave);
      this.foam.lineTo(x + 19, y);
      this.foam.strokePath();
    }
    for (const bubble of this.productionBubbles) {
      bubble.object.y =
        bubble.y - (this.reduced ? 0 : (time * 0.013 + bubble.phase * 6) % 18);
      bubble.object.alpha = this.reduced
        ? 0.7
        : 0.4 + Math.sin(time * 0.002 + bubble.phase) * 0.3;
    }
    if (!this.reduced)
      for (const f of this.floating)
        f.object.y = f.y + Math.sin(time * 0.0015 + f.phase) * 4;
  }
}
export function Ocean() {
  const ref = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const state = useGame((s) => s.state),
    placement = useGame((s) => s.placement),
    panel = useGame((s) => s.panel),
    selected = useGame((s) => s.selected);
  const dataRef = useRef<SceneData>({
    blocked: true,
    state,
    placement,
    onTile: () => {},
    onBuilding: () => {},
    onSalvage: async () => false,
  });
  dataRef.current = {
    blocked: !state || !!panel || !!selected,
    state,
    placement,
    onBuilding: (id) => {
      if (!dataRef.current.blocked)
        useGame.setState({ selected: id, panel: null });
    },
    onSalvage: async (id) => {
      if (dataRef.current.blocked) return false;
      return useGame.getState().action("/game/salvage", { spawnId: id });
    },
    onTile: (x, y) => {
      if (dataRef.current.blocked) return;
      const p = useGame.getState().placement;
      if (!p) return;
      const path = p.movingId
        ? "move"
        : p.kind === "floor"
          ? "expand"
          : "build";
      void useGame
        .getState()
        .action(`/game/${path}`, {
          x,
          y,
          ...(p.movingId ? { buildingId: p.movingId } : { kind: p.kind }),
        })
        .then((ok) => {
          if (ok) useGame.setState({ placement: null });
        });
    },
  };
  useEffect(() => {
    if (!ref.current) return;
    const game = new Phaser.Game({
      type: Phaser.CANVAS,
      fps: { target: 30, forceSetTimeOut: true },
      parent: ref.current,
      backgroundColor: "#51a8b5",
      scale: {
        mode: Phaser.Scale.RESIZE,
        width: ref.current.clientWidth,
        height: ref.current.clientHeight,
      },
      render: { antialias: true },
      scene: new OceanScene(dataRef),
    });
    gameRef.current = game;
    return () => {
      game.destroy(true);
      gameRef.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    const game = gameRef.current;
    if (!game?.scene.isActive("ocean")) return;
    const scene = game.scene.getScene("ocean") as OceanScene;
    scene.input.enabled = !dataRef.current.blocked;
    if (scene.world && !scene.input.activePointer.isDown) scene.redraw();
  }, [state, placement, panel, selected]);
  return (
    <>
      <div
        className="ocean-canvas"
        ref={ref}
        aria-label="可拖动和缩放的等距海上木筏场景"
      />
      <div className="scene-controls">
        <button
          aria-label="放大场景"
          onClick={() => gameRef.current?.events.emit("zoom", 0.15)}
        >
          ＋
        </button>
        <button
          aria-label="缩小场景"
          onClick={() => gameRef.current?.events.emit("zoom", -0.15)}
        >
          −
        </button>
        <button
          aria-label="回到基地中心"
          onClick={() => gameRef.current?.events.emit("reset")}
        >
          ⌾
        </button>
      </div>
      {placement && (
        <div className="placement-hint">
          <span>
            ✦{" "}
            {placement.movingId
              ? "移动建筑"
              : placement.kind === "floor"
                ? "扩建木筏"
                : `建造${BUILDINGS[placement.kind].name}`}{" "}
            · 绿色可放置，红色需调整
          </span>
          <button onClick={() => useGame.setState({ placement: null })}>
            取消
          </button>
        </div>
      )}
    </>
  );
}
