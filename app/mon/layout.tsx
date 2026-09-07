import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "MON liquidation clusters · How is Kuru doing?",
  description: "MON mark and spot, Hyperliquid long/short liquidation clusters, and perp venue summary.",
};

export default function MonLayout({ children }: { children: React.ReactNode }) {
  return children;
}
