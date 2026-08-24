"use client";

import React, { useState } from "react";

interface LazyDetailsProps extends React.DetailsHTMLAttributes<HTMLDetailsElement> {
  summary: React.ReactNode;
  children: React.ReactNode;
  unmountOnClose?: boolean;
}

export default function LazyDetails({
  summary,
  children,
  unmountOnClose = false,
  ...props
}: LazyDetailsProps) {
  const initiallyOpen = Boolean(props.open);
  const [hasOpened, setHasOpened] = useState(initiallyOpen);
  const [isOpen, setIsOpen] = useState(initiallyOpen);

  const handleToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    setIsOpen(e.currentTarget.open);
    if (e.currentTarget.open) {
      setHasOpened(true);
    }
    props.onToggle?.(e);
  };

  return (
    <details {...props} onToggle={handleToggle}>
      {summary}
      {hasOpened && (!unmountOnClose || isOpen) && children}
    </details>
  );
}
