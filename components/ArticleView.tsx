import type { Story } from "@/lib/store";

/**
 * data-rev / data-rendered-at are the load lab's hooks: k6 reads data-rev to
 * tell a stale copy from a fresh one after a publish.
 */
export function ArticleView({ story, mode }: { story: Story; mode: "isr" | "dynamic" }) {
  const renderedAt = new Date().toISOString();
  return (
    <article data-slug={story.slug} data-rev={story.rev} data-rendered-at={renderedAt} data-mode={mode}>
      <div className="section">{story.section}</div>
      <h1>{story.headline}</h1>
      <p className="meta">
        Updated {story.updatedAt} · rev {story.rev} · rendered {renderedAt} ({mode})
      </p>
      <p>
        <strong>{story.summary}</strong>
      </p>
      {story.body.map((para, i) => (
        <p key={i}>{para}</p>
      ))}
    </article>
  );
}
