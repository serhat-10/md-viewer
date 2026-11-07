# MD Viewer

A small, fully offline Markdown viewer for Windows.
No CDN, no network requests, nothing is sent anywhere.

> The interface is currently in Turkish (for example "Dosya aç" = Open file, "Yenile" = Reload, "Uzak görseller" = Remote images).

## Running

**Double-click `start.bat`.** The viewer opens in your browser.

You can also pass files on the command line:

```bat
start.bat notes.md
start.bat "C:\Docs\project\README.md" other.md
```

- With Node.js installed, a small local server starts (on `127.0.0.1` only, default port 47821).
  The viewer keeps running while the black console window stays open; close the window to stop it.
- If a viewer is already running, `start.bat file.md` does not start a new server. It opens a new browser tab in the running instance.
- `node server.js --no-browser` prints the URL without opening a browser.
- Without Node.js, `index.html` opens directly in the browser (serverless mode). In this mode, open files with drag & drop or the **Dosya aç** (Open file) button.

No installation is needed. All libraries are bundled in `vendor/`.

## Features

- **Opening files:** drag & drop, the open button (Ctrl+O), command line, and "open by path" (server mode; paste the output of Explorer's "Copy as path", quotes included).
- **Tabs:** multiple documents; close with middle click or ×.
- **Recent files:** listed on the start screen (stored in the browser's localStorage). Small files opened by drag & drop are also cached.
- **GitHub-flavoured Markdown:** tables, task lists, code blocks with syntax highlighting (highlight.js), `> [!NOTE]` style alerts, YAML front matter in a collapsible box.
- **Relative images:** in server mode, `![](images/a.png)` is resolved against the document's folder. In serverless mode, drop the images onto the window too and they are matched by file name.
- **Relative links:** in server mode, a link to another `.md` file opens in a new tab; `#heading` links scroll within the document.
- **Auto-reload:** in server mode, the view updates within 2 seconds when the open file changes on disk. Reload manually with **Yenile** (Alt+R).
- **Table of contents panel:** generated from headings, with the section you are reading highlighted. Toggle with ☰ or Alt+T.
- **In-document search:** Ctrl+F or `/`; Enter / Shift+Enter (or F3) for next/previous, Esc to close. It follows Turkish case rules (İ/i, I/ı).
- **Theme:** System (default, follows the OS) / Light / Dark.
- **Printing:** toolbar and panels are hidden, code blocks wrap, and external link addresses are printed. "Save as PDF" in the browser's print dialog produces a PDF.
- **Copy code:** a copy button appears when you hover over a code block.
- **Mermaid diagrams:** ` ```mermaid ` blocks are rendered as SVG (flowchart, sequence, class, state, Gantt and more). Diagrams are redrawn when the theme changes, and the light version is used when printing in dark mode. A block with invalid syntax does not break the page: the source and an error message are shown instead.
- **Footnotes:** `[^1]` in the text, `[^1]: Footnote text` anywhere. Footnotes are collected in a section at the end of the document. Click the number to jump to the footnote, and ↩ to return to the text.
- **Math (KaTeX):** inline `$E = mc^2$`, and `$$ ... $$` on separate lines for blocks. Dollar signs in code blocks and inline code are not treated as math, and ordinary text such as "5$ and 10$" is not matched (no space after the opening `$` or before the closing `$`, no digit right after the closing `$`, and the opening `$` must not directly follow a letter or digit). Write `\$` for a literal dollar sign.
- Mermaid (about 5.5 MB) and KaTeX are loaded only when a document actually contains a diagram or formula, so other documents open quickly.

## Security and privacy

- Rendered HTML is sanitized with **DOMPurify**. It removes `<script>`, event attributes (`onerror` and similar), `javascript:` links, `iframe` and `style` tags, and CSS `url(...)`, `image-set(...)`, `@import` (including variants hidden with escape sequences). References to external addresses from `<image>` / `<use>` in inline SVG are dropped.
- **Remote (internet) images are blocked by default**, because loading them means a request to the outside. You can enable them with the "Uzak görseller" (Remote images) button.
- Files are **read-only**. The server answers only `GET` requests and never writes any file.
- The server listens on `127.0.0.1` only (other devices on the network cannot reach it), uses a random session token on every start, and checks the `Host` header (DNS rebinding protection).
- The server reads only Markdown/text extensions (`.md .markdown .mdown .mkd .mkdn .mdx .txt`) and image files. It serves no other file types.
- Links to external sites open in a new tab, and only when you click them.
- **Mermaid** runs with `securityLevel: 'strict'` (click callbacks and scripts are disabled). `%%{init}%%` directives in a document cannot change security settings, `themeCSS`, fonts or Mermaid's internal sanitizer setting. Elements that could load external resources (images, `style`, `src` and similar) are dropped from diagram labels at render time. The resulting SVG also goes through DOMPurify, and CSS in it that could make external requests (`url(...)`, `@import`) is removed.
- **KaTeX** runs with `trust: false`: commands such as `\href`, `\url`, `\includegraphics` and `\htmlClass` do not run and appear as red source text. KaTeX output also goes through DOMPurify.
- From `vendor/`, the server serves only `.js`, `.css` and `.woff2` files (not `.map`, license files or other files in the app folder).

## Known limitations

- In-document search does not look inside diagrams or formulas.
- In serverless mode (`file://`), Chrome may refuse to load the KaTeX fonts for security reasons. Formulas still render, but with a system font.
- The first render of Mermaid diagrams can take a few seconds in large documents. Later renders come from a cache.
- In serverless mode (and for files opened by drag & drop), the browser does not know the file's path, so relative links and images work only partly and there is no auto-reload.
- Files are read as UTF-8.
- Reloading the page (F5) closes open tabs. Reopen them from the recent files list.

## File structure

```
start.bat        Launcher
server.js        Local server (no dependencies, Node.js built-in modules only)
index.html       Interface
app.js           Application logic
style.css        Styles (light/dark theme, print)
favicon.svg      Icon
vendor/          marked 15.0.12, marked-footnote 1.4.0, DOMPurify 3.2.6, highlight.js 11.11.1,
                 mermaid 12.2.0, KaTeX 0.19.1 (woff2 fonts under fonts/, licenses under licenses/)
ornek/           Sample documents (test.md, diger.md, gelismis.md: Mermaid, footnotes, math)
```

## License

MIT. See [LICENSE](LICENSE). Bundled libraries keep their own licenses in `vendor/licenses/`.
