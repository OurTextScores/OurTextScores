export function Figure({
  value,
  label,
  detail,
}: {
  value: string;
  label: string;
  detail?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900">
      <div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
        {value}
      </div>
      <div className="mt-0.5 text-sm text-slate-700 dark:text-slate-300">
        {label}
      </div>
      {detail ? (
        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {detail}
        </div>
      ) : null}
    </div>
  );
}

export function Section({
  id,
  title,
  children,
  wide = false,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
  /* Prose is capped for readability; a section of full-bleed embeds must not be, because
     the breakout below measures from its parent's centre and a left-aligned capped
     parent is not centred - which lands the embeds off to one side. */
  wide?: boolean;
}) {
  return (
    <section id={id} className="mt-12 scroll-mt-8">
      <h2 className="border-b border-slate-200 pb-1.5 text-xl font-semibold text-slate-900 dark:border-slate-700 dark:text-slate-100">
        {title}
      </h2>
      <div
        className={`mt-3 space-y-3 text-sm leading-6 text-slate-700 dark:text-slate-300 ${
          wide ? "" : "max-w-5xl"
        }`}
      >
        {children}
      </div>
    </section>
  );
}

export function Table({
  head,
  rows,
  emphasis,
}: {
  head: string[];
  rows: string[][];
  emphasis?: number;
}) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[32rem] border-collapse text-sm">
        <thead>
          <tr>
            {head.map((cell) => (
              <th
                key={cell}
                className="border-b border-slate-300 bg-slate-50 px-3 py-2 text-left font-semibold text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={row[0]}
              className={
                emphasis === index
                  ? "bg-amber-50 dark:bg-amber-950/30"
                  : undefined
              }
            >
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className="border-b border-slate-200 px-3 py-2 align-top tabular-nums text-slate-700 dark:border-slate-700 dark:text-slate-300"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
