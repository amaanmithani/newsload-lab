import { notFound } from "next/navigation";
import { ArticleView } from "@/components/ArticleView";
import { loadStory } from "@/lib/queries";

// "Origin only" baseline: rendered on every request, every request hits the slow origin.
export const dynamic = "force-dynamic";

export default async function LiveArticle({ params }: { params: Promise<{ slug: string }> }) {
  const story = await loadStory((await params).slug);
  if (!story) notFound();
  return <ArticleView story={story} mode="dynamic" />;
}
