"use client";

import React, { useState } from "react";

interface LazyDetailsProps extends React.DetailsHTMLAttributes<HTMLDetailsElement> {
  summary: React.ReactNode;
  children: React.ReactNode;
}

export default function LazyDetails({
  summary,
  children,
  ...props
}: LazyDetailsProps) {
  const [hasOpened, setHasOpened] = useState(false);

  const handleToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (e.currentTarget.open) {
      setHasOpened(true);
    }
    props.onToggle?.(e);
  };

  return (
    <details {...props} onToggle={handleToggle}>
      {summary}
      {hasOpened && children}
    </details>
  );
}
