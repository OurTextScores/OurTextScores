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
import { Playfair_Display, Plus_Jakarta_Sans } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";

const fontSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const fontHeading = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-heading",
  display: "swap",
});
import Header from "./components/header";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "OurTextScores",
  description: "Open platform for machine-readable music scores",
  icons: {
    icon: [
      {
        url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='0.9em' font-size='90'%3E%F0%9F%8E%BC%3C/text%3E%3C/svg%3E"
      }
    ]
  }
};

export default function RootLayout({
  children
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en" className={`min-h-full ${fontSans.variable} ${fontHeading.variable}`}>
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
        <Analytics />
      </body>
    </html>
  );
}
