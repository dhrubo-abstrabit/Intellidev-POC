import type { Metadata } from "next";
import { Inter, Inter_Tight } from "next/font/google";
import "./globals.css";

// Brand system typeface (D:\Build_TM\brand-system.html). Loaded once at the
// root — (auth)/(app) layouts used to each load these locally while the
// redesign was rolling out page by page; now that it covers the whole app,
// one load here replaces both.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const interTight = Inter_Tight({
  variable: "--font-inter-tight",
  weight: ["600", "700", "800"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Intellidev",
  description: "Your project's daily brain — synced activity, AI-generated action items, one dashboard per project.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${interTight.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
