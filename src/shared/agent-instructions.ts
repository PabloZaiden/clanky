import { AGENT_NOTIFICATION_INSTRUCTIONS } from "./agent-notifications";

export function buildAgentInstructions(options: {
  controlTools?: boolean;
  htmlArtifacts?: boolean;
}): string | undefined {
  if (!options.controlTools) return undefined;
  return [
    "## Clanky tools",
    AGENT_NOTIFICATION_INSTRUCTIONS,
    ...(options.htmlArtifacts ? [
      "## Visual replies",
      "Use clanky_html_render for visuals requested here and for data trends or comparisons that a chart explains better than prose. Prefer ordinary text or Markdown when it suffices.",
      "If tools already available in your execution environment can render the HTML and let you see the result, inspect it and correct problems before publishing, ideally at phone and desktop widths. Otherwise review the source and publish without blocking on visual inspection. Do not install a browser solely for this check or claim visual inspection you did not perform. A screenshot saved on disk or a text description does not publish the visual.",
      "Never start a development server just to display an artifact. This is a generated illustration, not validation of the actual project. Ordinary coding tasks, including refactoring chart components, do not require these tools.",
      "For revisions, edit the HTML file and pass its path rather than repeatedly sending its full content. Follow the tool's responsive layout, theme, and image-reference rules.",
      "If the user needs an image to post, send, or use elsewhere, provide a PNG file instead; an inline artifact is not an exported image. After publishing, do not announce or restate the page; reply only with what it does not already communicate.",
    ] : []),
  ].join("\n\n");
}
