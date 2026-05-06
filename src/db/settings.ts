import { db } from './client';
import { appSettings } from './schema';
import { eq } from 'drizzle-orm';

export async function getSetting(key: string, defaultValue: string | number | boolean): Promise<string | number | boolean> {
  const [row] = await db
    .select({ value: appSettings.value, valueType: appSettings.valueType })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .limit(1);

  if (!row) return defaultValue;
  if (row.valueType === 'boolean') return row.value === 'true';
  if (row.valueType === 'integer') {
    const n = parseInt(row.value, 10);
    return isNaN(n) ? defaultValue : n;
  }
  return row.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db
    .update(appSettings)
    .set({ value, updatedAt: new Date() })
    .where(eq(appSettings.key, key));
}

export async function getAllSettings(): Promise<Array<{ key: string; value: string; valueType: string; label: string; hint: string | null; updatedAt: Date }>> {
  return db.select().from(appSettings).orderBy(appSettings.key) as any;
}
