// "Watch this place": a watched place's month so far against its normal (/now), fetched once per page load and shared
// by every view that shows it (the landing card and the search palette).
import { useEffect, useState } from "react";
import { api } from "../../app/api";
import type { Category } from "../../app/types";

export interface WatchStatus {
  month: string;
  category: Category | null;
  mtd: number;
  expected: number;
}

const cache = new Map<string, Promise<WatchStatus | null>>();

export function watchStatus(id: string): Promise<WatchStatus | null> {
  let p = cache.get(id);
  if (!p) {
    p = api
      .areaByAdmin(id)
      .then((a) => api.now(a.area_id))
      .then((n) => ({ month: n.month, category: n.category, mtd: n.mtd_h_count, expected: n.expected_mtd }))
      .catch(() => null);
    cache.set(id, p);
  }
  return p;
}

/** Statuses of the watched places: undefined while loading, null when the API could not answer. */
export function useWatchStatuses(ids: string[]): Record<string, WatchStatus | null | undefined> {
  const [st, setSt] = useState<Record<string, WatchStatus | null | undefined>>({});
  const key = ids.join("|");
  useEffect(() => {
    let alive = true;
    ids.forEach((id) =>
      watchStatus(id).then((s) => {
        if (alive) setSt((o) => ({ ...o, [id]: s }));
      }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return st;
}

/** Above normal or worse: the watch list flags it. */
export const isAlert = (c: Category | null | undefined) => c === "above" || c === "much_above" || c === "record";
