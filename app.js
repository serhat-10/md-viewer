/* MD Görüntüleyici - istemci
 * Tamamen yerel: dışarıya istek yapılmaz. Uzak görseller varsayılan olarak engellenir.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const els = {
    content: $('content'), welcome: $('welcome'), tabs: $('tabs'), tocList: $('toc-list'), main: $('main'),
    fileInput: $('file-input'), dropzone: $('dropzone'), toast: $('toast'), recentList: $('recent-list'),
    clearRecent: $('btn-clear-recent'), modeNote: $('mode-note'), searchbar: $('searchbar'),
    searchInput: $('search-input'), searchCount: $('search-count'),
    btnTheme: $('btn-theme'), btnToc: $('btn-toc'), btnRemote: $('btn-remote'),
    btnReload: $('btn-reload'), btnOpenPath: $('btn-open-path'),
    hljsLight: $('hljs-light'), hljsDark: $('hljs-dark')
  };

  const MD_RE = /\.(md|markdown|mdown|mkd|mkdn|mdx|txt)$/i;
  const IMG_RE = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/i;
  const MAX_RECENT = 12;
  const MAX_CACHED_CONTENT = 200000; // yolu bilinmeyen dosyalar için localStorage'a saklanacak en fazla karakter

  // ---------- güvenli localStorage ----------
  const store = {
    get(k, def) { try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* yok say */ } }
  };

  // ---------- durum ----------
  const state = {
    token: null,
    server: false,
    docs: [],          // {id, name, path, content, mtime, scroll}
    activeId: null,
    assets: new Map(), // bırakılan görseller: küçük harf dosya adı -> blob URL
    remoteImages: store.get('mdv.remoteImages', false),
    theme: store.get('mdv.theme', 'system'),
    hits: [], hitIndex: -1
  };
  let nextId = 1;

  // ---------- yardımcılar ----------
  let toastTimer = null;
  function toast(msg, ms) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms || 2600);
  }
  function api(path, params) {
    const q = new URLSearchParams(Object.assign({ t: state.token }, params));
    return fetch(path + '?' + q.toString(), { cache: 'no-store', credentials: 'same-origin' });
  }
  function baseName(p) { return String(p).split(/[\\/]/).pop(); }
  function isExternal(u) { return /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('//'); }
  function slugify(text) {
    return text.trim().toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .replace(/\s/g, '-');
  }
  function activeDoc() { return state.docs.find(d => d.id === state.activeId) || null; }

  // ---------- tema ----------
  const THEME_LABEL = { system: 'Sistem', light: 'Açık', dark: 'Koyu' };
  function applyTheme() {
    const t = state.theme;
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    if (t === 'light') { els.hljsLight.media = 'all'; els.hljsDark.media = 'not all'; }
    else if (t === 'dark') { els.hljsLight.media = 'not all'; els.hljsDark.media = 'all'; }
    else { els.hljsLight.media = '(prefers-color-scheme: light)'; els.hljsDark.media = '(prefers-color-scheme: dark)'; }
    els.btnTheme.textContent = 'Tema: ' + THEME_LABEL[t];
    refreshMermaid(); // diyagramları yeni temayla yeniden çiz
  }
  const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
  function isDark() { return state.theme === 'dark' || (state.theme === 'system' && darkMq.matches); }
  darkMq.addEventListener('change', () => { if (state.theme === 'system') refreshMermaid(); });
  els.btnTheme.addEventListener('click', () => {
    state.theme = { system: 'light', light: 'dark', dark: 'system' }[state.theme] || 'system';
    store.set('mdv.theme', state.theme);
    applyTheme();
  });
  // Yazdırırken her zaman açık kod renkleri (ve hazırsa diyagramların açık tema sürümü)
  let savedMedia = null;
  window.addEventListener('beforeprint', () => {
    savedMedia = [els.hljsLight.media, els.hljsDark.media];
    els.hljsLight.media = 'all'; els.hljsDark.media = 'not all';
    mermaidPrintSwap(true);
  });
  window.addEventListener('afterprint', () => {
    if (savedMedia) { els.hljsLight.media = savedMedia[0]; els.hljsDark.media = savedMedia[1]; }
    mermaidPrintSwap(false);
  });

  // ---------- uzak görseller ----------
  function applyRemoteBtn() {
    els.btnRemote.setAttribute('aria-pressed', String(state.remoteImages));
    els.btnRemote.textContent = 'Uzak görseller: ' + (state.remoteImages ? 'açık' : 'kapalı');
  }
  els.btnRemote.addEventListener('click', () => {
    state.remoteImages = !state.remoteImages;
    store.set('mdv.remoteImages', state.remoteImages);
    applyRemoteBtn();
    renderActive(true);
    toast(state.remoteImages ? 'Uzak görseller yüklenecek (internete istek yapılır).' : 'Uzak görseller engellendi.');
  });

  // ---------- markdown + temizleme ----------
  marked.use({ gfm: true, breaks: false });

  // Dipnotlar: [^1] ve [^1]: metin (marked-footnote)
  if (window.markedFootnote) {
    marked.use(markedFootnote({
      description: 'Dipnotlar',
      headingClass: 'footnotes-title',
      backRefLabel: '{0} numaralı referansa dön'
    }));
  }

  // Matematik: $...$ (satır içi), $$...$$ (blok). Burada yalnızca yer tutucu üretilir;
  // KaTeX gerektiğinde yüklenir ve çıktısı DOMPurify'dan geçirilerek yerleştirilir.
  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function scanInlineMath(src) {
    if (src[1] === '$') { // $$...$$ paragraf içinde
      const end = src.indexOf('$$', 2);
      if (end < 0) return null;
      const body = src.slice(2, end);
      if (!body.trim() || /\n[ \t]*\n/.test(body)) return null;
      return { raw: src.slice(0, end + 2), text: body.trim(), display: true };
    }
    // Pandoc kuralı: açılış $'ından sonra boşluk olmaz, kapanış $'ından önce boşluk olmaz,
    // kapanıştan hemen sonra rakam gelmez. İlk kaçışsız $ uygun bir kapanış değilse matematik sayılmaz.
    if (!src[1] || /\s/.test(src[1])) return null;
    for (let i = 1; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') { i++; continue; }
      if (c !== '$') continue;
      if (/\s/.test(src[i - 1]) || /\d/.test(src[i + 1] || '')) return null;
      return { raw: src.slice(0, i + 1), text: src.slice(1, i), display: false };
    }
    return null;
  }
  marked.use({
    extensions: [{
      name: 'mathBlock',
      level: 'block',
      start(src) { const m = /^ {0,3}\$\$/m.exec(src); return m ? m.index : undefined; },
      tokenizer(src) {
        const m = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/.exec(src);
        if (!m || !m[1].trim() || /\n[ \t]*\n/.test(m[1])) return undefined;
        return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
      },
      renderer(t) { return '<div class="mdv-math mdv-math-display">' + escHtml(t.text) + '</div>\n'; }
    }, {
      name: 'mathInline',
      level: 'inline',
      start(src) { const i = src.indexOf('$'); return i < 0 ? undefined : i; },
      tokenizer(src, tokens) {
        if (src[0] !== '$') return undefined;
        // "5$" gibi: harf/rakamdan hemen sonra gelen $ açılış sayılmaz
        const prev = tokens && tokens.length ? String(tokens[tokens.length - 1].raw || '').slice(-1) : '';
        if (/[\p{L}\p{N}\\$]/u.test(prev)) return undefined;
        const r = scanInlineMath(src);
        if (!r) return undefined;
        return { type: 'mathInline', raw: r.raw, text: r.text, display: r.display };
      },
      renderer(t) {
        return '<span class="mdv-math' + (t.display ? ' mdv-math-display' : '') + '">' + escHtml(t.text) + '</span>';
      }
    }]
  });

  const FORBID_TAGS = ['style', 'link', 'meta', 'base', 'iframe', 'frame', 'object', 'embed', 'video', 'audio',
    'source', 'track', 'picture', 'form', 'button', 'select', 'textarea', 'template'];
  // CSS üzerinden dış istek yapılabilecek her şey: url(…) (#yerel başvurular hariç), image-set, @import,
  // ve CSS kaçış dizileri (\75 rl( gibi gizleme hilelerine karşı).
  const CSS_DANGER = /url\s*\(\s*(?!['"]?\s*#)|image-set|(?:^|[^\w-])image\s*\(|@import|expression\s*\(|\\/i;
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    // Yalnızca Mermaid SVG'si için izin verilen <style> öğelerinin içeriğini denetle
    if (data.tagName === 'style' && CSS_DANGER.test(node.textContent || '')) node.textContent = '';
  });
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.hasAttribute && node.hasAttribute('style') && CSS_DANGER.test(node.getAttribute('style'))) {
      node.removeAttribute('style'); // CSS üzerinden dış istekleri engelle
    }
    if (node.removeAttribute) { node.removeAttribute('srcset'); node.removeAttribute('ping'); }
    // SVG içindeki <image>, <use>, <feImage> vb.: yalnızca belge içi (#…) başvurulara izin ver
    if (node.namespaceURI === 'http://www.w3.org/2000/svg' && node.nodeName.toLowerCase() !== 'a') {
      for (const attr of ['href', 'xlink:href']) {
        const v = node.getAttribute(attr);
        if (v !== null && !/^\s*#/.test(v)) node.removeAttribute(attr);
      }
    }
    const tag = node.nodeName;
    if (tag === 'a' && node.namespaceURI === 'http://www.w3.org/2000/svg') {
      const href = node.getAttribute('href') || node.getAttribute('xlink:href') || '';
      if (/^(https?:|mailto:)/i.test(href)) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
    if (tag === 'IMG') {
      const src = node.getAttribute('src') || '';
      node.removeAttribute('src');
      node.setAttribute('loading', 'lazy');
      if (/^data:image\//i.test(src)) node.setAttribute('data-src-data', src);
      else if (/^(https?:)?\/\//i.test(src)) node.setAttribute('data-remote-src', src);
      else if (src && !isExternal(src)) node.setAttribute('data-rel-src', src);
    } else if (tag === 'INPUT') {
      if ((node.getAttribute('type') || '').toLowerCase() !== 'checkbox') node.setAttribute('type', 'checkbox');
      node.setAttribute('disabled', '');
    } else if (tag === 'A') {
      const href = node.getAttribute('href') || '';
      if (/^(https?:|mailto:)/i.test(href)) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  });

  function splitFrontMatter(src) {
    const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/.exec(src);
    if (!m) return { fm: null, body: src };
    return { fm: m[1], body: src.slice(m[0].length) };
  }

  const ALERTS = {
    NOTE: ['note', 'Not'], TIP: ['tip', 'İpucu'], IMPORTANT: ['important', 'Önemli'],
    WARNING: ['warning', 'Uyarı'], CAUTION: ['caution', 'Dikkat']
  };

  // Başlık metni (kimlik ve İçindekiler için): matematik kaynağı korunur, dipnot numaraları atılır.
  function headingText(h) {
    if (!h.querySelector('.mdv-math, sup')) return h.textContent;
    const c = h.cloneNode(true);
    c.querySelectorAll('.mdv-math').forEach(m => m.replaceWith(m.getAttribute('data-tex') || m.textContent));
    c.querySelectorAll('sup > a[href^="#footnote-"]').forEach(a => a.parentElement.remove());
    return c.textContent;
  }

  let renderGen = 0;
  function renderMarkdown(doc) {
    const gen = ++renderGen;
    const { fm, body } = splitFrontMatter(doc.content);
    const rawHtml = marked.parse(body);
    const frag = DOMPurify.sanitize(rawHtml, {
      RETURN_DOM_FRAGMENT: true,
      FORBID_TAGS,
      ADD_ATTR: ['target'],
      ALLOW_DATA_ATTR: false
    });
    const root = els.content;
    root.textContent = '';

    if (fm !== null) {
      const det = document.createElement('details');
      det.className = 'front-matter';
      const sum = document.createElement('summary');
      sum.textContent = 'Ön bilgi (front matter)';
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = 'language-yaml';
      code.textContent = fm;
      pre.appendChild(code);
      det.append(sum, pre);
      root.appendChild(det);
    }
    root.appendChild(frag);

    // Başlık kimlikleri (GitHub tarzı)
    const used = new Map();
    root.querySelectorAll('.mdv-math').forEach(m => m.setAttribute('data-tex', m.textContent));
    root.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
      if (h.closest('section.footnotes')) return; // dipnot başlığının kimliği (aria-describedby) korunur
      let base = slugify(headingText(h)) || 'baslik';
      let id = base, n = used.get(base) || 0;
      if (n) id = base + '-' + n;
      used.set(base, n + 1);
      h.id = id;
    });

    // GitHub uyarı blokları
    root.querySelectorAll('blockquote').forEach(bq => {
      const p = bq.firstElementChild;
      if (!p || p.tagName !== 'P' || !p.firstChild || p.firstChild.nodeType !== 3) return;
      const m = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(p.firstChild.nodeValue);
      if (!m) return;
      const [cls, label] = ALERTS[m[1].toUpperCase()];
      p.firstChild.nodeValue = p.firstChild.nodeValue.slice(m[0].length);
      if (!p.firstChild.nodeValue) p.firstChild.remove();
      if (p.firstChild && p.firstChild.nodeName === 'BR') p.firstChild.remove();
      if (!p.textContent.trim() && !p.querySelector('img')) p.remove();
      bq.classList.add('alert', 'alert-' + cls);
      const title = document.createElement('div');
      title.className = 'alert-title';
      title.textContent = label;
      bq.prepend(title);
    });

    // Görseller
    root.querySelectorAll('img').forEach(img => {
      const data = img.getAttribute('data-src-data');
      const remote = img.getAttribute('data-remote-src');
      const rel = img.getAttribute('data-rel-src');
      if (data) { img.src = data; return; }
      if (remote) {
        if (state.remoteImages) { img.referrerPolicy = 'no-referrer'; img.src = remote.startsWith('//') ? 'https:' + remote : remote; }
        else {
          const span = document.createElement('span');
          span.className = 'img-blocked';
          span.title = remote;
          span.textContent = '🖼 Uzak görsel engellendi' + (img.alt ? ': ' + img.alt : '');
          img.replaceWith(span);
        }
        return;
      }
      if (rel) {
        let decoded = rel;
        try { decoded = decodeURIComponent(rel); } catch (e) { /* olduğu gibi */ }
        const blob = state.assets.get(baseName(decoded.split(/[?#]/)[0]).toLowerCase());
        if (doc.path && state.server) {
          img.src = 'api/asset?' + new URLSearchParams({ t: state.token, base: doc.path, rel: rel }).toString();
          if (blob) img.addEventListener('error', () => { img.src = blob; }, { once: true });
        } else if (blob) {
          img.src = blob;
        } else {
          img.classList.add('img-missing');
          img.title = 'Göreli görsel bulunamadı: ' + decoded + (state.server ? '' : ' (görseli de pencereye sürükleyip bırakabilirsiniz)');
        }
        img.addEventListener('error', () => { img.classList.add('img-missing'); img.title = 'Görsel yüklenemedi: ' + decoded; });
      }
    });

    // Sözdizimi renklendirme + kopyala düğmesi
    root.querySelectorAll('pre > code').forEach(code => {
      const m = /language-([\w+#.-]+)/.exec(code.className);
      const lang = m && m[1].toLowerCase();
      try {
        if (lang && hljs.getLanguage(lang)) {
          code.innerHTML = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value;
          code.classList.add('hljs');
        } else if (!lang || lang === 'text' || lang === 'plaintext') {
          /* düz metin */
        } else {
          code.classList.add('hljs'); // bilinmeyen dil: renklendirme yok
        }
      } catch (e) { /* renklendirme hatası: düz bırak */ }
      const pre = code.parentElement;
      if (pre.closest('.front-matter')) return;
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.type = 'button';
      btn.textContent = 'Kopyala';
      btn.addEventListener('click', () => copyText(code.textContent, btn));
      pre.appendChild(btn);
    });

    // Mermaid blokları: kaynak kod bloğu, diyagram çizilene (ya da hata verene) kadar görünür kalır.
    root.querySelectorAll('pre > code.language-mermaid').forEach(code => {
      const pre = code.parentElement;
      const wrap = document.createElement('div');
      wrap.className = 'mermaid-block';
      pre.replaceWith(wrap);
      wrap.appendChild(pre);
      wrap._mdvSrc = code.textContent;
      wrap._mdvPre = pre;
    });

    renderMath(root, gen);
    refreshMermaid();
  }

  // ---------- isteğe bağlı kütüphaneler (yalnızca gerektiğinde yüklenir) ----------
  const loaded = new Map();
  function loadOnce(url, kind) {
    if (loaded.has(url)) return loaded.get(url);
    const p = new Promise((resolve, reject) => {
      const el = document.createElement(kind === 'css' ? 'link' : 'script');
      if (kind === 'css') { el.rel = 'stylesheet'; el.href = url; } else { el.src = url; }
      el.onload = () => resolve();
      el.onerror = () => { loaded.delete(url); el.remove(); reject(new Error(url + ' yüklenemedi')); };
      document.head.appendChild(el);
    });
    loaded.set(url, p);
    return p;
  }

  // Not: window.katex / window.mermaid adları, belgede id="katex" olan bir başlık tarafından da
  // doldurulabilir (DOM clobbering). Bu yüzden yalnızca gerçek kütüphane nesnesi kabul edilir.
  function katexLib() { const k = window.katex; return k && typeof k.renderToString === 'function' ? k : null; }
  function mermaidLib() { const m = window.mermaid; return m && typeof m.render === 'function' && typeof m.initialize === 'function' ? m : null; }

  // ---------- KaTeX ----------
  const KATEX_OPTS = { throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml', maxSize: 50, maxExpand: 1000 };
  const mathCache = new Map();
  function renderMath(root, gen) {
    const nodes = root.querySelectorAll('.mdv-math:not(.mdv-math-done)');
    if (!nodes.length) return;
    if (!katexLib()) {
      Promise.all([loadOnce('vendor/katex.min.css', 'css'), loadOnce('vendor/katex.min.js', 'js')])
        .then(() => { if (gen === renderGen && katexLib()) renderMath(root, gen); },
          () => toast('Matematik kütüphanesi (KaTeX) yüklenemedi; formüller kaynak olarak gösteriliyor.', 4000));
      return;
    }
    nodes.forEach(el => {
      const tex = el.getAttribute('data-tex') || el.textContent;
      const display = el.classList.contains('mdv-math-display');
      const key = (display ? 'D' : 'I') + tex;
      let html = mathCache.get(key);
      if (html === undefined) {
        try { html = katexLib().renderToString(tex, Object.assign({ displayMode: display }, KATEX_OPTS)); }
        catch (e) { html = null; }
        if (mathCache.size > 2000) mathCache.clear();
        mathCache.set(key, html);
      }
      if (html === null) { el.classList.add('mdv-math-error'); el.title = 'Formül çizilemedi'; return; }
      const frag = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true, FORBID_TAGS, ALLOW_DATA_ATTR: false });
      el.textContent = '';
      el.appendChild(frag);
      el.classList.add('mdv-math-done');
    });
  }

  // ---------- Mermaid ----------
  const mermaidCache = new Map(); // tema + kaynak -> {svg} | {error}
  let mermaidQueue = Promise.resolve();
  let mermaidSeq = 0;
  const MERMAID_SVG_SANITIZE = {
    RETURN_DOM_FRAGMENT: true,
    ADD_TAGS: ['foreignObject', 'style'],
    FORBID_TAGS: FORBID_TAGS.filter(t => t !== 'style'),
    ADD_ATTR: ['target'],
    ALLOW_DATA_ATTR: false,
    // Mermaid'in HTML etiketleri <foreignObject> içinde durur; burada HTML'e izin verilir (yine temizlenerek)
    HTML_INTEGRATION_POINTS: { foreignobject: true, 'annotation-xml': true }
  };
  // Mermaid, diyagramı ölçmek için etiketleri geçici olarak belgeye ekler (bizim temizliğimizden ÖNCE).
  // Bu sırada görsel vb. yüklenip dış istek yapılmasın diye kaynak yükleyebilen her şey etiketlerde yasak.
  const MERMAID_LABEL_PURIFY = {
    FORBID_TAGS: ['style', 'img', 'image', 'svg', 'use', 'picture', 'source', 'video', 'audio', 'track', 'iframe',
      'frame', 'object', 'embed', 'link', 'meta', 'base', 'input', 'form', 'button', 'template', 'math'],
    FORBID_ATTR: ['style', 'src', 'srcset', 'background', 'poster', 'xlink:href', 'action', 'formaction', 'ping'],
    ALLOW_DATA_ATTR: false
  };
  function mermaidTheme() { return isDark() ? 'dark' : 'default'; }
  function mermaidKey(theme, src) { return theme + '\u0000' + src; }
  function mermaidConfig(theme) {
    return {
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
      suppressErrorRendering: true,
      dompurifyConfig: MERMAID_LABEL_PURIFY,
      // Belge içindeki %%{init}%% yönergeleriyle değiştirilemeyecek ayarlar
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges',
        'themeCSS', 'fontFamily', 'altFontFamily', 'dompurifyConfig']
    };
  }
  function mermaidJob(src, theme) {
    const key = mermaidKey(theme, src);
    if (mermaidCache.has(key)) return Promise.resolve(mermaidCache.get(key));
    const run = async () => {
      if (mermaidCache.has(key)) return mermaidCache.get(key);
      const id = 'mdv-mmd-' + (++mermaidSeq);
      let res;
      try {
        const m = mermaidLib();
        if (!m) throw new Error('Mermaid yüklenemedi');
        m.initialize(mermaidConfig(theme));
        await m.parse(src);
        const out = await m.render(id, src);
        res = { svg: out.svg };
      } catch (e) {
        const msg = String((e && (e.message || e.str)) || e || 'Bilinmeyen hata').trim();
        res = { error: msg.length > 600 ? msg.slice(0, 600) + '…' : msg };
      } finally {
        ['d' + id, 'i' + id, id].forEach(x => { const n = document.getElementById(x); if (n && !els.content.contains(n)) n.remove(); });
      }
      if (mermaidCache.size > 300) mermaidCache.clear();
      mermaidCache.set(key, res);
      return res;
    };
    const p = mermaidQueue.then(run, run);
    mermaidQueue = p.catch(() => {});
    return p;
  }
  function applyMermaid(wrap, res, theme) {
    wrap.classList.remove('pending');
    wrap.textContent = '';
    wrap._mdvTheme = theme;
    if (res.svg) {
      const div = document.createElement('div');
      div.className = 'mermaid-diagram';
      div.appendChild(DOMPurify.sanitize(res.svg, MERMAID_SVG_SANITIZE));
      const svg = div.querySelector('svg');
      if (svg) { svg.setAttribute('role', 'img'); svg.removeAttribute('height'); }
      wrap.appendChild(div);
    } else {
      const err = document.createElement('div');
      err.className = 'mermaid-error';
      err.setAttribute('role', 'note');
      const strong = document.createElement('strong');
      strong.textContent = 'Mermaid diyagramı çizilemedi (sözdizimi veya yapılandırma hatası). ';
      const detail = document.createElement('span');
      detail.textContent = 'Ayrıntı: ' + res.error;
      err.append(strong, detail);
      wrap.append(err, wrap._mdvPre);
    }
  }
  function refreshMermaid() {
    const blocks = Array.from(els.content.querySelectorAll('.mermaid-block'));
    if (!blocks.length) return;
    const theme = mermaidTheme();
    const todo = [];
    blocks.forEach(w => {
      const hit = mermaidCache.get(mermaidKey(theme, w._mdvSrc));
      if (hit) applyMermaid(w, hit, theme); // önbellekten: eşzamanlı, kaydırma konumu bozulmaz
      else { w.classList.add('pending'); todo.push(w); }
    });
    const prefetchLight = () => {
      // Koyu temada yazdırma için açık tema sürümünü arka planda hazırla
      if (theme === 'dark') blocks.forEach(w => mermaidJob(w._mdvSrc, 'default'));
    };
    if (!todo.length) { if (mermaidLib()) prefetchLight(); return; }
    loadOnce('vendor/mermaid.min.js', 'js').then(() => {
      todo.forEach(w => mermaidJob(w._mdvSrc, theme).then(res => {
        if (w.isConnected && mermaidTheme() === theme) applyMermaid(w, res, theme);
      }));
      prefetchLight();
    }, () => {
      todo.forEach(w => w.classList.remove('pending'));
      toast('Diyagram kütüphanesi (Mermaid) yüklenemedi; kaynak kod gösteriliyor.', 4000);
    });
  }
  function mermaidPrintSwap(printing) {
    els.content.querySelectorAll('.mermaid-block').forEach(w => {
      const theme = printing ? 'default' : mermaidTheme();
      if (w._mdvTheme === theme) return;
      const hit = mermaidCache.get(mermaidKey(theme, w._mdvSrc));
      if (hit) applyMermaid(w, hit, theme);
    });
  }

  function copyText(text, btn) {
    const done = () => { btn.textContent = 'Kopyalandı'; setTimeout(() => { btn.textContent = 'Kopyala'; }, 1400); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => fallback());
    } else fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Kopyalanamadı'); }
      ta.remove();
    }
  }

  // ---------- İçindekiler ----------
  let tocLinks = [];
  function buildToc() {
    els.tocList.textContent = '';
    tocLinks = [];
    const heads = els.content.querySelectorAll('h1,h2,h3,h4,h5,h6');
    if (!heads.length) {
      const li = document.createElement('li');
      li.className = 'toc-empty';
      li.textContent = activeDoc() ? 'Başlık yok' : 'Belge açık değil';
      els.tocList.appendChild(li);
      return;
    }
    const minLvl = Math.min(...Array.from(heads, h => +h.tagName[1]));
    heads.forEach(h => {
      const lvl = +h.tagName[1] - minLvl + 1;
      const li = document.createElement('li');
      li.className = 'lvl-' + lvl;
      const a = document.createElement('a');
      a.href = '#' + encodeURIComponent(h.id);
      const text = headingText(h);
      a.textContent = text;
      a.title = text;
      a.addEventListener('click', e => {
        e.preventDefault();
        tocPinned = { h, until: performance.now() + 400 }; // sayfa sonundaki başlıklar da seçili görünsün
        h.scrollIntoView({ block: 'start' });
        updateTocActive();
      });
      li.appendChild(a);
      els.tocList.appendChild(li);
      tocLinks.push([h, a]);
    });
    updateTocActive();
  }
  let tocRaf = 0;
  let tocPinned = null;
  function updateTocActive() {
    tocRaf = 0;
    if (!tocLinks.length) return;
    const top = els.main.getBoundingClientRect().top + 90;
    let current = tocLinks[0];
    for (const pair of tocLinks) {
      if (pair[0].getBoundingClientRect().top <= top) current = pair; else break;
    }
    if (tocPinned) {
      const pinned = tocLinks.find(p => p[0] === tocPinned.h);
      if (pinned && performance.now() < tocPinned.until) current = pinned;
      else if (pinned && current !== pinned && atBottom()) current = pinned;
      else tocPinned = null;
    }
    for (const pair of tocLinks) pair[1].classList.toggle('active', pair === current);
    const a = current[1], box = a.parentElement.parentElement.parentElement;
    if (box && (a.offsetTop < box.scrollTop || a.offsetTop > box.scrollTop + box.clientHeight - 30)) {
      box.scrollTop = a.offsetTop - box.clientHeight / 3;
    }
  }
  function atBottom() { return els.main.scrollTop + els.main.clientHeight >= els.main.scrollHeight - 4; }
  els.main.addEventListener('scroll', () => {
    const d = activeDoc(); if (d) d.scroll = els.main.scrollTop;
    if (!tocRaf) tocRaf = requestAnimationFrame(updateTocActive);
  }, { passive: true });

  function setTocVisible(v) {
    document.body.classList.toggle('toc-hidden', !v);
    els.btnToc.setAttribute('aria-pressed', String(v));
    store.set('mdv.toc', v);
  }
  els.btnToc.addEventListener('click', () => setTocVisible(document.body.classList.contains('toc-hidden')));

  // ---------- sekmeler ----------
  function renderTabs() {
    els.tabs.textContent = '';
    state.docs.forEach(d => {
      const tab = document.createElement('div');
      tab.className = 'tab';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(d.id === state.activeId));
      tab.title = d.path || d.name;
      const name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = d.name;
      const x = document.createElement('button');
      x.className = 'tab-close';
      x.type = 'button';
      x.title = 'Kapat';
      x.textContent = '×';
      x.addEventListener('click', e => { e.stopPropagation(); closeDoc(d.id); });
      tab.append(name, x);
      tab.addEventListener('click', () => activate(d.id));
      tab.addEventListener('auxclick', e => { if (e.button === 1) { e.preventDefault(); closeDoc(d.id); } });
      els.tabs.appendChild(tab);
    });
  }

  function activate(id) {
    const cur = activeDoc();
    if (cur) cur.scroll = els.main.scrollTop;
    state.activeId = id;
    renderTabs();
    renderActive(false);
  }

  function closeDoc(id) {
    const i = state.docs.findIndex(d => d.id === id);
    if (i < 0) return;
    state.docs.splice(i, 1);
    if (state.activeId === id) {
      const next = state.docs[i] || state.docs[i - 1];
      state.activeId = next ? next.id : null;
    }
    renderTabs();
    renderActive(false);
  }

  function renderActive(keepScroll) {
    const d = activeDoc();
    const prevScroll = els.main.scrollTop;
    closeSearch(true);
    if (!d) {
      els.content.hidden = true;
      els.content.textContent = '';
      els.welcome.hidden = false;
      els.btnReload.hidden = true;
      document.title = 'MD Görüntüleyici';
      renderRecent();
      buildToc();
      return;
    }
    els.welcome.hidden = true;
    els.content.hidden = false;
    els.btnReload.hidden = !(d.path && state.server);
    document.title = d.name + ' — MD Görüntüleyici';
    try { renderMarkdown(d); }
    catch (e) {
      els.content.textContent = '';
      const p = document.createElement('p');
      p.className = 'load-error';
      p.textContent = 'Belge görüntülenemedi: ' + (e && e.message);
      els.content.appendChild(p);
    }
    buildToc();
    els.main.scrollTop = keepScroll ? prevScroll : (d.scroll || 0);
    updateTocActive();
  }

  function openDoc({ name, path, content, mtime }) {
    if (path) {
      const existing = state.docs.find(d => d.path && d.path.toLowerCase() === path.toLowerCase());
      if (existing) {
        existing.content = content; existing.mtime = mtime;
        activate(existing.id);
        addRecent({ name, path });
        return existing;
      }
    }
    const doc = { id: nextId++, name, path: path || null, content, mtime: mtime || 0, scroll: 0 };
    state.docs.push(doc);
    addRecent({ name, path, content: path ? null : content });
    activate(doc.id);
    return doc;
  }

  // ---------- dosya açma ----------
  async function openPath(p, quiet) {
    if (!state.server) { toast('Yol ile açma yalnızca start.bat ile başlatıldığında çalışır.'); return null; }
    try {
      const r = await api('api/file', { path: p });
      const j = await r.json();
      if (!r.ok) { if (!quiet) toast((j.error || 'Açılamadı') + ': ' + p, 4000); return null; }
      return openDoc({ name: j.name, path: j.path, content: j.content, mtime: j.mtime });
    } catch (e) { if (!quiet) toast('Dosya okunamadı: ' + p, 4000); return null; }
  }

  async function openRelative(basePath, rel) {
    try {
      const r = await api('api/file', { base: basePath, rel });
      const j = await r.json();
      if (!r.ok) { toast((j.error || 'Açılamadı') + ': ' + (j.path || rel), 4000); return; }
      const doc = openDoc({ name: j.name, path: j.path, content: j.content, mtime: j.mtime });
      const hash = rel.split('#')[1];
      if (hash && doc) scrollToAnchor(hash);
    } catch (e) { toast('Dosya okunamadı', 3000); }
  }

  function registerAsset(file) {
    const key = file.name.toLowerCase();
    const old = state.assets.get(key);
    if (old) URL.revokeObjectURL(old);
    state.assets.set(key, URL.createObjectURL(file));
  }

  async function openFiles(fileList) {
    const files = Array.from(fileList || []);
    const imgs = files.filter(f => IMG_RE.test(f.name) || (f.type || '').startsWith('image/'));
    const mds = files.filter(f => !imgs.includes(f));
    imgs.forEach(registerAsset);
    let opened = 0;
    for (const f of mds) {
      if (!MD_RE.test(f.name) && f.type && !/^text\//.test(f.type)) { toast('Desteklenmeyen dosya: ' + f.name); continue; }
      try {
        let text = await f.text();
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        openDoc({ name: f.name, path: null, content: text, mtime: f.lastModified });
        opened++;
      } catch (e) { toast('Okunamadı: ' + f.name); }
    }
    if (!opened && imgs.length) {
      renderActive(true);
      toast(imgs.length + ' görsel eklendi; göreli görsel yolları dosya adına göre eşleştirilir.');
    }
  }

  els.fileInput.addEventListener('change', () => { openFiles(els.fileInput.files); els.fileInput.value = ''; });
  $('btn-open').addEventListener('click', () => els.fileInput.click());
  els.btnOpenPath.addEventListener('click', () => {
    const p = window.prompt('Açılacak dosyanın tam yolu (ör. C:\\Belgeler\\notlar.md):');
    if (p && p.trim()) openPath(p.trim().replace(/^"(.*)"$/, '$1'));
  });
  els.btnReload.addEventListener('click', () => reloadActive(false));
  $('btn-print').addEventListener('click', () => window.print());

  async function reloadActive(auto) {
    const d = activeDoc();
    if (!d || !d.path || !state.server) return;
    try {
      const r = await api('api/file', { path: d.path });
      const j = await r.json();
      if (!r.ok) { if (!auto) toast(j.error || 'Yenilenemedi'); return; }
      d.content = j.content; d.mtime = j.mtime;
      if (state.activeId === d.id) renderActive(true);
      toast(auto ? 'Dosya değişti, yeniden yüklendi.' : 'Yenilendi.');
    } catch (e) { if (!auto) toast('Yenilenemedi'); }
  }

  // Açık dosyada değişiklik izleme (2 sn'de bir, sadece görünürken)
  setInterval(async () => {
    const d = activeDoc();
    if (!d || !d.path || !state.server || document.hidden) return;
    try {
      const r = await api('api/stat', { path: d.path });
      if (!r.ok) return;
      const j = await r.json();
      if (j.mtime && d.mtime && j.mtime > d.mtime) reloadActive(true);
    } catch (e) { /* sunucu kapanmış olabilir */ }
  }, 2000);

  // ---------- sürükle-bırak ----------
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; els.dropzone.hidden = false; });
  window.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) els.dropzone.hidden = true; });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; els.dropzone.hidden = true;
    openFiles(e.dataTransfer.files);
  });

  // ---------- belge içi bağlantılar ----------
  function scrollToAnchor(raw) {
    let h = raw;
    try { h = decodeURIComponent(raw); } catch (e) { /* olduğu gibi */ }
    const el = document.getElementById(h) || document.getElementById(raw) || document.getElementById(slugify(h)) ||
      els.content.querySelector('[name="' + CSS.escape(h) + '"]');
    if (el && els.content.contains(el)) {
      el.scrollIntoView({ block: el.closest('section.footnotes') || el.closest('sup') ? 'center' : 'start' });
      el.classList.remove('mdv-flash'); void el.offsetWidth; el.classList.add('mdv-flash');
      setTimeout(() => el.classList.remove('mdv-flash'), 1600);
      return true;
    }
    return false;
  }
  els.content.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (href.startsWith('#')) {
      e.preventDefault();
      if (!scrollToAnchor(href.slice(1))) toast('Bağlantı hedefi bulunamadı');
      return;
    }
    if (isExternal(href)) return; // target=_blank ile tarayıcıda açılır
    e.preventDefault();
    const pathPart = href.split('#')[0].split('?')[0];
    let decoded = pathPart; try { decoded = decodeURIComponent(pathPart); } catch (er) { /* */ }
    const d = activeDoc();
    if (MD_RE.test(decoded)) {
      if (d && d.path && state.server) return openRelative(d.path, href);
      const already = state.docs.find(x => x.name.toLowerCase() === baseName(decoded).toLowerCase());
      if (already) return activate(already.id);
      toast('Göreli bağlantılar yalnızca start.bat ile açılan dosyalarda çalışır (veya hedef dosyayı da sürükleyip bırakın).', 4500);
      return;
    }
    toast('Bu tür bağlantı görüntüleyicide açılamaz: ' + decoded, 3500);
  });

  // ---------- arama ----------
  function clearMarks() {
    const marks = els.content.querySelectorAll('mark.mdv-hit');
    const parents = new Set();
    marks.forEach(m => { parents.add(m.parentNode); m.replaceWith(document.createTextNode(m.textContent)); });
    parents.forEach(p => p && p.normalize());
    state.hits = []; state.hitIndex = -1;
  }
  function lower(s) {
    const t = s.toLocaleLowerCase('tr-TR');
    return t.length === s.length ? t : s.toLowerCase();
  }
  function doSearch(q) {
    clearMarks();
    if (!q) { els.searchCount.textContent = ''; return; }
    const needle = lower(q);
    const walker = document.createTreeWalker(els.content, NodeFilter.SHOW_TEXT, {
      // Diyagram (SVG) ve formül içleri aranmaz: <mark> eklemek çizimi bozar
      acceptNode: n => (n.parentElement && n.parentElement.closest('.copy-btn, .mdv-math, .mermaid-diagram, svg')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      const hay = lower(text);
      if (hay.length !== text.length) continue;
      let idx = hay.indexOf(needle);
      if (idx < 0) continue;
      let cur = node;
      let offset = 0;
      while (idx >= 0) {
        const rel = idx - offset;
        const matchNode = cur.splitText(rel);
        cur = matchNode.splitText(needle.length);
        const mark = document.createElement('mark');
        mark.className = 'mdv-hit';
        matchNode.replaceWith(mark);
        mark.appendChild(matchNode);
        state.hits.push(mark);
        offset = idx + needle.length;
        idx = hay.indexOf(needle, offset);
      }
    }
    if (state.hits.length) goHit(0); else els.searchCount.textContent = 'Sonuç yok';
  }
  function goHit(i) {
    if (!state.hits.length) return;
    if (state.hitIndex >= 0 && state.hits[state.hitIndex]) state.hits[state.hitIndex].classList.remove('active');
    state.hitIndex = (i + state.hits.length) % state.hits.length;
    const m = state.hits[state.hitIndex];
    m.classList.add('active');
    let det = m.closest('details');
    while (det) { det.open = true; det = det.parentElement && det.parentElement.closest('details'); }
    m.scrollIntoView({ block: 'center' });
    els.searchCount.textContent = (state.hitIndex + 1) + ' / ' + state.hits.length;
  }
  function openSearch() {
    if (!activeDoc()) { toast('Önce bir belge açın'); return; }
    els.searchbar.hidden = false;
    els.searchInput.focus();
    els.searchInput.select();
    if (els.searchInput.value) doSearch(els.searchInput.value);
  }
  function closeSearch(silent) {
    clearMarks();
    els.searchCount.textContent = '';
    if (!silent) els.searchbar.hidden = true;
    else if (!els.searchbar.hidden && els.searchInput.value && activeDoc()) {
      // belge değiştiğinde açık aramayı yeniden uygula
      setTimeout(() => doSearch(els.searchInput.value), 0);
    }
  }
  let searchTimer = 0;
  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(els.searchInput.value), 120);
  });
  els.searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer);
      if (!state.hits.length) doSearch(els.searchInput.value); else goHit(state.hitIndex + (e.shiftKey ? -1 : 1)); }
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(false); }
  });
  $('search-next').addEventListener('click', () => goHit(state.hitIndex + 1));
  $('search-prev').addEventListener('click', () => goHit(state.hitIndex - 1));
  $('search-close').addEventListener('click', () => closeSearch(false));
  $('btn-search').addEventListener('click', openSearch);

  // ---------- klavye ----------
  document.addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    const inInput = /^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      if (k === 'o') { e.preventDefault(); els.fileInput.click(); }
      else if (k === 'f') { e.preventDefault(); openSearch(); }
      else if (k === 'g') { e.preventDefault(); goHit(state.hitIndex + 1); }
    } else if (e.altKey && !e.ctrlKey) {
      if (k === 't') { e.preventDefault(); setTocVisible(document.body.classList.contains('toc-hidden')); }
      else if (k === 'r') { e.preventDefault(); reloadActive(false); }
    } else if (e.key === 'Escape' && !els.searchbar.hidden) {
      closeSearch(false);
    } else if (e.key === 'F3') {
      e.preventDefault(); goHit(state.hitIndex + (e.shiftKey ? -1 : 1));
    } else if (!inInput && e.key === '/' ) {
      e.preventDefault(); openSearch();
    }
  });

  // ---------- son açılanlar ----------
  function recentKey(entry) { return (entry.path || ('isim:' + entry.name)).toLowerCase(); }
  function addRecent({ name, path, content }) {
    let list = store.get('mdv.recent', []);
    if (!Array.isArray(list)) list = [];
    const key = recentKey({ name, path });
    list = list.filter(x => x && x.key !== key);
    const entry = { key, name, path: path || null, ts: Date.now(), cached: false };
    if (!path && typeof content === 'string' && content.length <= MAX_CACHED_CONTENT) {
      entry.cached = store.set('mdv.rc.' + key, content);
    }
    list.unshift(entry);
    list.slice(MAX_RECENT).forEach(x => { if (x.cached) store.del('mdv.rc.' + x.key); });
    store.set('mdv.recent', list.slice(0, MAX_RECENT));
  }
  function renderRecent() {
    let list = store.get('mdv.recent', []);
    if (!Array.isArray(list)) list = [];
    els.recentList.textContent = '';
    els.clearRecent.hidden = !list.length;
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Henüz dosya açılmadı.';
      els.recentList.appendChild(li);
      return;
    }
    list.forEach(x => {
      const li = document.createElement('li');
      const n = document.createElement('span'); n.className = 'r-name'; n.textContent = x.name;
      const p = document.createElement('span'); p.className = 'r-path';
      const when = new Date(x.ts).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });
      p.textContent = (x.path || (x.cached ? 'sürükle-bırak (kopyası saklandı)' : 'sürükle-bırak')) + ' · ' + when;
      li.append(n, p);
      const canPath = x.path && state.server;
      const cachedContent = !x.path && x.cached ? store.get('mdv.rc.' + x.key, null) : null;
      if (canPath) li.addEventListener('click', () => openPath(x.path));
      else if (cachedContent !== null) li.addEventListener('click', () => openDoc({ name: x.name, path: null, content: cachedContent }));
      else {
        li.classList.add('disabled');
        li.title = x.path ? 'Yol ile açmak için görüntüleyiciyi start.bat ile başlatın.' : 'Dosyanın kopyası yok; yeniden sürükleyip bırakın.';
      }
      els.recentList.appendChild(li);
    });
  }
  els.clearRecent.addEventListener('click', () => {
    store.get('mdv.recent', []).forEach(x => { if (x && x.cached) store.del('mdv.rc.' + x.key); });
    store.del('mdv.recent');
    renderRecent();
  });

  // ---------- başlangıç ----------
  async function init() {
    applyTheme();
    applyRemoteBtn();
    setTocVisible(store.get('mdv.toc', window.innerWidth > 800));

    const params = new URLSearchParams(location.hash.slice(1));
    const files = params.getAll('f');
    state.token = params.get('t');
    if (location.protocol.startsWith('http') && state.token) {
      try {
        const r = await api('api/ping', {});
        state.server = r.ok && (await r.json()).app === 'md-viewer';
      } catch (e) { state.server = false; }
    }
    if (state.token) history.replaceState(null, '', location.pathname + '#t=' + state.token);
    els.btnOpenPath.hidden = !state.server;
    els.modeNote.textContent = state.server
      ? 'Yerel sunucu modu: dosyalar yalnızca okunur; göreli görseller ve .md bağlantıları desteklenir.'
      : (location.protocol === 'file:'
        ? 'Doğrudan tarayıcıda açıldı (sunucusuz mod). Göreli görseller için görselleri de pencereye bırakın.'
        : 'Sunucu oturumu bulunamadı. start.bat ile yeniden başlatın.');

    renderActive(false);
    for (const f of files) await openPath(f);
  }
  init();
})();
