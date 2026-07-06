import { RecordId, type Surreal } from "surrealdb";
import { queryResults } from "./surreal.js";

export function sizeFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

export function batchesOf<T>(items: T[], size: number): T[][] {
  const batchSize = Math.max(1, Math.floor(size));
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

export interface UpsertBatchRow {
  id: RecordId;
  record: Record<string, unknown>;
}

export async function upsertBatches(
  db: Surreal,
  rows: UpsertBatchRow[],
  batchSize: number,
): Promise<void> {
  if (batchSize <= 1) {
    for (const row of rows) {
      await db.upsert(row.id).content(row.record);
    }
    return;
  }

  for (const batch of batchesOf(rows, batchSize)) {
    const bindings: Record<string, unknown> = {};
    const statements = batch
      .map((row, index) => {
        bindings[`id${index}`] = row.id;
        bindings[`record${index}`] = row.record;
        return `UPSERT $id${index} CONTENT $record${index};`;
      })
      .join("\n");
    await queryResults(db, statements, bindings);
  }
}
