import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "The Daily Spike", template: "%s · The Daily Spike" },
  description: "A fictional news site used by newsload-lab to study caching under breaking-news traffic.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="masthead">
          <Link href="/" className="brand">
            The Daily Spike
          </Link>
          <span className="tagline">fictional news for load testing</span>
        </header>
        <main>{children}</main>
        <footer className="foot">newsload-lab · all stories are fictional</footer>
      </body>
    </html>
  );
}
