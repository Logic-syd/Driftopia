import { z } from "zod";
import {
  BUILDING_IDS,
  RESOURCE_IDS,
  type Bundle,
  type BuildingKind,
  type Resource,
  type Recipe,
} from "../../game-config/src/index";
export const registerSchema = z.object({
  email: z
    .email()
    .max(200)
    .transform((v) => v.toLowerCase()),
  password: z.string().min(8).max(128),
  name: z.string().trim().min(2).max(20),
});
export const loginSchema = registerSchema.omit({ name: true });
export const pointSchema = z.object({
  x: z.number().int().min(-8).max(8),
  y: z.number().int().min(-8).max(8),
});
export const buildSchema = pointSchema.extend({ kind: z.enum(BUILDING_IDS) });
export const listingSchema = z.object({
  resource: z.enum(RESOURCE_IDS),
  quantity: z.number().int().min(1).max(100),
  unitPrice: z.number().int().min(1).max(10000),
});
export const buySchema = z.object({
  quantity: z.number().int().min(1).max(100),
});
export interface BuildingView {
  id: string;
  kind: BuildingKind;
  x: number;
  y: number;
  level: number;
  autoEnabled: boolean;
  autoStatus: "off" | "running" | "warehouse_full" | "materials";
  recipe?: Recipe;
  jobs: {
    id: string;
    startsAt: string;
    finishesAt: string;
    output: Bundle;
    status: string;
  }[];
}
export interface PlayerState {
  id: string;
  name: string;
  role: string;
  isGuest: boolean;
  guestExpiresAt: string | null;
  coins: number;
  xp: number;
  level: number;
  prosperity: number;
  capacity: number;
  inventory: Bundle;
  tiles: { x: number; y: number }[];
  buildings: BuildingView[];
  salvage: {
    id: string;
    kind: string;
    x: number;
    y: number;
    expiresAt: string;
  }[];
  orders: {
    id: string;
    name: string;
    description: string;
    input: Bundle;
    coins: number;
    xp: number;
    expiresAt: string;
  }[];
  stats: { salvaged: number; produced: number; orders: number };
  serverTime: string;
  offlineReady: number;
  productionReport: {
    id: string;
    batches: number;
    resources: Bundle;
    createdAt: string;
  } | null;
}
export interface ListingView {
  id: string;
  sellerId: string;
  resource: Resource;
  quantity: number;
  unitPrice: number;
  status: string;
  seller: { profile: { name: string } };
  createdAt: string;
}
export interface PublicPlayer {
  id: string;
  name: string;
  xp: number;
  prosperity: number;
  level: number;
  weeklyPoints: number;
}
