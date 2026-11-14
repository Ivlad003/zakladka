// Diagrams in the agents' answers. A model writes a diagram as text (Mermaid, in a ```mermaid
// block) and it is drawn here. The library is large, so it is loaded when the first diagram appears.
type Mermaid = typeof import('mermaid').default;

let library: Promise<Mermaid> | null = null;
let counter = 0;

/** Draws a Mermaid diagram and returns it as SVG markup; throws when the text is not a valid diagram. */
export async function renderDiagram(code: string, dark: boolean): Promise<string> {
  library ??= import('mermaid').then((m) => m.default);
  const mermaid = await library;
  // "strict": labels are plain text and the diagram cannot carry links or scripts.
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral', fontFamily: 'inherit' });
  const id = `zk-diagram-${++counter}`;
  try {
    return (await mermaid.render(id, code)).svg;
  } finally {
    // On a syntax error Mermaid leaves its own error picture in the page.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}
