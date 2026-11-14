import ePub, { EpubCFI, type Book, type NavItem } from 'epubjs';
import type Section from 'epubjs/types/section';
import type { SearchHit, TocItem } from '../types';
import { makeExcerpt, queryRegex } from '../lib/utils';
import type { EpubEngineLike, SearchOptions } from './types';

/** epub.js types `load()` as synchronous, but it returns a promise. */
type LoadableSection = Omit<Section, 'load'> & { load(request: unknown): Promise<Element> };

/**
 * Safari delivers no events from a frame that is forbidden to run scripts, so the frames that show
 * the book have to allow them (see EpubView). The book's own code must still never run — it would
 * share the app's storage, keys included — so every chapter gets a policy that forbids all script,
 * and script elements are cut out on top of that.
 */
const NO_SCRIPT_POLICY = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'">`;

export function lockDown(html: string): string {
  const clean = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/<script\b[^>]*\/>/gi, '');
  const head = /<head\b[^>]*>/i.exec(clean);
  if (head) return clean.slice(0, head.index + head[0].length) + NO_SCRIPT_POLICY + clean.slice(head.index + head[0].length);
  const html5 = /<html\b[^>]*>/i.exec(clean);
  if (html5) return `${clean.slice(0, html5.index + html5[0].length)}<head>${NO_SCRIPT_POLICY}</head>${clean.slice(html5.index + html5[0].length)}`;
  return NO_SCRIPT_POLICY + clean;
}

export class EpubEngine implements EpubEngineLike {
  readonly format = 'epub' as const;
  readonly kind = 'epub' as const;
  unitCount = 0;
  metadata: { title?: string; author?: string } = {};

  private sections: LoadableSection[] = [];
  private toc: TocItem[] = [];
  private titles: (string | undefined)[] = [];
  private textCache = new Map<number, string>();
  private cfi = new EpubCFI();
  private locationsReady: Promise<string | null> | null = null;

  private constructor(readonly book: Book) {}

  static async open(data: ArrayBuffer): Promise<EpubEngine> {
    const book = ePub(data);
    await book.ready;
    // Runs on the text of every chapter right before it is put on screen. epub.js registered its own
    // hook while opening the book — the one that points stylesheets and pictures at the unpacked
    // files — and leaves its result in `section.output`; every hook is handed the untouched text,
    // so the lock has to be applied to that result, not to the argument, or the book loses its
    // styles and pictures.
    (book.spine as unknown as { hooks: { serialize: { register(fn: (output: string, section: { output: string }) => void): void } } }).hooks.serialize.register((output, section) => {
      section.output = lockDown(section.output || output);
    });
    const engine = new EpubEngine(book);

    engine.sections = (book.spine as unknown as { spineItems: LoadableSection[] }).spineItems;
    engine.unitCount = engine.sections.length;

    const meta = await book.loaded.metadata;
    engine.metadata = { title: meta.title?.trim() || undefined, author: meta.creator?.trim() || undefined };

    const nav = await book.loaded.navigation;
    engine.toc = engine.convertToc(nav.toc ?? []);
    engine.titles = engine.buildTitles();
    return engine;
  }

  private spineIndexForHref(href: string): number | undefined {
    const clean = decodeURIComponent(href.split('#')[0]);
    if (!clean) return undefined;
    const exact = this.sections.find((s) => s.href === clean || decodeURIComponent(s.href) === clean);
    if (exact) return exact.index;
    // Navigation hrefs can be relative to the nav document rather than the package file.
    const name = clean.replace(/^(\.\.\/)+/, '');
    return this.sections.find((s) => s.href.endsWith(name) || name.endsWith(s.href))?.index;
  }

  private convertToc(items: NavItem[]): TocItem[] {
    return items.map((item) => ({
      title: item.label?.trim() || '—',
      href: item.href,
      unit: this.spineIndexForHref(item.href),
      children: this.convertToc(item.subitems ?? []),
    }));
  }

  /** For every spine section, the title of the nearest TOC entry at or before it. */
  private buildTitles(): (string | undefined)[] {
    const starts = new Map<number, string>();
    const walk = (items: TocItem[]) => {
      for (const item of items) {
        if (item.unit !== undefined && !starts.has(item.unit)) starts.set(item.unit, item.title);
        walk(item.children);
      }
    };
    walk(this.toc);
    const titles: (string | undefined)[] = [];
    let current: string | undefined;
    for (let i = 0; i < this.unitCount; i++) {
      current = starts.get(i) ?? current;
      titles.push(current);
    }
    return titles;
  }

  titleForUnit(unit: number): string | undefined {
    return this.titles[unit];
  }

  async getToc(): Promise<TocItem[]> {
    return this.toc;
  }

  private async withSection<T>(unit: number, fn: (doc: Document, section: LoadableSection) => T): Promise<T> {
    const section = this.sections[unit];
    if (!section) throw new Error(`Розділ ${unit + 1} не існує`);
    const root = await section.load(this.book.load.bind(this.book));
    try {
      return fn(root.ownerDocument, section);
    } finally {
      section.unload();
    }
  }

  async getUnitText(unit: number): Promise<string> {
    const cached = this.textCache.get(unit);
    if (cached !== undefined) return cached;
    const text = await this.withSection(unit, (doc) =>
      (doc.body?.textContent ?? doc.documentElement.textContent ?? '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
    );
    this.textCache.set(unit, text);
    return text;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const re = queryRegex(query);
    if (!re) return [];
    const limit = opts.limit ?? 500;
    const hits: SearchHit[] = [];

    for (let unit = 0; unit < this.unitCount && hits.length < limit; unit++) {
      if (opts.signal?.aborted) break;
      const label = this.titles[unit] ?? `Розділ ${unit + 1}`;
      await this.withSection(unit, (doc, section) => {
        const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode() as Text | null; node && hits.length < limit; node = walker.nextNode() as Text | null) {
          const text = node.data;
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) && hits.length < limit) {
            if (m[0].length === 0) {
              re.lastIndex++;
              continue;
            }
            const range = doc.createRange();
            range.setStart(node, m.index);
            range.setEnd(node, m.index + m[0].length);
            hits.push({ unit, label, cfi: section.cfiFromRange(range), ...makeExcerpt(text, m.index, m[0].length) });
          }
        }
      }).catch(() => {
        // A broken section should not abort the whole search.
      });
      opts.onProgress?.(unit + 1, this.unitCount);
    }
    return hits;
  }

  async locatePassage(unit: number, passage: string): Promise<string | null> {
    const wanted = passage.replace(/\s+/g, ' ').trim();
    // The passage was cut from whitespace-normalised text and may span several nodes, so look for
    // progressively shorter openings of it inside single text nodes.
    const probes = [48, 28, 14].map((n) => wanted.slice(0, n)).filter((p, i, all) => p.length >= 8 && all.indexOf(p) === i);
    if (!probes.length) return null;
    return this.withSection(unit, (doc, section) => {
      for (const probe of probes) {
        const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
          if (!node.data.replace(/\s+/g, ' ').includes(probe)) continue;
          const range = doc.createRange();
          range.selectNodeContents(node);
          range.collapse(true);
          return section.cfiFromRange(range);
        }
      }
      return null;
    }).catch(() => null);
  }

  async makeCover(): Promise<Blob | null> {
    try {
      const url = await this.book.coverUrl();
      if (!url) return null;
      return await (await fetch(url)).blob();
    } catch {
      return null;
    }
  }

  /** Builds (or restores) the location index that turns CFIs into whole-book percentages. */
  ensureLocations(saved?: string): Promise<string | null> {
    this.locationsReady ??= (async () => {
      try {
        if (saved) {
          this.book.locations.load(saved);
          return saved;
        }
        await this.book.locations.generate(1600);
        return this.book.locations.save();
      } catch {
        return null;
      }
    })();
    return this.locationsReady;
  }

  private hasLocations(): boolean {
    return this.book.locations.length() > 0;
  }

  percentageFromCfi(cfi: string): number | null {
    if (!this.hasLocations()) return null;
    try {
      return this.book.locations.percentageFromCfi(cfi);
    } catch {
      return null;
    }
  }

  cfiFromPercentage(p: number): string | null {
    if (!this.hasLocations()) return null;
    try {
      return this.book.locations.cfiFromPercentage(p);
    } catch {
      return null;
    }
  }

  compareCfi(a: string, b: string): number {
    try {
      return this.cfi.compare(a, b);
    } catch {
      return 0;
    }
  }

  destroy(): void {
    try {
      this.book.destroy();
    } catch {
      // epub.js can throw while tearing down a book that is still loading.
    }
  }
}
