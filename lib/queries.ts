import { cache } from "react";
import { getStory } from "./store";

/**
 * Per-request memoised story lookup: generateMetadata and the page body both
 * need the story, and without this each render would hit the slow origin twice.
 */
export const loadStory = cache(getStory);
