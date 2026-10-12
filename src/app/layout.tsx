import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import Link from "next/link";
import { Nav } from "@/components/nav";
import { NextBrief } from "@/components/next-brief";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Editorial face for the Overview headline and headline numbers only.
const serif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: { default: "Podcast Radar", template: "%s · Podcast Radar" },
  description: "Weekly intelligence on who to book, what to cover, and who to pitch, from 10 Indian founder podcasts.",
};

function Mark() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="size-8" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-ink" />
        <circle cx="16" cy="16" r="9.5" fill="none" strokeWidth="1.5" className="stroke-bg" opacity=".35" />
        <circle cx="16" cy="16" r="5" fill="none" strokeWidth="1.5" className="stroke-bg" opacity=".6" />
        <path d="M16 16 L23.5 9.5" strokeWidth="2" strokeLinecap="round" className="stroke-bg" />
        <circle cx="21.5" cy="20" r="1.8" className="fill-accent" />
      </svg>
      <span className="leading-tight">
        <span className="block text-[0.95rem] font-semibold tracking-[-0.01em] text-ink">Podcast Radar</span>
        <span className="block text-xs text-ink-3">Founder podcast intel</span>
      </span>
    </Link>
  );
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${serif.variable} h-full antialiased`}>
      <body className="min-h-full">
        <div className="md:grid md:min-h-screen md:grid-cols-[236px_1fr]">
          <aside className="hidden border-r border-line bg-surface-2 md:sticky md:top-0 md:flex md:h-screen md:flex-col md:px-3 md:py-5">
            <div className="px-2"><Mark /></div>
            <nav className="mt-8 flex-1" aria-label="Main"><Nav variant="side" /></nav>
            <NextBrief />
          </aside>

          <header className="sticky top-0 z-10 border-b border-line bg-surface-2/95 backdrop-blur md:hidden">
            <div className="px-4 pt-3"><Mark /></div>
            <nav className="flex gap-1 overflow-x-auto px-3 py-2.5" aria-label="Main"><Nav variant="top" /></nav>
          </header>

          <main className="min-w-0 px-4 pb-20 pt-6 sm:px-8 md:pt-10 lg:px-12">
            <div className="mx-auto max-w-[1080px]">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
