"use client";

import Link from "next/link";
import { useState } from "react";

export type ShowcaseFeature = {
  id: string;
  title: string;
  body: string;
  href: string;
  linkLabel: string;
  media: { light: string; dark?: string };
};

// One video at a time: only the selected tab's <video> elements are mounted,
// so the page loads a single clip instead of six.
export default function FeatureShowcase({ features }: { features: ShowcaseFeature[] }) {
  const [activeId, setActiveId] = useState(features[0].id);
  const active = features.find((f) => f.id === activeId) ?? features[0];

  return (
    <div>
      <div role="tablist" aria-label="Platform features" className="flex flex-wrap gap-2">
        {features.map((feature) => {
          const selected = feature.id === active.id;
          return (
            <button
              key={feature.id}
              type="button"
              role="tab"
              id={`feature-tab-${feature.id}`}
              aria-selected={selected}
              aria-controls="feature-panel"
              onClick={() => setActiveId(feature.id)}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                selected
                  ? "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              }`}
            >
              {feature.title}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id="feature-panel"
        aria-labelledby={`feature-tab-${active.id}`}
        className="mt-5 grid gap-6 md:grid-cols-[1fr_1.6fr] md:items-center"
      >
        <div>
          <h3 className="text-xl font-semibold">{active.title}</h3>
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{active.body}</p>
          <Link
            href={active.href}
            className="mt-4 inline-flex text-sm font-semibold text-emerald-700 hover:underline dark:text-emerald-400"
          >
            {active.linkLabel} <span aria-hidden="true">→</span>
          </Link>
        </div>
        <div key={active.id}>
          <video
            src={active.media.light}
            autoPlay
            loop
            muted
            playsInline
            className={`w-full rounded-lg border border-slate-200 shadow-sm dark:border-slate-700 ${
              active.media.dark ? "dark:hidden" : ""
            }`}
          />
          {active.media.dark && (
            <video
              src={active.media.dark}
              autoPlay
              loop
              muted
              playsInline
              className="hidden w-full rounded-lg border border-slate-700 shadow-sm dark:block"
            />
          )}
        </div>
      </div>
    </div>
  );
}
