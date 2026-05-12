"use client";

import { useSetBreadcrumbs } from "./provider";
import type { Breadcrumb } from "./types";

/**
 * small client wrapper that registers a breadcrumb trail
 * for the current page. Intended for direct use from Server Component
 * pages: render `<BreadcrumbsSetter crumbs={[...]} />` once near the
 * top of the page subtree. The trail unregisters on unmount so the
 * next navigation starts blank.
 *
 * For data-aware breadcrumbs (e.g., "Leads › *Lead Name*"), pass the
 * resolved values from the page's server component once it has loaded
 * the entity. The label updates whenever the underlying data does.
 */
export function BreadcrumbsSetter({ crumbs }: { crumbs: Breadcrumb[] }) {
  useSetBreadcrumbs(crumbs);
  return null;
}
