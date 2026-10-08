// Hash navigation (#/ledger, #/tracker?focus=<id>, #/stats).
export function navigate(view, params) {
  const query = params ? `?${new URLSearchParams(params)}` : "";
  const hash = `#/${view}${query}`;
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = hash;
}
