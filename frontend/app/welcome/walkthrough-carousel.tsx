"use client";

import { useState } from "react";

const walkthroughs = [
  {
    id: "cSDI19N7kcE",
    label: "Scanner",
    title: "Scanner walkthrough",
    body: "Turn printed sheet music into an editable score, review the results, and open it in the Score Editor.",
  },
  {
    id: "65ISfJhIO4s",
    label: "Editor",
    title: "Score Editor walkthrough",
    body: "Write, edit and play music in your browser, then export or share your score.",
  },
  {
    id: "-Z09sxFUjys",
    label: "Website",
    title: "Website walkthrough",
    body: "Explore the catalogue, upload a score, and collaborate through revisions and change reviews.",
  },
];

const controlClass = "rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-emerald-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800";

export default function WalkthroughCarousel({ className }: { className?: string }) {
  const [index, setIndex] = useState(0);
  const active = walkthroughs[index];

  return (
    <section aria-labelledby="walkthroughs" aria-roledescription="carousel" className={className}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="walkthroughs" className="font-[var(--font-heading)] text-2xl">Watch the walkthroughs</h2>
        <div role="group" aria-label="Choose a walkthrough" className="flex flex-wrap gap-2">
          {walkthroughs.map((walkthrough, slideIndex) => (
            <button
              key={walkthrough.id}
              type="button"
              aria-pressed={index === slideIndex}
              aria-controls="walkthrough-slide"
              onClick={() => setIndex(slideIndex)}
              className={`${controlClass} ${index === slideIndex ? "ring-2 ring-emerald-600 dark:ring-emerald-400" : ""}`}
            >
              {walkthrough.label}
            </button>
          ))}
        </div>
      </div>
      <div id="walkthrough-slide" role="group" aria-roledescription="slide" aria-label={`${index + 1} of ${walkthroughs.length}: ${active.title}`} className="mt-5">
        <iframe
          key={active.id}
          src={`https://www.youtube-nocookie.com/embed/${active.id}`}
          title={active.title}
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
          className="aspect-video w-full rounded-xl border border-slate-200 bg-slate-950 shadow-sm dark:border-slate-700"
        />
        <div className="mt-4" aria-live="polite" aria-atomic="true">
          <h3 className="text-lg font-semibold">{active.title}</h3>
          <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">{active.body}</p>
          <a
            href={`https://www.youtube.com/watch?v=${active.id}`}
            target="_blank"
            rel="noreferrer"
            aria-label={`Watch the ${active.title} on YouTube`}
            className="mt-2 inline-flex text-sm font-medium text-emerald-700 hover:underline dark:text-emerald-400"
          >
            Watch on YouTube <span aria-hidden="true" className="ml-1">↗</span>
          </a>
        </div>
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        <button type="button" aria-label="Previous walkthrough" onClick={() => setIndex((index + walkthroughs.length - 1) % walkthroughs.length)} className={controlClass}>
          <span aria-hidden="true">← </span>Previous
        </button>
        <span className="text-sm text-slate-600 dark:text-slate-400">{index + 1} / {walkthroughs.length}</span>
        <button type="button" aria-label="Next walkthrough" onClick={() => setIndex((index + 1) % walkthroughs.length)} className={controlClass}>
          Next<span aria-hidden="true"> →</span>
        </button>
      </div>
    </section>
  );
}
