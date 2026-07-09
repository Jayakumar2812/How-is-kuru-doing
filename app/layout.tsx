import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { Outfit, Syne } from "next/font/google";

import "./globals.css";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-body",
});

const syne = Syne({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["600", "700", "800"],
});

export const metadata: Metadata = {
  title: "How is Kuru doing?",
  description: "Live Kuru activity per block on Monad",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${syne.variable}`}>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
