/*
 * Copyright (C) 2025 OurTextScores Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import Header from "./components/header";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "OurTextScores",
  description: "Open platform for machine-readable music scores"
};

export default function RootLayout({
  children
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en" className="min-h-full">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(() => {
              try {
                var t = localStorage.getItem('theme');
                if (t === 'dark') {
                  document.documentElement.classList.add('dark');
                } else if (t === 'light') {
                  document.documentElement.classList.remove('dark');
                } else {
                  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
                  if (prefersDark) document.documentElement.classList.add('dark');
                  else document.documentElement.classList.remove('dark');
                }
              } catch(e){}
            })();`
          }}
        />
      </head>
      <body>
        <Providers>
          <Header />
          {children}
        </Providers>
      </body>
    </html>
  );
}
