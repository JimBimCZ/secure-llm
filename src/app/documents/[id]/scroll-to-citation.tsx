"use client";

import { useEffect } from "react";

/**
 * Brings the cited passage into view. A plain `#fragment` would do the same on
 * a static page, but this one is server-rendered per request and the browser
 * restores the previous scroll position on a client-side navigation, so the
 * jump has to happen after paint.
 */
export function ScrollToCitation() {
  useEffect(() => {
    document
      .getElementById("cited-passage")
      ?.scrollIntoView({ block: "center" });
  }, []);

  return null;
}
