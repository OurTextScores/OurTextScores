"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Client component that handles deep linking from notifications
 * Scrolls to the target comment if specified in URL params
 */
export default function NotificationDeepLink() {
  const searchParams = useSearchParams();
  const commentId = searchParams.get("comment");
  const sourceId = searchParams.get("source");

  useEffect(() => {
    if (commentId) {
      // Wait for page to fully load and render (source card + revision history)
      const timer = setTimeout(() => {
        // Try to find the comment element by ID
        const commentElement = document.getElementById(`comment-${commentId}`);
        if (commentElement) {
          commentElement.scrollIntoView({ behavior: "smooth", block: "center" });
          // Highlight the comment briefly
          commentElement.classList.add("ring-2", "ring-blue-500");
          setTimeout(() => {
            commentElement.classList.remove("ring-2", "ring-blue-500");
          }, 3000);
        }
      }, 500); // Wait 500ms for source card + revision history to open

      return () => clearTimeout(timer);
    }
  }, [commentId]);

  useEffect(() => {
    if (sourceId && !commentId) {
      const timer = setTimeout(() => {
        const sourceElement = document.getElementById(`source-${sourceId}`);
        if (sourceElement) {
          sourceElement.scrollIntoView({ behavior: "smooth", block: "start" });
          sourceElement.classList.add("ring-2", "ring-cyan-500");
          setTimeout(() => {
            sourceElement.classList.remove("ring-2", "ring-cyan-500");
          }, 3000);
        }
      }, 500);

      return () => clearTimeout(timer);
    }
  }, [sourceId, commentId]);

  return null; // This component doesn't render anything
}
