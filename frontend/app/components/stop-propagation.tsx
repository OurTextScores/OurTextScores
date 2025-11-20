"use client";

import React from "react";

export default function StopPropagation({
    children,
    className,
    as: Component = "div"
}: {
    children: React.ReactNode;
    className?: string;
    as?: any;
}) {
    return (
        <Component
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            className={className}
        >
            {children}
        </Component>
    );
}
