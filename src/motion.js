// Page-world script: the page moves, whatever the OS asks for.
//
// Under `prefers-reduced-motion: reduce` Lichess turns every transition and
// animation off, ours included, with one rule in its site CSS
// (`*, :before, :after { transition: none !important; animation: none
// !important }`), and its scripts ask `matchMedia` as well. We never reduce
// motion, so every reduced-motion query answers as if nothing were asked for:
// `reduce` never matches, `no-preference` always does.
//
// - `matchMedia` gets the query rewritten that way.
// - Lichess's sheets come from lichess1.org, and a script can't touch a
//   cross-origin sheet's rules (its link has no `crossorigin`). So each one is
//   loaded again with CORS (its server allows it, and the file is in the cache
//   by then), its reduced-motion rules rewritten, and the copy takes the
//   original's place right after it, the original switched off. A sheet with
//   no such rule is left as is; a copy goes when its original does.
(() => {
  const QUERY = /\(\s*prefers-reduced-motion\s*(?::\s*(reduce|no-preference)\s*)?\)/g;
  const moving = query => query.replace(QUERY, (_, v) => (v === 'no-preference' ? '(width >= 0)' : '(width < 0)'));

  const matchMedia = window.matchMedia.bind(window);
  window.matchMedia = query => matchMedia(moving(String(query)));

  // Rewrites the reduced-motion media rules, nested ones too; whether any was.
  function rewrite(rules) {
    let hit = false;
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule && rule.media.mediaText.includes('prefers-reduced-motion')) {
        rule.media.mediaText = moving(rule.media.mediaText);
        hit = true;
      }
      if (rule instanceof CSSGroupingRule) hit = rewrite(rule.cssRules) || hit;
    }
    return hit;
  }

  const seen = new WeakSet();
  const copies = new WeakMap();

  function swap(link) {
    if (seen.has(link) || !link.href) return;
    seen.add(link);
    const copy = document.createElement('link');
    seen.add(copy);
    copy.rel = 'stylesheet';
    copy.crossOrigin = 'anonymous';
    if (link.media) copy.media = link.media;
    copy.href = link.href;
    copy.onload = () => {
      if (rewrite(copy.sheet.cssRules)) link.disabled = true;
      else copy.remove();
    };
    copy.onerror = () => copy.remove();
    copies.set(link, copy);
    link.after(copy);
  }

  const isSheet = n => n.nodeName === 'LINK' && n.relList.contains('stylesheet');
  new MutationObserver(records => {
    for (const r of records) {
      for (const n of r.addedNodes) if (isSheet(n)) swap(n);
      for (const n of r.removedNodes) if (isSheet(n)) copies.get(n)?.remove();
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.querySelectorAll('link[rel~="stylesheet"]').forEach(swap);
})();
