import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "MON liquidation clusters · How is Kuru doing?",
  description: "MON mark and spot, cross-exchange long/short liquidation clusters, and venue detail across major perp venues.",
};

export default function MonLayout({ children }: { children: React.ReactNode }) {
  return children;
}
