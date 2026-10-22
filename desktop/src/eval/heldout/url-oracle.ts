// A held-out url oracle asks the page URL to contain a phrase.
// Query strings encode a space as +, so the raw URL can hold the phrase
// without containing the space. The decoded query value is part of the check.
// hn-search replay on 22 Oct 2026 passed and finished at
// https://hn.algolia.com/?q=Grace+Hopper and ?q=Alan+Turing.
// The raw URL does not contain "Grace Hopper".

export function urlHasPhrase(url: string, phrase: string): boolean {
  if (!phrase) return false;
  if (url.includes(phrase)) return true;
  try {
    const parsed = new URL(url);
    const decodedPath = decodeURIComponent(parsed.pathname);
    const values = [...parsed.searchParams.values()];
    return [decodedPath, ...values].some((part) => part.includes(phrase));
  } catch {
    return false;
  }
}
