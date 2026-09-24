import Link from "next/link";
import { listLatest } from "@/lib/store";

// Home page is ISR too: regenerated at most every 30 s, or on publish.
export const revalidate = 30;

export default async function Home() {
  const stories = await listLatest(20);
  return (
    <>
      <h1 className="section">Latest</h1>
      <ul className="list">
        {stories.map((s) => (
          <li key={s.slug}>
            <span className="section">{s.section}</span>
            <h2>
              <Link href={`/news/${s.slug}`}>{s.headline}</Link>
            </h2>
            <p>{s.summary}</p>
          </li>
        ))}
      </ul>
    </>
  );
}
