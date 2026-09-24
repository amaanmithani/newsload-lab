import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArticleView } from "@/components/ArticleView";
import { loadStory } from "@/lib/queries";

// ISR: each article is rendered on first request, cached, and regenerated in
// the background at most every 30 s (or immediately on POST /api/publish).
export const revalidate = 30;
export const dynamicParams = true;

export function generateStaticParams(): { slug: string }[] {
  return []; // nothing at build time; pages are generated lazily on first hit
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const story = await loadStory((await params).slug);
  return { title: story?.headline ?? "Not found" };
}

export default async function IsrArticle({ params }: Props) {
  const story = await loadStory((await params).slug);
  if (!story) notFound();
  return <ArticleView story={story} mode="isr" />;
}
