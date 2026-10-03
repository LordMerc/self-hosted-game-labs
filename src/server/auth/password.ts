import argon2 from "argon2";
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";

const KEY = "admin_password_hash";

export function hasAdminPassword(db: Db): boolean {
  return db.select().from(schema.settings).where(eq(schema.settings.key, KEY)).get() !== undefined;
}

export async function setAdminPassword(db: Db, password: string): Promise<void> {
  const value = await argon2.hash(password, { type: argon2.argon2id });
  db.insert(schema.settings).values({ key: KEY, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } }).run();
}

export async function verifyAdminPassword(db: Db, password: string): Promise<boolean> {
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, KEY)).get();
  if (!row) return false;
  return argon2.verify(row.value, password);
}
